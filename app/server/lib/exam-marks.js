import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';
import { VAULT_ROOT, PORT } from '../config.js';
import { handle, getMeta, setMeta } from './db.js';
import { getExam, attemptsOf } from './exams.js';
import { attemptOf as drillAttemptOf } from './drill.js';
import { todayStr } from './review.js';
import { reclaimTex } from './katex-tex.js';

/**
 * 真题上的两种「留痕」：
 *
 *  1. 荧光笔：英语阅读里选中一句、右键「标记句子」。真相在 exam_marks 表，
 *     投影到 英语/语法/真题例句.md。和词汇日志同一套节奏——只落脏标记，
 *     闲置 30 秒或离开卷面时合并写一次，绝不一划就写盘。
 *
 *  2. 错题本：某道题右侧「加入 md」，把题干 / 选项 / 答案解析转成 Markdown
 *     追加到 <学科>/错题本/<年份 科目>.md，frontmatter 里带知识点标签。
 *     这是显式动作、频率低，直接写盘。答案只在那一单元交过卷之后才附上。
 */

const SENTENCE_FILE = path.join(VAULT_ROOT, '英语', '语法', '真题例句.md');
const DIRTY_KEY = 'exam_marks_dirty';
const IDLE_FLUSH_MS = 30_000;
const AUTO_START = '<!-- kb:sentences:start -->';
const AUTO_END = '<!-- kb:sentences:end -->';

const KIND_NAME = {
  english1: '英语一', english2: '英语二', 408: '408', math1: '数学一', math2: '数学二', math3: '数学三',
};
const GROUP_FOLDER = { english: '英语', math: '数学', 408: '408' };

const appUrl = (examId, q, hl) => `http://127.0.0.1:${PORT}/#/resources/exam/${examId}${hl ? `?hl=${hl}` : q ? `?q=${q}` : ''}`;
const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ *
 * 荧光笔
 * ------------------------------------------------------------------ */

const COLORS = new Set(['y', 'g', 'b', 'p']);
const rowOut = (r) => ({ id: r.id, examId: r.exam_id, sectionId: r.section_id, q: r.q, text: r.text, note: r.note, color: r.color || 'y', createdAt: r.created_at });

export function listMarks(examId) {
  return handle().prepare('SELECT * FROM exam_marks WHERE exam_id = ? ORDER BY id').all(examId).map(rowOut);
}

export function addMark(examId, sectionId, text, q = null, color = 'y') {
  const t = normText(text);
  if (t.length < 2) throw Object.assign(new Error('没选中文字'), { status: 400 });
  if (t.length > 2000) throw Object.assign(new Error('选得太长了，一次最多 2000 字'), { status: 400 });
  const exam = getExam(examId);
  if (!exam?.sections.some((s) => s.id === sectionId)) throw Object.assign(new Error('单元不存在'), { status: 404 });
  const d = handle();
  const c = COLORS.has(color) ? color : 'y';
  d.prepare(`INSERT INTO exam_marks (exam_id, section_id, q, text, color, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(exam_id, section_id, text) DO UPDATE SET color = excluded.color`)
    .run(examId, sectionId, Number.isInteger(q) ? q : null, t, c, todayStr());
  setMeta(DIRTY_KEY, '1');
  scheduleIdleFlush();
  return rowOut(d.prepare('SELECT * FROM exam_marks WHERE exam_id = ? AND section_id = ? AND text = ?').get(examId, sectionId, t));
}

export function recolorMark(id, color) {
  if (!COLORS.has(color)) throw Object.assign(new Error('颜色只能是 y / g / b / p'), { status: 400 });
  const r = handle().prepare('UPDATE exam_marks SET color = ? WHERE id = ?').run(color, id);
  return { ok: r.changes > 0 };
}

