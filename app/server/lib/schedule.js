import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SCHEDULE_FILE, DEFAULT_EXAM_DATE, VAULT_ROOT } from '../config.js';
import { index, toAbs } from './vault.js';
import { readLog, todayStr, daysBetween } from './review.js';

const ym = (date) => date.slice(0, 7);
const pad = (n) => String(n).padStart(2, '0');

/* ------------------------------------------------------------------ *
 * schedule.json：自定义日程 + 关键日期
 * ------------------------------------------------------------------ */

const EMPTY = { examDate: DEFAULT_EXAM_DATE, startDate: null, events: [] };

export async function loadSchedule() {
  try {
    const parsed = JSON.parse(await fsp.readFile(SCHEDULE_FILE, 'utf8'));
    return {
      examDate: parsed.examDate || DEFAULT_EXAM_DATE,
      startDate: parsed.startDate || null,
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch {
    return { ...EMPTY, events: [] };
  }
}

export async function saveSchedule(data) {
  await fsp.writeFile(SCHEDULE_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

export async function addEvent({ date, title, note = '', kind = 'plan' }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw Object.assign(new Error('日期格式应为 YYYY-MM-DD'), { status: 400 });
  if (!String(title || '').trim()) throw Object.assign(new Error('标题不能为空'), { status: 400 });
  const data = await loadSchedule();
  const event = { id: randomUUID(), date, title: String(title).trim(), note: String(note || ''), kind, done: false };
  data.events.push(event);
  await saveSchedule(data);
  return event;
}

export async function patchEvent(id, patch) {
  const data = await loadSchedule();
  const event = data.events.find((e) => e.id === id);
  if (!event) throw Object.assign(new Error('日程不存在'), { status: 404 });
  for (const key of ['date', 'title', 'note', 'done', 'kind']) {
    if (key in patch) event[key] = patch[key];
  }
  await saveSchedule(data);
  return event;
}

export async function removeEvent(id) {
  const data = await loadSchedule();
  const before = data.events.length;
  data.events = data.events.filter((e) => e.id !== id);
  if (data.events.length === before) throw Object.assign(new Error('日程不存在'), { status: 404 });
  await saveSchedule(data);
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
    const lines = text.split('\n').slice(1);
    const tasks = [];
    const desc = [];
    let phase = '';
    for (const line of lines) {
      const task = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
      if (task) { tasks.push({ text: task[2].trim(), done: task[1].toLowerCase() === 'x' }); continue; }
      const bold = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
      if (bold && !phase) { phase = bold[1].trim(); continue; }
      if (line.trim()) desc.push(line.trim());
    }
    // 同一个月可能有多个节点（正式路线 + 复试规划），合并
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
 * 按天聚合：待复习 / 已复习 / 新建 / 自定义日程
 * ------------------------------------------------------------------ */

async function aggregate() {
  const [log, schedule, plan] = await Promise.all([readLog(), loadSchedule(), roadmap()]);
  const notes = index.allMeta();

  const byDay = new Map();
  const day = (d) => {
    if (!byDay.has(d)) byDay.set(d, { date: d, due: [], reviewed: [], created: [], events: [] });
    return byDay.get(d);
  };

  for (const n of notes) {
    if (n.nextReview) day(n.nextReview).due.push(n);
    if (n.created) day(n.created).created.push(n);
  }
  for (const e of log) {
    if (!e.date) continue;
    const note = index.get(e.note_path);
    day(e.date).reviewed.push({ ...e, title: note?.title || e.note_path });
  }
  for (const e of schedule.events) day(e.date).events.push(e);

  return { byDay, schedule, plan, notes, log };
}

/** 年表：12 张月卡片 */
export async function yearView(year) {
  const { byDay, plan, notes, log, schedule } = await aggregate();
  const today = todayStr();

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    let due = 0, reviewed = 0, created = 0, events = 0;
    for (const [date, d] of byDay) {
      if (ym(date) !== key) continue;
      due += d.due.length; reviewed += d.reviewed.length; created += d.created.length; events += d.events.length;
    }
    months.push({
      month: key, index: m, due, reviewed, created, events,
      milestone: plan[key] || null,
      isCurrent: ym(today) === key,
      isPast: key < ym(today),
    });
  }

  const years = new Set([Number(year), Number(today.slice(0, 4))]);
  for (const key of Object.keys(plan)) years.add(Number(key.slice(0, 4)));

  return {
    year: Number(year),
    months,
    years: [...years].sort((a, b) => a - b),
    examDate: schedule.examDate,
    daysToExam: daysBetween(today, schedule.examDate),
    totals: { notes: notes.length, reviews: log.length },
  };
}

/** 月表：日历格子 */
export async function monthView(monthKey) {
  const { byDay, plan, schedule } = await aggregate();
  const today = todayStr();
  const [y, m] = monthKey.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();

  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const bucket = byDay.get(date);
    days.push({
      date, day: d,
      weekday: new Date(y, m - 1, d).getDay(),
      due: bucket?.due.length || 0,
      reviewed: bucket?.reviewed.length || 0,
      created: bucket?.created.length || 0,
      events: bucket?.events.length || 0,
      isToday: date === today,
      isPast: date < today,
    });
  }

  return {
    month: monthKey,
    year: y,
    // 周一为一周之首：把周日(0)排到第 7 位
    leadingBlanks: (first.getDay() + 6) % 7,
    days,
    milestone: plan[monthKey] || null,
    examDate: schedule.examDate,
  };
}

/** 日表：当天全部安排 */
export async function dayView(date) {
  const { byDay, schedule } = await aggregate();
  const bucket = byDay.get(date) || { date, due: [], reviewed: [], created: [], events: [] };
  const today = todayStr();
  return {
    ...bucket,
    // 今天要看的不只是当天到期的，还有之前欠下的
    overdue: date === today
      ? index.allMeta().filter((n) => n.nextReview && n.nextReview < today).map((n) => ({ ...n, overdueDays: -daysBetween(today, n.nextReview) }))
      : [],
    isToday: date === today,
    weekday: new Date(...date.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))).getDay(),
    examDate: schedule.examDate,
    daysToExam: daysBetween(date, schedule.examDate),
  };
}

export { VAULT_ROOT };
