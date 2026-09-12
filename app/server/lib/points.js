import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from '../config.js';
import { handle } from './db.js';
import { allNotes } from './query.js';
import { todayStr, daysBetween, addDays } from './review.js';

/**
 * 考点层：真题标签（.kb/exams/tags-math.json / tags-408.json）就是考点清单。
 *
 * 我的笔记不是考点本身，而是「学这个考点时的感悟」——所以一个考点
 * 有没有学过，看的是有没有一篇笔记对得上它：标题就是考点名、打了这个
 * 标签、或标题里含着考点名。据此把学习过程算成三件事：
 *   今天学了哪些考点（对上的笔记今天新建 / 首次复习）
 *   还剩多少没学（一篇笔记都没有）
 *   还有多少要复习（对上的笔记到期了）
 *
 * 英语没有考点清单，词表分支下的笔记照旧直接挂在分支上。
 */

const EXAMS_DIR = path.join(VAULT_ROOT, '.kb', 'exams');
/** tags.yaml 的大类 → 真题标签文件。用数组不用对象：对象会把 "408" 这种数字键排到最前 */
const GROUPS = [
  { category: '数学', key: 'math', file: 'tags-math.json' },
  { category: '408', key: '408', file: 'tags-408.json' },
];
const groupOf = (category) => GROUPS.find((g) => g.category === String(category));

const cache = new Map();   // file → { mtime, data }

function loadTags(file) {
  const abs = path.join(EXAMS_DIR, file);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.data;
  let data = null;
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    data = (raw.subjects || []).map((s) => ({
      name: String(s.name),
      points: (s.tags || []).map((t) => ({ name: String(t.name), items: (t.items || []).length })),
    }));
  } catch { data = null; }
  cache.set(file, { mtime: st.mtimeMs, data });
  return data;
}

/** 大类名 → 该类的考点科目；没有清单的（英语）返回 null */
export function subjectsOf(category) {
  const g = groupOf(category);
  return g ? loadTags(g.file) : null;
}

export const groupKeyOf = (category) => groupOf(category)?.key || null;

/** 词表分支名与清单科目名对上：概率论 ↔ 概率论与数理统计，计算机组成原理 ↔ 组成原理 */
export const subjectMatches = (branch, subject) =>
  branch === subject || branch.includes(subject) || subject.includes(branch);

/* ------------------------------------------------------------------ *
 * 笔记 ↔ 考点
 * ------------------------------------------------------------------ */

const dateOfMs = (ms) => (ms ? todayStr(new Date(ms)) : null);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s，、,。.．·:：;；()（）\-—_的]/g, '');

/** 每篇笔记的「学习日」：frontmatter 的 created > 首次复习日 > 文件修改日 */
export function learnedDates() {
  const first = new Map(handle().prepare('SELECT note_id, MIN(date) AS d FROM reviews GROUP BY note_id').all().map((r) => [r.note_id, r.d]));
  const out = new Map();
  for (const n of allNotes()) out.set(n.id, n.created || first.get(n.id) || dateOfMs(n.mtime));
  return out;
}

/**
 * 给一组笔记找它们对应的考点。返回 Map<noteId, pointName>；
 * 一篇笔记只归一个考点：标题完全相同 > 标签命中 > 标题里含考点名（取最长的）。
 */
export function matchNotes(notes, points) {
  // 「函数，极限，连续」对「函数、极限、连续」、「矩阵相似与相似对角化」对「矩阵的相似与相似对角化」：
  // 标点、空白和「的」都不该成为对不上的理由
  const byNorm = new Map(points.map((p) => [norm(p.name), p.name]));
  const byLen = [...points].map((p) => ({ name: p.name, key: norm(p.name) })).filter((p) => p.key.length >= 2)
    .sort((a, b) => b.key.length - a.key.length);
  const out = new Map();
  for (const n of notes) {
    const title = norm(n.title);
    if (byNorm.has(title)) { out.set(n.id, byNorm.get(title)); continue; }
    const tagHit = (n.tags || []).map(norm).find((t) => byNorm.has(t));
    if (tagHit) { out.set(n.id, byNorm.get(tagHit)); continue; }
    const sub = byLen.find((p) => title.includes(p.key));
    if (sub) out.set(n.id, sub.name);
  }
  return out;
}

/** 一个考点的状态：today（今天学的）> due（要复习）> learned > new */
export function pointStatus(notes, today, learnedAt) {
  if (!notes.length) return 'new';
  if (notes.some((n) => n.reviewable !== false && n.nextReview && daysBetween(today, n.nextReview) <= 0)) return 'due';
  if (notes.some((n) => learnedAt.get(n.id) === today)) return 'today';
  return 'learned';
}

/* ------------------------------------------------------------------ *
 * 仪表盘用的进度汇总
 * ------------------------------------------------------------------ */

const zero = () => ({ total: 0, learned: 0, due: 0, today: 0 });
const bump = (s, st) => {
  s.total += 1;
  if (st !== 'new') s.learned += 1;
  if (st === 'due') s.due += 1;
  if (st === 'today') s.today += 1;
};

export function progress() {
  const today = todayStr();
  const weekAgo = addDays(today, -6);
  const notes = allNotes().filter((n) => !n.empty);
  const learnedAt = learnedDates();
  let week = 0;   // 近 7 天学过的考点数，用来估还要多久学完
  const groups = [];
  const todayList = [];
  const dueList = [];
  const nextList = [];
  const totals = zero();

  for (const g of GROUPS) {
    const { category } = g;
    const subjects = loadTags(g.file);
    if (!subjects) continue;
    const gs = { key: g.key, label: category, ...zero(), subjects: [] };
    // 只在「和这一类沾边」的笔记里找：数学的笔记别对到 408 的同名考点上
    const pool = notes.filter((n) => n.tags.includes(category) || n.id.startsWith(`${category}/`));
    for (const s of subjects) {
      const map = matchNotes(pool, s.points);
      const ss = { name: s.name, ...zero() };
      for (const p of s.points) {
        const own = pool.filter((n) => map.get(n.id) === p.name);
        const st = pointStatus(own, today, learnedAt);
        bump(ss, st); bump(gs, st); bump(totals, st);
        if (st !== 'new' && own.some((n) => (learnedAt.get(n.id) || '') >= weekAgo)) week += 1;
        const first = own[0];
        const ref = { name: p.name, group: g.key, subject: s.name, items: p.items, noteId: first?.id || null };
        if (st === 'today') todayList.push(ref);
        if (st === 'due') {
          const soonest = own.map((n) => n.nextReview).filter(Boolean).sort()[0] || null;
          dueList.push({ ...ref, nextReview: soonest, overdueDays: soonest ? Math.max(0, daysBetween(soonest, today)) : 0 });
        }
        if (st === 'new') nextList.push(ref);
      }
      gs.subjects.push(ss);
    }
    groups.push(gs);
  }

  // 接下来学什么：没学过的考点里真题出得最多的
  nextList.sort((a, b) => b.items - a.items);

  return {
    today,
    totals: { ...totals, unlearned: totals.total - totals.learned, week },
    groups,
    todayLearned: todayList,
    due: dueList.sort((a, b) => b.overdueDays - a.overdueDays).slice(0, 30),
    next: nextList.slice(0, 8),
  };
}
