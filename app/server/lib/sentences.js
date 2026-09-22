import { handle } from './db.js';
import { getExam } from './exams.js';
import { todayStr, addDays } from './review.js';

/**
 * 长难句卡片。
 *
 * 复习练的是「拆得开」：正面只有原句，逐层揭示主干 → 结构 → 译文，再三档评分。
 * 结构标注在第一次复习时自己做，所以新卡 annotated = 0，前端先进解析模式。
 * 一句要一两分钟，每轮最多 ROUND 句。
 */

const ROUND = 15;
const RATINGS = new Set(['again', 'hard', 'good']);
const ROLES = new Set(['main', 'clause', 'phrase', 'insert']);
const KIND_NAME = { english1: '英语一', english2: '英语二' };

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim();

function sourceOf(r) {
  if (r.source) return r.source;
  if (!r.exam_id) return '';
  const exam = getExam(r.exam_id);
  if (!exam) return r.exam_id;
  const sec = exam.sections.find((s) => s.id === r.section_id);
  return [`${exam.year} ${KIND_NAME[exam.kind] || exam.kindLabel}`, sec?.label, r.q ? `第 ${r.q} 题` : ''].filter(Boolean).join(' · ');
}

const out = (r) => {
  let spans = [];
  try { spans = JSON.parse(r.spans || '[]'); } catch { /* 坏数据当没标 */ }
  return {
    id: r.id,
    text: r.text,
    examId: r.exam_id,
    sectionId: r.section_id,
    q: r.q,
    source: sourceOf(r),
    spans,
    translation: r.translation,
    note: r.note,
    annotated: !!r.annotated,
    due: r.due,
    interval: r.interval,
    reps: r.reps,
    lapses: r.lapses,
    createdAt: r.created_at,
  };
};

const get = (id) => {
  const r = handle().prepare('SELECT * FROM sentence_cards WHERE id = ?').get(id);
  if (!r) throw bad('卡片不存在', 404);
  return r;
};

export function add({ text, examId = null, sectionId = null, q = null, source = '' }) {
  const t = normText(text);
  if (t.split(' ').length < 4) throw bad('太短了，长难句至少要几个词');
  if (t.length > 1200) throw bad('太长了，一张卡放一句就好');
  const d = handle();
  const hit = d.prepare('SELECT * FROM sentence_cards WHERE text = ?').get(t);
  if (hit) return { card: out(hit), added: false };
  const today = todayStr();
  d.prepare(`INSERT INTO sentence_cards (text, exam_id, section_id, q, source, due, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(t, examId || null, sectionId || null, Number.isInteger(q) ? q : null, String(source || '').slice(0, 120), today, today);
  return { card: out(d.prepare('SELECT * FROM sentence_cards WHERE text = ?').get(t)), added: true };
}

export function annotate(id, { spans, translation = '', note = '' }) {
  const row = get(id);
  const n = row.text.split(' ').length;
  if (!Array.isArray(spans)) throw bad('spans 应为数组');
  const clean = spans.map((s) => ({
    s: Number(s.s), e: Number(s.e), role: String(s.role), label: String(s.label || '').slice(0, 12),
  })).filter((s) => Number.isInteger(s.s) && Number.isInteger(s.e) && s.s >= 0 && s.e < n && s.s <= s.e && ROLES.has(s.role));
  if (!clean.some((s) => s.role === 'main')) throw bad('至少标出主干');
  handle().prepare('UPDATE sentence_cards SET spans = ?, translation = ?, note = ?, annotated = 1 WHERE id = ?')
    .run(JSON.stringify(clean), String(translation).slice(0, 2000), String(note).slice(0, 2000), id);
  return out(get(id));
}

/** 三档：重来明天再见；模糊小步加；通透按易度乘 */
export function rate(id, rating) {
  if (!RATINGS.has(rating)) throw bad('rating 只能是 again / hard / good');
  const r = get(id);
  const today = todayStr();
  let { interval, ease, reps, lapses } = r;
  if (rating === 'again') {
    if (reps > 0) lapses += 1;
    reps = 0; interval = 1; ease = Math.max(1.3, ease - 0.2);
  } else if (rating === 'hard') {
    interval = reps === 0 ? 1 : Math.max(interval + 1, Math.round(interval * 1.2));
    ease = Math.max(1.3, ease - 0.15); reps += 1;
  } else {
    interval = reps === 0 ? 2 : reps === 1 ? 5 : Math.round(interval * ease);
    reps += 1;
  }
  const d = handle();
  d.prepare('UPDATE sentence_cards SET due = ?, interval = ?, ease = ?, reps = ?, lapses = ? WHERE id = ?')
    .run(addDays(today, interval), interval, ease, reps, lapses, id);
  d.prepare('INSERT INTO sentence_reviews (card_id, date, at, rating, interval_after) VALUES (?, ?, ?, ?, ?)')
    .run(id, today, new Date().toISOString(), rating, interval);
  return out(get(id));
}

export function remove(id) {
  const r = handle().prepare('DELETE FROM sentence_cards WHERE id = ?').run(id);
  return { ok: r.changes > 0 };
}

/** 本轮：到期的按到期先后，最多 ROUND 句 */
export function queue() {
  const d = handle();
  const today = todayStr();
  const cards = d.prepare('SELECT * FROM sentence_cards WHERE due <= ? ORDER BY due, id LIMIT ?').all(today, ROUND).map(out);
  const c = d.prepare(`SELECT COUNT(*) total, IFNULL(SUM(due <= ?), 0) due, IFNULL(SUM(annotated = 0), 0) fresh FROM sentence_cards`).get(today);
  const reviewedToday = d.prepare('SELECT COUNT(DISTINCT card_id) c FROM sentence_reviews WHERE date = ?').get(today).c;
  return { today, round: ROUND, cards, counts: { total: c.total, due: c.due, fresh: c.fresh, reviewedToday } };
}

/** 全部卡片，新加的在前：句子列表拿来平时翻着回顾 */
export function all() {
  return { today: todayStr(), cards: handle().prepare('SELECT * FROM sentence_cards ORDER BY id DESC').all().map(out) };
}

/** [from, to] 每天复习了几句（同一句一天只算一次），Map<日期, 数量> */
export function dailyBetween(from, to) {
  return new Map(handle().prepare(
    'SELECT date, COUNT(DISTINCT card_id) c FROM sentence_reviews WHERE date BETWEEN ? AND ? GROUP BY date',
  ).all(from, to).map((r) => [r.date, r.c]));
}
