#!/usr/bin/env node
/**
 * 给考研词表里的每个词配一条英文例句，生成 app/server/data/tatoeba-ky-examples.json。
 *
 * 用法：
 *   node scripts/import-tatoeba-ky-examples.mjs [eng_sentences.tsv.bz2 的路径]
 *   不给路径就从 Tatoeba 官方导出下载（约 25MB）。
 *
 * 依赖 seek-bzip 解压。它只在这个脚本里用，不进服务端和浏览器的运行时路径。
 *
 * 数据来源：Tatoeba (https://tatoeba.org)，CC BY 2.0 FR。
 * 每条例句都保留原始 sentence id 和可回溯 URL，满足署名要求。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORDS_IN = path.resolve(__dirname, '../server/data/ecdict-ky.json');
const PROJECT_IN = path.resolve(__dirname, '../server/data/project-examples.json');
const OUT = path.resolve(__dirname, '../server/data/tatoeba-ky-examples.json');
const TATOEBA_URL = 'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2';

const MIN_WORDS = 5;
const MAX_WORDS = 22;

/** 明显模板化 / 带噪声的句子，不适合当例句 */
const REJECT = [
  /https?:\/\//i,             // 链接
  /[^\x20-\x7E’‘“”—–]/,       // 非 ASCII 残留（乱码、其它语种混入）
  /\b(Tom|Mary|Tom's|Mary's)\b/,  // Tatoeba 里铺天盖地的 Tom/Mary 模板句
  /^\s*["']/,                 // 整句被引号包起来的对白
  /\b(\w+)\s+\1\b/i,          // 连续重复词，多半是坏数据
];

/** 中性陈述句优先：疑问句和感叹句排后面 */
function score(sentence, wordCount) {
  let s = 0;
  if (/[.]$/.test(sentence)) s += 3;
  if (/[?!]$/.test(sentence)) s -= 2;
  // 8~14 词最适合做卡背例句：够完整又不占版面
  s += 4 - Math.abs(wordCount - 11) * 0.4;
  if (/^[A-Z]/.test(sentence)) s += 1;
  return s;
}

async function ensureBz2(argPath) {
  if (argPath) {
    if (!fs.existsSync(argPath)) throw new Error(`找不到文件：${argPath}`);
    return argPath;
  }
  const cache = path.join(process.env.TEMP || '/tmp', 'eng_sentences.tsv.bz2');
  if (fs.existsSync(cache) && fs.statSync(cache).size > 20_000_000) {
    console.log(`使用缓存：${cache}`);
    return cache;
  }
  console.log(`下载 Tatoeba 英文导出（约 25MB）…\n  ${TATOEBA_URL}`);
  const res = await fetch(TATOEBA_URL);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  fs.writeFileSync(cache, Buffer.from(await res.arrayBuffer()));
  return cache;
}

async function main() {
  const bz2Path = await ensureBz2(process.argv[2]);
  const raw = fs.readFileSync(bz2Path);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  console.log(`输入包 SHA-256：${sha256}`);

  const { entries } = JSON.parse(fs.readFileSync(WORDS_IN, 'utf8'));
  // 只保留词表里的词，避免为 77 万句话建全量倒排
  const wanted = new Set(entries.map((e) => e.termKey));
  console.log(`词表 ${wanted.size} 条，开始解压…`);

  const bz = require('seek-bzip');
  const text = bz.decode(raw).toString('utf8');
  console.log(`解压完成，${(text.length / 1e6).toFixed(1)} MB`);

  /** termKey -> 当前最佳例句 */
  const best = new Map();
  let lines = 0;

  for (const line of text.split('\n')) {
    lines += 1;
    if (!line) continue;
    // 格式：id \t lang \t text
    const t1 = line.indexOf('\t');
    if (t1 < 0) continue;
    const t2 = line.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const id = line.slice(0, t1);
    const sentence = line.slice(t2 + 1).trim();
    if (!sentence) continue;

    const words = sentence.split(/\s+/);
    if (words.length < MIN_WORDS || words.length > MAX_WORDS) continue;
    if (REJECT.some((re) => re.test(sentence))) continue;

    const sc = score(sentence, words.length);
    // 大小写不敏感的精确 token 匹配：把标点剥掉再比，
    // 用 includes 会让 "cat" 命中 "category"，例句就完全对不上词了
    for (const w of words) {
      const key = w.toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, '');
      if (!key || !wanted.has(key)) continue;
      const prev = best.get(key);
      if (!prev || sc > prev.score) {
        best.set(key, { score: sc, id, text: sentence });
      }
    }
  }

  console.log(`扫描 ${lines} 行，覆盖 ${best.size} / ${wanted.size} 个词`);

  const examples = {};
  for (const [key, v] of best) {
    examples[key] = {
      text: v.text,
      source: 'Tatoeba',
      license: 'CC BY 2.0 FR',
      sentenceId: Number(v.id),
      url: `https://tatoeba.org/en/sentences/show/${v.id}`,
    };
  }

  // 没被 Tatoeba 覆盖到的词，用项目自己写的 CC0 例句兜底（project-examples.json，附译文）；
  // 那里也没有的才退回占位句，并在末尾列出来提醒补写
  let curated = {};
  try { curated = JSON.parse(fs.readFileSync(PROJECT_IN, 'utf8')).examples || {}; } catch { /* 可选 */ }
  const missing = entries.filter((e) => !examples[e.termKey]);
  const stillMissing = [];
  for (const e of missing) {
    const c = curated[e.termKey];
    if (!c) stillMissing.push(e.term);
    examples[e.termKey] = {
      text: c ? c.text : `The word "${e.term}" appears in this sentence as a placeholder example.`,
      translation: c ? c.translation || '' : '',
      source: 'project',
      license: 'CC0',
      sentenceId: null,
      url: null,
    };
  }
  if (stillMissing.length) console.warn(`还有 ${stillMissing.length} 个词只有占位句，请补到 project-examples.json：${stillMissing.join(', ')}`);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    source: 'Tatoeba English export',
    license: 'CC BY 2.0 FR',
    url: TATOEBA_URL,
    inputSha256: sha256,
    generatedAt: new Date().toISOString().slice(0, 10),
    counts: { tatoeba: best.size, fallback: missing.length, total: Object.keys(examples).length },
    examples,
  }, null, 0), 'utf8');

  console.log(`Tatoeba 例句 ${best.size} 条，CC0 兜底 ${missing.length} 条`);
  console.log(`写入 ${OUT}（${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB）`);
}

main().catch((err) => { console.error(err); process.exit(1); });
