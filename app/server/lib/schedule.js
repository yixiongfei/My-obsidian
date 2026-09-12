import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { handle, getMeta, setMeta } from './db.js';
import { DEFAULT_EXAM_DATE } from '../config.js';
import { index, toAbs } from './vault.js';
import { allNotes } from './query.js';
import { todayStr, daysBetween } from './review.js';
import { holidaysInMonth, holidayOn } from './holidays.js';
import { dailyCount, dailyBetween } from './vocabulary.js';
import { statsBetween } from './exams.js';

const pad = (n) => String(n).padStart(2, '0');

/** 词汇库还没建起来时（首次启动、或用户没用过词汇功能）不该让日历跟着报错 */
const vocabDaily = (date) => {
  try { return dailyCount(date); } catch { return { done: 0, mastered: 0 }; }
};

export const examDate = () => getMeta('exam_date') || DEFAULT_EXAM_DATE;
export const setExamDate = (d) => setMeta('exam_date', d);

/* ------------------------------------------------------------------ *
 * 自定义日程：SQLite 是唯一真相
 * ------------------------------------------------------------------ */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const rowToEvent = (r) => ({ ...r, done: !!r.done });

export const listEvents = (from, to) =>
  handle().prepare('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date, rowid')
    .all(from, to).map(rowToEvent);

export function addEvent({ date, title, note = '', kind = 'plan' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('日期格式应为 YYYY-MM-DD');
  if (!String(title || '').trim()) throw bad('标题不能为空');
  const event = { id: randomUUID(), date, title: String(title).trim(), note: String(note || ''), kind, done: 0 };
  handle().prepare('INSERT INTO events (id, date, title, note, kind, done) VALUES (?, ?, ?, ?, ?, ?)')
    .run(event.id, event.date, event.title, event.note, event.kind, event.done);
  return rowToEvent(event);
}

export function patchEvent(id, patch) {
  const db = handle();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!row) throw bad('日程不存在', 404);
  const next = {
    date: patch.date ?? row.date,
    title: patch.title ?? row.title,
    note: patch.note ?? row.note,
    kind: patch.kind ?? row.kind,
    done: 'done' in patch ? (patch.done ? 1 : 0) : row.done,
  };
  db.prepare('UPDATE events SET date = ?, title = ?, note = ?, kind = ?, done = ? WHERE id = ?')
    .run(next.date, next.title, next.note, next.kind, next.done, id);
  return rowToEvent({ id, ...next });
}

