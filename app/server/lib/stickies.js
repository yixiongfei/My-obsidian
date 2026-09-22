import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { VAULT_ROOT, KB_DIR } from '../config.js';
import { handle } from './db.js';

/**
 * 便利贴 —— 贴在笔记正文上的纸片。
 *
 * 真相在 SQLite：便利贴是**读者在笔记之上的私人批注**，不是笔记内容本身。
 * 写进 .md 会有两个后果：一是 Obsidian 里正文被一堆坐标噪声撑开，二是每拖一次
 * 纸片就要改文件 → chokidar 触发 → 重新索引 → SSE 推送 → 正文重渲染，纸片脚下的
 * 地面会在拖动过程中反复塌陷。所以走库，和日程、荧光笔同一套定位。
 *
 * 图片 / PDF 反过来：那是**用户的素材**，必须跟着 vault 走，落在 My-md/图像/便利贴/，
 * 用已有的 /vault 静态路由送出去，换台机器打开仓库照样在。
 *
 * 撕掉一张带图的便利贴时，图片不直接删——挪进 .kb/trash/便利贴/。撕纸是一下就完成的
 * 动作，没有撤销；截图丢了找不回来，一个回收站的代价便宜得多。
 */

const COLORS = new Set(['y', 'b', 'g', 'r']);
const MEDIA_DIR = path.join(VAULT_ROOT, '图像', '便利贴');
const TRASH_DIR = path.join(KB_DIR, 'trash', '便利贴');
/** 相对 vault 的 POSIX 路径前缀，存进库里、也用来判断能不能进回收站 */
const MEDIA_REL = '图像/便利贴';

const MIME_EXT = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'],
  ['image/gif', '.gif'], ['image/avif', '.avif'], ['image/bmp', '.bmp'],
  ['application/pdf', '.pdf'],
]);
const OK_EXT = new Set([...MIME_EXT.values(), '.jpeg']);

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clamp = (v, lo, hi, dflt = lo) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const rowOut = (r) => r && ({
  id: r.id,
  noteId: r.note_id,
  color: r.color,
  x: r.x, y: r.y, w: r.w, h: r.h,
  text: r.text,
  media: r.media || '',
  mediaKind: r.media_kind || '',
  poster: r.poster || '',
  anchor: parseAnchor(r.anchor),
  pinned: !!r.pinned,
  arrows: parseArrows(r.arrows),
  updatedAt: r.updated_at,
});

/** 纸片自己的锚：贴在哪一段旁边。解析不出来就当没有，退回绝对坐标 */
function parseAnchor(s) {
  try {
    const a = JSON.parse(s || '{}');
    if (!a || typeof a !== 'object' || typeof a.sel !== 'string') return null;
    return { sel: a.sel.slice(0, 120), txt: String(a.txt ?? '').slice(0, 60), dx: Number(a.dx) || 0, dy: Number(a.dy) || 0 };
  } catch { return null; }
}

const cleanAnchor = (v) => (v && typeof v === 'object' && typeof v.sel === 'string'
  ? JSON.stringify({ sel: v.sel.slice(0, 120), txt: String(v.txt ?? '').slice(0, 60), dx: clamp(v.dx, -20000, 20000, 0), dy: clamp(v.dy, -20000, 200000, 0) })
  : '{}');

