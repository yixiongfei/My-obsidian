import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_ROOT } from '../config.js';
import { todayStr, addDays } from './review.js';
import * as vdb from './vocabulary-db.js';

/**
 * 英语词汇 Anki：种子、迁移、队列、评分、Markdown 投影。
 *
 * 真相层次：
 *   vocabulary.db  —— 词汇进度的唯一真相，公开词表种子恢复不了个人排期
 *   Markdown 日志  —— 只是给 Obsidian 看的可浏览投影，随时可以重建
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');

const DECK_NAME = '考研英语一';
const SESSION_DUE_LIMIT = 100;
const SESSION_NEW_LIMIT = 20;
const GRADUATED_DUE = '9999-12-31';
const RATINGS = new Set(['again', 'hard', 'good', 'easy']);

const VOCAB_LOG_DIR = '英语/词汇复习';
const DIRTY_PREFIX = 'md_dirty:';
const IDLE_FLUSH_MS = 30_000;

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

/* ══════════════════════════════════════════════════════════════
 * 一、种子
 * ══════════════════════════════════════════════════════════════ */

/**
 * 幂等地把公开词表灌进库里。
 * 只补充字典内容（释义、例句、音标），**绝不碰 vocab_cards**——
 * 那里是个人排期，种子恢复不了，覆盖一次就永久丢了。
 */
