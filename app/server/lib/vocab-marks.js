import { todayStr } from './review.js';
import * as vdb from './vocabulary-db.js';

/**
 * 标注词与单词列表。
 *
 * 真题阅读页里双击一个词 → mark()：
 *   - 词形先做一轮粗糙的还原（criticized → criticize，studies → study），能对上词表就标在那条上
 *   - 对得上考研词表（ECDICT 种子）的，前端画红线；对不上的建一条自定义词，画蓝线
 *   - 标注 = vocab_cards.important，排队时优先出现在新词里
 *
 * 单词列表四栏：今日（今天复习 / 标注 / 新加的）、未学习、学习中、已熟识。
 * 重要度四个点：标注 +2，遗忘一次 +1，遗忘三次以上再 +1，封顶 4。
 */

const CUSTOM_SOURCE = 'custom';
const CUSTOM_DECK = '我的标注';

const keyOf = (t) => String(t || '').trim().toLowerCase().replace(/[’']/g, "'");
const isWord = (t) => /^[a-z][a-z'-]{0,40}$/i.test(t);

/** 词形还原的候选，按可信度排序；只覆盖规则变化，够真题阅读用 */
export function lemmaCandidates(raw) {
  const w = keyOf(raw);
  const out = [w];
  const add = (x) => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  if (/ies$/.test(w)) add(`${w.slice(0, -3)}y`);
  if (/ied$/.test(w)) add(`${w.slice(0, -3)}y`);
  if (/(sses|shes|ches|xes|zes)$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ing$/.test(w)) {
    const stem = w.slice(0, -3);
    add(stem); add(`${stem}e`);
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (/ed$/.test(w)) {
    const stem = w.slice(0, -2);
    add(stem); add(`${stem}e`); add(w.slice(0, -1));
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return out;
}

const findWord = (d, term) => {
  const q = d.prepare(`SELECT w.id, w.term, w.term_key, s.name AS source FROM vocab_words w
                       LEFT JOIN vocab_sources s ON s.id = w.source_id WHERE w.term_key = ?`);
  for (const k of lemmaCandidates(term)) {
    const hit = q.get(k);
    if (hit) return hit;
  }
  return null;
};

function ensureCustom(d) {
  d.prepare('INSERT INTO vocab_sources (name, license) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(CUSTOM_SOURCE, 'personal');
  d.prepare('INSERT INTO vocab_decks (name, note) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(CUSTOM_DECK, '真题里双击标出来、或手动加的词');
  return {
    sourceId: d.prepare('SELECT id FROM vocab_sources WHERE name = ?').get(CUSTOM_SOURCE).id,
    deckId: d.prepare('SELECT id FROM vocab_decks WHERE name = ?').get(CUSTOM_DECK).id,
  };
}

const publicWord = (row) => ({
  id: row.id,
  term: row.term,
  termKey: row.term_key,
  inList: row.source !== CUSTOM_SOURCE,   // 考研词表内 → 红线；自定义 → 蓝线
  important: !!row.important,
});

/** 标注 / 取消标注。取消一个没复习过的自定义词就直接删掉，别留垃圾 */
export function mark(term, { source = '', meaning = '', on = true } = {}) {
  const t = String(term || '').trim();
  if (!isWord(t)) { const e = new Error('不是一个英文单词'); e.code = 'BAD_TERM'; throw e; }
  const today = todayStr();

  return vdb.tx((d) => {
    let w = findWord(d, t);
    if (!on) {
      if (!w) return { word: null, removed: false };
      const card = d.prepare('SELECT * FROM vocab_cards WHERE word_id = ?').get(w.id);
      if (w.source === CUSTOM_SOURCE && (!card || card.repetitions === 0)) {
        d.prepare('DELETE FROM vocab_words WHERE id = ?').run(w.id);
        return { word: { ...publicWord({ ...w, important: 0 }) }, removed: true };
      }
      d.prepare('UPDATE vocab_cards SET important = 0, marked_at = NULL WHERE word_id = ?').run(w.id);
      return { word: publicWord({ ...w, important: 0 }), removed: false };
    }

    let created = false;
    if (!w) {
      const { sourceId, deckId } = ensureCustom(d);
      d.prepare(`INSERT INTO vocab_words (term_key, term, source_id, deck_id, added_at) VALUES (?, ?, ?, ?, ?)`)
        .run(keyOf(t), t.toLowerCase(), sourceId, deckId, today);
      w = findWord(d, t);
      created = true;
      if (meaning.trim()) {
        d.prepare('INSERT INTO vocab_senses (word_id, ord, pos, gloss) VALUES (?, 0, ?, ?)').run(w.id, '', meaning.trim());
      }
    } else if (meaning.trim() && w.source === CUSTOM_SOURCE) {
      d.prepare('DELETE FROM vocab_senses WHERE word_id = ?').run(w.id);
      d.prepare('INSERT INTO vocab_senses (word_id, ord, pos, gloss) VALUES (?, 0, ?, ?)').run(w.id, '', meaning.trim());
    }
    d.prepare(`INSERT INTO vocab_cards (word_id, important, marked_at, mark_source) VALUES (?, 1, ?, ?)
               ON CONFLICT(word_id) DO UPDATE SET important = 1, marked_at = excluded.marked_at, mark_source = excluded.mark_source`)
      .run(w.id, today, String(source || ''));
    return { word: publicWord({ ...w, important: 1 }), created };
  });
}

/** 所有标注词（给阅读页画线用） */
export function marks() {
  return vdb.handle().prepare(`
    SELECT w.id, w.term, w.term_key, s.name AS source, c.important
    FROM vocab_cards c JOIN vocab_words w ON w.id = c.word_id
    LEFT JOIN vocab_sources s ON s.id = w.source_id
    WHERE c.important = 1 ORDER BY w.term_key`).all().map(publicWord);
}

export function setImportant(wordId, on) {
  const r = vdb.handle().prepare('UPDATE vocab_cards SET important = ?, marked_at = ? WHERE word_id = ?')
    .run(on ? 1 : 0, on ? todayStr() : null, wordId);
  return { ok: r.changes > 0 };
}

/* ------------------------------------------------------------------ *
 * 单词列表
 * ------------------------------------------------------------------ */

export const importanceOf = (c) =>
  Math.min(4, (c.important ? 2 : 0) + (c.lapses >= 1 ? 1 : 0) + (c.lapses >= 3 ? 1 : 0));

const VIEWS = {
  today: (today) => ({ where: '(c.last_review = ? OR c.marked_at = ? OR w.added_at = ?)', args: [today, today, today], order: 'c.important DESC, c.last_review DESC, w.term_key' }),
  new: () => ({ where: "c.state = 'new'", args: [], order: 'c.important DESC, w.frequency DESC, w.term_key' }),
  learning: () => ({ where: "c.state = 'review'", args: [], order: 'c.due ASC, c.important DESC, w.term_key' }),
  known: () => ({ where: "c.state = 'mastered'", args: [], order: 'c.last_review DESC, w.term_key' }),
};

export function list({ view = 'today', q = '', limit = 200, offset = 0 } = {}) {
  const d = vdb.handle();
  const today = todayStr();
  const v = (VIEWS[view] || VIEWS.today)(today);
  const needle = keyOf(q);
  const where = [v.where];
  const args = [...v.args];
  if (needle) { where.push('(w.term_key LIKE ? OR EXISTS (SELECT 1 FROM vocab_senses s WHERE s.word_id = w.id AND s.gloss LIKE ?))'); args.push(`%${needle}%`, `%${q.trim()}%`); }

  const rows = d.prepare(`
    SELECT w.id, w.term, w.term_key, w.phonetic, w.added_at, src.name AS source,
           c.state, c.due, c.interval, c.repetitions, c.lapses, c.last_review, c.important, c.marked_at,
           (SELECT group_concat(CASE WHEN pos <> '' THEN pos || ' ' || gloss ELSE gloss END, '；')
              FROM (SELECT pos, gloss FROM vocab_senses WHERE word_id = w.id ORDER BY ord LIMIT 2)) AS gloss
    FROM vocab_cards c JOIN vocab_words w ON w.id = c.word_id
    LEFT JOIN vocab_sources src ON src.id = w.source_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${v.order}
    LIMIT ? OFFSET ?`).all(...args, Math.min(500, Math.max(1, limit)), Math.max(0, offset));

  const counts = d.prepare(`
    SELECT
      SUM(CASE WHEN c.last_review = ? OR c.marked_at = ? OR w.added_at = ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN c.state = 'new' THEN 1 ELSE 0 END) AS new,
      SUM(CASE WHEN c.state = 'review' THEN 1 ELSE 0 END) AS learning,
      SUM(CASE WHEN c.state = 'mastered' THEN 1 ELSE 0 END) AS known,
      SUM(c.important) AS important
    FROM vocab_cards c JOIN vocab_words w ON w.id = c.word_id`).get(today, today, today);

  return {
    today,
    view,
    counts: { today: counts.today || 0, new: counts.new || 0, learning: counts.learning || 0, known: counts.known || 0, important: counts.important || 0 },
    items: rows.map((r) => ({
      id: r.id,
      term: r.term,
      phonetic: r.phonetic,
      gloss: r.gloss || '',
      inList: r.source !== CUSTOM_SOURCE,
      state: r.state,
      due: r.state === 'review' ? r.due : null,
      interval: r.interval,
      reviews: r.repetitions,
      lapses: r.lapses,
      lastReview: r.last_review,
      important: !!r.important,
      markedAt: r.marked_at,
      addedAt: r.added_at,
      importance: importanceOf(r),
      todayWhy: r.last_review === today ? 'reviewed' : r.marked_at === today ? 'marked' : r.added_at === today ? 'added' : null,
    })),
  };
}
