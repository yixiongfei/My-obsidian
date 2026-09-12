import fs from 'node:fs';
import path from 'node:path';
import { KB_DIR } from '../config.js';
import { handle } from './db.js';

/**
 * 真题：题面来自 .kb/exams/*.json（由 scripts/import-exams.mjs 抓取生成），
 * 作答与得分记在 SQLite 的 exam_attempts 表。
 *
 * 答案只在交卷之后才发给前端——API 是唯一把关口，前端拿不到没交卷单元的
 * 答案和解析，开 DevTools 也偷看不到。这一页要模拟真卷：做完一整块再对答案。
 *
 * 单元类型：
 *   choice  选择题（英语完形 / 阅读、408 按科目、数学）   answers {"1":"C"}
 *   match   英语新题型，字母答题卡                          answers {"41":"E"}
 *   fill    数学填空题，六个短答                            answers {"11":"…"}
 *   free    翻译 / 作文 / 解答题，一个长答                   answers {"text":"…"}
 */

export const EXAMS_DIR = path.join(KB_DIR, 'exams');
export const EXAMS_IMG_DIR = path.join(EXAMS_DIR, 'img');
const INDEX_FILE = path.join(EXAMS_DIR, 'index.json');

/* ------------------------------------------------------------------ *
 * 加载：清单常驻，卷子按需读、只留最近几份（数学卷带 KaTeX 一份就一兆多）
 * ------------------------------------------------------------------ */

const MAX_CACHED = 8;
const cache = new Map(); // id -> { mtime, exam }
let indexCache = { mtime: -1, data: null };

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

export function getExam(id) {
  if (!/^[a-z0-9]+-\d{4}$/i.test(id)) return null;
  const abs = path.join(EXAMS_DIR, `${id}.json`);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const hit = cache.get(id);
  if (hit && hit.mtime === st.mtimeMs) {
    cache.delete(id); cache.set(id, hit); // 挪到最近
    return hit.exam;
  }
  const exam = readJson(abs);
  cache.set(id, { mtime: st.mtimeMs, exam });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return exam;
}

/** 清单：优先读 index.json；没有就扫目录（只在导入脚本没跑完时会走到） */
function manifest() {
  let st = null;
  try { st = fs.statSync(INDEX_FILE); } catch { /* 没有清单 */ }
  if (st && indexCache.mtime === st.mtimeMs) return indexCache.data;
  let data;
  if (st) {
    data = readJson(INDEX_FILE);
  } else {
    let files = [];
    try { files = fs.readdirSync(EXAMS_DIR).filter((f) => /^[a-z0-9]+-\d{4}\.json$/i.test(f)); } catch { /* 目录不存在 */ }
    data = { exams: [], tags: {} };
    for (const f of files) {
      try {
        const e = readJson(path.join(EXAMS_DIR, f));
        data.exams.push({
          id: e.id, kind: e.kind, kindLabel: e.kindLabel, group: e.group, year: e.year, title: e.title,
          units: e.sections.length,
          objectiveTotal: e.sections.filter((x) => x.type === 'choice' || (x.type === 'match' && x.answers)).reduce((s, x) => s + x.points, 0),
          total: e.sections.reduce((s, x) => s + (x.points || 0), 0),
        });
      } catch { /* 坏文件跳过 */ }
    }
  }
  indexCache = { mtime: st ? st.mtimeMs : -1, data };
  return data;
}

export function getTags(group) {
  if (!/^[a-z0-9]+$/i.test(group)) return null;
  const abs = path.join(EXAMS_DIR, `tags-${group}.json`);
  if (!fs.existsSync(abs)) return null;
  const tags = readJson(abs);
  // 标出哪些题本地已经有卷子，前端只给能跳的加链接
  const have = new Set(manifest().exams.map((e) => e.id));
  for (const s of tags.subjects) for (const t of s.tags) for (const it of t.items) it.exam = `${it.kind}-${it.year}`;
  tags.available = [...have].filter((id) => tags.subjects.some((s) => s.tags.some((t) => t.items.some((it) => it.exam === id))));
  return tags;
}

/* ------------------------------------------------------------------ *
 * 作答记录
 * ------------------------------------------------------------------ */

const rowToAttempt = (r) => (r ? {
  answers: JSON.parse(r.answers || '{}'),
  submittedAt: r.submitted_at,
  score: r.score,
  total: r.total,
  updatedAt: r.updated_at,
} : null);

export function attemptsOf(examId) {
  const rows = handle().prepare('SELECT * FROM exam_attempts WHERE exam_id = ?').all(examId);
  const out = {};
  for (const r of rows) out[r.section_id] = rowToAttempt(r);
  return out;
}

