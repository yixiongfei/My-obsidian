import { handle, hasFts } from './db.js';
import { todayStr, daysBetween, intervalAfter } from './review.js';

/** SQL 里用 char(1) 把标签聚成一列，这里用同一个分隔符拆回来 */
const TAG_SEP = String.fromCharCode(1);

/** notes 表的一行 → 前端用的 meta 结构 */
const toMeta = (r) => ({
  id: r.id,
  title: r.title,
  basename: r.basename,
  folder: r.folder,
  tags: r.tags ? r.tags.split(TAG_SEP) : [],
  created: r.created,
  reviewCount: r.review_count,
  lastReviewed: r.last_reviewed,
  nextReview: r.next_review,
  words: r.words,
  mtime: r.mtime,
  empty: r.words === 0,
  reviewable: r.reviewable !== 0,
});

/** 把每篇笔记的标签聚成一列，省掉 N+1 次查询 */
const WITH_TAGS = `
  LEFT JOIN (SELECT note_id, group_concat(tag, char(1)) AS tags FROM tags GROUP BY note_id) t
    ON t.note_id = n.id`;

export const allNotes = () =>
  handle().prepare(`SELECT n.*, t.tags FROM notes n ${WITH_TAGS} ORDER BY n.id`).all().map(toMeta);

export const getNoteMeta = (id) => {
  const row = handle().prepare(`SELECT n.*, t.tags FROM notes n ${WITH_TAGS} WHERE n.id = ?`).get(id);
  return row ? toMeta(row) : null;
};

/* ------------------------------------------------------------------ *
 * 搜索
 *
 * trigram 分词器要求查询词 >= 3 字符，「矩阵」「极限」这类两字词命不中，
 * 所以短词退回 LIKE。候选取回来后在 JS 里打分：标题 / 标签 / 小标题的
 * 命中权重高于正文，正文命中次数只作次要加权。
 * ------------------------------------------------------------------ */

function candidates(q) {
  const db = handle();

  if (q.length >= 3 && hasFts()) {
    const phrase = `"${q.replace(/"/g, '""')}"`;
    try {
      const ids = db.prepare('SELECT id FROM notes_fts WHERE notes_fts MATCH ? LIMIT 400').all(phrase);
      if (!ids.length) return [];
      const holes = ids.map(() => '?').join(',');
      return db.prepare(`SELECT n.*, t.tags FROM notes n ${WITH_TAGS} WHERE n.id IN (${holes})`)
        .all(...ids.map((r) => r.id));
    } catch { /* MATCH 语法出错就退回 LIKE */ }
  }

  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db.prepare(`
    SELECT n.*, t.tags FROM notes n ${WITH_TAGS}
    WHERE n.title LIKE ?1 ESCAPE '\\' OR n.plain LIKE ?1 ESCAPE '\\'
       OR n.id LIKE ?1 ESCAPE '\\' OR IFNULL(t.tags, '') LIKE ?1 ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM headings h WHERE h.note_id = n.id AND h.text LIKE ?1 ESCAPE '\\')
    LIMIT 400`).all(like);
}

function snippet(plain, q, len = 90) {
  const at = plain.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return plain.slice(0, len).trim();
  const start = Math.max(0, at - Math.floor(len / 3));
  return `${start > 0 ? '…' : ''}${plain.slice(start, start + len).trim()}…`;
}

