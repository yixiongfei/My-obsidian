#!/usr/bin/env node
/**
 * 把一门 B 站课程的选集按天排进日程（events 表，kind = study）。
 *
 * 用法：
 *   node scripts/plan-course.mjs --bv BV1CAxaeHEeH --from 29 --to 103 --start 2026-09-14 --label 高数
 *   node scripts/plan-course.mjs --bv ... --dry          # 只打印，不写库
 *   node scripts/plan-course.mjs --bv ... --clear        # 先删掉这门课之前生成的日程再排
 *
 * 规则（按你的作息）：
 *   工作日 20:00–23:00，3 小时；周末 / 祝日 / 标了「休假」的日子 10:00–23:00，
 *   其中 12:30–14:00、18:00–19:00 留出来吃饭，其余最多 --rest-min（默认 360）分钟。
 *   每集按时长向上取整到半小时（≤30 → 30，≤60 → 60，…），取整多出来的就是记笔记的时间。
 *   一集不拆开跨天；标题带【黑板】【补充】的是重讲版，默认跳过（--all 不跳）。
 *   选集信息从 api.bilibili.com/x/player/pagelist 拿，每条日程的 note 里存 plan:<BV>:<集号>，重排时靠它清理。
 */

import { handle } from '../server/lib/db.js';
import { addEvent } from '../server/lib/schedule.js';
import { holidayOn } from '../server/lib/holidays.js';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : [])).filter((x) => x.length));
const BV = args.bv;
if (!BV) { console.error('缺 --bv'); process.exit(1); }
const FROM = Number(args.from) || 1;
const TO = Number(args.to) || 9999;
const LABEL = args.label || '课程';
const START = args.start || todayStr();
const WEEKDAY_MIN = Number(args['weekday-min']) || 180;
const REST_MIN = Number(args['rest-min']) || 360;
const DRY = !!args.dry;
const CLEAR = !!args.clear;
const ALL = !!args.all;

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d + n); return todayStr(dt); };
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${BV}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const json = await res.json();
if (json.code !== 0) { console.error('拿不到选集：', json.message); process.exit(1); }
const episodes = json.data
  .filter((p) => p.page >= FROM && p.page <= TO)
  .filter((p) => ALL || !/^【(黑板|补充)】/.test(p.part))
  .map((p) => ({ page: p.page, title: p.part.trim(), minutes: Math.round(p.duration / 60), block: Math.max(30, Math.ceil(p.duration / 60 / 30) * 30) }));
console.log(`${LABEL}：${episodes.length} 集，视频共 ${episodes.reduce((s, e) => s + e.minutes, 0)} 分钟，排课按 ${episodes.reduce((s, e) => s + e.block, 0)} 分钟算`);

const db = handle();
const vacation = new Set(db.prepare("SELECT date FROM events WHERE title LIKE '%休假%'").all().map((r) => r.date));
const isRest = (date) => { const wd = new Date(date).getDay(); return wd === 0 || wd === 6 || !!holidayOn(date) || vacation.has(date); };

/** 一天可用的时间段（分钟计，从 0:00 起） */
function slotsOf(date) {
  if (isRest(date)) return { cap: REST_MIN, ranges: [[10 * 60, 12 * 60 + 30], [14 * 60, 18 * 60], [19 * 60, 23 * 60]] };
  return { cap: WEEKDAY_MIN, ranges: [[20 * 60, 23 * 60]] };
}

// 逐天填：一集不拆；放不下就换下一天
const plan = [];
let date = START;
let day = slotsOf(date);
let used = 0;
let ri = 0;                      // 当前时段
let cursor = day.ranges[0][0];   // 当前时段里的游标
const nextDay = () => { date = addDays(date, 1); day = slotsOf(date); used = 0; ri = 0; cursor = day.ranges[0][0]; };
for (const ep of episodes) {
  for (let guard = 0; guard < 400; guard += 1) {
    if (used + ep.block <= day.cap) {
      // 在时段里找放得下的位置
      while (ri < day.ranges.length && cursor + ep.block > day.ranges[ri][1]) { ri += 1; cursor = day.ranges[ri]?.[0] ?? 0; }
      if (ri < day.ranges.length) break;
    }
    nextDay();
  }
  plan.push({ ...ep, date, start: hm(cursor), end: hm(cursor + ep.block) });
  cursor += ep.block;
  used += ep.block;
}

const byDate = new Map();
for (const p of plan) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); }
for (const [d, list] of byDate) {
  console.log(`\n${d} ${isRest(d) ? '（休息日）' : ''}`);
  for (const p of list) console.log(`  ${p.start}–${p.end}  p${p.page} ${p.title}（${p.minutes}m）`);
}
console.log(`\n共 ${byDate.size} 天，${plan[0].date} → ${plan[plan.length - 1].date}`);

if (DRY) process.exit(0);
if (CLEAR) {
  const n = db.prepare("DELETE FROM events WHERE kind = 'study' AND note LIKE ?").run(`plan:${BV}:%`).changes;
  console.log(`清掉之前生成的 ${n} 条`);
}
let added = 0;
for (const p of plan) {
  const exists = db.prepare("SELECT 1 FROM events WHERE note LIKE ?").get(`plan:${BV}:${p.page}%`);
  if (exists) continue;
  addEvent({
    date: p.date,
    title: `${LABEL} p${p.page} ${p.title}`,
    note: `plan:${BV}:${p.page} · ${p.start}–${p.end} · 视频 ${p.minutes} 分钟，按 ${p.block} 分钟排 · https://www.bilibili.com/video/${BV}/?p=${p.page}`,
    kind: 'study',
  });
  added += 1;
}
console.log(`写入 ${added} 条日程`);