function attemptOf(examId, sectionId) {
  return rowToAttempt(handle().prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND section_id = ?').get(examId, sectionId));
}

/** 只允许存字母 / 文本，别的什么都不落库 */
function normalizeAnswers(section, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (section.type === 'free') {
    out.text = String(raw.text ?? '').slice(0, 20000);
    return out;
  }
  if (section.type === 'fill') {
    for (const q of section.questions) {
      const v = String(raw[q.n] ?? raw[String(q.n)] ?? '').slice(0, 2000);
      if (v.trim()) out[q.n] = v;
    }
    return out;
  }
  const letters = section.type === 'match'
    ? new Set(section.letters || [])
    : new Set(['A', 'B', 'C', 'D']);
  const numbers = section.type === 'match'
    ? section.numbers
    : section.questions.map((q) => q.n);
  for (const n of numbers) {
    const v = String(raw[n] ?? raw[String(n)] ?? '').trim().toUpperCase();
    if (letters.has(v)) out[n] = v;
  }
  return out;
}

export function saveDraft(examId, sectionId, rawAnswers) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw Object.assign(new Error('单元不存在'), { status: 404 });
  const cur = attemptOf(examId, sectionId);
  if (cur?.submittedAt) throw Object.assign(new Error('已交卷，不能再改；要重做先重置'), { status: 409 });
  const answers = normalizeAnswers(section, rawAnswers);
  const now = new Date().toISOString();
  handle().prepare(`
    INSERT INTO exam_attempts (exam_id, section_id, answers, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(exam_id, section_id) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`)
    .run(examId, sectionId, JSON.stringify(answers), now);
  return { answers, submittedAt: null, score: null, total: null, updatedAt: now };
}

/* ------------------------------------------------------------------ *
 * 判分
 * ------------------------------------------------------------------ */

function grade(section, answers) {
  if (section.type === 'choice') {
    const per = section.points / section.questions.length;
    let hit = 0;
    for (const q of section.questions) if (answers[q.n] === q.answer) hit += 1;
    return { score: Math.round(hit * per * 100) / 100, total: section.points, hit, count: section.questions.length };
  }
  if (section.type === 'match') {
    if (!section.answers) return { score: null, total: section.points, hit: null, count: section.numbers.length };
    const per = section.points / section.numbers.length;
    let hit = 0;
    section.numbers.forEach((n, i) => { if (answers[n] === section.answers[i]) hit += 1; });
    return { score: Math.round(hit * per * 100) / 100, total: section.points, hit, count: section.numbers.length };
  }
  // 填空 / 翻译 / 作文 / 解答题没法机器判分，只记「已完成」
  return { score: null, total: section.points, hit: null, count: section.questions?.length || 1 };
}

export function submit(examId, sectionId, rawAnswers) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw Object.assign(new Error('单元不存在'), { status: 404 });
  const cur = attemptOf(examId, sectionId);
  if (cur?.submittedAt) throw Object.assign(new Error('这一单元已经交过卷'), { status: 409 });
  const answers = normalizeAnswers(section, rawAnswers ?? cur?.answers ?? {});
  const g = grade(section, answers);
  const now = new Date().toISOString();
  handle().prepare(`
    INSERT INTO exam_attempts (exam_id, section_id, answers, submitted_at, score, total, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(exam_id, section_id) DO UPDATE SET
      answers = excluded.answers, submitted_at = excluded.submitted_at,
      score = excluded.score, total = excluded.total, updated_at = excluded.updated_at`)
    .run(examId, sectionId, JSON.stringify(answers), now, g.score, g.total, now);
  return {
    attempt: { answers, submittedAt: now, score: g.score, total: g.total, updatedAt: now },
    key: keyOf(section),
  };
}

export function reset(examId, sectionId) {
  const r = handle().prepare('DELETE FROM exam_attempts WHERE exam_id = ? AND section_id = ?').run(examId, sectionId);
  return { ok: true, removed: r.changes };
}

/* ------------------------------------------------------------------ *
 * 对外视图：交卷前剥掉答案、解析、标签（标签也算提示）
 * ------------------------------------------------------------------ */