export function search(rawQuery, limit = 30) {
  const q = String(rawQuery || '').trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const headingsOf = handle().prepare('SELECT text FROM headings WHERE note_id = ? ORDER BY ord');
  const out = [];

  for (const row of candidates(q)) {
    const meta = toMeta(row);
    const plain = row.plain || '';
    const hits = plain.toLowerCase().split(lower).length - 1;
    const matchedHeading = headingsOf.all(row.id).map((h) => h.text)
      .find((h) => h.toLowerCase().includes(lower)) || null;

    let score = 0;
    const titleAt = meta.title.toLowerCase().indexOf(lower);
    if (titleAt !== -1) score += 3000 - titleAt * 8 + (titleAt === 0 ? 600 : 0);
    if (meta.tags.some((t) => t.toLowerCase().includes(lower))) score += 1400;
    if (matchedHeading) score += 900;
    if (row.id.toLowerCase().includes(lower)) score += 400;
    if (hits) score += 500 + Math.min(hits, 12) * 25;
    if (!score) continue;

    out.push({
      ...meta,
      score,
      hits,
      matchedHeading,
      snippet: hits ? snippet(plain, q) : (matchedHeading || plain.slice(0, 80).trim()),
    });
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 复习分桶
 * ------------------------------------------------------------------ */

export function bucketNotes(today = todayStr()) {
  const due = [], upcoming = [], unscheduled = [], scheduled = [];
  for (const n of allNotes()) {
    // 自动生成的词汇日志带 reviewable: false，能浏览能搜索，但不该出现在复习队列里
    if (!n.reviewable) continue;
    if (n.empty) { unscheduled.push({ ...n, status: 'empty' }); continue; }
    if (!n.nextReview) { unscheduled.push({ ...n, status: 'new' }); continue; }
    const delta = daysBetween(today, n.nextReview);
    if (delta <= 0) due.push({ ...n, status: 'due', overdueDays: -delta });
    else if (delta <= 7) upcoming.push({ ...n, status: 'upcoming', inDays: delta });
    else scheduled.push({ ...n, status: 'scheduled', inDays: delta });
  }
  due.sort((a, b) => b.overdueDays - a.overdueDays);
  upcoming.sort((a, b) => a.inDays - b.inDays);
  return { due, upcoming, unscheduled, done: scheduled };
}

/* ------------------------------------------------------------------ *
 * 仪表盘
 * ------------------------------------------------------------------ */

export function dashboard(examDate) {
  const db = handle();
  const today = todayStr();

  const totals = db.prepare('SELECT COUNT(*) n, IFNULL(SUM(words), 0) w, IFNULL(SUM(words = 0), 0) e FROM notes').get();
  const reviewTotal = db.prepare('SELECT COUNT(*) c FROM reviews').get().c;

  const perDay = new Map(
    db.prepare('SELECT date, COUNT(*) c FROM reviews GROUP BY date').all().map((r) => [r.date, r.c]),
  );

  // 近 26 周，从周一起算
  const heatmap = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7) - 25 * 7);
  for (let i = 0; i < 26 * 7; i++) {
    const d = todayStr(cursor);
    heatmap.push({ date: d, count: perDay.get(d) || 0, future: d > today });
    cursor.setDate(cursor.getDate() + 1);
  }

  // 连续复习天数：今天还没复习不算断
  let streak = 0;
  const back = new Date();
  for (;;) {
    const d = todayStr(back);
    if (perDay.get(d)) { streak++; back.setDate(back.getDate() - 1); continue; }
    if (d === today) { back.setDate(back.getDate() - 1); continue; }
    break;
  }

  const subjects = db.prepare(`
    SELECT t.tag                                                             AS tag,
           COUNT(*)                                                          AS notes,
           IFNULL(SUM(n.review_count), 0)                                    AS reviews,
           IFNULL(SUM(n.reviewable = 1 AND n.next_review IS NOT NULL AND n.next_review <= ?), 0)  AS due,
           IFNULL(SUM(n.words = 0), 0)                                       AS empty
    FROM tags t JOIN notes n ON n.id = t.note_id
    GROUP BY t.tag ORDER BY notes DESC, tag`).all(today)
    .map((s) => ({ ...s, mastery: Math.min(1, s.notes ? s.reviews / (s.notes * 5) : 0) }));

  const recent = db.prepare(`
    SELECT r.date, r.note_id AS note_path, r.review_count_after, r.added_content, r.source,
           IFNULL(n.title, r.note_id) AS title
    FROM reviews r LEFT JOIN notes n ON n.id = r.note_id
    ORDER BY r.date DESC, r.id DESC LIMIT 12`).all();

  const buckets = bucketNotes(today);

  return {
    today,
    examDate: examDate || null,
    daysToExam: examDate ? daysBetween(today, examDate) : null,
    counts: {
      notes: totals.n,
      words: totals.w,
      empty: totals.e,
      reviews: reviewTotal,
      due: buckets.due.length,
      upcoming: buckets.upcoming.length,
      unscheduled: buckets.unscheduled.length,
      todayDone: perDay.get(today) || 0,
    },
    streak,
    due: buckets.due.slice(0, 50),
    upcoming: buckets.upcoming.slice(0, 20),
    unscheduled: buckets.unscheduled.slice(0, 20),
    heatmap,
    subjects,
    recent,
    intervals: [0, 1, 2, 3, 4, 5].map((c) => ({ after: c, days: intervalAfter(c) })),
  };
}
