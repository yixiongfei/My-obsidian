import { handle } from './db.js';
import { getExam, getTags } from './exams.js';

/**
 * 专题训练：把一个知识点（真题标签）名下历年出现过的题抽出来，逐题练。
 *
 * 和整卷不同：一题一交、一题一看答案，作答记在 exam_drill 表，按 (卷, 单元, 题号) 一行，
 * 不碰 exam_attempts——整卷的成绩单不受专题训练影响，反过来也一样。
 * 答案 / 解析仍然只在这道题交了之后才发给前端。
 */

const TYPE_OF = { 选择题: 'choice', 填空题: 'fill', 解答题: 'free' };

function ensureTable() {
  handle().exec(`
    CREATE TABLE IF NOT EXISTS exam_drill (
      exam_id     TEXT NOT NULL,
      section_id  TEXT NOT NULL,
      n           INTEGER NOT NULL,
      answer      TEXT NOT NULL DEFAULT '',   -- 选择题是字母，填空 / 解答题是文本
      correct     INTEGER,                    -- 只有选择题能判：1 对 0 错；其它 NULL
      answered_at TEXT NOT NULL,
      PRIMARY KEY (exam_id, section_id, n)
    )`);
}
let ready = false;
const db = () => { if (!ready) { ensureTable(); ready = true; } return handle(); };

/** 标签项 → 卷子里的那道题所在单元。解答题一个单元一题，按 numbers 对 */
function locate(exam, item) {
  const type = TYPE_OF[item.type];
  if (!type) return null;
  return exam.sections.find((s) => s.type === type && (
    s.questions ? s.questions.some((q) => q.n === item.n) : (s.numbers || []).includes(item.n)
  )) || null;
}

/** 交卷前给前端看的题面 */
function publicQuestion(section, n) {
  if (section.type === 'choice') {
    const { answer, explanation, tags, ...q } = section.questions.find((x) => x.n === n);
    return { ...q, directions: section.directions || '' };
  }
  if (section.type === 'fill') {
    const { solution, tags, ...q } = section.questions.find((x) => x.n === n);
    return q;
  }
  return { n, directions: section.directions || '', body: section.body || '' };
}

/** 这道题的「答案包」 */
export function keyOfQuestion(section, n) {
  if (section.type === 'choice') {
    const q = section.questions.find((x) => x.n === n);
    return { answer: q.answer, explanation: q.explanation || '', tags: q.tags || [] };
  }
  if (section.type === 'fill') {
    const q = section.questions.find((x) => x.n === n);
    return { solution: q.solution || '', tags: q.tags || [] };
  }
  return { solution: section.solution || '', tags: section.tags || [] };
}

const rowToAttempt = (r) => (r ? { answer: r.answer, correct: r.correct == null ? null : !!r.correct, answeredAt: r.answered_at } : null);

export function attemptOf(examId, sectionId, n) {
  return rowToAttempt(db().prepare('SELECT * FROM exam_drill WHERE exam_id = ? AND section_id = ? AND n = ?').get(examId, sectionId, n));
}

/** 一个知识点的题单，带每题的作答状态；已答的附答案包 */
export function drill(group, tagName) {
  const tags = getTags(group);
  if (!tags) return null;
  let subject = null;
  let tag = null;
  for (const s of tags.subjects) {
    const t = s.tags.find((x) => x.name === tagName);
    if (t) { subject = s.name; tag = t; break; }
  }
  if (!tag) return null;

  const rows = db().prepare('SELECT * FROM exam_drill').all();
  const done = new Map(rows.map((r) => [`${r.exam_id}:${r.section_id}:${r.n}`, r]));

  const items = [];
  let missing = 0;
  for (const it of tag.items) {
    const exam = getExam(it.exam);
    const section = exam && locate(exam, it);
    if (!section) { missing += 1; continue; }
    const attempt = rowToAttempt(done.get(`${exam.id}:${section.id}:${it.n}`));
    items.push({
      id: `${exam.id}:${section.id}:${it.n}`,
      exam: exam.id,
      kind: exam.kind,
      kindLabel: exam.kindLabel,
      year: exam.year,
      section: { id: section.id, type: section.type, title: section.title || section.label, points: section.points, count: section.questions?.length || 1 },
      n: it.n,
      type: it.type,
      question: publicQuestion(section, it.n),
      attempt,
      key: attempt ? keyOfQuestion(section, it.n) : undefined,
    });
  }
  // 新到旧：先练最近的年份
  items.sort((a, b) => (b.year - a.year) || (a.n - b.n));
  return { group, label: tags.label, subject, tag: tag.name, total: tag.items.length, missing, items };
}

function findSection(examId, sectionId, n) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw Object.assign(new Error('单元不存在'), { status: 404 });
  const has = section.questions ? section.questions.some((q) => q.n === n) : (section.numbers || []).includes(n);
  if (!has) throw Object.assign(new Error('题号不存在'), { status: 404 });
  return section;
}

/** 交这一题：存作答、判分（选择题），返回答案包 */
export function answer(examId, sectionId, n, raw) {
  const section = findSection(examId, sectionId, n);
  const cur = attemptOf(examId, sectionId, n);
  if (cur) throw Object.assign(new Error('这道题已经交过了，要重做先重置'), { status: 409 });
  let value = String(raw ?? '').trim();
  let correct = null;
  if (section.type === 'choice') {
    value = value.toUpperCase();
    if (!/^[A-D]$/.test(value)) value = '';
    correct = value && value === section.questions.find((q) => q.n === n).answer ? 1 : 0;
  } else {
    value = value.slice(0, 20000);
  }
  const now = new Date().toISOString();
  db().prepare(`INSERT INTO exam_drill (exam_id, section_id, n, answer, correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(examId, sectionId, n, value, correct, now);
  return { attempt: { answer: value, correct: correct == null ? null : !!correct, answeredAt: now }, key: keyOfQuestion(section, n) };
}

export function reset(examId, sectionId, n) {
  const r = db().prepare('DELETE FROM exam_drill WHERE exam_id = ? AND section_id = ? AND n = ?').run(examId, sectionId, n);
  return { ok: true, removed: r.changes };
}

/** 各知识点的训练进度：{ '泰勒公式': { done, right } }，给标签页显示 */
export function progressOf(group) {
  const tags = getTags(group);
  if (!tags) return {};
  // 题号在一份卷子里唯一（数学 1–22、408 1–47），不用打开卷子文件对单元
  const rows = db().prepare('SELECT exam_id, n, correct FROM exam_drill').all();
  const done = new Map(rows.map((r) => [`${r.exam_id}:${r.n}`, r]));
  const out = {};
  for (const s of tags.subjects) {
    for (const t of s.tags) {
      let d = 0;
      let right = 0;
      for (const it of t.items) {
        const r = done.get(`${it.exam}:${it.n}`);
        if (r) { d += 1; if (r.correct) right += 1; }
      }
      if (d) out[t.name] = { done: d, right };
    }
  }
  return out;
}
