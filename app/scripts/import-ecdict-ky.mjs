#!/usr/bin/env node
/**
 * 从 ECDICT 里挑出考研词表，生成离线种子 app/server/data/ecdict-ky.json。
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
const hasKy = (tag) => (tag || '').split(/\s+/).includes('ky');

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
    if (!hasKy(f[idx.tag])) continue;

    const word = (f[idx.word] || '').trim();
    if (!word) continue;
    const rec = {
      term: word,
      termKey: word.toLowerCase(),
      phonetic: (f[idx.phonetic] || '').trim(),
      translation: (f[idx.translation] || '').trim(),
      definition: (f[idx.definition] || '').trim(),
      frequency: Number(f[idx.frq] || 0) || 0,
      tags: ['考研', '英语一', 'ECDICT'],
    };
    const prev = byKey.get(rec.termKey);
    byKey.set(rec.termKey, prev ? richer(prev, rec) : rec);
  }

  const entries = [...byKey.values()]
    .map((r) => ({ ...r, senses: parseSenses(r.translation) }))
    .sort((a, b) => (b.frequency - a.frequency) || a.termKey.localeCompare(b.termKey));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    source: 'ECDICT',
    license: 'MIT',
    url: 'https://github.com/skywind3000/ECDICT',
    commit: ECDICT_COMMIT,
    filter: 'tag token == "ky"',
    generatedAt: new Date().toISOString().slice(0, 10),
    count: entries.length,
    entries,
  }, null, 0), 'utf8');

  const noSense = entries.filter((e) => !e.senses.length).length;
  console.log(`扫描 ${scanned} 行，命中 ky ${byKey.size} 条，去重后 ${entries.length} 条`);
  console.log(`没有解析出义项的：${noSense} 条`);
  console.log(`写入 ${OUT}（${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB）`);
}

main().catch((err) => { console.error(err); process.exit(1); });
