import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from '../config.js';

/**
 * 英语词汇的独立数据库。
 *
 * 为什么不跟 index.db 合用：
 *   index.db 是**派生索引层**——删掉它下次启动会从 Markdown 原样重建。
 *   而词汇的卡片排期和复习历史是**不可再生的个人数据**，公开词表种子恢复不了。
 *   两种生命周期完全不同的数据放一个库里，迟早会在"重建索引"时被误删。
 *
 * 所以：vocabulary.db 是词汇进度的唯一真相，词汇读写事务只发生在本库内，
 * 不跨 index.db 做混合事务。
 */

const DB_DIR = path.join(VAULT_ROOT, '.kb');
export const VOCAB_DB_PATH = process.env.KB_VOCAB_DB || path.join(DB_DIR, 'vocabulary.db');

export const SCHEMA_VERSION = 2;

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vocab_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS vocab_sources (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  url     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vocab_decks (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  note  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vocab_words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term_key   TEXT NOT NULL UNIQUE,      -- 小写词形，去重键
  term       TEXT NOT NULL,
  phonetic   TEXT NOT NULL DEFAULT '',
  frequency  INTEGER NOT NULL DEFAULT 0,
  translation TEXT NOT NULL DEFAULT '', -- ECDICT 原始释义，保留做兼容与回退
  definition  TEXT NOT NULL DEFAULT '', -- 英英释义
  source_id  INTEGER REFERENCES vocab_sources(id),
  deck_id    INTEGER REFERENCES vocab_decks(id)
);
CREATE INDEX IF NOT EXISTS idx_vw_freq ON vocab_words(frequency DESC);

-- 按词性拆开的常用义项，每词最多 3 条
CREATE TABLE IF NOT EXISTS vocab_senses (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  pos     TEXT NOT NULL DEFAULT '',
  gloss   TEXT NOT NULL,
  UNIQUE (word_id, ord)
);

/* 例句和义项分开存：ECDICT 的义项与 Tatoeba 的例句之间本来就没有对应关系，
   硬编成"每个义项配一条例句"是在捏造数据 */
CREATE TABLE IF NOT EXISTS vocab_examples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id     INTEGER NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  translation TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  license     TEXT NOT NULL DEFAULT '',
  ref_id      INTEGER,                  -- Tatoeba sentence id
  url         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ve_word ON vocab_examples(word_id);

CREATE TABLE IF NOT EXISTS vocab_tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS vocab_word_tags (
  word_id INTEGER NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES vocab_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (word_id, tag_id)
);

/* 卡片状态。state: new / review / mastered
   毕业词的 due 写 9999-12-31，这样"按到期日排序取前 N 条"这一条查询
   就能同时把毕业词排除掉，不用在每个查询里另加 state 判断 */
CREATE TABLE IF NOT EXISTS vocab_cards (
  word_id     INTEGER PRIMARY KEY REFERENCES vocab_words(id) ON DELETE CASCADE,
  state       TEXT NOT NULL DEFAULT 'new',
  due         TEXT NOT NULL DEFAULT '1970-01-01',
  interval    INTEGER NOT NULL DEFAULT 0,   -- 天
  repetitions INTEGER NOT NULL DEFAULT 0,
  ease        REAL NOT NULL DEFAULT 2.5,
  lapses      INTEGER NOT NULL DEFAULT 0,
  last_review TEXT
);
CREATE INDEX IF NOT EXISTS idx_vc_due   ON vocab_cards(due);
CREATE INDEX IF NOT EXISTS idx_vc_state ON vocab_cards(state);

CREATE TABLE IF NOT EXISTS vocab_sessions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT NOT NULL,
  ended   TEXT,
  note    TEXT NOT NULL DEFAULT ''
);

-- 每次评分的审计历史，只追加不修改
CREATE TABLE IF NOT EXISTS vocab_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id       INTEGER NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,           -- YYYY-MM-DD，本地日期
  at            TEXT NOT NULL,           -- ISO 时间戳
  rating        TEXT NOT NULL,           -- again / hard / good / easy
  interval_after INTEGER NOT NULL DEFAULT 0,
  ease_after    REAL NOT NULL DEFAULT 2.5,
  state_after   TEXT NOT NULL DEFAULT 'review',
  session_id    INTEGER REFERENCES vocab_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_vr_date ON vocab_reviews(date);
CREATE INDEX IF NOT EXISTS idx_vr_word ON vocab_reviews(word_id);

/* 每日完成量。
   同一个词同一天可能被评好几次（again 之后再 good），
   只取当天最后一次评分、且只计为一个完成词——否则"今天背了多少词"会虚高。 */
CREATE VIEW IF NOT EXISTS v_vocab_daily AS
SELECT date,
       COUNT(*) AS done,
       SUM(CASE WHEN rating = 'easy' THEN 1 ELSE 0 END) AS mastered
FROM (
  SELECT r.date, r.word_id, r.rating,
         ROW_NUMBER() OVER (PARTITION BY r.date, r.word_id ORDER BY r.at DESC, r.id DESC) AS rn
  FROM vocab_reviews r
)
WHERE rn = 1
GROUP BY date;

/* 单词维度的统计，用于"薄弱词"排序 */
CREATE VIEW IF NOT EXISTS v_vocab_word_stats AS
SELECT w.id AS word_id, w.term, w.term_key,
       COUNT(r.id) AS reviews,
       SUM(CASE WHEN r.rating = 'again' THEN 1 ELSE 0 END) AS agains,
       SUM(CASE WHEN r.rating = 'hard'  THEN 1 ELSE 0 END) AS hards,
       c.lapses AS lapses,
       c.state  AS state,
       MAX(r.date) AS last_date
FROM vocab_words w
LEFT JOIN vocab_reviews r ON r.word_id = w.id
LEFT JOIN vocab_cards   c ON c.word_id = w.id
GROUP BY w.id;
`;

export function open() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(VOCAB_DB_PATH);
  // 索引重建和批量 seed 期间可能有并发读，给一点等待余量
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  /* v2：标注词。important 是「我在真题里双击标出来的 / 手动加的」，排队时优先；
     marked_at 记哪天标的，进「今日」列表用；added_at 只有手动加的自定义词才有。
     CREATE TABLE IF NOT EXISTS 不会给老库补列，逐条 ALTER，列已存在就吞掉报错。 */
  for (const sql of [
    'ALTER TABLE vocab_cards ADD COLUMN important INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE vocab_cards ADD COLUMN marked_at TEXT',
    'ALTER TABLE vocab_cards ADD COLUMN mark_source TEXT',
    'ALTER TABLE vocab_words ADD COLUMN added_at TEXT',
  ]) {
    try { db.exec(sql); } catch { /* 已经有了 */ }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_vc_important ON vocab_cards(important)');
  setMeta('schema_version', SCHEMA_VERSION);
  return db;
}

export const handle = () => db || open();

export function close() {
  if (!db) return;
  try { db.close(); } catch { /* 已经关了 */ }
  db = null;
}

export const getMeta = (k) =>
  handle().prepare('SELECT v FROM vocab_meta WHERE k = ?').get(k)?.v ?? null;

export const setMeta = (k, v) =>
  handle().prepare(
    'INSERT INTO vocab_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).run(k, String(v));

export const delMeta = (k) => handle().prepare('DELETE FROM vocab_meta WHERE k = ?').run(k);

/** 本库内的事务。词汇的写入不允许跨 index.db，所以这里不接受外部 handle */
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