/** 一个单元的「答案包」：交卷后才发 */
function keyOf(section) {
  if (section.type === 'choice') {
    return {
      answers: Object.fromEntries(section.questions.map((q) => [q.n, q.answer])),
      explanations: Object.fromEntries(section.questions.map((q) => [q.n, q.explanation])),
      tags: Object.fromEntries(section.questions.map((q) => [q.n, q.tags || []])),
      extras: section.extras || [],
    };
  }
  if (section.type === 'match') return { answers: section.answers, solution: section.solution };
  if (section.type === 'fill') {
    return {
      solutions: Object.fromEntries(section.questions.map((q) => [q.n, q.solution])),
      tags: Object.fromEntries(section.questions.map((q) => [q.n, q.tags || []])),
    };
  }
  return { solution: section.solution, tags: section.tags || [] };
}

function publicSection(section, attempt) {
  const s = { ...section };
  delete s.extras;
  delete s.tags;
  if (section.type === 'choice') {
    s.questions = section.questions.map(({ answer, explanation, tags, ...q }) => q);
  } else if (section.type === 'fill') {
    s.questions = section.questions.map(({ solution, tags, ...q }) => q);
  } else if (section.type === 'match') {
    delete s.answers;
    delete s.solution;
    s.gradable = Array.isArray(section.answers);
  } else {
    delete s.solution;
  }
  s.attempt = attempt || null;
  if (attempt?.submittedAt) s.key = keyOf(section);
  return s;
}

export function publicExam(id) {
  const exam = getExam(id);
  if (!exam) return null;
  const attempts = attemptsOf(id);
  return {
    id: exam.id,
    kind: exam.kind,
    kindLabel: exam.kindLabel,
    group: exam.group,
    year: exam.year,
    title: exam.title,
    source: exam.source,
    sections: exam.sections.map((s) => publicSection(s, attempts[s.id])),
  };
}

/** 列表：每份卷子的单元数、已交卷数、可判分部分的得分 */
export function listExams() {
  const rows = handle().prepare('SELECT exam_id, section_id, submitted_at, score, total FROM exam_attempts').all();
  const byExam = new Map();
  for (const r of rows) {
    if (!byExam.has(r.exam_id)) byExam.set(r.exam_id, []);
    byExam.get(r.exam_id).push(r);
  }
  const { exams, tags } = manifest();
  const list = exams.map((e) => {
    const rs = byExam.get(e.id) || [];
    const submitted = rs.filter((r) => r.submitted_at);
    const graded = submitted.filter((r) => r.score !== null);
    return {
      ...e,
      started: rs.length,
      submitted: submitted.length,
      score: graded.reduce((s, r) => s + r.score, 0),
      gradedTotal: graded.reduce((s, r) => s + r.total, 0),
      lastAt: rs.reduce((m, r) => (r.submitted_at && r.submitted_at > m ? r.submitted_at : m), ''),
    };
  });
  return { exams: list, tags: tags || {} };
}

/* ------------------------------------------------------------------ *
 * 统计：某段日期里做了多少道题，按学科分
 * ------------------------------------------------------------------ */

const SUBJECT_OF_GROUP = { english: '英语', math: '数学' };

/** 交卷时间（ISO，UTC）→ 本机日期 */
function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 一个单元里实际作答的题数 */
function answeredCount(section, answers) {
  if (section.type === 'free') return String(answers.text || '').trim() ? 1 : 0;
  const numbers = section.questions ? section.questions.map((q) => q.n) : section.numbers || [];
  return numbers.filter((n) => String(answers[n] ?? '').trim()).length;
}

/**
 * [from, to] 闭区间内交卷的题数：{ total, bySubject: {学科: n}, byDate: {日期: n} }。
 * 学科：英语、数学整体各算一类，408 按四门拆开——和标签页、目录树的分法一致。
 */
export function statsBetween(from, to) {
  const rows = handle().prepare('SELECT exam_id, section_id, answers, submitted_at FROM exam_attempts WHERE submitted_at IS NOT NULL').all();
  const out = { total: 0, bySubject: {}, byDate: {} };
  const examCache = new Map();
  for (const r of rows) {
    const date = localDate(r.submitted_at);
    if (date < from || date > to) continue;
    if (!examCache.has(r.exam_id)) examCache.set(r.exam_id, getExam(r.exam_id));
    const exam = examCache.get(r.exam_id);
    const section = exam?.sections.find((s) => s.id === r.section_id);
    if (!section) continue;
    let answers = {};
    try { answers = JSON.parse(r.answers || '{}'); } catch { /* 坏行跳过 */ }
    const n = answeredCount(section, answers);
    if (!n) continue;
    const subject = SUBJECT_OF_GROUP[exam.group] || section.subject || exam.kindLabel;
    out.total += n;
    out.bySubject[subject] = (out.bySubject[subject] || 0) + n;
    out.byDate[date] = (out.byDate[date] || 0) + n;
  }
  return out;
}