function parseArrows(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

/**
 * 箭头的锚点。两种落点：
 *   text —— 落在某个文字上，存「元素路径 + 文本节点序号 + 字符偏移」，
 *           正文换行、窗口变宽都不影响，箭头还钉在那个字上。
 *   box  —— 落在公式、图片、空白处，存「元素路径 + 框内百分比」。
 * 两种都带一份绝对坐标兜底：笔记被改到锚点找不着了，箭头不至于消失。
 */
function cleanArrows(v) {
  if (!Array.isArray(v)) return '[]';
  const out = v.slice(0, 16).map((a) => ({
    side: ['t', 'r', 'b', 'l'].includes(a?.side) ? a.side : 'r',
    kind: a?.kind === 'text' ? 'text' : 'box',
    sel: String(a?.sel ?? '').slice(0, 120),
    node: Number.isFinite(Number(a?.node)) ? Number(a.node) : 0,
    off: Number.isFinite(Number(a?.off)) ? Number(a.off) : 0,
    fx: clamp(a?.fx, 0, 1, 0.5),
    fy: clamp(a?.fy, 0, 1, 0.5),
    x: clamp(a?.x, -20000, 20000, 0),
    y: clamp(a?.y, -20000, 20000, 0),
    txt: String(a?.txt ?? '').slice(0, 60),
  }));
  return JSON.stringify(out);
}

const nowIso = () => new Date().toISOString();

export function list(noteId) {
  if (!noteId) throw bad('缺 path');
  return handle().prepare('SELECT * FROM stickies WHERE note_id = ? ORDER BY id').all(noteId).map(rowOut);
}

export function create(noteId, p = {}) {
  if (!noteId) throw bad('缺 path');
  const d = handle();
  const t = nowIso();
  const info = d.prepare(`
    INSERT INTO stickies (note_id, color, x, y, w, h, text, media, media_kind, poster, anchor, pinned, arrows, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
    noteId,
    COLORS.has(p.color) ? p.color : 'y',
    clamp(p.x, 0, 20000, 0), clamp(p.y, 0, 200000, 0),
    clamp(p.w, 120, 1200, 216), clamp(p.h, 72, 1200, 132),
    String(p.text ?? '').slice(0, 8000),
    String(p.media ?? '').slice(0, 400),
    ['image', 'pdf'].includes(p.mediaKind) ? p.mediaKind : '',
    String(p.poster ?? '').slice(0, 400),
    cleanAnchor(p.anchor),
    cleanArrows(p.arrows),
    t, t,
  );
  return rowOut(d.prepare('SELECT * FROM stickies WHERE id = ?').get(Number(info.lastInsertRowid)));
}

/** 只改传上来的字段：拖动只发坐标，改字只发 text，互不覆盖 */
export function update(id, p = {}) {
  const d = handle();
  const row = d.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  if (!row) throw bad('便利贴不存在', 404);

  const set = [];
  const vals = [];
  const put = (col, v) => { set.push(`${col} = ?`); vals.push(v); };

  if ('color' in p) { if (!COLORS.has(p.color)) throw bad('颜色只能是 y / b / g / r'); put('color', p.color); }
  if ('x' in p) put('x', clamp(p.x, -2000, 20000, row.x));
  if ('y' in p) put('y', clamp(p.y, -2000, 200000, row.y));
  if ('w' in p) put('w', clamp(p.w, 120, 1200, row.w));
  if ('h' in p) put('h', clamp(p.h, 72, 1200, row.h));
  if ('text' in p) put('text', String(p.text ?? '').slice(0, 8000));
  if ('media' in p) put('media', String(p.media ?? '').slice(0, 400));
  if ('mediaKind' in p) put('media_kind', ['image', 'pdf'].includes(p.mediaKind) ? p.mediaKind : '');
  if ('poster' in p) put('poster', String(p.poster ?? '').slice(0, 400));
  if ('anchor' in p) put('anchor', cleanAnchor(p.anchor));
  if ('pinned' in p) put('pinned', p.pinned ? 1 : 0);
  if ('arrows' in p) put('arrows', cleanArrows(p.arrows));
  if (!set.length) return rowOut(row);

  put('updated_at', nowIso());
  vals.push(id);
  d.prepare(`UPDATE stickies SET ${set.join(', ')} WHERE id = ?`).run(...vals);
  return rowOut(d.prepare('SELECT * FROM stickies WHERE id = ?').get(id));
}

export function remove(id) {
  const d = handle();
  const row = d.prepare('SELECT * FROM stickies WHERE id = ?').get(id);
  if (!row) return { ok: false };
  d.prepare('DELETE FROM stickies WHERE id = ?').run(id);
  if (row.media) trashMedia(row.media, 'media');
  if (row.poster) trashMedia(row.poster, 'poster');
  return { ok: true };
}

/** 图片只在没有别的便利贴引用、且确实是贴纸目录里的文件时才进回收站 */
function trashMedia(rel, col = 'media') {
  if (!rel.startsWith(`${MEDIA_REL}/`)) return;
  const still = handle().prepare('SELECT 1 FROM stickies WHERE media = ? OR poster = ? LIMIT 1').get(rel, rel);
  if (still) return;
  void col;
  const abs = path.join(VAULT_ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(abs)) return;
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    fs.renameSync(abs, path.join(TRASH_DIR, path.basename(abs)));
  } catch (err) {
    console.warn(`[便利贴] ${rel} 挪进回收站失败：${err.message}`);
  }
}

/**
 * 存一张贴图。按内容哈希命名：同一张截图粘两次只占一份磁盘，
 * 也顺带保证文件名里不会混进用户剪贴板里的奇怪字符。
 */
/* 作答区贴的手写图放 图像/作答/，和便利贴分开——便利贴的回收逻辑只认 图像/便利贴/ */
const ANSWER_DIR = path.join(VAULT_ROOT, '图像', '作答');
const ANSWER_REL = '图像/作答';

export async function saveMedia(buf, name = '', mime = '', { answer = false } = {}) {
  if (!buf?.length) throw bad('空文件');
  if (buf.length > 24 * 1024 * 1024) throw bad('单张最多 24MB');

  const byMime = MIME_EXT.get(String(mime).split(';')[0].trim().toLowerCase());
  const byName = path.extname(String(name)).toLowerCase();
  const ext = byMime || (OK_EXT.has(byName) ? byName : '');
  if (!ext) throw bad('只收图片和 PDF');
  if (answer && ext === '.pdf') throw bad('作答区只收图片');

  const dir = answer ? ANSWER_DIR : MEDIA_DIR;
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const file = `${day}-${hash}${ext === '.jpeg' ? '.jpg' : ext}`;
  const abs = path.join(dir, file);
  await fsp.mkdir(dir, { recursive: true });
  if (!fs.existsSync(abs)) await fsp.writeFile(abs, buf);

  return { path: `${answer ? ANSWER_REL : MEDIA_REL}/${file}`, kind: ext === '.pdf' ? 'pdf' : 'image', name: String(name).slice(0, 120) };
}
