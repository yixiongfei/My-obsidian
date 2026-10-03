import { handle, getMeta, setMeta } from './db.js';
import { todayStr, addDays } from './review.js';

/**
 * 学习时长：前端按「页面开着、窗口在前台、人在动」计秒，每半分钟交一次，这里按天、按类别累加。
 *
 *   exam     做题（专题训练、整卷、全屏阅读）
 *   words    背单词
 *   reading  阅读卡片（长难句、生词短文）
 *   notes    看笔记、复习笔记
 *   assistant 和学习助手讨论
 *   focus    番茄钟专注、但人不在上面这些页面（在纸上做题、看书）——专注期间不看窗口在不在前台
 *
 * 只记从开始计时那天起的真实时长；之前的日子没有数，就显示「没记录」，不拿学习量去估。
 */

export const KINDS = ['exam', 'notes', 'assistant', 'reading', 'words', 'focus'];

function ensureTable() {
  handle().exec(`
    CREATE TABLE IF NOT EXISTS study_time (
      date    TEXT NOT NULL,
      kind    TEXT NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, kind)
    )`);
}
let ready = false;
const db = () => { if (!ready) { ensureTable(); ready = true; } return handle(); };

/** 加一段时长。单次最多 10 分钟——前端半分钟交一次，再大就是时钟出错或重复提交 */
export function add(kind, seconds) {
  const k = String(kind);
  const s = Math.round(Number(seconds));
  if (!KINDS.includes(k) || !Number.isFinite(s) || s <= 0) return false;
  const today = todayStr();
  db().prepare(`INSERT INTO study_time (date, kind, seconds) VALUES (?, ?, ?)
                ON CONFLICT(date, kind) DO UPDATE SET seconds = seconds + excluded.seconds`)
    .run(today, k, Math.min(s, 600));
  if (!getMeta('studytime:since')) setMeta('studytime:since', today);
  return true;
}

/** [from, to] 每天的时长：[{ date, total, byKind: { exam: 秒, … } }]，没记录的日子 total 为 0 */
export function byDay(from, to) {
  const rows = db().prepare('SELECT date, kind, seconds FROM study_time WHERE date BETWEEN ? AND ?').all(from, to);
  const map = new Map();
  for (const r of rows) {
    const d = map.get(r.date) || { date: r.date, total: 0, byKind: {} };
    d.byKind[r.kind] = (d.byKind[r.kind] || 0) + r.seconds;
    d.total += r.seconds;
    map.set(r.date, d);
  }
  const out = [];
  for (let date = from; date <= to; date = addDays(date, 1)) out.push(map.get(date) || { date, total: 0, byKind: {} });
  return out;
}

/** 仪表盘用：近 days 天（含今天）+ 从哪天开始计时 */
export function summary(days = 35) {
  const today = todayStr();
  return { since: getMeta('studytime:since') || null, days: byDay(addDays(today, -(days - 1)), today) };
}

/* ── 每日目标：学习时间（分钟）、背单词（个）、做题（道）。存在 meta，换电脑跟着库走 ── */
const GOAL_DEFAULT = { minutes: 120, words: 50, exams: 10 };
const GOAL_RANGE = { minutes: [10, 900], words: [5, 500], exams: [1, 200] };

export function goals() {
  const out = {};
  for (const [k, d] of Object.entries(GOAL_DEFAULT)) out[k] = Number(getMeta(`goal:${k}`)) || d;
  return out;
}

export function setGoals(input = {}) {
  for (const [k, [lo, hi]] of Object.entries(GOAL_RANGE)) {
    if (input[k] == null) continue;
    const v = Math.round(Number(input[k]));
    if (Number.isFinite(v)) setMeta(`goal:${k}`, String(Math.max(lo, Math.min(hi, v))));
  }
  return goals();
}
