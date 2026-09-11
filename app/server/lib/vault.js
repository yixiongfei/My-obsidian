import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { VAULT_ROOT, IGNORED_DIRS, IMAGE_EXT } from '../config.js';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 统一用 POSIX 相对路径作为笔记 id，Windows 上也保持一致 */
export const toId = (abs) => path.relative(VAULT_ROOT, abs).split(path.sep).join('/');
export const toAbs = (id) => path.join(VAULT_ROOT, id.split('/').join(path.sep));

/** frontmatter 里的日期可能被 YAML 解析成 Date，统一成 YYYY-MM-DD 字符串 */
export function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    // YAML 的裸日期按 UTC 午夜解析，取 UTC 各字段避免时区偏移一天
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** 中文按字计、西文按词计的粗略字数 */
function countWords(text) {
  const cjk = (text.match(/[一-龥]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + latin;
}

function normTags(fm, id) {
  const raw = fm.tags ?? fm.tag ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/);
  const set = new Set(list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean));
  // 没写 tags 的笔记，用所在目录兜底，保证任何笔记都能被分类检索到
  if (set.size === 0) {
    for (const seg of id.split('/').slice(0, -1)) set.add(seg);
  }
  if (set.size === 0) set.add('未分类');
  return [...set];
}

/* ------------------------------------------------------------------ *
 * 解析单个 .md
 * ------------------------------------------------------------------ */

const WIKILINK_RE = /(!?)\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

