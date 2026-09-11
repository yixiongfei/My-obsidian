import fsp from 'node:fs/promises';
import { INTERVALS, REVIEW_LOG } from '../config.js';
import { index, toAbs } from './vault.js';
import { recordReviewRow, syncNote } from './sync.js';

export const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayStr(dt);
}

export const daysBetween = (a, b) => {
  const p = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86400000);
};

/** 第 count 次复习之后，距下一次的天数（config.js 的 INTERVALS 间隔表） */
export const intervalAfter = (count) => INTERVALS[Math.min(count, INTERVALS.length - 1)];

const DEFAULT_NOTE = {
  again: '需重来，未完全掌握',
  hard: '有点吃力，缩短间隔',
  good: '完成一次复习',
  easy: '很轻松，拉长间隔',
};

/**
 * 笔记复习的四档间隔。都建立在原有的 1·2·4·7·15·30 表上，不另起一套：
 *   again 明天重来 / hard 折半 / good 照表 / easy 跳到下一级
 */
function gapFor(result, reviewCount) {
  const normal = intervalAfter(reviewCount);
  if (result === 'again') return 1;
  if (result === 'hard') return Math.max(1, Math.round(normal / 2));
  if (result === 'easy') return INTERVALS[Math.min(reviewCount + 1, INTERVALS.length - 1)];
  return normal;
}

/* ------------------------------------------------------------------ *
 * frontmatter 写回
 *
 * 只改 review_count / last_reviewed / next_review 三行，其余字节原样保留。
 * 不用 gray-matter 的 stringify，避免它把 `tags: [a, b]` 重排成块状列表。
 * ------------------------------------------------------------------ */

const FM_KEYS = ['review_count', 'last_reviewed', 'next_review'];

export function patchFrontmatter(raw, updates) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);

  if (!fmMatch) {
    const block = FM_KEYS.filter((k) => k in updates).map((k) => `${k}: ${updates[k]}`).join(eol);
    return `---${eol}${block}${eol}---${eol}${eol}${raw.replace(/^\s*\r?\n/, '')}`;
  }

  const lines = fmMatch[1].split(/\r?\n/);
  for (const key of FM_KEYS) {
    if (!(key in updates)) continue;
    const value = `${key}: ${updates[key]}`;
    const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    if (at === -1) lines.push(value);
    else lines[at] = value;
  }
  const rebuilt = `---${eol}${lines.join(eol)}${eol}---`;
  return raw.slice(0, fmMatch.index) + rebuilt + raw.slice(fmMatch.index + fmMatch[0].length - fmMatch[2].length);
}

/* ------------------------------------------------------------------ *
 * 记一次复习
 * ------------------------------------------------------------------ */

/**
 * @param {string} id            笔记相对路径
 * @param {'again'|'hard'|'good'|'easy'} result
 * @param {string} addedContent  本次新增理解，写进 review_log.jsonl
 * @param {string} source        "白天复习" | "晚上首次学习"
 */
export async function recordReview(id, { result = 'good', addedContent = '', source } = {}) {
  const note = index.get(id);
  if (!note) throw Object.assign(new Error('笔记不存在'), { status: 404 });

  const today = todayStr();
  const countAfter = note.reviewCount + 1;
  const gap = gapFor(result, note.reviewCount);
  const nextReview = addDays(today, gap);

  const abs = toAbs(id);
  const raw = await fsp.readFile(abs, 'utf8');
  const patched = patchFrontmatter(raw, {
    review_count: countAfter,
    last_reviewed: today,
    next_review: nextReview,
  });
  await fsp.writeFile(abs, patched, 'utf8');

  const entry = {
    date: today,
    note_path: id,
    tags: note.tags,
    review_count_after: countAfter,
    added_content: String(addedContent || '').trim() || DEFAULT_NOTE[result] || '完成一次复习',
    source: source || (countAfter === 1 ? '晚上首次学习' : '白天复习'),
  };
  await fsp.appendFile(REVIEW_LOG, `${JSON.stringify(entry)}\n`, 'utf8');

  // 三处写入：frontmatter（给 Obsidian）、review_log.jsonl（给 schema/Claudian）、
  // SQLite（只为统计快，任何时候都能从前两者重建）
  recordReviewRow(entry);
  await index.update(abs);
  syncNote(id);

  return { entry, nextReview, reviewCount: countAfter, gap };
}

/* ------------------------------------------------------------------ *
 * 读复习日志
 * ------------------------------------------------------------------ */

export async function readLog() {
  let text = '';
  try { text = await fsp.readFile(REVIEW_LOG, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 跳过坏行，不让整份日志失效 */ }
  }
  return out;
}
