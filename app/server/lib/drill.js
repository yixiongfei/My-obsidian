import { handle } from './db.js';
import { getExam, getTags, withImages } from './exams.js';

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
      correct     INTEGER,                    -- 选择题自动判；填空 / 解答题由 AI 批改后填（全对 1，部分对 / 错 0），没批改 NULL
      answered_at TEXT NOT NULL,
      ai          TEXT,                       -- AI 批改：JSON { score, total, verdict, brief, points, at }
      PRIMARY KEY (exam_id, section_id, n)
    )`);
  // 老库补列：列已存在就吞掉报错
  try { handle().exec('ALTER TABLE exam_drill ADD COLUMN ai TEXT'); } catch { /* 已有 */ }
  // 做题便利贴：每道题一张，写做完后的总结。和作答分开存——重做不会把总结一起删掉
  handle().exec(`
    CREATE TABLE IF NOT EXISTS drill_notes (
      exam_id    TEXT NOT NULL,
      section_id TEXT NOT NULL,
      n          INTEGER NOT NULL,
      color      TEXT NOT NULL DEFAULT 'y',   -- 同便利贴：y 疑问 b 推导 g 结论 r 易错
      text       TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
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

const parseAi = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const rowToAttempt = (r) => (r ? { answer: r.answer, correct: r.correct == null ? null : !!r.correct, answeredAt: r.answered_at, ai: parseAi(r.ai) } : null);

export function attemptOf(examId, sectionId, n) {
  return rowToAttempt(db().prepare('SELECT * FROM exam_drill WHERE exam_id = ? AND section_id = ? AND n = ?').get(examId, sectionId, n));
}

/** 这道题满分：解答题整单元的分，选择 / 填空按题均分 */
export function pointsOf(section) {
  if (section.points == null) return null;
  if (section.type === 'free') return section.points;
  return Math.round((section.points / (section.questions?.length || 1)) * 10) / 10;
}

/** 记下 AI 批改结果，并按结论回填对错（全对算对；部分对 / 错都算没掌握） */
export function saveGrade(examId, sectionId, n, grade) {
  if (!attemptOf(examId, sectionId, n)) throw Object.assign(new Error('这道题还没交'), { status: 409 });
  const correct = grade.verdict === 'right' ? 1 : 0;
  db().prepare('UPDATE exam_drill SET ai = ?, correct = ? WHERE exam_id = ? AND section_id = ? AND n = ?')
    .run(JSON.stringify(grade), correct, examId, sectionId, n);
  return attemptOf(examId, sectionId, n);
}

/* ── 做题便利贴 ── */
const NOTE_COLORS = new Set(['y', 'b', 'g', 'r']);
const rowToNote = (r) => (r ? { color: r.color, text: r.text, updatedAt: r.updated_at } : null);

export function noteOf(examId, sectionId, n) {
  return rowToNote(db().prepare('SELECT * FROM drill_notes WHERE exam_id = ? AND section_id = ? AND n = ?').get(examId, sectionId, n));
}

/** 写便利贴；文字清空就当撕掉 */
export function saveNote(examId, sectionId, n, { color, text } = {}) {
  findSection(examId, sectionId, n);
  const body = String(text ?? '').slice(0, 8000);
  if (!body.trim()) {
    db().prepare('DELETE FROM drill_notes WHERE exam_id = ? AND section_id = ? AND n = ?').run(examId, sectionId, n);
    return null;
  }
  const c = NOTE_COLORS.has(color) ? color : (noteOf(examId, sectionId, n)?.color || 'y');
  db().prepare(`INSERT INTO drill_notes (exam_id, section_id, n, color, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(exam_id, section_id, n) DO UPDATE SET color = excluded.color, text = excluded.text, updated_at = excluded.updated_at`)
    .run(examId, sectionId, n, c, body, new Date().toISOString());
  return noteOf(examId, sectionId, n);
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
  const notes = new Map(db().prepare('SELECT * FROM drill_notes').all().map((r) => [`${r.exam_id}:${r.section_id}:${r.n}`, rowToNote(r)]));

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
      note: notes.get(`${exam.id}:${section.id}:${it.n}`) || null,
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

/** 交过的主观题补 / 换手写图：文字不动，只换图片那几行 */
export function attachImages(examId, sectionId, n, images) {
  const section = findSection(examId, sectionId, n);
  if (section.type === 'choice') throw Object.assign(new Error('选择题不能贴图'), { status: 400 });
  const cur = attemptOf(examId, sectionId, n);
  if (!cur) throw Object.assign(new Error('这道题还没交'), { status: 409 });
  const value = withImages(cur.answer, images);
  db().prepare('UPDATE exam_drill SET answer = ? WHERE exam_id = ? AND section_id = ? AND n = ?').run(value, examId, sectionId, n);
  return { ...cur, answer: value };
}

export function reset(examId, sectionId, n) {
  const r = db().prepare('DELETE FROM exam_drill WHERE exam_id = ? AND section_id = ? AND n = ?').run(examId, sectionId, n);
  return { ok: true, removed: r.changes };
}

/**
 * 训练进度，给标签页：
 *   tags  { '泰勒公式': { done, right } }
 *   items { 'math2-2021:5': true | false | null }   每道题对 / 错 / 交了但不能判
 */
export function progressOf(group) {
  const tags = getTags(group);
  if (!tags) return { tags: {}, items: {} };
  // 题号在一份卷子里唯一（数学 1–22、408 1–47），不用打开卷子文件对单元
  const rows = db().prepare('SELECT exam_id, n, correct FROM exam_drill').all();
  const done = new Map(rows.map((r) => [`${r.exam_id}:${r.n}`, r]));
  const out = {};
  const items = {};
  for (const [k, r] of done) items[k] = r.correct == null ? null : !!r.correct;
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
  return { tags: out, items };
}