function parseNote(abs, id, raw) {
  let fm = {};
  let body = raw;
  try {
    const parsed = matter(raw);
    fm = parsed.data || {};
    body = parsed.content;
  } catch {
    // frontmatter 坏了不该让整篇笔记消失，退化成无 frontmatter 处理
  }

  const basename = path.basename(id, '.md');
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = String(fm.title || (h1 ? h1[1] : basename)).trim();

  // 目录（h2/h3），用于阅读页右侧大纲
  const outline = [];
  const linkTargets = [];
  const embedTargets = [];
  let inFence = false;

  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) outline.push({ level: h[1].length, text: h[2].trim() });
  }

  // 链接与嵌入（含代码块内的也无所谓，图谱多一条边不影响正确性，且笔记里没有此写法）
  for (const m of body.matchAll(WIKILINK_RE)) {
    const [, bang, target] = m;
    (bang ? embedTargets : linkTargets).push(target.trim());
  }

  const plain = body
    .replace(WIKILINK_RE, '$2')
    .replace(/\[!\w+\][-+]?/g, ' ')          // callout 标记不该出现在搜索摘要里
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/[>*_`#|\-]/g, ' ');

  return {
    id,
    abs,
    title,
    basename,
    folder: path.dirname(id) === '.' ? '' : path.dirname(id),
    tags: normTags(fm, id),
    created: toDateStr(fm.created) || null,
    reviewCount: Number.isFinite(Number(fm.review_count)) ? Number(fm.review_count) : 0,
    lastReviewed: toDateStr(fm.last_reviewed),
    nextReview: toDateStr(fm.next_review),
    hasFrontmatter: Object.keys(fm).length > 0,
    frontmatter: fm,
    outline,
    linkTargets,
    embedTargets,
    words: countWords(plain),
    body,
    plain,
    raw,
  };
}

/* ------------------------------------------------------------------ *
 * 索引
 * ------------------------------------------------------------------ */

class VaultIndex {
  constructor() {
    this.notes = new Map();     // id -> note
    this.images = new Map();    // id -> { id, basename }
    this.canvases = new Map();  // id -> { id, title }
    this.byBasename = new Map();// 小写 basename -> [id]（wiki 链接解析用）
    this.backlinks = new Map(); // id -> Set<id>
    this.version = 0;
  }

  async scan() {
    this.notes.clear();
    this.images.clear();
    this.canvases.clear();

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') {
          if (IGNORED_DIRS.has(e.name)) continue;
        }
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          // 自带 .git 的子目录是另一个仓库（比如把本站点克隆进了 vault），
          // 里面的 .md 不是你的笔记，扫进来会凭空多出重复条目
          if (fs.existsSync(path.join(abs, '.git'))) continue;
          await walk(abs);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        const id = toId(abs);
        if (ext === '.md') {
          try {
            const raw = await fsp.readFile(abs, 'utf8');
            this.notes.set(id, parseNote(abs, id, raw));
          } catch { /* 读不了就跳过这个文件 */ }
        } else if (IMAGE_EXT.has(ext)) {
          this.images.set(id, { id, basename: path.basename(id) });
        } else if (ext === '.canvas') {
          this.canvases.set(id, { id, basename: path.basename(id, '.canvas') });
        }
      }
    };

    await walk(VAULT_ROOT);
    this.rebuildLinkMaps();
    this.version += 1;
    return this;
  }

  rebuildLinkMaps() {
    this.byBasename.clear();
    const push = (key, id) => {
      const k = key.toLowerCase();
      if (!this.byBasename.has(k)) this.byBasename.set(k, []);
      this.byBasename.get(k).push(id);
    };
    for (const [id, n] of this.notes) { push(n.basename, id); push(id, id); push(id.replace(/\.md$/, ''), id); }
    for (const [id] of this.images) { push(path.basename(id), id); push(id, id); }
    for (const [id, c] of this.canvases) { push(c.basename, id); push(id, id); push(id.replace(/\.canvas$/, ''), id); }

    this.backlinks.clear();
    for (const [id, n] of this.notes) {
      for (const t of [...n.linkTargets, ...n.embedTargets]) {
        const target = this.resolve(t);
        if (!target || target === id) continue;
        if (!this.backlinks.has(target)) this.backlinks.set(target, new Set());
        this.backlinks.get(target).add(id);
      }
    }
  }

  /** Obsidian 风格的链接解析：先按完整路径，再按文件名 */
  resolve(target) {
    if (!target) return null;
    const t = target.trim().replace(/^\.\//, '');
    for (const key of [t, `${t}.md`, t.replace(/\.md$/, '')]) {
      const hit = this.byBasename.get(key.toLowerCase());
      if (hit && hit.length) return hit[0];
    }
    return null;
  }

  get(id) { return this.notes.get(id) || null; }

  /** 更新单个文件，避免每次改动都全量重扫 */
  async update(abs) {
    const id = toId(abs);
    if (id.startsWith('..')) return false;
    const ext = path.extname(abs).toLowerCase();
    if (ext !== '.md' && !IMAGE_EXT.has(ext) && ext !== '.canvas') return false;
    try {
      if (ext === '.md') {
        const raw = await fsp.readFile(abs, 'utf8');
        this.notes.set(id, parseNote(abs, id, raw));
      } else if (IMAGE_EXT.has(ext)) {
        this.images.set(id, { id, basename: path.basename(id) });
      } else {
        this.canvases.set(id, { id, basename: path.basename(id, '.canvas') });
      }
    } catch {
      return false;
    }
    this.rebuildLinkMaps();
    this.version += 1;
    return true;
  }

  remove(abs) {
    const id = toId(abs);
    const had = this.notes.delete(id) || this.images.delete(id) || this.canvases.delete(id);
    if (had) { this.rebuildLinkMaps(); this.version += 1; }
    return had;
  }

  /** 笔记的公开元信息（不含正文，用于列表/树/图谱） */
  meta(n) {
    return {
      id: n.id,
      title: n.title,
      basename: n.basename,
      folder: n.folder,
      tags: n.tags,
      created: n.created,
      reviewCount: n.reviewCount,
      lastReviewed: n.lastReviewed,
      nextReview: n.nextReview,
      words: n.words,
      headings: n.outline.length,
      empty: n.words === 0,
    };
  }

  allMeta() {
    return [...this.notes.values()].map((n) => this.meta(n)).sort((a, b) => a.id.localeCompare(b.id, 'zh'));
  }

  /** 文件夹树，供左侧导航 */
  tree() {
    const root = { name: '', path: '', type: 'folder', children: [] };
    const folders = new Map([['', root]]);
    const ensure = (folderPath) => {
      if (folders.has(folderPath)) return folders.get(folderPath);
      const parent = ensure(path.posix.dirname(folderPath) === '.' ? '' : path.posix.dirname(folderPath));
      const node = { name: path.posix.basename(folderPath), path: folderPath, type: 'folder', children: [] };
      folders.set(folderPath, node);
      parent.children.push(node);
      return node;
    };
    for (const meta of this.allMeta()) {
      ensure(meta.folder).children.push({ ...meta, name: meta.title, type: 'note' });
    }
    const sort = (node) => {
      node.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'folder' ? -1 : 1));
      node.children.filter((c) => c.type === 'folder').forEach(sort);
    };
    sort(root);
    return root.children;
  }
}

export const index = new VaultIndex();

export function statSyncSafe(abs) {
  try { return fs.statSync(abs); } catch { return null; }
}
