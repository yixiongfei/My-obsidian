#!/usr/bin/env node
/**
 * 抓取「计算机考研杂货铺」的考研真题，整理成本站能直接出卷的 JSON。
 *
 *   英语一 / 英语二   2010–2026     完形 · 阅读 · 新题型 · 翻译 · 写作
 *   408               2009–2026     选择题（按四门拆）· 解答题（逐题）
 *   数学一 / 二 / 三  2008–2026     选择题 · 填空题 · 解答题（逐题）
 *   真题标签           408 / 数学    知识点 → 各年题号（真题标签页）
 *
 * 用法：
 *   node scripts/import-exams.mjs                    # 全部
 *   node scripts/import-exams.mjs 408                # 只抓一个科目：english1 english2 408 math1 math2 math3 tags
 *   node scripts/import-exams.mjs math1 2025         # 只抓一年
 *   node scripts/import-exams.mjs --reparse [...]    # 不联网，用本地缓存的原始页面重新解析
 *
 * 产物落在 vault 的 .kb/exams/ 下：
 *   <kind>-<year>.json   一张卷子        raw/   原始页面缓存      img/  图片
 *   tags-408.json        408 真题标签     tags-math.json  数学真题标签
 *   index.json           清单（服务端只读它做列表，不用把几十兆卷子全解析一遍）
 * 和 SQLite 一样属于本机私有数据、不进 git——该站声明保留所有权利，
 * 抓下来只作个人练习之用，不要再分发。
 *
 * 页面是 Hugo 生成的静态 HTML，结构规整：
 *   选择题 = h5 题号 + 题干 + .choice-container（data-answer / data-tags）
 *   主观题 = h5 题号 + 题面 + .answer-container + .solution-detail
 * 数学公式是 KaTeX 渲染好的 HTML，原样保留（站点已引入 KaTeX 样式）；
 * 英语完形的空是 KaTeX 画的下划线 + 题号，转成可回填的 blank 标记。
 *
 * 依赖 node-html-parser，只在这个脚本里用，不进服务端和浏览器。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'node-html-parser';
import { KB_DIR } from '../server/config.js';

const SITE = 'https://www.csgraduates.com';

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** 科目：抓取路径、年份范围、解析器 */
export const KINDS = {
  english1: { label: '英语一', group: 'english', groupLabel: '英语', path: (y) => `english/english1/${y}`, years: range(2010, 2026), parser: 'english' },
  english2: { label: '英语二', group: 'english', groupLabel: '英语', path: (y) => `english/english2/${y}`, years: range(2010, 2026), parser: 'english' },
  408:      { label: '408',    group: '408',     groupLabel: '408',  path: (y) => `408quiz/${y}`,          years: range(2009, 2026), parser: '408' },
  math1:    { label: '数学一', group: 'math',    groupLabel: '数学', path: (y) => `math/math1/${y}`,       years: range(2008, 2026), parser: 'math' },
  math2:    { label: '数学二', group: 'math',    groupLabel: '数学', path: (y) => `math/math2/${y}`,       years: range(2008, 2026), parser: 'math' },
  math3:    { label: '数学三', group: 'math',    groupLabel: '数学', path: (y) => `math/math3/${y}`,       years: range(2008, 2026), parser: 'math' },
};

/** 真题标签页：知识点 → 题号 */
const TAG_PAGES = {
  408: { path: 'tags/408quiz', label: '408 真题标签', kindOf: () => '408' },
  math: { path: 'tags/math', label: '数学真题标签', kindOf: (href) => /math(\d)/.exec(href)?.[0] || 'math1' },
};

const OUT_DIR = path.join(KB_DIR, 'exams');
const RAW_DIR = path.join(OUT_DIR, 'raw');
const IMG_DIR = path.join(OUT_DIR, 'img');
const UA = 'Mozilla/5.0 (personal study tool; kb-exams importer)';

/* ------------------------------------------------------------------ *
 * 抓取（带缓存）
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function fetchCached(name, rel, { reparse }) {
  const cache = path.join(RAW_DIR, `${name}.html`);
  if (fs.existsSync(cache) && (reparse || fs.statSync(cache).size > 50_000)) {
    return fsp.readFile(cache, 'utf8');
  }
  if (reparse) throw new Error(`没有缓存：${cache}`);
  const html = await fetchText(`${SITE}/study_methods/${rel}/`);
  await fsp.mkdir(RAW_DIR, { recursive: true });
  await fsp.writeFile(cache, html, 'utf8');
  await sleep(400); // 礼貌一点，别把人家静态站当 CDN 压
  return html;
}

async function fetchImage(src) {
  const name = path.basename(src);
  const dest = path.join(IMG_DIR, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return name;
  const res = await fetch(src.startsWith('http') ? src : SITE + src, { headers: { 'User-Agent': UA } });
  if (!res.ok) { console.warn(`  图片下载失败 ${res.status}：${src}`); return null; }
  await fsp.mkdir(IMG_DIR, { recursive: true });
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return name;
}

/* ------------------------------------------------------------------ *
 * HTML 清洗：只留排版需要的标签，所有事件属性、样式、站点自己的挂件一律扔掉
 * ------------------------------------------------------------------ */

