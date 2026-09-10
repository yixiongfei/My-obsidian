import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { handle, tx, hasFts, getMeta, setMeta } from './db.js';
import { index, statSyncSafe } from './vault.js';
import { REVIEW_LOG, SCHEDULE_FILE } from '../config.js';

/* ------------------------------------------------------------------ *
 * 笔记：内存索引 → SQLite
 * ------------------------------------------------------------------ */

const UPSERT_NOTE = `
INSERT INTO notes (id, title, basename, folder, created, review_count, last_reviewed, next_review, words, mtime, body, plain)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title, basename = excluded.basename, folder = excluded.folder,
  created = excluded.created, review_count = excluded.review_count,
  last_reviewed = excluded.last_reviewed, next_review = excluded.next_review,
  words = excluded.words, mtime = excluded.mtime, body = excluded.body, plain = excluded.plain`;

function writeNote(db, note) {
  const st = statSyncSafe(note.abs);
  db.prepare(UPSERT_NOTE).run(
    note.id, note.title, note.basename, note.folder, note.created,
    note.reviewCount, note.lastReviewed, note.nextReview,
    note.words, st ? Math.floor(st.mtimeMs) : 0,
    note.body, note.plain.replace(/\s+/g, ' ').trim(),
  );

  db.prepare('DELETE FROM tags     WHERE note_id = ?').run(note.id);
  db.prepare('DELETE FROM headings WHERE note_id = ?').run(note.id);
  db.prepare('DELETE FROM links    WHERE src     = ?').run(note.id);

  const insTag = db.prepare('INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)');
  for (const tag of note.tags) insTag.run(note.id, tag);

  const insHead = db.prepare('INSERT OR REPLACE INTO headings (note_id, ord, level, text) VALUES (?, ?, ?, ?)');
  note.outline.forEach((h, i) => insHead.run(note.id, i, h.level, h.text));

  const insLink = db.prepare('INSERT OR IGNORE INTO links (src, dst, embed) VALUES (?, ?, ?)');
  for (const t of note.linkTargets) {
    const dst = index.resolve(t);
    if (dst && dst !== note.id) insLink.run(note.id, dst, 0);
  }
  for (const t of note.embedTargets) {
    const dst = index.resolve(t);
    if (dst && dst !== note.id) insLink.run(note.id, dst, 1);
  }

  if (hasFts()) {
    db.prepare('DELETE FROM notes_fts WHERE id = ?').run(note.id);
    db.prepare('INSERT INTO notes_fts (id, title, tags, headings, plain) VALUES (?, ?, ?, ?, ?)').run(
      note.id, note.title, note.tags.join(' '),
      note.outline.map((h) => h.text).join(' '),
      note.plain.replace(/\s+/g, ' ').trim(),
    );
  }
}

function dropNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (hasFts()) db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
}

/** 全量重建：以内存索引为准，库里多出来的笔记一并删掉 */
export function syncNotes() {
  return tx((db) => {
    const alive = new Set();
    for (const note of index.notes.values()) {
      writeNote(db, note);
      alive.add(note.id);
    }
    for (const { id } of db.prepare('SELECT id FROM notes').all()) {
      if (!alive.has(id)) dropNote(db, id);
    }
    return alive.size;
  });
}

/** 单篇同步：链接解析依赖全局，所以顺带刷新指向它的反向链接不需要，dst 是按 id 存的 */
export function syncNote(id) {
  const note = index.get(id);
  return tx((db) => {
    if (!note) { dropNote(db, id); return false; }
    writeNote(db, note);
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * review_log.jsonl → reviews 表
 *
 * 唯一键是 (date, note_id, review_count_after)，重复导入是幂等的，
 * 所以启动时无脑全量重放即可，不需要记录读到第几行。
 * ------------------------------------------------------------------ */

export async function syncReviewLog() {
  let text = '';
  try { text = await fsp.readFile(REVIEW_LOG, 'utf8'); } catch { return 0; }

  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (!e.date || !e.note_path) continue;
      rows.push(e);
    } catch { /* 坏行跳过，不让整份日志失效 */ }
  }

  return tx((db) => {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO reviews (date, note_id, tags, review_count_after, added_content, source)
      VALUES (?, ?, ?, ?, ?, ?)`);
    let n = 0;
    for (const e of rows) {
      const r = ins.run(
        e.date, e.note_path, JSON.stringify(e.tags || []),
        Number(e.review_count_after) || 0, e.added_content || '', e.source || '',
      );
      n += r.changes;
    }
    return n;
  });
}

export function recordReviewRow(entry) {
  handle().prepare(`
    INSERT OR IGNORE INTO reviews (date, note_id, tags, review_count_after, added_content, source)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    entry.date, entry.note_path, JSON.stringify(entry.tags || []),
    entry.review_count_after, entry.added_content || '', entry.source || '',
  );
}

/* ------------------------------------------------------------------ *
 * schedule.json → events 表（一次性迁移）
 * ------------------------------------------------------------------ */

export async function migrateSchedule() {
  if (getMeta('schedule_migrated') === '1') return 0;

  let parsed = null;
  try { parsed = JSON.parse(await fsp.readFile(SCHEDULE_FILE, 'utf8')); } catch { /* 没有就跳过 */ }

  const moved = tx((db) => {
    const ins = db.prepare('INSERT OR IGNORE INTO events (id, date, title, note, kind, done) VALUES (?, ?, ?, ?, ?, ?)');
    let n = 0;
    for (const e of parsed?.events || []) {
      if (!e?.date || !e?.title) continue;
      n += ins.run(e.id || randomUUID(), e.date, e.title, e.note || '', e.kind || 'plan', e.done ? 1 : 0).changes;
    }
    return n;
  });

  if (parsed?.examDate) setMeta('exam_date', parsed.examDate);
  setMeta('schedule_migrated', '1');

  // 迁移完把旧文件挪走而不是删掉，出问题还能翻回来
  if (moved > 0) {
    try { await fsp.rename(SCHEDULE_FILE, `${SCHEDULE_FILE}.migrated`); } catch { /* 挪不动就留着 */ }
  }
  return moved;
}

/* ------------------------------------------------------------------ */

export async function syncAll() {
  const notes = syncNotes();
  const reviews = await syncReviewLog();
  const events = await migrateSchedule();
  return { notes, reviews, events };
}

export { path };
