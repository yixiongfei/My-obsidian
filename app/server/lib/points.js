import fs from 'node:fs';
import path from 'node:path';
import { KB_DIR } from '../config.js';
import { handle } from './db.js';
import { allNotes } from './query.js';
import { todayStr, daysBetween, addDays } from './review.js';
import { questionResults } from './exams.js';

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

const EXAMS_DIR = path.join(KB_DIR, 'exams');
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
      points: (s.tags || []).map((t) => ({ name: String(t.name), items: (t.items || []).length, list: t.items || [] })),
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

/**
 * 错题本 → 考点：错题本里每道题带 <!-- kb:q:<卷子id>:<单元>:<题号> --> 标记，
 * 卷子 id 是 <kind>-<year>，和标签清单里的 items {kind, year, n} 对得上。
 * 返回 Map<"kind-year-n", 错题本笔记 id[]>，考点层拿它数"这个考点错过几题、记在哪篇"。
 */
export function wrongIndex(notes) {
  const map = new Map();
  for (const n of notes) {
    if (n.kind !== 'wrong') continue;
    const body = handle().prepare('SELECT body FROM notes WHERE id = ?').get(n.id)?.body || '';
    for (const m of body.matchAll(/<!--\s*kb:q:([a-z0-9]+)-(\d{4}):[^:]+:(\d+)\s*-->/g)) {
      const key = `${m[1]}-${m[2]}-${m[3]}`;
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(n.id)) map.get(key).push(n.id);
    }
  }
  return map;
}

/** 某考点在错题本里出现的题：{ count, notes: id[] } */
export function wrongOf(point, index) {
  const notes = new Set();
  let count = 0;
  for (const it of point.list || []) {
    const hit = index.get(`${it.kind}-${it.year}-${it.n}`);
    if (hit) { count += 1; hit.forEach((id) => notes.add(id)); }
  }
  return { count, notes: [...notes] };
}

/** 一个考点的状态：today（今天学的）> due（要复习）> learned > new */
export function pointStatus(notes, today, learnedAt) {
  if (!notes.length) return 'new';
  if (notes.some((n) => n.reviewable !== false && n.nextReview && daysBetween(today, n.nextReview) <= 0)) return 'due';
  if (notes.some((n) => learnedAt.get(n.id) === today)) return 'today';
  return 'learned';
}

/* ------------------------------------------------------------------ *
 * 一轮复习的阶段
 *
 *   0 概念   什么都还没有
 *   1 做题   做过带这个标签的真题，或写了真题笔记（考研真题/ 目录）
 *   2 理解   有知识点笔记
 *   3 复习   知识点笔记复习过 ≥ 1 次
 *   4 总结   阅读页点了「总结完成」（frontmatter stage: 总结）
 * 二轮：总结之后再做这个考点的题，做错的进薄弱名单。
 * 每个阶段第一次达到的日期都记下来，日历按天列「考点推进」。
 * ------------------------------------------------------------------ */

export const STAGE_NAMES = ['概念', '做题', '理解', '复习', '总结'];