export function seed() {
  const words = readJson('ecdict-ky.json');
  const ex = readJson('tatoeba-ky-examples.json');
  const stamp = `${words.commit}:${words.count}:${ex.inputSha256?.slice(0, 12)}`;
  if (vdb.getMeta('seed_stamp') === stamp) return { skipped: true, count: words.count };

  return vdb.tx((d) => {
    d.prepare(`INSERT INTO vocab_sources (name, version, license, url) VALUES (?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET version = excluded.version`)
      .run('ECDICT', words.commit, words.license, words.url);
    d.prepare(`INSERT INTO vocab_sources (name, version, license, url) VALUES (?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET version = excluded.version`)
      .run('Tatoeba', ex.inputSha256 || '', ex.license, ex.url);
    d.prepare('INSERT INTO vocab_decks (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(DECK_NAME);

    const srcId = d.prepare('SELECT id FROM vocab_sources WHERE name = ?').get('ECDICT').id;
    const deckId = d.prepare('SELECT id FROM vocab_decks WHERE name = ?').get(DECK_NAME).id;

    const upWord = d.prepare(`
      INSERT INTO vocab_words (term_key, term, phonetic, frequency, translation, definition, source_id, deck_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(term_key) DO UPDATE SET
        term = excluded.term, phonetic = excluded.phonetic, frequency = excluded.frequency,
        translation = excluded.translation, definition = excluded.definition
      WHERE vocab_words.user_edited = 0`);
    const getId = d.prepare('SELECT id, user_edited FROM vocab_words WHERE term_key = ?');
    const delSenses = d.prepare('DELETE FROM vocab_senses WHERE word_id = ?');
    const insSense = d.prepare('INSERT INTO vocab_senses (word_id, ord, pos, gloss) VALUES (?, ?, ?, ?)');
    const delEx = d.prepare('DELETE FROM vocab_examples WHERE word_id = ?');
    const insEx = d.prepare(`INSERT INTO vocab_examples (word_id, text, translation, source, license, ref_id, url)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // 卡片只在缺失时创建，已存在的一律不动
    const insCard = d.prepare('INSERT INTO vocab_cards (word_id) VALUES (?) ON CONFLICT(word_id) DO NOTHING');
    const insTag = d.prepare('INSERT INTO vocab_tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING');
    const getTag = d.prepare('SELECT id FROM vocab_tags WHERE name = ?');
    const linkTag = d.prepare('INSERT INTO vocab_word_tags (word_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING');

    for (const e of words.entries) {
      upWord.run(e.termKey, e.term, e.phonetic || '', e.frequency || 0,
        e.translation || '', e.definition || '', srcId, deckId);
      const { id, user_edited: edited } = getId.get(e.termKey);
      insCard.run(id);
      for (const t of e.tags || []) {
        insTag.run(t);
        linkTag.run(id, getTag.get(t).id);
      }
      // 人工改过释义 / 例句的词，字典内容以人工为准
      if (edited) continue;

      delSenses.run(id);
      (e.senses || []).forEach((s, i) => insSense.run(id, i, s.pos || '', s.gloss));

      delEx.run(id);
      const one = ex.examples?.[e.termKey];
      if (one) insEx.run(id, one.text, one.translation || '', one.source || '', one.license || '', one.sentenceId ?? null, one.url || '');
    }

    d.prepare(`INSERT INTO vocab_meta (k, v) VALUES ('seed_stamp', ?)
               ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(stamp);
    return { skipped: false, count: words.entries.length };
  });
}

/* ══════════════════════════════════════════════════════════════
 * 二、从旧 index.db 迁移
 * ══════════════════════════════════════════════════════════════ */

/**
 * 兼容旧 index.db 里可能存在的 vocab_* 表。绝不删除旧表——它是回退证据。
 *
 * 迁移与"已迁移"标记必须在同一个目标库事务里：分成两步的话，
 * 中断会留下"数据进了一半、标记没写"的状态，下次启动会重复迁移。
 *
 * @returns {{status: string, moved?: number, reason?: string}}
 */
export function migrateFromIndexDb(indexDb) {
  if (vdb.getMeta('migrated_from_index') === '1') return { status: 'already' };

  let hasOld = false;
  try {
    hasOld = !!indexDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vocab_cards'",
    ).get();
  } catch { hasOld = false; }
  if (!hasOld) {
    vdb.setMeta('migrated_from_index', '1');
    return { status: 'nothing-to-migrate' };
  }

  const d = vdb.handle();
  const newCount = d.prepare('SELECT COUNT(*) AS n FROM vocab_words').get().n;

  if (newCount > 0) {
    /* 新库里已经有词条却没有迁移标记。只有一种情况可以安全继续：
       它是刚 seed 出来的纯净基线——没有任何复习历史、卡片全是 pristine new。
       否则说明两边都有学习痕迹，我们无法判断该以哪份为准，只能停下让人工核对。 */
    const reviews = d.prepare('SELECT COUNT(*) AS n FROM vocab_reviews').get().n;
    const touched = d.prepare(
      "SELECT COUNT(*) AS n FROM vocab_cards WHERE state <> 'new' OR repetitions > 0 OR lapses > 0 OR last_review IS NOT NULL",
    ).get().n;
    if (reviews > 0 || touched > 0) {
      return {
        status: 'conflict',
        reason: '新库里已经有复习痕迹，旧 index.db 里也有 vocab_* 表。'
          + '无法判断该以哪一份进度为准，迁移已停止。请先备份 .kb/ 下的两个 .db 文件后人工核对。',
      };
    }
  }

  let oldRows;
  try {
    oldRows = indexDb.prepare(`
      SELECT c.*, w.term AS term, w.term_key AS term_key
      FROM vocab_cards c JOIN vocab_words w ON w.id = c.word_id`).all();
  } catch (err) {
    return { status: 'conflict', reason: `旧表结构无法识别：${err.message}` };
  }

  return vdb.tx((t) => {
    const findWord = t.prepare('SELECT id FROM vocab_words WHERE term_key = ?');
    const upCard = t.prepare(`
      INSERT INTO vocab_cards (word_id, state, due, interval, repetitions, ease, lapses, last_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(word_id) DO UPDATE SET
        state = excluded.state, due = excluded.due, interval = excluded.interval,
        repetitions = excluded.repetitions, ease = excluded.ease,
        lapses = excluded.lapses, last_review = excluded.last_review`);

    let moved = 0;
    for (const r of oldRows) {
      const w = findWord.get(r.term_key || String(r.term || '').toLowerCase());
      if (!w) continue;
      // 旧数据里最后一次被标 easy 的卡，按新模型就是"已掌握"
      const graduated = r.state === 'mastered' || r.last_rating === 'easy';
      upCard.run(
        w.id,
        graduated ? 'mastered' : (r.state || 'new'),
        graduated ? GRADUATED_DUE : (r.due || '1970-01-01'),
        r.interval || 0, r.repetitions || 0, r.ease || 2.5, r.lapses || 0,
        r.last_review || null,
      );
      moved += 1;
    }

    try {
      const hist = indexDb.prepare('SELECT * FROM vocab_reviews').all();
      const insRev = t.prepare(`
        INSERT INTO vocab_reviews (word_id, date, at, rating, interval_after, ease_after, state_after)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const h of hist) {
        const w = findWord.get(h.term_key || '');
        if (!w) continue;
        insRev.run(w.id, h.date, h.at || `${h.date}T00:00:00.000Z`, h.rating || 'good',
          h.interval_after || 0, h.ease_after || 2.5, h.state_after || 'review');
      }
    } catch { /* 旧库没有历史表，只迁卡片 */ }

    t.prepare(`INSERT INTO vocab_meta (k, v) VALUES ('migrated_from_index', '1')
               ON CONFLICT(k) DO UPDATE SET v = '1'`).run();
    return { status: 'migrated', moved };
  });
}

/* ══════════════════════════════════════════════════════════════
 * 三、队列
 * ══════════════════════════════════════════════════════════════ */

const CARD_SELECT = `
  SELECT w.id, w.term, w.term_key, w.phonetic, w.frequency, w.translation, w.definition,
         c.state, c.due, c.interval, c.repetitions, c.ease, c.lapses, c.last_review, c.important
  FROM vocab_words w JOIN vocab_cards c ON c.word_id = w.id`;

function decorate(d, row, today) {
  const senses = d.prepare('SELECT pos, gloss FROM vocab_senses WHERE word_id = ? ORDER BY ord').all(row.id);
  const examples = d.prepare('SELECT id, text, translation, source, license, ref_id, url FROM vocab_examples WHERE word_id = ? ORDER BY id').all(row.id);
  const ex = examples[0];
  const tags = d.prepare(
    'SELECT t.name FROM vocab_tags t JOIN vocab_word_tags wt ON wt.tag_id = t.id WHERE wt.word_id = ? LIMIT 5',
  ).all(row.id).map((t) => t.name);

  /* 只有真正排过期的卡才谈得上逾期。
     新卡的 due 是占位的 1970-01-01，直接拿去减会算出两万多天 */
  const scheduled = row.state !== 'new' && row.state !== 'mastered';
  const overdueDays = scheduled && row.due && row.due < today
    ? Math.round((Date.parse(today) - Date.parse(row.due)) / 86400000) : 0;

  return {
    type: 'word',
    id: row.id,
    term: row.term,
    phonetic: row.phonetic,
    frequency: row.frequency,
    senses,
    // 旧前端可能还在读这两个字段，保留以免卡背空白
    meanings: senses.map((s) => [s.pos, s.gloss].filter(Boolean).join(' ')),
    translation: row.translation,
    definition: row.definition,
    example: ex || null,
    examples,
    tags,
    state: row.state,
    due: scheduled ? row.due : null,
    interval: row.interval,
    reviewCount: row.repetitions,
    lapses: row.lapses,
    important: !!row.important,
    overdueDays,
  };
}

/**
 * 取一轮的词卡：最多 100 张到期 + 最多 20 个新词。
 * 一轮开始后前端只从这份快照里移除，不再补词——中途补入会让
 * "本轮还剩几张"一直在变，用户永远看不到尽头。
 */
export function buildQueue() {
  const d = vdb.handle();
  const today = todayStr();

  const due = d.prepare(`${CARD_SELECT}
    WHERE c.state <> 'mastered' AND c.state <> 'new' AND c.due <= ?
    ORDER BY c.due ASC, c.important DESC, w.frequency DESC, w.term ASC LIMIT ?`).all(today, SESSION_DUE_LIMIT);

  // 标注词（真题里双击标的、手动加的）插队排在新词最前面
  const fresh = d.prepare(`${CARD_SELECT}
    WHERE c.state = 'new'
    ORDER BY c.important DESC, w.frequency DESC, w.term ASC LIMIT ?`).all(SESSION_NEW_LIMIT);

  const counts = d.prepare(`
    SELECT
      SUM(CASE WHEN state <> 'mastered' AND state <> 'new' AND due <= ? THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS new,
      SUM(CASE WHEN state <> 'mastered' AND state <> 'new' AND due > ? THEN 1 ELSE 0 END) AS upcoming,
      SUM(CASE WHEN state = 'mastered' THEN 1 ELSE 0 END) AS mastered,
      SUM(CASE WHEN important = 1 AND state <> 'mastered' THEN 1 ELSE 0 END) AS important,
      COUNT(*) AS total
    FROM vocab_cards`).get(today, today);

  return {
    today,
    source: 'vocabulary.db',
    cards: [...due, ...fresh].map((r) => decorate(d, r, today)),
    counts: {
      words: {
        due: counts.due || 0,
        new: counts.new || 0,
        upcoming: counts.upcoming || 0,
        mastered: counts.mastered || 0,
        important: counts.important || 0,
        total: counts.total || 0,
        sessionNewLimit: SESSION_NEW_LIMIT,
      },
    },
  };
}

/** 首页阶梯用的词汇进度：学过（进过队列、评过分）的词 / 词表总数 */
export function progress() {
  const r = vdb.handle().prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN state <> 'new' THEN 1 ELSE 0 END) AS learned,
           SUM(CASE WHEN state = 'mastered' THEN 1 ELSE 0 END) AS mastered
    FROM vocab_cards`).get();
  return { total: r.total || 0, learned: r.learned || 0, mastered: r.mastered || 0 };
}

/* ══════════════════════════════════════════════════════════════
 * 四、评分
 * ══════════════════════════════════════════════════════════════ */

/**
 * 四档评分。卡片状态与审计历史写在同一个事务里——
 * 只写一半的话，"这词今天到底复习过没有"就永远说不清了。
 *
 * @throws {Error & {code:'NOT_FOUND'|'GRADUATED'|'BAD_RATING'}}
 */
export function rate(wordId, rating) {
  if (!RATINGS.has(rating)) {
    const e = new Error(`rating 只能是 ${[...RATINGS].join(' / ')}`);
    e.code = 'BAD_RATING';
    throw e;
  }

  const today = todayStr();
  const now = new Date().toISOString();

  const out = vdb.tx((d) => {
    const card = d.prepare('SELECT * FROM vocab_cards WHERE word_id = ?').get(wordId);
    if (!card) { const e = new Error('没有这个词'); e.code = 'NOT_FOUND'; throw e; }
    if (card.state === 'mastered') { const e = new Error('这个词已经毕业'); e.code = 'GRADUATED'; throw e; }

    let { interval, repetitions, ease, lapses } = card;
    let state = 'review';

    if (rating === 'again') {
      // 间隔归零，让它在本轮之后仍然到期
      repetitions = 0;
      lapses += 1;
      interval = 0;
      ease = Math.max(1.3, ease - 0.2);
    } else if (rating === 'hard') {
      repetitions += 1;
      ease = Math.max(1.3, ease - 0.15);
      interval = Math.max(1, Math.round(interval * 1.2));
    } else if (rating === 'good') {
      repetitions += 1;
      interval = repetitions <= 1 ? 1 : Math.max(1, Math.round(Math.max(interval, 1) * ease));
    } else {
      repetitions += 1;
      ease = Math.min(3.2, ease + 0.15);
      state = 'mastered';
    }

    const due = state === 'mastered' ? GRADUATED_DUE : addDays(today, interval);

    d.prepare(`UPDATE vocab_cards SET state = ?, due = ?, interval = ?, repetitions = ?,
               ease = ?, lapses = ?, last_review = ? WHERE word_id = ?`)
      .run(state, due, interval, repetitions, ease, lapses, today, wordId);

    d.prepare(`INSERT INTO vocab_reviews (word_id, date, at, rating, interval_after, ease_after, state_after)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(wordId, today, now, rating, interval, ease, state);

    // 只落一个脏标记就返回。在这里写 Markdown 会让每次翻卡都等一次磁盘 IO
    d.prepare(`INSERT INTO vocab_meta (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = '1'`)
      .run(DIRTY_PREFIX + today);

    return { interval, ease, repetitions, lapses, state, due: state === 'mastered' ? null : due };
  });

  scheduleIdleFlush();
  return { ...out, graduated: out.state === 'mastered', markdownQueued: true };
}

/* ══════════════════════════════════════════════════════════════
 * 五、分析
 * ══════════════════════════════════════════════════════════════ */

/** 某天去重后的完成词数，供日历日视图使用 */
export function dailyCount(date) {
  const row = vdb.handle().prepare('SELECT done, mastered FROM v_vocab_daily WHERE date = ?').get(date);
  return { done: row?.done || 0, mastered: row?.mastered || 0 };
}

/** [from, to] 闭区间内每天去重后的完成词数，Map<日期, 数量>；供月历标"这天学过" */
export function dailyBetween(from, to) {
  return new Map(vdb.handle().prepare('SELECT date, done FROM v_vocab_daily WHERE date BETWEEN ? AND ?').all(from, to)
    .map((r) => [r.date, r.done || 0]));
}

export function overview() {
  const d = vdb.handle();
  const today = todayStr();

  const deck = d.prepare(`
    SELECT SUM(CASE WHEN state = 'new' THEN 1 ELSE 0 END) AS new,
           SUM(CASE WHEN state = 'review' THEN 1 ELSE 0 END) AS review,
           SUM(CASE WHEN state = 'mastered' THEN 1 ELSE 0 END) AS mastered,
           COUNT(*) AS total
    FROM vocab_cards`).get();

  const byPos = d.prepare(`
    SELECT s.pos AS pos, COUNT(DISTINCT s.word_id) AS total,
           SUM(CASE WHEN c.state = 'mastered' THEN 1 ELSE 0 END) AS mastered
    FROM vocab_senses s JOIN vocab_cards c ON c.word_id = s.word_id
    WHERE s.ord = 0 AND s.pos <> ''
    GROUP BY s.pos ORDER BY total DESC LIMIT 12`).all();

  const since = addDays(today, -89);
  const trend = d.prepare('SELECT date, done, mastered FROM v_vocab_daily WHERE date >= ? ORDER BY date').all(since);

  const weak = d.prepare(`
    SELECT term, reviews, agains, hards, lapses, state, last_date
    FROM v_vocab_word_stats
    WHERE reviews > 0
    ORDER BY agains DESC, hards DESC, lapses DESC, reviews DESC
    LIMIT 30`).all();

  return { today, deck, byPos, trend, weak };
}

/* ══════════════════════════════════════════════════════════════
 * 六、Markdown 投影
 * ══════════════════════════════════════════════════════════════ */

const dirtyDates = () => vdb.handle()
  .prepare("SELECT k FROM vocab_meta WHERE k LIKE ?").all(`${DIRTY_PREFIX}%`)
  .map((r) => r.k.slice(DIRTY_PREFIX.length));

/* ── 一周一个文件 ────────────────────────────────────────
   按天建文件一个月就是三十个，翻起来太碎；改成 ISO 周（周一起）一份，
   周内各天按日期排成小节。文件名 2026-W37.md，方便按名字排序。 */

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** 某天所属的 ISO 周：{ key, start, end, year, week } */
export function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;                     // 周一 1 … 周日 7
  const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow + 1);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((thursday - jan1) / 86400000 + 1) / 7);
  return { key: `${year}-W${pad2(week)}`, start: ymd(monday), end: ymd(sunday), year, week };
}

const logPath = (weekKey) => path.join(VAULT_ROOT, VOCAB_LOG_DIR, `${weekKey}.md`);

const FRONTMATTER = (w) => `---
title: ${w.year} 年第 ${w.week} 周 英语词汇复习
tags: [英语, 词汇, 复习]
created: ${w.start}
week: ${w.key}
kind: vocabulary-review-log
reviewable: false
---
`;

const AUTO_START = '<!-- kb:vocab:start -->';
const AUTO_END = '<!-- kb:vocab:end -->';
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 一周的自动区：每天一小节，按日期排；同一个词当天多次评分只算一个、以最后一次为准 */
function renderAuto(w) {
  const d = vdb.handle();
  const dates = d.prepare('SELECT DISTINCT date FROM vocab_reviews WHERE date BETWEEN ? AND ? ORDER BY date').all(w.start, w.end).map((r) => r.date);
  const dayRows = d.prepare(`
    SELECT w.term AS term, r.rating AS rating, w.id AS word_id
    FROM (
      SELECT word_id, rating,
             ROW_NUMBER() OVER (PARTITION BY word_id ORDER BY at DESC, id DESC) AS rn
      FROM vocab_reviews WHERE date = ?
    ) r JOIN vocab_words w ON w.id = r.word_id
    WHERE r.rn = 1
    ORDER BY w.term`);
  const glossOf = d.prepare('SELECT pos, gloss FROM vocab_senses WHERE word_id = ? ORDER BY ord LIMIT 3');
  const label = { again: '重来', hard: '困难', good: '掌握', easy: '轻松' };

  let total = 0; let mastered = 0;
  const days = dates.map((date) => {
    const rows = dayRows.all(date);
    total += rows.length;
    mastered += rows.filter((r) => r.rating === 'easy').length;
    return { date, rows };
  });

  const lines = [
    AUTO_START,
    '',
    `本周（${w.start.slice(5).replace('-', '.')} – ${w.end.slice(5).replace('-', '.')}）完成 **${total}** 个词，其中标为「轻松」已掌握 **${mastered}** 个。`,
    '',
  ];
  for (const { date, rows } of days) {
    const wd = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
    lines.push(`### ${date.replaceAll('-', '.')} 周${wd} · ${rows.length} 个词`, '', '| 单词 | 释义 | 评分 |', '| --- | --- | --- |');
    for (const r of rows) {
      const gloss = glossOf.all(r.word_id)
        .map((s) => [s.pos, s.gloss].filter(Boolean).join(' ')).join('；')
        .replace(/\|/g, '\\|');
      lines.push(`| ${r.term} | ${gloss} | ${label[r.rating] || r.rating} |`);
    }
    lines.push('');
  }
  lines.push(AUTO_END);
  return lines.join('\n');
}

/** 同一周的写入串行化，防止并发覆盖 */
const writing = new Map();

async function writeLog(weekKey) {
  const prev = writing.get(weekKey) || Promise.resolve();
  const job = prev.then(() => writeLogOnce(weekKey)).catch(() => {});
  writing.set(weekKey, job);
  await job;
  if (writing.get(weekKey) === job) writing.delete(weekKey);
}

/** 由 2026-W37 反推这一周：ISO 第 1 周是 1 月 4 日所在的那周，往后数 */
function weekFromKey(key) {
  const first = weekOf(`${key.slice(0, 4)}-01-04`);
  const monday = new Date(`${first.start}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() + (Number(key.slice(6)) - 1) * 7);
  return weekOf(ymd(monday));
}

async function writeLogOnce(weekKey) {
  const week = weekFromKey(weekKey);
  const file = logPath(week.key);
  await fsp.mkdir(path.dirname(file), { recursive: true });

  let existing = '';
  try { existing = await fsp.readFile(file, 'utf8'); } catch { /* 首次写入 */ }

  const auto = renderAuto(week);
  let body;
  if (existing.includes(AUTO_START) && existing.includes(AUTO_END)) {
    // 只替换自动区，用户在区外写的手记原样保留
    const head = existing.slice(0, existing.indexOf(AUTO_START));
    const tail = existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length);
    body = head + auto + tail;
  } else if (existing) {
    body = `${existing.trimEnd()}\n\n${auto}\n`;
  } else {
    body = `${FRONTMATTER(week)}\n## 手写笔记\n\n（这一块不会被自动覆盖，随便写）\n\n${auto}\n`;
  }

  // 临时文件 + 原子 rename：半截文件会被 Obsidian 和索引器同时读到
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, file);
  return file;
}

let idleTimer = null;

/** 连续复习期间，30 秒没有新操作就把当天的评分合并写一次 */
function scheduleIdleFlush() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; flush().catch(() => {}); }, IDLE_FLUSH_MS);
  idleTimer.unref?.();
}

/**
 * 把所有脏日期所在的周写成 Markdown。返回已处理的日期，不等磁盘。
 *
 * 脏标记只在这一次任务**自己认领的日期**写完后才清：
 * 如果直接清空全部标记，写盘期间新产生的评分就会被静默丢掉。
 */
export async function flush() {
  const dates = dirtyDates();
  if (!dates.length) return [];
  const weeks = [...new Set(dates.map((d) => weekOf(d).key))];
  for (const key of weeks) await writeLog(key);
  for (const date of dates) vdb.delMeta(DIRTY_PREFIX + date);
  return dates;
}

/**
 * 早期是一天一个文件（2026-09-11.md）。启动时把**没有手写内容**的日文件收进周文件：
 * 正文剥掉自动区后只剩默认脚手架的，删掉并把那天标脏；写过手记的原样留着，不动。
 */
export async function migrateDailyLogs() {
  const dir = path.join(VAULT_ROOT, VOCAB_LOG_DIR);
  let files = [];
  try { files = await fsp.readdir(dir); } catch { return []; }
  const moved = [];
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
    if (!m) continue;
    let text = '';
    try { text = await fsp.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const a = text.indexOf(AUTO_START); const b = text.indexOf(AUTO_END);
    const rest = (a >= 0 && b >= 0 ? text.slice(0, a) + text.slice(b + AUTO_END.length) : text)
      .replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim();
    if (rest !== '## 手写笔记 （这一块不会被自动覆盖，随便写）') continue;
    await fsp.unlink(path.join(dir, f));
    vdb.setMeta(DIRTY_PREFIX + m[1], '1');
    moved.push(m[1]);
  }
  if (moved.length) await flush();
  return moved;
}

/** 进程意外退出时脏标记会留在库里，下次启动把欠的账补上 */
export function recoverPendingLogs() {
  const dates = dirtyDates();
  if (dates.length) flush().catch(() => {});
  return dates;
}

export const pendingDates = dirtyDates;
export { GRADUATED_DUE, SESSION_DUE_LIMIT, SESSION_NEW_LIMIT, VOCAB_LOG_DIR };
