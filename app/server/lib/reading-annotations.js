import { handle } from './db.js';

const EMPTY = Object.freeze({ strokes: [], highlights: [], notes: [] });
const MAX_JSON = 900_000;

const cleanId = (v, name) => {
  const out = String(v || '').trim();
  if (!out || out.length > 180) throw Object.assign(new Error(`${name} 不合法`), { status: 400 });
  return out;
};

function normalize(value) {
  const source = value && typeof value === 'object' ? value : EMPTY;
  return {
    strokes: Array.isArray(source.strokes) ? source.strokes.slice(-600) : [],
    highlights: Array.isArray(source.highlights) ? source.highlights.slice(-300) : [],
    notes: Array.isArray(source.notes) ? source.notes.slice(-200) : [],
  };
}

export function read(examId, sectionId) {
  const exam = cleanId(examId, '试卷');
  const section = cleanId(sectionId, '阅读单元');
  const row = handle().prepare(`
    SELECT data, updated_at AS updatedAt
    FROM exam_reading_annotations WHERE exam_id = ? AND section_id = ?
  `).get(exam, section);
  if (!row) return { ...EMPTY, updatedAt: null };
  try { return { ...normalize(JSON.parse(row.data)), updatedAt: row.updatedAt }; }
  catch { return { ...EMPTY, updatedAt: row.updatedAt }; }
}

export function write(examId, sectionId, value) {
  const exam = cleanId(examId, '试卷');
  const section = cleanId(sectionId, '阅读单元');
  const data = normalize(value);
  const json = JSON.stringify(data);
  if (json.length > MAX_JSON) throw Object.assign(new Error('这篇阅读的批注过多，请先清理部分手写轨迹'), { status: 413 });
  const updatedAt = new Date().toISOString();
  handle().prepare(`
    INSERT INTO exam_reading_annotations (exam_id, section_id, data, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(exam_id, section_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(exam, section, json, updatedAt);
  return { ...data, updatedAt };
}