export function removeEvent(id) {
  const r = handle().prepare('DELETE FROM events WHERE id = ?').run(id);
  if (!r.changes) throw bad('日程不存在', 404);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 备考路线图：实时解析 .canvas，改画布网站立刻跟着变
 * ------------------------------------------------------------------ */

const MONTH_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月/;

export async function roadmap() {
  const canvasId = [...index.canvases.keys()].find((id) => /倒计时|路线|roadmap/i.test(id))
    || [...index.canvases.keys()][0];
  if (!canvasId) return {};

  let data;
  try { data = JSON.parse(await fsp.readFile(toAbs(canvasId), 'utf8')); } catch { return {}; }

  const out = {};
  for (const node of data.nodes || []) {
    const text = node.text || '';
    const header = text.split('\n')[0] || '';
    const m = header.match(MONTH_RE);
    if (!m || !/^#{2,4}\s/.test(header)) continue;

    const key = `${m[1]}-${pad(Number(m[2]))}`;
    const tasks = [];
    const desc = [];
    let phase = '';
    for (const line of text.split('\n').slice(1)) {
      const task = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
      if (task) { tasks.push({ text: task[2].trim(), done: task[1].toLowerCase() === 'x' }); continue; }
      const bold = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (bold && !phase) { phase = bold[1].trim(); continue; }
      if (line.trim()) desc.push(line.trim());
    }

    const prev = out[key];
    out[key] = {
      month: key,
      phase: prev?.phase || phase,
      desc: [...(prev?.desc ? [prev.desc] : []), ...desc].join(' · '),
      tasks: [...(prev?.tasks || []), ...tasks],
      color: prev?.color || node.color || null,
      source: canvasId,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 年 / 月 / 日聚合，全部走 SQL
 * ------------------------------------------------------------------ */

const countsByDay = (from, to) => {
  const db = handle();
  const map = new Map();
  const bump = (date, key, n = 1) => {
    if (!map.has(date)) map.set(date, { due: 0, reviewed: 0, created: 0, events: 0 });
    map.get(date)[key] += n;
  };
  for (const r of db.prepare('SELECT next_review d, COUNT(*) c FROM notes WHERE reviewable = 1 AND next_review BETWEEN ? AND ? GROUP BY d').all(from, to)) bump(r.d, 'due', r.c);
  for (const r of db.prepare('SELECT date d, COUNT(*) c FROM reviews WHERE date BETWEEN ? AND ? GROUP BY d').all(from, to)) bump(r.d, 'reviewed', r.c);
  for (const r of db.prepare('SELECT created d, COUNT(*) c FROM notes WHERE created BETWEEN ? AND ? GROUP BY d').all(from, to)) bump(r.d, 'created', r.c);
  for (const r of db.prepare('SELECT date d, COUNT(*) c FROM events WHERE date BETWEEN ? AND ? GROUP BY d').all(from, to)) bump(r.d, 'events', r.c);
  return map;
};

/** 年表：12 张月卡片 */
export async function yearView(year) {
  const plan = await roadmap();
  const today = todayStr();
  const db = handle();

  const agg = (key, table, col) =>
    new Map(db.prepare(
      `SELECT substr(${col}, 1, 7) m, COUNT(*) c FROM ${table} WHERE ${col} LIKE ? GROUP BY m`,
    ).all(`${year}-%`).map((r) => [r.m, r.c]));

  const due = agg('due', 'notes', 'next_review');
  const reviewed = agg('reviewed', 'reviews', 'date');
  const created = agg('created', 'notes', 'created');
  const events = agg('events', 'events', 'date');

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    months.push({
      month: key,
      index: m,
      due: due.get(key) || 0,
      reviewed: reviewed.get(key) || 0,
      created: created.get(key) || 0,
      events: events.get(key) || 0,
      milestone: plan[key] || null,
      isCurrent: today.slice(0, 7) === key,
      isPast: key < today.slice(0, 7),
    });
  }

  const years = new Set([Number(year), Number(today.slice(0, 4))]);
  for (const key of Object.keys(plan)) years.add(Number(key.slice(0, 4)));

  const exam = examDate();
  return {
    year: Number(year),
    months,
    years: [...years].sort((a, b) => a - b),
    examDate: exam,
    daysToExam: daysBetween(today, exam),
    totals: {
      notes: db.prepare('SELECT COUNT(*) c FROM notes').get().c,
      reviews: db.prepare('SELECT COUNT(*) c FROM reviews').get().c,
    },
  };
}

/** 月表：日历格子 */
export async function monthView(monthKey) {
  const plan = await roadmap();
  const today = todayStr();
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const from = `${monthKey}-01`, to = `${monthKey}-${pad(daysInMonth)}`;
  const counts = countsByDay(from, to);
  const exams = examsSafe(from, to);
  let words = new Map();
  try { words = dailyBetween(from, to); } catch { /* 词库不可用就当没背 */ }

  const jp = holidaysInMonth(y, m);
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const c = counts.get(date) || { due: 0, reviewed: 0, created: 0, events: 0 };
    const weekday = new Date(y, m - 1, d).getDay();
    const wordsDone = words.get(date) || 0;
    const examsDone = exams.byDate?.[date] || 0;
    days.push({
      date, day: d, weekday,
      ...c,
      words: wordsDone,
      exams: examsDone,
      // 这一天有没有"学过"：复习了笔记、新建了笔记、背了词、做了题，任一即算
      active: c.reviewed > 0 || c.created > 0 || wordsDone > 0 || examsDone > 0,
      holiday: jp.get(d) || null,
      isWeekend: weekday === 0 || weekday === 6,
      isToday: date === today,
      isPast: date < today,
    });
  }

  return {
    month: monthKey,
    year: y,
    // 周日为一周之首，和日本日历一致（日 月 火 水 木 金 土）
    leadingBlanks: new Date(y, m - 1, 1).getDay(),
    days,
    holidays: [...jp.entries()].map(([d, name]) => ({ day: d, name })).sort((a, b) => a.day - b.day),
    milestone: plan[monthKey] || null,
    examDate: examDate(),
    // 本月做过的真题题数，按学科分（英语 / 数学 / 408 四门）
    exams,
  };
}

/** 真题数据没抓、或 JSON 坏了都不该让日历报错 */
function examsSafe(from, to) {
  try { return statsBetween(from, to); } catch { return { total: 0, bySubject: {}, byDate: {} }; }
}

/** 日表：当天全部安排 */
export function dayView(date) {
  const db = handle();
  const today = todayStr();
  const notes = new Map(allNotes().map((n) => [n.id, n]));

  const pick = (ids) => ids.map((r) => notes.get(r.id)).filter(Boolean);

  const due = pick(db.prepare('SELECT id FROM notes WHERE reviewable = 1 AND next_review = ? ORDER BY id').all(date));
  const created = pick(db.prepare('SELECT id FROM notes WHERE created = ? ORDER BY id').all(date));

  const reviewed = db.prepare(`
    SELECT r.date, r.note_id AS note_path, r.review_count_after, r.added_content, r.source,
           IFNULL(n.title, r.note_id) AS title
    FROM reviews r LEFT JOIN notes n ON n.id = r.note_id
    WHERE r.date = ? ORDER BY r.id`).all(date);

  // 今天要看的不只是当天到期的，还有之前欠下的
  const overdue = date === today
    ? pick(db.prepare('SELECT id FROM notes WHERE reviewable = 1 AND next_review IS NOT NULL AND next_review < ? ORDER BY next_review').all(today))
      .map((n) => ({ ...n, status: 'due', overdueDays: -daysBetween(today, n.nextReview) }))
    : [];

  const [y, m, d] = date.split('-').map(Number);
  const exam = examDate();
  /* 词汇完成数从 vocabulary.db 现算，不往 index.db 里复制一份：
     两处存同一个数，迟早会对不上 */
  const vocabReviewed = vocabDaily(date);
  return {
    date,
    due, created, reviewed, overdue, vocabReviewed,
    events: listEvents(date, date),
    isToday: date === today,
    weekday: new Date(y, m - 1, d).getDay(),
    holiday: holidayOn(date),
    examDate: exam,
    daysToExam: daysBetween(date, exam),
  };
}
