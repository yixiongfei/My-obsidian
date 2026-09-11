import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from '../config.js';

/**
 * SQLite 的定位：**派生索引层 + 应用数据**。
 *
 * - 笔记正文的唯一真相仍是 .md 文件；库里的 notes/headings/links 都是从文件重建出来的，
 *   删掉 .kb/index.db 下次启动会原样长回来。
 * - 复习记录同时写三处：笔记 frontmatter、review_log.jsonl、本库。前两者是给 Obsidian
 *   和 Claudian 看的契约，本库只是为了快速统计（热力图、连续天数、按学科聚合）。
 * - 日程（events）以本库为准，schedule.json 不再需要，启动时自动迁移一次。
 */

const DB_DIR = path.join(VAULT_ROOT, '.kb');
export const DB_PATH = process.env.KB_DB || path.join(DB_DIR, 'index.db');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,       -- 相对 vault 的 POSIX 路径
  title         TEXT NOT NULL,
  basename      TEXT NOT NULL,
  folder        TEXT NOT NULL DEFAULT '',
  created       TEXT,                   -- YYYY-MM-DD
  review_count  INTEGER NOT NULL DEFAULT 0,
  last_reviewed TEXT,
  next_review   TEXT,
  words         INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL DEFAULT 0,
  body          TEXT NOT NULL DEFAULT '',
  plain         TEXT NOT NULL DEFAULT '',
  -- frontmatter 里 reviewable: false 的笔记不进复习队列（自动生成的词汇日志就是）
  reviewable    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_notes_next    ON notes(next_review);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created);
CREATE INDEX IF NOT EXISTS idx_notes_folder  ON notes(folder);

CREATE TABLE IF NOT EXISTS tags (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS headings (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  level   INTEGER NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (note_id, ord)
);

CREATE TABLE IF NOT EXISTS links (
  src   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  dst   TEXT NOT NULL,
  embed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (src, dst, embed)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);

-- 复习历史：review_log.jsonl 的镜像，(date, note_id, review_count_after) 唯一，重放不会重复
CREATE TABLE IF NOT EXISTS reviews (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  date               TEXT NOT NULL,
  note_id            TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '[]',
  review_count_after INTEGER NOT NULL,
  added_content      TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT '',
  UNIQUE (date, note_id, review_count_after)
);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(date);
CREATE INDEX IF NOT EXISTS idx_reviews_note ON reviews(note_id);

-- 自定义日程：本库是唯一真相
CREATE TABLE IF NOT EXISTS events (
  id    TEXT PRIMARY KEY,
  date  TEXT NOT NULL,
  title TEXT NOT NULL,
  note  TEXT NOT NULL DEFAULT '',
  kind  TEXT NOT NULL DEFAULT 'plan',
  done  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);

-- 真题作答：一份卷子的一个单元（完形 / 某篇阅读 / 新题型 / 翻译 / 作文）一行。
-- 交卷前 answers 是草稿，交卷后锁定并记分；重做就删行。本库是唯一真相
CREATE TABLE IF NOT EXISTS exam_attempts (
  exam_id      TEXT NOT NULL,
  section_id   TEXT NOT NULL,
  answers      TEXT NOT NULL DEFAULT '{}',   -- JSON：选择题 {"1":"C"}，主观题 {"text":"…"}
  submitted_at TEXT,                         -- ISO 时间；NULL = 还在作答
  score        REAL,
  total        REAL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (exam_id, section_id)
);

-- 真题里划的句子（荧光笔）。写进 英语/语法/真题例句.md 是投影，本表是真相
CREATE TABLE IF NOT EXISTS exam_marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id    TEXT NOT NULL,
  section_id TEXT NOT NULL,
  q          INTEGER,                    -- 所在题号，划在正文上时为空
  text       TEXT NOT NULL,              -- 划中的原句（空白已归一）
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (exam_id, section_id, text)
);
CREATE INDEX IF NOT EXISTS idx_exam_marks_exam ON exam_marks(exam_id);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/**
 * 中文没有词边界，unicode61 分词器切不开；trigram 把「特征值」这类词拆成
 * 三字滑窗，中英文都能命中子串。代价是**查询词必须 ≥ 3 个字符**，所以
 * 「矩阵」「极限」这种两字词由 search() 退回 LIKE 处理（见 query.js）。
 * 不用 content='' 的无内容表：那种表删行要重放原值，得不偿失。
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  id UNINDEXED, title, tags, headings, plain,
  tokenize = 'trigram'
);
`;

export function open() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  /* CREATE TABLE IF NOT EXISTS 不会给已有的库补列，老库要单独 ALTER 一次。
     列已存在时 SQLite 直接报错，吞掉即可——这里没有别的失败可能 */
  try { db.exec('ALTER TABLE notes ADD COLUMN reviewable INTEGER NOT NULL DEFAULT 1'); } catch { /* 已经有了 */ }
  try {
    db.exec(FTS_SCHEMA);
    db.prepare('SELECT rowid FROM notes_fts LIMIT 1').get();
    setMeta('fts', '1');
  } catch {
    setMeta('fts', '0');
  }
  return db;
}

export const handle = () => db || open();
export const hasFts = () => getMeta('fts') === '1';

export function close() {
  if (!db) return;
  try { db.close(); } catch { /* 已经关了 */ }
  db = null;
}

export const getMeta = (k) => handle().prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
export const setMeta = (k, v) =>
  handle().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));

/** 把一组语句放进一个事务；批量重建索引时快一个数量级 */
export function tx(fn) {
  const d = handle();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* 回滚失败也要抛原始错误 */ }
    throw err;
  }
}