export function removeMark(id) {
  const r = handle().prepare('DELETE FROM exam_marks WHERE id = ?').run(id);
  if (r.changes) { setMeta(DIRTY_KEY, '1'); scheduleIdleFlush(); }
  return { ok: r.changes > 0 };
}

function renderSentences() {
  const rows = handle().prepare('SELECT * FROM exam_marks ORDER BY exam_id, id').all();
  const byExam = new Map();
  for (const r of rows) {
    if (!byExam.has(r.exam_id)) byExam.set(r.exam_id, []);
    byExam.get(r.exam_id).push(r);
  }
  const lines = [AUTO_START, '', `真题里划的 **${rows.length}** 句（${byExam.size} 套卷子）。`, ''];
  const exams = [...byExam.keys()].map((id) => ({ id, exam: getExam(id) })).filter((x) => x.exam)
    .sort((a, b) => b.exam.year - a.exam.year || a.id.localeCompare(b.id));
  for (const { id, exam } of exams) {
    lines.push(`## ${exam.year} 年 ${KIND_NAME[exam.kind] || exam.kindLabel}`, '');
    const order = new Map(exam.sections.map((s, i) => [s.id, i]));
    const list = byExam.get(id).sort((a, b) => (order.get(a.section_id) ?? 99) - (order.get(b.section_id) ?? 99) || a.id - b.id);
    let lastSec = null;
    for (const r of list) {
      const sec = exam.sections.find((s) => s.id === r.section_id);
      if (r.section_id !== lastSec) { lines.push(`### ${sec?.label || r.section_id}`, ''); lastSec = r.section_id; }
      // 只留句子本身；哪年哪张卷已经在标题里，标注日期和站内链接都是噪音
      lines.push(`> ${r.text.replace(/\n/g, ' ')}${r.q ? `　<sub>第 ${r.q} 题</sub>` : ''}`, '');
    }
  }
  lines.push(AUTO_END);
  return lines.join('\n');
}

const FRONTMATTER = `---
title: 真题例句
tags: [英语, 语法, 真题]
created: ${todayStr()}
kind: exam-sentences
reviewable: false
---
`;

let writing = Promise.resolve();

async function writeSentencesOnce() {
  await fsp.mkdir(path.dirname(SENTENCE_FILE), { recursive: true });
  let existing = '';
  try { existing = await fsp.readFile(SENTENCE_FILE, 'utf8'); } catch { /* 首次写入 */ }
  const auto = renderSentences();
  let body;
  if (existing.includes(AUTO_START) && existing.includes(AUTO_END)) {
    // 只替换自动区，区外的手记原样保留
    body = existing.slice(0, existing.indexOf(AUTO_START)) + auto + existing.slice(existing.indexOf(AUTO_END) + AUTO_END.length);
  } else if (existing) {
    body = `${existing.trimEnd()}\n\n${auto}\n`;
  } else {
    body = `${FRONTMATTER}\n## 手写笔记\n\n（这一块不会被自动覆盖，随便写）\n\n${auto}\n`;
  }
  const tmp = `${SENTENCE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, SENTENCE_FILE);
}

/** 把脏标记对应的句子写成 Markdown；返回是否真的写了 */
export async function flush() {
  if (getMeta(DIRTY_KEY) !== '1') return false;
  writing = writing.then(writeSentencesOnce).catch(() => {});
  await writing;
  setMeta(DIRTY_KEY, '0');
  return true;
}

let idleTimer = null;
function scheduleIdleFlush() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; flush().catch(() => {}); }, IDLE_FLUSH_MS);
  idleTimer.unref?.();
}

export function recoverPending() {
  if (getMeta(DIRTY_KEY) === '1') flush().catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 错题本：HTML → Markdown
 * ------------------------------------------------------------------ */

const esc = (t) => t.replace(/([*_`[\]])/g, '\\$1');
/** KaTeX 渲染文本的线性化：没有 TeX 源，只能这样凑合；顺手去掉零宽空格 */
const texText = (node) => node.text.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim();
/* KaTeX 的 HTML 压成一行再嵌进 Markdown：换行会被当成段落边界，
   而 Markdown 语法字符（* _ ~）在 KaTeX 里都是 ∗ 之类的 Unicode，不会被误解析 */
