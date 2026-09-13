#!/usr/bin/env node
/**
 * 生成考研词表种子 app/server/data/ecdict-ky.json。
 *
 * 词表本身来自 server/data/lists/ 下三份清单的并集（不再用 ECDICT 的 ky 标签）：
 *   syllabus-2025.txt      2025 英语（一）大纲词汇
 *   zhenti-2025.txt        《考研真相》真题词汇篇（按章节：高频 / 中频 / 低频 / 基础 / 超纲）
 *   netem_full_list.json   exam-data/NETEMVocabulary 的 5530 词真题词频（CC BY-NC-SA 4.0）
 * ECDICT 只负责给每个词补音标、释义、义项。
 *
 * 每个词带三个记忆用的字段：
 *   frequency  NETEM 真题词频（次数，越大越常考；不在 NETEM 里的为 0）
 *   tier       core（真题 40 次以上）/ mid（10–39）/ low（1–9）/ extra（真题里出现过的超纲、派生词）/ basic（the、family 这类基础词）
 *   rank       排队顺序：core → mid → low → extra，同档按词频降序；basic 排最后且默认不进队列
 *
 * 用法：
 *   node scripts/import-ecdict-ky.mjs [ecdict.csv 的路径]
 *   不给路径就从下面钉死的 commit 下载（约 66MB）。
 *
 * 为什么钉 commit 而不是 master：ECDICT 会持续更新词条和标签，
 * 跟着 master 走会让每次重新生成的种子都不一样，对不上账。
 *
 * 数据来源：ECDICT (https://github.com/skywind3000/ECDICT)，MIT License。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../server/data/ecdict-ky.json');
const LISTS = path.resolve(__dirname, '../server/data/lists');
const LIST_VERSION = '2025-syllabus+zhenti+netem';

const ECDICT_COMMIT = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b';
const ECDICT_URL = `https://raw.githubusercontent.com/skywind3000/ECDICT/${ECDICT_COMMIT}/ecdict.csv`;

/** 无词性的词条兜底补一个，数量很少，够用即可 */
const POS_FALLBACK = new Map(Object.entries({
  n: 'n.', v: 'v.', adj: 'adj.', adv: 'adv.', prep: 'prep.',
  conj: 'conj.', pron: 'pron.', art: 'art.', num: 'num.', int: 'int.',
}));

/** ECDICT 的 translation 里词性前缀形如 "n. 名词释义" / "vt. ..." */
const POS_LINE = /^\s*((?:[a-z]{1,5}\.\s*)+)\s*(.+)$/i;

/**
 * CSV 行解析。ECDICT 的字段里有逗号和转义双引号，不能直接 split(',')。
 * 只需要按 RFC4180 处理引号包裹和 "" 转义即可。
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * tag 字段是空格分隔的标签集合，如 "zk gk ky cet4"。
 * 必须按 token 精确匹配：用 includes('ky') 会把 "ky" 之外的东西也算进来
 * （例如将来出现 "kyx" 这类标签），词表规模就对不上了。
 */