const KEEP = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'blockquote', 'hr', 'img', 'sup', 'sub', 'code', 'pre', 'details', 'summary', 'h5', 'h6', 'dl', 'dt', 'dd']);
const DROP = new Set(['script', 'style', 'button', 'input', 'form', 'label', 'svg', 'iframe']);
const DROP_CLASS = ['video-links', 'quiz-actions', 'feedback-area', 'quiz-tag-container'];

/** 英语完形里 KaTeX 画的下划线空格：\underline{\quad 7 \quad} → 题号 7 */
function blankOf(el) {
  if (!el.classList?.contains('katex')) return null;
  if (!el.querySelector('.mord.underline')) return null;
  const n = el.text.replace(/\u200B/g, '').trim();
  return /^\d+$/.test(n) ? Number(n) : null;
}

const pendingImages = [];
let blankMode = false; // 只有英语完形正文才把下划线转成空

function clean(node) {
  if (node.nodeType === 3) return node.rawText.replace(/\u200B/g, '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (DROP.has(tag)) return '';
  const cls = node.classList;
  if (cls && DROP_CLASS.some((c) => cls.contains(c))) return '';

  // 公式：KaTeX 渲染结果原样保留（前端已经有 KaTeX 样式），完形的空格例外
  if (cls?.contains('katex-display')) return node.outerHTML;
  if (cls?.contains('katex')) {
    const blank = blankMode ? blankOf(node) : null;
    if (blank !== null) return `<span class="blank" data-n="${blank}">${blank}</span>`;
    return node.outerHTML;
  }

  const inner = node.childNodes.map(clean).join('');
  if (!KEEP.has(tag)) return inner; // span / div / a 等：拆掉外壳留内容
  if (tag === 'br' || tag === 'hr') return `<${tag}>`;
  if (tag === 'img') {
    const src = node.getAttribute('src') || '';
    if (!src) return '';
    pendingImages.push(src);
    return `<img src="__IMG__${path.basename(src)}" alt="${(node.getAttribute('alt') || '').replace(/"/g, '&quot;')}">`;
  }
  const attrs = [];
  if (tag === 'ol' && node.getAttribute('start')) attrs.push(` start="${Number(node.getAttribute('start'))}"`);
  if (tag === 'td' || tag === 'th') {
    const align = /text-align:\s*(center|right)/.exec(node.getAttribute('style') || '')?.[1];
    if (align) attrs.push(` align="${align}"`);
    const cs = node.getAttribute('colspan'); if (cs) attrs.push(` colspan="${Number(cs)}"`);
    const rs = node.getAttribute('rowspan'); if (rs) attrs.push(` rowspan="${Number(rs)}"`);
  }
  if (tag === 'code') {
    const lang = /language-([\w+#-]+)/.exec(node.getAttribute('class') || '')?.[1];
    if (lang) attrs.push(` data-lang="${lang}"`);
  }
  if (tag === 'details') attrs.push(' open');
  return `<${tag}${attrs.join('')}>${inner}</${tag}>`;
}

const cleanAll = (nodes) => nodes.map(clean).join('').trim();
const textOf = (nodes) => nodes.map((n) => n.text || '').join(' ').replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
const norm = (t) => t.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();

/**
 * 只解析正文那一段。整页喂给 node-html-parser 时，部分 408 页面（侧栏里有没闭合的标签）
 * 会把 <main> 整个吞掉、查不到 .td-content；从 .td-content 切到 </main> 就稳了，还快。
 * 另外默认把 <pre> 当原文不解析，Chroma 高亮的 span 会原样漏出来，所以显式列出块级原文元素。
 */
function parseHtml(html) {
  const a = html.search(/<div class="?td-content"?>/);
  const b = html.indexOf('</main>', a);
  const slice = a >= 0 ? html.slice(a, b > a ? b : undefined) : html;
  return parse(slice, { blockTextElements: { script: true, noscript: true, style: true } });
}

/**
 * 完形正文拆成「段落 → 片段」：字符串片段是行内 HTML，{ n } 是第 n 空。
 * 前端要在空格里回填所选单词，所以不能整段 innerHTML 一把梭。
 */
function splitBlanks(html) {
  const re = /<span class="blank" data-n="(\d+)">\d+<\/span>/g;
  const segs = [];
  let last = 0;
  for (const m of html.matchAll(re)) {
    if (m.index > last) segs.push(html.slice(last, m.index));
    segs.push({ n: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < html.length) segs.push(html.slice(last));
  return segs;
}

function passageOf(nodes, withBlanks) {
  blankMode = withBlanks;
  const out = [];
  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const tag = n.tagName.toLowerCase();
    if (tag === 'p') out.push({ segs: splitBlanks(cleanAll(n.childNodes)) });
    else if (KEEP.has(tag)) out.push({ html: clean(n) });
  }
  blankMode = false;
  return out;
}

/* ------------------------------------------------------------------ *
 * 页面切块
 * ------------------------------------------------------------------ */

/** 按 h3 / h4 切成块，每块记下标题和它下面的节点 */
function blocksOf(content) {
  const blocks = [];
  let cur = null;
  for (const n of content.childNodes) {
    // 偶尔（2026 数学三）大题标题写成了 h2，一并当 h3 看
    if (n.nodeType === 1 && /^H[234]$/.test(n.tagName)) {
      cur = { level: n.tagName === 'H4' ? 4 : 3, title: norm(n.text), nodes: [] };
      blocks.push(cur);
    } else if (cur) {
      cur.nodes.push(n);
    }
  }
  return blocks;
}

/** 把一个块的节点按 h5 切开：h5 前的是引子，之后每个 h5 一组 */
function splitByH5(nodes) {
  const lead = [];
  const groups = [];
  let cur = null;
  for (const n of nodes) {
    if (n.nodeType === 1 && n.tagName === 'H5') { cur = { n: norm(n.text), nodes: [] }; groups.push(cur); continue; }
    (cur ? cur.nodes : lead).push(n);
  }
  return { lead, groups };
}

/** 一组节点里的挂件：选择题 / 主观题解析；其余是正文 */
function pick(nodes) {
  const choices = []; const solutions = []; const answerBoxes = []; const rest = [];
  for (const n of nodes) {
    if (n.nodeType !== 1) { rest.push(n); continue; }
    if (n.classList.contains('choice-container')) choices.push(n);
    else if (n.classList.contains('solution-detail')) solutions.push(n);
    else if (n.classList.contains('answer-container')) answerBoxes.push(n);
    else rest.push(n);
  }
  return { choices, solutions, answerBoxes, rest };
}

const tagsOf = (el) => (el?.getAttribute('data-tags') || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);

function parseChoice(el) {
  // 完形是 .choice-option-inline，阅读 / 408 / 数学是 .choice-option，前缀相同
  const options = el.querySelectorAll('label[class^="choice-option"]').map((o) => ({
    k: (o.querySelector('.choice-label')?.text || '').replace(/[.．\s]/g, ''),
    text: cleanAll(o.querySelector('.choice-text')?.childNodes || []),
  }));
  const exp = el.querySelector('.explanation');
  let explanation = exp ? cleanAll(exp.childNodes) : '';
  // 开头那句「正确答案：C」是站点挂件自己加的，前端会单独展示答案，去掉
  explanation = explanation.replace(/^<strong>正确答案：\s*[A-H]?\s*<\/strong>\s*(<br>)?\s*/i, '').trim();
  return {
    answer: (el.getAttribute('data-answer') || '').trim().toUpperCase(),
    multiple: el.getAttribute('data-multiple') === 'true',
    options,
    explanation,
    tags: tagsOf(el),
  };
}

/**
 * 题面里的分值：「本题满分 10 分」直接用；408 综合题只标各小问「（4 分）（7 分）（2 分）」，相加；
 * 什么都没写就不猜，前端不显示分值、也不计入总分。
 */
function pointsInText(text) {
  const full = /满分\s*(\d+)\s*分/.exec(text);
  if (full) return Number(full[1]);
  const parts = [...text.matchAll(/[（(]\s*(\d+)\s*分\s*[)）]/g)].map((m) => Number(m[1]));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/* ------------------------------------------------------------------ *
 * 英语
 * ------------------------------------------------------------------ */

/**
 * 分值按考试大纲写死，不从页面里抓：2010 年以来英语一 / 英语二的题型分值一直没变过，
 * 而站点偶尔会把 Directions 挂错位置（2015 年英语一就把 Part A 的说明放进了 Part B）。
 */
const EN_POINTS = {
  english1: { cloze: 10, reading: 10, 'reading-b': 10, translation: 10, 'writing-a': 10, 'writing-b': 20 },
  english2: { cloze: 10, reading: 10, 'reading-b': 10, translation: 15, 'writing-a': 10, 'writing-b': 15 },
};
const enPoints = (kind, id) => EN_POINTS[kind][/^reading-\d$/.test(id) ? 'reading' : id] ?? 10;

/**
 * 新题型答案的尽力提取。站点每年写法都不同：
 *   41. 【答案】B ／ 41、【答案】[C] ／ 【41】E ／ (41) 答案：C ／ 41. Jay Dunwell → [E]
 *   41. 题干……[答案] F ／ 【答案】 B E A G D ／ 连续五个不带题号的【答案】X
 */
export function extractMatchAnswers(solutionText, numbers, letters) {
  const L = `[${letters.join('')}]`;
  const txt = solutionText.replace(/\u200B/g, '').replace(/\s+/g, ' ');
  const found = new Map();
  const num = `(${numbers.join('|')})`;
  const marker = '(?:【答案】|\\[答案\\]|［答案］|答案\\s*[:：为])';
  const pats = [
    // 题号 … 答案标记 … 字母（中间允许一句题干，但不能越过下一个题号）
    new RegExp(`[（(【]?\\s*${num}\\s*[)）】]?\\s*[.．、]?(?:(?!\\b(?:${numbers.join('|')})\\s*[.．、）)】]).){0,260}?${marker}\\s*[\\[［]?\\s*(${L})(?![A-Za-z])`, 'g'),
    new RegExp(`【${num}】\\s*[\\[［]?\\s*(${L})(?![A-Za-z])`, 'g'),
    // 「41. Jay Dunwell → [E]」：箭头只认后面紧跟方括号字母的，免得把解析里的段落顺序 E → D 也当成答案
    new RegExp(`${num}\\s*[.．、]?\\s*[^→\\d]{0,80}?→\\s*[\\[［]\\s*(${L})\\s*[\\]］]`, 'g'),
    // 「解析：41. E」这种裸写法，题号前面可能贴着中文标点
    new RegExp(`(?:^|[^\\d])${num}\\s*[.．、]\\s*[\\[［]?\\s*(${L})(?![A-Za-z])`, 'g'),
  ];
  for (const re of pats) {
    for (const m of txt.matchAll(re)) {
      const n = Number(m[1]);
      if (!found.has(n)) found.set(n, m[2].toUpperCase());
    }
  }
  if (numbers.every((n) => found.has(n))) return numbers.map((n) => found.get(n));

  // 【答案】 B E A G D
  const seq = new RegExp(`【答案】\\s*((?:${L}\\s+){${numbers.length - 1}}${L})(?![A-Za-z])`).exec(txt);
  if (seq) return seq[1].trim().split(/\s+/).map((s) => s.toUpperCase());

  // 五个不带题号、按顺序出现的【答案】X
  const ordered = [...txt.matchAll(new RegExp(`【答案】\\s*[\\[［]?\\s*(${L})(?![A-Za-z])`, 'g'))].map((m) => m[1].toUpperCase());
  if (ordered.length === numbers.length) return ordered;
  return null;
}

/** 题面里出现的选项字母集合：[A]…[G] 或段首 "A." */
export function lettersOf(bodyText, directions) {
  if (/true\s*\(?\s*T?\s*\)?\s*or\s*false/i.test(directions) || /decide whether .* (true|false)/i.test(directions)) return ['T', 'F'];
  const seen = new Set();
  for (const m of bodyText.matchAll(/\[([A-H])\]/g)) seen.add(m[1]);
  if (!seen.size) for (const m of bodyText.matchAll(/(?:^|\s)([A-H])[.．]\s/g)) seen.add(m[1]);
  let max = 'G';
  for (const l of seen) if (l > max) max = l;
  if (seen.size < 5) max = 'G';
  const out = [];
  for (let c = 'A'.charCodeAt(0); c <= max.charCodeAt(0); c++) out.push(String.fromCharCode(c));
  return out;
}

const isText = (t) => /^Text\s*\d?$/i.test(t);

function parseEnglish(content, kind, year) {
  const blocks = blocksOf(content);
  const sections = [];
  let h3 = '';
  let readingDirections = '';
  let writingIdx = 0;

  for (const b of blocks) {
    if (b.level === 3) { h3 = b.title; if (h3 === '阅读理解') readingDirections = cleanAll(b.nodes); continue; }
    const t = b.title.replace(/\s+/g, ' ');

    if (h3 === '完形填空' && isText(t)) {
      sections.push(parseCloze(b.nodes, blocks, b, kind));
      continue;
    }
    if (h3 === '阅读理解') {
      if (t === 'Part A') { readingDirections = cleanAll(b.nodes) || readingDirections; continue; }
      if (/^Text\s*\d$/i.test(t)) {
        const idx = Number(t.match(/\d/)[0]);
        sections.push(parseReadingText(b.nodes, idx, readingDirections, kind));
        continue;
      }
      if (t === 'Part B') { sections.push(parseEnglishFree(b.nodes, 'reading-b', '新题型', 'match', kind)); continue; }
      if (t === 'Part C') { sections.push(parseEnglishFree(b.nodes, 'translation', '翻译', 'free', kind)); continue; }
    }
    if (h3 === '写作') {
      writingIdx += 1;
      const id = t === 'Part A' ? 'writing-a' : t === 'Part B' ? 'writing-b' : `writing-${writingIdx}`;
      sections.push(parseEnglishFree(b.nodes, id, t === 'Part A' ? '小作文' : '大作文', 'free', kind));
      continue;
    }
    console.warn(`  跳过未识别的块：${h3} / ${t}`);
  }

  // 2015 年英语一把 Part A 的 Directions 挂在了 Part B 标题下，挪回去
  const r1 = sections.find((x) => x.id === 'reading-1');
  const rb = sections.find((x) => x.id === 'reading-b');
  if (r1 && rb && !r1.directions && /four texts/i.test(rb.directions)) { r1.directions = rb.directions; rb.directions = ''; }
  return sections;
}

function parseCloze(nodes, blocks, block, kind) {
  // Directions 在 h3 完形填空 块里、h4 Text 之前
  const dirBlock = blocks[blocks.indexOf(block) - 1];
  const directions = dirBlock?.level === 3 ? cleanAll(dirBlock.nodes) : '';
  const { lead, groups } = splitByH5(nodes);
  const { rest: passageNodes, solutions: leadSol } = pick(lead);
  const questions = [];
  const extras = leadSol.map((s) => ({ title: '参考译文与解析', html: cleanAll(s.childNodes) }));
  for (const g of groups) {
    const { choices, solutions } = pick(g.nodes);
    if (choices[0]) questions.push({ n: Number(g.n), ...parseChoice(choices[0]) });
    for (const s of solutions) extras.push({ title: `第 ${g.n} 题补充`, html: cleanAll(s.childNodes) });
  }
  return {
    id: 'cloze',
    label: '完形填空',
    title: '完形填空',
    heading: 'Section I  Use of English',
    type: 'choice',
    points: enPoints(kind, 'cloze'),
    directions,
    passage: passageOf(passageNodes, true),
    questions,
    extras,
  };
}

function parseReadingText(nodes, idx, directions, kind) {
  const { lead, groups } = splitByH5(nodes);
  const { rest: passageNodes, solutions: leadSol } = pick(lead);
  const questions = [];
  const extras = leadSol.map((s) => ({ title: '参考译文与解析', html: cleanAll(s.childNodes) }));
  for (const g of groups) {
    const { choices, solutions, rest } = pick(g.nodes);
    if (choices[0]) questions.push({ n: Number(g.n), stem: cleanAll(rest), ...parseChoice(choices[0]) });
    for (const s of solutions) extras.push({ title: `第 ${g.n} 题补充`, html: cleanAll(s.childNodes) });
  }
  return {
    id: `reading-${idx}`,
    label: `阅读 Text ${idx}`,
    title: idx === 1 ? 'Part A · Text 1' : `Text ${idx}`,
    heading: idx === 1 ? 'Section II  Reading Comprehension' : null,
    type: 'choice',
    points: enPoints(kind, `reading-${idx}`),
    directions: idx === 1 ? directions : '',
    passage: passageOf(passageNodes, false),
    questions,
    extras,
  };
}

function parseEnglishFree(nodes, id, label, type, kind) {
  const { lead, groups } = splitByH5(nodes);
  const directionsText = textOf(lead);
  const directions = cleanAll(lead);
  let bodyNodes = []; const solutions = [];
  for (const g of (groups.length ? groups : [{ n: '', nodes: lead }])) {
    const p = pick(g.nodes);
    bodyNodes.push(...p.rest);
    solutions.push(...p.solutions);
  }
  /* 图表作文：站点会在图片后面用中文把图表内容复述一遍。真卷上没有这段，
     而且等于把「描述图表」这一步替你做了，挪到参考答案里去 */
  let chartNote = '';
  const lastImg = bodyNodes.reduce((at, n, i) => (n.nodeType === 1 && n.querySelector?.('img') ? i : at), -1);
  if (lastImg >= 0) {
    const cjk = bodyNodes.slice(lastImg + 1).filter((n) => /[\u4e00-\u9fff]/.test(n.text || ''));
    if (cjk.length) {
      chartNote = `<p><strong>【图表说明】</strong></p>${cleanAll(cjk)}`;
      bodyNodes = bodyNodes.filter((n) => !cjk.includes(n));
    }
  }
  const numbers = groups.map((g) => g.n).join(',').split(/[,，-]/).map((s) => Number(s.trim())).filter(Boolean);
  const section = {
    id,
    label,
    title: id === 'reading-b' ? 'Part B' : id === 'translation' ? 'Part C' : id === 'writing-a' ? 'Part A' : 'Part B',
    heading: id === 'writing-a' ? 'Section III  Writing' : null,
    type,
    points: enPoints(kind, id),
    directions,
    body: cleanAll(bodyNodes),
    solution: [chartNote, ...solutions.map((s) => cleanAll(s.childNodes))].filter(Boolean).join('<hr>'),
    numbers,
  };

  if (type === 'match') {
    const [a, b] = numbers.length === 2 ? numbers : [41, 45];
    section.numbers = range(a, b);
    section.letters = lettersOf(textOf(bodyNodes), directionsText);
    // 标签换成空格再匹配，否则 <strong>41. E</strong>若… 会粘成 “E若”
    const solText = solutions.map((s) => cleanAll(s.childNodes).replace(/<[^>]+>/g, ' ')).join(' ');
    section.answers = extractMatchAnswers(solText, section.numbers, section.letters);
    if (!section.answers) console.warn(`  ${label}：答案没提取出来，前端将退化为自行对照`);
  }
  return section;
}

/* ------------------------------------------------------------------ *
 * 408：选择题按四门拆成四个单元，解答题逐题一个单元
 * ------------------------------------------------------------------ */

const SUBJECTS_408 = [
  { re: /数据结构/, id: 'ds', name: '数据结构' },
  { re: /组成原理/, id: 'co', name: '计算机组成原理' },
  { re: /操作系统/, id: 'os', name: '操作系统' },
  { re: /计算机网络|网络/, id: 'cn', name: '计算机网络' },
];
const subject408 = (title) => SUBJECTS_408.find((s) => s.re.test(title)) || { id: 'x', name: title };

/** 一组 h5 节点 → 一道主观题：题面 + 解析 */
function freeQuestion(g, points) {
  const { rest, solutions, answerBoxes } = pick(g.nodes);
  const body = cleanAll(rest);
  return {
    n: Number(g.n) || g.n,
    body,
    solution: solutions.map((s) => cleanAll(s.childNodes)).join('<hr>'),
    tags: tagsOf(answerBoxes[0]),
    points: pointsInText(textOf(rest)) ?? points,
  };
}

function parse408(content, kind, year) {
  const blocks = blocksOf(content);
  const sections = [];
  let h3 = '';
  let first = { mc: true, free: true };

  for (const b of blocks) {
    if (b.level === 3) { h3 = b.title; continue; }
    const subj = subject408(b.title);
    const { groups } = splitByH5(b.nodes);
    if (!groups.length) continue;

    if (/选择/.test(h3)) {
      const questions = [];
      for (const g of groups) {
        const { choices, rest } = pick(g.nodes);
        if (choices[0]) questions.push({ n: Number(g.n), stem: cleanAll(rest), ...parseChoice(choices[0]) });
      }
      sections.push({
        id: `mc-${subj.id}`,
        label: `选择题 · ${subj.name}`,
        title: subj.name,
        subject: subj.name,
        heading: first.mc ? '一、单项选择题（每小题 2 分，共 80 分）' : null,
        type: 'choice',
        points: questions.length * 2,
        directions: '',
        passage: [],
        questions,
        extras: [],
      });
      first.mc = false;
      continue;
    }
    if (/解答|综合/.test(h3)) {
      for (const g of groups) {
        const q = freeQuestion(g, null);
        sections.push({
          id: `q${g.n}`,
          label: `第 ${g.n} 题 · ${subj.name}`,
          title: `${g.n}．${subj.name}`,
          subject: subj.name,
          heading: first.free ? '二、综合应用题（共 70 分）' : null,
          type: 'free',
          points: q.points,
          directions: '',
          body: q.body,
          solution: q.solution,
          tags: q.tags,
          numbers: [q.n],
        });
        first.free = false;
      }
      continue;
    }
    console.warn(`  跳过未识别的块：${h3} / ${b.title}`);
  }
  return sections;
}

/* ------------------------------------------------------------------ *
 * 数学：选择题一个单元，填空题一个单元（六个短答），解答题逐题
 * ------------------------------------------------------------------ */

const MATH_SUBJECTS = ['高等数学', '线性代数', '概率论与数理统计'];

function parseMath(content, kind, year) {
  const blocks = blocksOf(content);
  const sections = [];
  // 2021 年改革起选择 / 填空每题 5 分（10 + 6 题），之前 4 分（8 + 6 题）
  const small = year >= 2021 ? 5 : 4;
  let h3 = '';
  let lastH3 = null;
  const flush = () => { if (lastH3 && lastH3.groups.length) sections.push(...mathSection(lastH3, small)); lastH3 = null; };

  for (const b of blocks) {
    if (b.level === 3) {
      flush();
      h3 = b.title;
      lastH3 = { title: h3, groups: [] };
      const { groups } = splitByH5(b.nodes);
      lastH3.groups.push(...groups);
      continue;
    }
    // 偶尔有 h4 小标题夹在中间，题目照样收进当前 h3
    const { groups } = splitByH5(b.nodes);
    if (lastH3) lastH3.groups.push(...groups);
  }
  flush();
  return sections;
}

function mathSection(block, small) {
  const t = block.title;
  if (/选择/.test(t)) {
    const questions = [];
    for (const g of block.groups) {
      const { choices, rest } = pick(g.nodes);
      if (choices[0]) questions.push({ n: Number(g.n), stem: cleanAll(rest), ...parseChoice(choices[0]) });
    }
    return [{
      id: 'mc', label: '选择题', title: '选择题', heading: `一、选择题（每小题 ${small} 分，共 ${questions.length * small} 分）`,
      type: 'choice', points: questions.length * small, directions: '', passage: [], questions, extras: [],
    }];
  }
  if (/填空/.test(t)) {
    const questions = block.groups.map((g) => {
      const q = freeQuestion(g, small);
      // 站点在每道填空题前加的「（填空题）」标记，有时单独成段有时贴在题干前面
      const stem = q.body.replace(/^<p>\s*[（(]填空题[)）]\s*<\/p>\s*/, '').replace(/^<p>\s*[（(]填空题[)）]\s*/, '<p>');
      return { n: q.n, stem, solution: q.solution, tags: q.tags };
    });
    return [{
      id: 'fill', label: '填空题', title: '填空题', heading: `二、填空题（每小题 ${small} 分，共 ${questions.length * small} 分）`,
      type: 'fill', points: questions.length * small, directions: '', questions,
    }];
  }
  if (/解答/.test(t)) {
    return block.groups.map((g, i) => {
      const q = freeQuestion(g, null);
      const subj = MATH_SUBJECTS.find((s) => q.tags[0] === s) || '';
      return {
        id: `q${g.n}`, label: `第 ${g.n} 题${subj ? ` · ${subj}` : ''}`, title: `${g.n}．${subj || '解答题'}`,
        subject: subj,
        heading: i === 0 ? '三、解答题（解答应写出文字说明、证明过程或演算步骤）' : null,
        type: 'free', points: q.points, directions: '', body: q.body, solution: q.solution, tags: q.tags, numbers: [q.n],
      };
    });
  }
  console.warn(`  跳过未识别的块：${t}`);
  return [];
}

/* ------------------------------------------------------------------ *
 * 整页
 * ------------------------------------------------------------------ */

const PARSERS = { english: parseEnglish, 408: parse408, math: parseMath };

/**
 * 源站的录入错误，能确定的在这里修：
 * 英语二 2020 完形第二个「2」号空其实是第 5 空（序列 2,3,4,2,6 只可能是 5）。
 * 其余几处（2010 英语一缺第 3 空、2023 英语一一句话重复了两遍）原文本身就坏了，不猜。
 */
const FIXUPS = {
  'english2-2020': (exam) => {
    const cloze = exam.sections.find((s) => s.id === 'cloze');
    let seen = 0;
    for (const p of cloze?.passage || []) for (const seg of p.segs || []) {
      if (typeof seg === 'object' && seg.n === 2 && ++seen === 2) seg.n = 5;
    }
  },
};

function parseExam(html, kind, year) {
  pendingImages.length = 0;
  const root = parseHtml(html);
  const content = root.querySelector('.td-content');
  if (!content) throw new Error('找不到 .td-content');
  const meta = KINDS[kind];
  const sections = PARSERS[meta.parser](content, kind, year);
  const exam = {
    id: `${kind}-${year}`,
    kind,
    kindLabel: meta.label,
    group: meta.group,
    year,
    title: norm(content.querySelector('h1')?.text || `${year} 年真题`),
    source: `${SITE}/study_methods/${meta.path(year)}/`,
    fetchedAt: new Date().toISOString(),
    sections,
    images: [...new Set(pendingImages)],
  };
  FIXUPS[exam.id]?.(exam);
  return exam;
}

/* ------------------------------------------------------------------ *
 * 真题标签页：h3 科目 → h4 知识点 → (h5 数学一/二/三) → 选择题 / 填空题 / 解答题 → 题号链接
 * ------------------------------------------------------------------ */

function parseTagPage(html, group) {
  const root = parseHtml(html);
  const content = root.querySelector('.td-content');
  if (!content) throw new Error('找不到 .td-content');
  const subjects = [];
  let subject = null;
  let tag = null;
  const linkRe = /\/study_methods\/([^/]+)\/(?:(math\d)\/)?(\d{4})\/#(\d+)/;

  for (const n of content.childNodes) {
    if (n.nodeType !== 1) continue;
    if (n.tagName === 'H3') { subject = { name: norm(n.text), tags: [] }; subjects.push(subject); tag = null; continue; }
    if (n.tagName === 'H4') { tag = { name: norm(n.text), items: [] }; subject?.tags.push(tag); continue; }
    if (!tag) continue;
    if (n.classList.contains('kp-panel') && !n.classList.contains('kp-panel-video')) {
      for (const grp of n.querySelectorAll('.kp-group')) {
        const label = norm(grp.querySelector('.kp-group-label')?.text || '');
        for (const a of grp.querySelectorAll('a.kp-link')) {
          const m = linkRe.exec(a.getAttribute('href') || '');
          if (!m) continue;
          const kind = group === '408' ? '408' : (m[2] || 'math1');
          tag.items.push({ kind, year: Number(m[3]), n: Number(m[4]), type: label });
        }
      }
    }
  }
  for (const s of subjects) {
    s.tags = s.tags.filter((t) => t.items.length);
    for (const t of s.tags) t.items.sort((a, b) => a.kind.localeCompare(b.kind) || b.year - a.year || a.n - b.n);
    s.tags.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'zh'));
  }
  return {
    group,
    label: TAG_PAGES[group].label,
    source: `${SITE}/study_methods/${TAG_PAGES[group].path}/`,
    fetchedAt: new Date().toISOString(),
    subjects,
    counts: { tags: subjects.reduce((s, x) => s + x.tags.length, 0), items: subjects.reduce((s, x) => s + x.tags.reduce((a, t) => a + t.items.length, 0), 0) },
  };
}

/* ------------------------------------------------------------------ *
 * 清单：服务端列表只读这个，不用把几十兆卷子全解析一遍
 * ------------------------------------------------------------------ */

async function writeIndex() {
  const files = (await fsp.readdir(OUT_DIR)).filter((f) => /^[a-z0-9]+-\d{4}\.json$/i.test(f));
  const exams = [];
  for (const f of files) {
    try {
      const e = JSON.parse(await fsp.readFile(path.join(OUT_DIR, f), 'utf8'));
      exams.push({
        id: e.id, kind: e.kind, kindLabel: e.kindLabel, group: e.group, year: e.year, title: e.title,
        units: e.sections.length,
        questions: e.sections.reduce((s, x) => s + (x.questions?.length || (x.type === 'match' ? x.numbers.length : 1)), 0),
        objectiveTotal: e.sections.filter((x) => x.type === 'choice' || (x.type === 'match' && x.answers)).reduce((s, x) => s + x.points, 0),
        total: e.sections.reduce((s, x) => s + (x.points || 0), 0),
      });
    } catch (err) {
      console.warn(`  清单跳过 ${f}：${err.message}`);
    }
  }
  exams.sort((a, b) => a.kind.localeCompare(b.kind) || b.year - a.year);
  const tags = {};
  for (const g of Object.keys(TAG_PAGES)) {
    const p = path.join(OUT_DIR, `tags-${g}.json`);
    if (fs.existsSync(p)) {
      const t = JSON.parse(await fsp.readFile(p, 'utf8'));
      tags[g] = t.counts;
    }
  }
  await fsp.writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify({ generatedAt: new Date().toISOString(), exams, tags }, null, 1), 'utf8');
  return exams.length;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function importExam(kind, year, opts) {
  const html = await fetchCached(`${kind}-${year}`, KINDS[kind].path(year), opts);
  const exam = parseExam(html, kind, year);
  // 图片落地后把占位符换成本站路由
  let json = JSON.stringify(exam);
  for (const src of exam.images) {
    const name = opts.reparse ? path.basename(src) : await fetchImage(src);
    json = json.split(`__IMG__${path.basename(src)}`).join(name ? `/api/exams/assets/${name}` : '');
  }
  const out = JSON.parse(json);
  delete out.images;
  await fsp.writeFile(path.join(OUT_DIR, `${out.id}.json`), JSON.stringify(out, null, 1), 'utf8');
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { reparse: args.includes('--reparse') };
  const rest = args.filter((a) => !a.startsWith('--'));
  const only = rest[0];
  const kinds = only && KINDS[only] ? [only] : only === 'tags' ? [] : Object.keys(KINDS);
  const wantTags = !only || only === 'tags';

  await fsp.mkdir(OUT_DIR, { recursive: true });
  let ok = 0;
  for (const kind of kinds) {
    const years = rest[1] ? [Number(rest[1])] : KINDS[kind].years;
    for (const year of years) {
      const tag = `${KINDS[kind].label} ${year}`;
      try {
        const exam = await importExam(kind, year, opts);
        const q = exam.sections.reduce((s, x) => s + (x.questions?.length || 0), 0);
        const b = exam.sections.find((x) => x.type === 'match');
        console.log(`${tag}：${exam.sections.length} 个单元，${q} 道客观题${b ? `，新题型答案 ${b.answers ? b.answers.join('') : '（未提取）'}` : ''}`);
        ok += 1;
      } catch (err) {
        console.error(`${tag}：失败 —— ${err.message}`);
      }
    }
  }

  if (wantTags) {
    for (const [group, meta] of Object.entries(TAG_PAGES)) {
      try {
        const html = await fetchCached(`tags-${group}`, meta.path, opts);
        const tags = parseTagPage(html, group);
        await fsp.writeFile(path.join(OUT_DIR, `tags-${group}.json`), JSON.stringify(tags, null, 1), 'utf8');
        console.log(`${meta.label}：${tags.subjects.length} 个科目，${tags.counts.tags} 个知识点，${tags.counts.items} 处题目引用`);
      } catch (err) {
        console.error(`${meta.label}：失败 —— ${err.message}`);
      }
    }
  }

  const n = await writeIndex();
  console.log(`完成：本次 ${ok} 份，清单共 ${n} 份，输出目录 ${OUT_DIR}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