/** 全部考点的阶段明细 + 阶段变更事件 */
export function stages() {
  const today = todayStr();
  const all = allNotes().filter((n) => !n.empty);
  const first = new Map(handle().prepare('SELECT note_id, MIN(date) AS d FROM reviews GROUP BY note_id').all().map((r) => [r.note_id, r.d]));
  let results = [];
  try { results = questionResults(); } catch { /* 真题没抓也能算 */ }
  const byQ = new Map();
  for (const r of results) {
    const key = `${r.kind}-${r.year}-${r.n}`;
    if (!byQ.has(key)) byQ.set(key, []);
    byQ.get(key).push(r);
  }

  const points = [];
  const events = [];
  for (const g of GROUPS) {
    const subjects = loadTags(g.file);
    if (!subjects) continue;
    const pool = all.filter((n) => n.tags.includes(g.category) || n.id.startsWith(`${g.category}/`));
    const pointNotes = pool.filter((n) => n.kind === 'point');
    const examNotes = pool.filter((n) => n.kind === 'exam');
    for (const s of subjects) {
      const mapP = matchNotes(pointNotes, s.points);
      const mapE = matchNotes(examNotes, s.points);
      for (const p of s.points) {
        const own = pointNotes.filter((n) => mapP.get(n.id) === p.name);
        const ex = examNotes.filter((n) => mapE.get(n.id) === p.name);
        const qs = (p.list || []).flatMap((it) => byQ.get(`${it.kind}-${it.year}-${it.n}`) || []);
        const dates = [];
        // 1 做题
        const d1 = [...qs.map((q) => q.date), ...ex.map((n) => n.created)].filter(Boolean).sort()[0] || null;
        // 2 理解
        const d2 = own.map((n) => n.created).filter(Boolean).sort()[0] || null;
        // 3 复习：复习记录表按路径存，笔记挪过目录会对不上，所以 frontmatter 的 last_reviewed 也算
        const d3 = own.flatMap((n) => [first.get(n.id), n.reviewCount > 0 ? n.lastReviewed : null]).filter(Boolean).sort()[0] || null;
        // 4 总结
        const sums = own.map((n) => n.summarized).filter(Boolean);
        const d4 = sums.length ? (sums.filter((x) => x !== 'yes').sort()[0] || d2 || today) : null;
        const stage = d4 ? 4 : d3 ? 3 : (own.length ? 2 : (d1 || ex.length || qs.length) ? 1 : 0);
        dates.push(null, d1, d2, d3, d4);
        const wrong = qs.filter((q) => q.correct === false);
        const wrongAfter = d4 ? wrong.filter((q) => q.date > d4) : [];
        const rec = {
          name: p.name, subject: s.name, group: g.key, items: p.items, stage, dates,
          noteId: own[0]?.id || ex[0]?.id || null,
          attempted: qs.length, wrong: wrong.length, wrongAfter: wrongAfter.length,
          correct: qs.filter((q) => q.correct === true).length,
        };
        points.push(rec);
        for (let k = 1; k <= stage; k += 1) if (dates[k]) events.push({ date: dates[k], stage: k, name: p.name, subject: s.name, group: g.key, noteId: rec.noteId });
      }
    }
  }
  events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { points, events };
}

/** 仪表盘：各科五段分布 + 薄弱考点 */
export function stageSummary() {
  const { points, events } = stages();
  const groups = [];
  for (const g of GROUPS) {
    const mine = points.filter((p) => p.group === g.key);
    if (!mine.length) continue;
    const count = (list) => STAGE_NAMES.map((_, k) => list.filter((p) => p.stage === k).length);
    const subjects = [...new Set(mine.map((p) => p.subject))].map((name) => ({ name, counts: count(mine.filter((p) => p.subject === name)), total: mine.filter((p) => p.subject === name).length }));
    groups.push({ key: g.key, label: g.category, counts: count(mine), total: mine.length, subjects });
  }
  const weak = points.filter((p) => p.wrong > 0)
    .sort((a, b) => (b.wrongAfter - a.wrongAfter) || (b.wrong - a.wrong) || (b.items - a.items))
    .slice(0, 12);
  const today = todayStr();
  return {
    names: STAGE_NAMES,
    groups,
    weak,
    todayEvents: events.filter((e) => e.date === today),
    recent: events.slice(0, 20),
  };
}

/** 日历：某区间每天推进了几个考点，Map<日期, 事件[]> */
export function eventsBetween(from, to) {
  const map = new Map();
  for (const e of stages().events) {
    if (e.date < from || e.date > to) continue;
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date).push(e);
  }
  return map;
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
  // 只有知识点笔记算"学过"：错题本、日志不是对考点的理解
  const notes = allNotes().filter((n) => !n.empty && n.kind === 'point');
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