const katexHtml = (node) => node.outerHTML.replace(/\s*\n\s*/g, ' ');

/**
 * 尽力而为的 HTML → Markdown。
 *
 * 公式：题源只给了 KaTeX 渲染后的 HTML，没有 TeX 源。原样嵌 HTML 在本站没问题
 * （页面自带 KaTeX 样式），但在 Obsidian 里那堆 span 没有样式，上下标靠绝对定位摞成一团。
 * 所以先试着把 TeX 倒推回来写成 `$…$`——两边都是原生支持，还能直接改。
 * 倒推必须经过校验（见 katex-tex.js），验不过就退回嵌 HTML，宁可难看也不能写错一个公式。
 *
 * 只有英语完形的下划线空格另写成 ___7___。
 */
function toMd(html, { examId, q } = {}) {
  if (!html) return '';
  // <pre> 默认被当成原文块不解析，显式列出块级原文元素才能拿到里面的 <code>
  const root = parse(`<div>${html}</div>`, { blockTextElements: { script: true, noscript: true, style: true } });
  const walk = (node, ctx = {}) => {
    if (node.nodeType === 3) return esc(node.rawText.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const cls = node.classList;
    if (cls?.contains('katex-display')) {
      const got = reclaimTex(node.outerHTML, true);
      return got ? `\n\n$$\n${got.tex}\n$$\n\n` : `\n\n${katexHtml(node)}\n\n`;
    }
    if (cls?.contains('katex')) {
      const t = texText(node);
      // 英语题干里的空是 \underline{\quad}，渲染文本为空 → 写成下划线
      if (!t || node.querySelector('.mord.underline')) return t ? ` ___${t}___ ` : ' ______ ';
      const got = reclaimTex(node.outerHTML, false);
      if (got) return got.display ? `\n\n$$\n${got.tex}\n$$\n\n` : `$${got.tex}$`;
      return katexHtml(node);
    }
    if (cls?.contains('blank')) return ` ___${node.text.trim()}___ `;
    const kids = () => node.childNodes.map((c) => walk(c, ctx)).join('');
    switch (tag) {
      case 'p': return `\n\n${kids().trim()}\n\n`;
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': return `**${kids().trim()}**`;
      case 'em': case 'i': return `*${kids().trim()}*`;
      case 'u': return kids();
      case 'code': return ctx.pre ? node.text : `\`${node.text}\``;
      case 'pre': {
        const code = node.querySelector('code');
        const lang = code?.getAttribute('data-lang') || '';
        return `\n\n\`\`\`${lang}\n${(code || node).text.replace(/\n$/, '')}\n\`\`\`\n\n`;
      }
      case 'ul': case 'ol': {
        const items = node.childNodes.filter((c) => c.nodeType === 1 && c.tagName === 'LI');
        const start = Number(node.getAttribute('start') || 1);
        return `\n\n${items.map((li, i) => `${tag === 'ol' ? `${start + i}.` : '-'} ${walk(li, ctx).trim().replace(/\n+/g, '\n  ')}`).join('\n')}\n\n`;
      }
      case 'li': return kids();
      case 'table': {
        const rows = node.querySelectorAll('tr').map((tr) => tr.childNodes.filter((c) => c.nodeType === 1).map((td) => walk(td, ctx).trim().replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r) => `| ${[...r, ...Array(w - r.length).fill('')].join(' | ')} |`;
        return `\n\n${line(rows[0])}\n| ${Array(w).fill('---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
      }
      case 'img': {
        // 图片不搬进笔记：留一句话和回到原题的链接（见 README「真题」一节）
        return `\n\n（图：见原题 → [${examId || '原题'}${q ? ` 第 ${q} 题` : ''}](${appUrl(examId, q)})）\n\n`;
      }
      case 'blockquote': return `\n\n> ${kids().trim().replace(/\n+/g, '\n> ')}\n\n`;
      case 'details': case 'summary': case 'div': case 'span': default: return kids();
    }
  };
  return walk(root.firstChild).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* 题干写成引用块：错题本笔记里引用块被样式成醒目的题面（标签只进 frontmatter，正文不再重复一行 #）
   空行也要带 >，否则引用块在空行处断开 */
const quote = (md) => md.trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

/** 一道题的 Markdown 片段 */
/**
 * 完形：把带这个空的那一句原文抠出来。
 * 这个空填正确答案（加粗），我选错的话划掉放前面；同句里别的空也填上答案，读起来是一句完整的话。
 */
function clozeSentence(section, n, mine, submitted) {
  const TOK = (k) => `\u0001${k}\u0002`;
  const html = (section.passage || []).map((p) => (p.segs || []).map((seg) => (typeof seg === 'string' ? seg : TOK(seg.n))).join('')).join('\n\n');
  const text = toMd(html, {}).replace(/\s+/g, ' ').trim();
  // 按句号 / 问号 / 感叹号切句，取含本空的那句
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z"“])/);
  const hit = sentences.find((x) => x.includes(TOK(n))) || text;
  const wordOf = (k, key) => section.questions.find((q) => q.n === k)?.options.find((o) => o.k === key)?.text || '';
  return hit.replace(/\u0001(\d+)\u0002/g, (_, k) => {
    const q = section.questions.find((x) => x.n === Number(k));
    if (!q) return '____';
    if (!submitted) return Number(k) === n ? '**____**' : '____';
    const right = wordOf(q.n, q.answer);
    if (Number(k) !== n) return right || '____';
    return mine && mine !== q.answer ? `~~${wordOf(q.n, mine)}~~ **${right}**` : `**${right}**`;
  });
}

export function questionMd(exam, section, n, submitted, mine) {
  const marker = `<!-- kb:q:${exam.id}:${section.id}:${n ?? 'all'} -->`;
  const ctx = { examId: exam.id, q: n };
  // 数学 / 408 按知识点归档，一个文件里跨年份，标题要带卷子；英语按卷归档，只写题号
  const paper = exam.group === 'english' ? '' : `${KIND_NAME[exam.kind] || exam.kindLabel} ${exam.year} · `;
  const head = `## ${paper}${n != null ? `第 ${n} 题` : section.label}${section.subject ? ` · ${section.subject}` : ''}`;
  const out = [marker, head, ''];
  let tags = [];

  if (section.type === 'choice') {
    const q = section.questions.find((x) => x.n === n);
    if (!q) throw Object.assign(new Error('题目不存在'), { status: 404 });
    tags = q.tags || [];
    if (section.id === 'cloze') {
      // 错题本要一眼看出错在哪：直接给原句，不让人再跳回卷面
      out.push(`> ${clozeSentence(section, n, mine, submitted)}`, '');
    } else if (q.stem) {
      out.push(quote(toMd(q.stem, ctx)), '');
    }
    // 交过卷：正确项打 ✓，我选错的打 ✗
    const mark = (o) => (!submitted ? '' : o.k === q.answer ? '✓ ' : mine && o.k === mine ? '✗ ' : '');
    out.push(...q.options.map((o) => `- ${mark(o)}${o.k}. ${toMd(o.text, ctx).replace(/\n+/g, ' ')}`), '');
    if (submitted) {
      out.push(`**答案：${q.answer}**${mine && mine !== q.answer ? `　我选了 ${mine}` : ''}`, '');
      if (q.explanation) out.push(toMd(q.explanation, ctx), '');
    } else {
      out.push('（这一单元还没交卷，答案与解析未附）', '');
    }
  } else if (section.type === 'fill') {
    const q = section.questions.find((x) => x.n === n);
    if (!q) throw Object.assign(new Error('题目不存在'), { status: 404 });
    tags = q.tags || [];
    out.push(quote(toMd(q.stem, ctx)), '');
    if (submitted) out.push('**参考答案**', '', toMd(q.solution, ctx), '');
    else out.push('（这一单元还没交卷，答案未附）', '');
  } else {
    tags = section.tags || [];
    if (section.directions) out.push(toMd(section.directions, ctx), '');
    out.push(quote(toMd(section.body, ctx)), '');
    if (submitted) out.push('**参考答案**', '', toMd(section.solution, ctx), '');
    else out.push('（这一单元还没交卷，参考答案未附）', '');
  }
  return { marker, md: out.join('\n'), tags };
}

/**
 * 把一道题追加到错题本。同一道题只追加一次（靠 marker 去重）。
 * 文件是给 Obsidian 编辑的，所以只追加、不重写已有内容。
 */
export async function exportQuestion(examId, sectionId, n, { drill = false } = {}) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw Object.assign(new Error('单元不存在'), { status: 404 });
  let submitted;
  let mine;
  if (drill && n != null) {
    const a = drillAttemptOf(examId, sectionId, n);
    submitted = !!a;
    mine = a?.answer || null;
  } else {
    const attempt = attemptsOf(examId)[sectionId];
    submitted = !!attempt?.submittedAt;
    mine = n != null ? attempt?.answers?.[n] || null : null;
  }
  const { marker, md, tags } = questionMd(exam, section, n, submitted, mine);

  /* 归档位置：数学 / 408 按最具体的知识点一个文件（泰勒公式 错题.md），同一考点历年的错题聚在一起；
     英语没有知识点标签，仍按卷归档（2026 英语二.md） */
  const point = exam.group !== 'english' && tags.length ? tags[tags.length - 1].replace(/[\\/:*?"<>|]/g, '_') : '';
  const folder = path.join(VAULT_ROOT, GROUP_FOLDER[exam.group] || exam.kindLabel, '错题本');
  const file = path.join(folder, point ? `${point} 错题.md` : `${exam.year} ${KIND_NAME[exam.kind] || exam.kindLabel}.md`);
  const title = point ? `${point} 错题` : `${exam.year} ${KIND_NAME[exam.kind] || exam.kindLabel} 错题`;
  const h1 = point ? `${point} · 错题本` : `${exam.year} 年 ${KIND_NAME[exam.kind] || exam.kindLabel} · 错题本`;
  await fsp.mkdir(folder, { recursive: true });

  let existing = '';
  try { existing = await fsp.readFile(file, 'utf8'); } catch { /* 新建 */ }
  const rel = path.relative(VAULT_ROOT, file).split(path.sep).join('/');
  if (existing.includes(marker)) return { file: rel, added: false, submitted };

  let body;
  if (!existing) {
    const subject = GROUP_FOLDER[exam.group] || exam.kindLabel;
    body = `---\ntitle: ${title}\ntags: [${[subject, '错题', ...tags].map((t) => t.replace(/[,\s]/g, '_')).join(', ')}]\ncreated: ${todayStr()}\nkind: wrong-questions\n---\n\n# ${h1}\n\n${md}\n`;
  } else {
    body = `${existing.trimEnd()}\n\n${md}\n`;
    // 新标签补进 frontmatter 的 tags 行，方便按知识点检索
    const m = /^tags:\s*\[([^\]]*)\]/m.exec(body);
    if (m && tags.length) {
      const have = new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
      const add = tags.map((t) => t.replace(/[,\s]/g, '_')).filter((t) => !have.has(t));
      if (add.length) body = body.replace(m[0], `tags: [${[...have, ...add].join(', ')}]`);
    }
  }
  await fsp.writeFile(file, body, 'utf8');
  return { file: rel, added: true, submitted };
}