const norm = (t) => String(t || '').trim().toLowerCase().replace(/[’']/g, "'");
const readList = (name) => fs.readFileSync(path.join(LISTS, name), 'utf8').replace(/^\uFEFF/, '')
  .split(/\r?\n/).map(norm).filter(Boolean);

/**
 * 目标词表：并集，附 tier / frequency。
 * 《考研真相》的行号就是章节：1–978 高频、979–1970 中频、1971–3819 低频、3820–5648 基础、5649– 超纲派生。
 * tier 以 NETEM 词频为准（40 次以上 core，10–39 mid，1–9 low），基础章的词一律 basic，
 * 只出现在超纲章、NETEM 里又没有的记 extra。
 */
function targetWords() {
  const syllabus = readList('syllabus-2025.txt');
  const zhenti = readList('zhenti-2025.txt');
  const netem = JSON.parse(fs.readFileSync(path.join(LISTS, 'netem_full_list.json'), 'utf8'))['5530考研词汇词频排序表'];
  const freq = new Map();
  const gloss = new Map();
  for (const row of netem) {
    const k = norm(row.单词);
    freq.set(k, Math.max(freq.get(k) || 0, Number(row.词频) || 0));
    if (row.释义 && !gloss.has(k)) gloss.set(k, String(row.释义).trim());
  }
  // ECDICT / NETEM 都没有的合成词，用项目手写的释义（lists/glosses.json）
  const manual = JSON.parse(fs.readFileSync(path.join(LISTS, 'glosses.json'), 'utf8')).glosses || {};
  for (const [k, g] of Object.entries(manual)) if (!gloss.has(norm(k))) gloss.set(norm(k), g);
  const chapter = new Map();
  zhenti.forEach((w, i) => {
    const n = i + 1;
    const ch = n <= 978 ? 'high' : n <= 1970 ? 'mid' : n <= 3819 ? 'low' : n <= 5648 ? 'basic' : 'extra';
    if (!chapter.has(w)) chapter.set(w, ch);
  });
  const out = new Map();
  for (const w of [...syllabus, ...zhenti]) {
    if (out.has(w)) continue;
    const f = freq.get(w) || 0;
    const ch = chapter.get(w);
    let tier;
    if (ch === 'basic') tier = 'basic';
    else if (f >= 40) tier = 'core';
    else if (f >= 10) tier = 'mid';
    else if (f >= 1) tier = 'low';
    else tier = ch === 'extra' || !chapter.has(w) ? 'extra' : 'low';
    out.set(w, { tier, frequency: f, netemGloss: gloss.get(w) || '', inSyllabus: syllabus.includes(w), inZhenti: chapter.has(w) });
  }
  return out;
}

const TIER_ORDER = { core: 0, mid: 1, low: 2, extra: 3, basic: 4 };

/** 把多行 translation 按词性分组，每词最多 3 个义项、每义项最多 3 个短语 */
function parseSenses(translation) {
  const senses = [];
  for (const raw of (translation || '').split(/\\n|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(POS_LINE);
    let pos = '';
    let text = line;
    if (m) {
      pos = m[1].trim().replace(/\s+/g, ' ');
      text = m[2].trim();
    }
    if (!pos) {
      const guess = line.match(/^([a-z]{1,5})[\s.]/i);
      pos = (guess && POS_FALLBACK.get(guess[1].toLowerCase())) || '';
    }
    const phrases = text.split(/[；;，,]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
    if (!phrases.length) continue;
    senses.push({ pos, gloss: phrases.join('；') });
    if (senses.length >= 3) break;
  }
  return senses;
}

/** 释义、音标、词频都更全的那条留下 */
function richer(a, b) {
  const score = (r) => (r.translation?.length || 0) + (r.phonetic ? 30 : 0)
    + (r.definition?.length ? 20 : 0) + (r.frequency > 0 ? 10 : 0);
  return score(b) > score(a) ? b : a;
}

async function ensureCsv(argPath) {
  if (argPath) {
    if (!fs.existsSync(argPath)) throw new Error(`找不到文件：${argPath}`);
    return argPath;
  }
  const cache = path.join(process.env.TEMP || '/tmp', `ecdict-${ECDICT_COMMIT.slice(0, 8)}.csv`);
  if (fs.existsSync(cache) && fs.statSync(cache).size > 60_000_000) {
    console.log(`使用缓存：${cache}`);
    return cache;
  }
  console.log(`下载 ECDICT（约 66MB）…\n  ${ECDICT_URL}`);
  const res = await fetch(ECDICT_URL);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  return cache;
}

async function main() {
  const csv = await ensureCsv(process.argv[2]);
  const rl = readline.createInterface({ input: fs.createReadStream(csv, 'utf8'), crlfDelay: Infinity });

  let header = null;
  let idx = null;
  let scanned = 0;
  const byKey = new Map();
  const target = targetWords();
  console.log(`目标词表 ${target.size} 条（大纲 ∪ 真题词汇），开始扫 ECDICT…`);

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!header) {
      header = parseCsvLine(line).map((h) => h.trim());
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      for (const need of ['word', 'translation', 'tag']) {
        if (!(need in idx)) throw new Error(`CSV 缺少列：${need}`);
      }
      continue;
    }
    scanned += 1;
    const f = parseCsvLine(line);
    const word = (f[idx.word] || '').trim();
    const key = norm(word);
    if (!word || !target.has(key)) continue;
    const rec = {
      term: word,
      termKey: key,
      phonetic: (f[idx.phonetic] || '').trim(),
      translation: (f[idx.translation] || '').trim(),
      definition: (f[idx.definition] || '').trim(),
      // ECDICT 自己的语料词频留着做兜底排序用
      corpusFreq: Number(f[idx.frq] || 0) || 0,
    };
    const prev = byKey.get(rec.termKey);
    byKey.set(rec.termKey, prev ? richer(prev, rec) : rec);
  }

  // ECDICT 里没有的（多是真题里的合成词、派生词），用 NETEM 的释义或空释义占位，等人工在单词列表里补
  let missing = 0;
  for (const [key, t] of target) {
    if (byKey.has(key)) continue;
    missing += 1;
    byKey.set(key, { term: key, termKey: key, phonetic: '', translation: t.netemGloss, definition: '', corpusFreq: 0 });
  }

  const entries = [...byKey.values()].map((r) => {
    const t = target.get(r.termKey);
    const senses = parseSenses(r.translation);
    if (!senses.length && t.netemGloss) senses.push({ pos: '', gloss: t.netemGloss });
    const tags = ['考研', '英语一'];
    if (t.inSyllabus) tags.push('大纲2025');
    if (t.inZhenti) tags.push('真题词汇');
    return { ...r, senses, frequency: t.frequency, tier: t.tier, tags };
  }).sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (b.frequency - a.frequency) || (b.corpusFreq - a.corpusFreq) || a.termKey.localeCompare(b.termKey))
    .map((e, i) => ({ ...e, rank: i + 1 }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    source: 'ECDICT',
    license: 'MIT',
    url: 'https://github.com/skywind3000/ECDICT',
    commit: ECDICT_COMMIT,
    lists: LIST_VERSION,
    filter: 'lists/syllabus-2025 ∪ lists/zhenti-2025, tier/frequency from NETEMVocabulary',
    generatedAt: new Date().toISOString().slice(0, 10),
    count: entries.length,
    tiers: Object.fromEntries(Object.keys(TIER_ORDER).map((t) => [t, entries.filter((e) => e.tier === t).length])),
    entries,
  }, null, 0), 'utf8');

  const noSense = entries.filter((e) => !e.senses.length).length;
  console.log(`扫描 ${scanned} 行，词表 ${entries.length} 条，ECDICT 没收的 ${missing} 条`);
  console.log('各档：', Object.entries(Object.fromEntries(Object.keys(TIER_ORDER).map((t) => [t, entries.filter((e) => e.tier === t).length]))).map(([k, v]) => `${k} ${v}`).join('，'));
  console.log(`没有解析出义项的：${noSense} 条`);
  console.log(`写入 ${OUT}（${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB）`);
}

main().catch((err) => { console.error(err); process.exit(1); });
