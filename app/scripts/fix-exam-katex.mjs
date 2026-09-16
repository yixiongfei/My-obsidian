#!/usr/bin/env node
/**
 * 把已经写进笔记的 KaTeX HTML 换成 `$…$`。
 *
 * 1.0.13 起，错题本把真题里的公式按渲染后的 HTML 原样嵌进 Markdown——本站没问题，
 * Obsidian 里没有 KaTeX 样式，那堆 span 会摞成一团。现在导出走的是 TeX（见
 * server/lib/katex-tex.js），这个脚本负责把**存量**笔记也补齐。
 *
 * 和导出用的是同一道校验：倒推出的 TeX 必须重新渲染出一模一样的结构，才敢替换；
 * 验不过的原样留着。所以这个脚本只会让笔记变好，不会改坏任何一个公式。
 *
 *   node scripts/fix-exam-katex.mjs            # 预览，不写盘
 *   node scripts/fix-exam-katex.mjs --write    # 真的改
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VAULT_ROOT } from '../server/config.js';
import { reclaimTex } from '../server/lib/katex-tex.js';

const WRITE = process.argv.includes('--write');

/** 从 <span class=katex…> 开始，数着层级找到配对的 </span> */
function spanEnd(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s.startsWith('<span', i)) { depth++; i = s.indexOf('>', i); if (i < 0) return -1; i++; continue; }
    if (s.startsWith('</span>', i)) { depth--; i += 7; if (depth === 0) return i; continue; }
    i++;
  }
  return -1;
}

const OPEN = /<span class="?katex(-display)?"?[ >]/g;

function convert(md) {
  let out = '';
  let at = 0;
  let done = 0;
  let kept = 0;
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(md); m; m = OPEN.exec(md)) {
    if (m.index < at) continue;
    const end = spanEnd(md, m.index);
    if (end < 0) continue;
    const html = md.slice(m.index, end);
    const display = !!m[1];
    const got = reclaimTex(html, display);
    out += md.slice(at, m.index);
    if (got) {
      out += got.display ? `\n\n$$\n${got.tex}\n$$\n\n` : `$${got.tex}$`;
      done++;
    } else {
      out += html;
      kept++;
    }
    at = end;
    OPEN.lastIndex = end;
  }
  out += md.slice(at);
  // 行间公式前后各自留一个空行，别把段落粘在一起
  return { md: out.replace(/\n{3,}/g, '\n\n'), done, kept };
}

function walk(dir, hits = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hits);
    else if (e.name.endsWith('.md')) hits.push(p);
  }
  return hits;
}

const files = walk(VAULT_ROOT).filter((f) => fs.readFileSync(f, 'utf8').includes('class=katex') || fs.readFileSync(f, 'utf8').includes('class="katex'));
if (!files.length) {
  console.log('没有笔记嵌着 KaTeX HTML，不用改。');
  process.exit(0);
}

let all = 0;
let left = 0;
for (const f of files) {
  const src = await fsp.readFile(f, 'utf8');
  const { md, done, kept } = convert(src);
  all += done;
  left += kept;
  const rel = path.relative(VAULT_ROOT, f);
  console.log(`${rel}：转成 $…$ ${done} 个，校验没过、保持原样 ${kept} 个`);
  if (WRITE && done) await fsp.writeFile(f, md, 'utf8');
}
console.log(`\n合计 ${all} 个公式改成了 TeX，${left} 个仍是内嵌 HTML（${(all / (all + left) * 100).toFixed(1)}%）`);
console.log(WRITE ? '已写盘。' : '这只是预览，加 --write 才会真的改。');
