import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';
import { VAULT_ROOT, PORT } from '../config.js';
import { handle, getMeta, setMeta } from './db.js';
import { getExam, attemptsOf } from './exams.js';
import { todayStr } from './review.js';

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

/**
 * 词卡上的例句也能摘到同一个文件里：exam_id 写成 vocab:<词>，section_id = example。
 * 渲染时单独归到「词卡例句」一节，不参与卷子分组。
 */
export function addVocabSentence(term, text) {
  const t = normText(text);
  const key = String(term || '').trim().toLowerCase();
  if (!key || t.length < 2) throw Object.assign(new Error('没有例句'), { status: 400 });
  const d = handle();
  d.prepare(`INSERT INTO exam_marks (exam_id, section_id, q, text, color, created_at) VALUES (?, 'example', NULL, ?, 'y', ?)
             ON CONFLICT(exam_id, section_id, text) DO NOTHING`)
    .run(`vocab:${key}`, t, todayStr());
  setMeta(DIRTY_KEY, '1');
  scheduleIdleFlush();
  return rowOut(d.prepare("SELECT * FROM exam_marks WHERE exam_id = ? AND section_id = 'example' AND text = ?").get(`vocab:${key}`, t));
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
  const all = handle().prepare('SELECT * FROM exam_marks ORDER BY exam_id, id').all();
  const vocabRows = all.filter((r) => r.exam_id.startsWith('vocab:'));
  const rows = all.filter((r) => !r.exam_id.startsWith('vocab:'));
  const byExam = new Map();
  for (const r of rows) {
    if (!byExam.has(r.exam_id)) byExam.set(r.exam_id, []);
    byExam.get(r.exam_id).push(r);
  }
  const lines = [AUTO_START, '', `真题里划的 **${rows.length}** 句（${byExam.size} 套卷子），词卡摘录 **${vocabRows.length}** 句。`, ''];
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
      lines.push(`> ${r.text.replace(/\n/g, ' ')}`, '');
      // 链接带 hl=标记 id：打开后直接滚到这一句并闪一下，像书签
      lines.push(`标于 ${r.created_at.replaceAll('-', '.')}${r.q ? ` · 第 ${r.q} 题` : ''} · [跳到原句](${appUrl(id, r.q, r.id)})`, '');
    }
  }
  if (vocabRows.length) {
    lines.push('## 词卡例句', '');
    for (const r of vocabRows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id - b.id)) {
      lines.push(`- **${r.exam_id.slice(6)}** — ${r.text.replace(/\n/g, ' ')}　<sub>${r.created_at.replaceAll('-', '.')}</sub>`);
    }
    lines.push('');
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

/** 尽力而为的 HTML → Markdown。公式没有 TeX 源，只能取 KaTeX 渲染文本裹在反引号里 */
function toMd(html, { examId, q } = {}) {
  if (!html) return '';
  // <pre> 默认被当成原文块不解析，显式列出块级原文元素才能拿到里面的 <code>
  const root = parse(`<div>${html}</div>`, { blockTextElements: { script: true, noscript: true, style: true } });
  const walk = (node, ctx = {}) => {
    if (node.nodeType === 3) return esc(node.rawText.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const cls = node.classList;
    if (cls?.contains('katex-display')) { const t = texText(node); return t ? `\n\n\`${t}\`\n\n` : ''; }
    if (cls?.contains('katex')) {
      const t = texText(node);
      // 英语题干里的空是 \underline{\quad}，渲染文本为空 → 写成下划线
      if (!t || node.querySelector('.mord.underline')) return t ? ` ___${t}___ ` : ' ______ ';
      return `\`${t}\``;
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

const mdTags = (tags) => tags.map((t) => `#${t.replace(/[\s#]/g, '_')}`).join(' ');

/** 一道题的 Markdown 片段 */
function questionMd(exam, section, n, submitted) {
  const marker = `<!-- kb:q:${exam.id}:${section.id}:${n ?? 'all'} -->`;
  const ctx = { examId: exam.id, q: n };
  const head = `## ${n != null ? `第 ${n} 题` : section.label}${section.subject ? ` · ${section.subject}` : ''}`;
  const out = [marker, head, ''];
  let tags = [];

  if (section.type === 'choice') {
    const q = section.questions.find((x) => x.n === n);
    if (!q) throw Object.assign(new Error('题目不存在'), { status: 404 });
    tags = q.tags || [];
    if (tags.length) out.push(mdTags(tags), '');
    if (section.id === 'cloze') {
      out.push(`完形第 ${n} 空（原文见 [卷面](${appUrl(exam.id, n)})）`, '');
    } else if (q.stem) {
      out.push(toMd(q.stem, ctx), '');
    }
    out.push(...q.options.map((o) => `- ${o.k}. ${toMd(o.text, ctx).replace(/\n+/g, ' ')}`), '');
    if (submitted) {
      out.push(`**答案：${q.answer}**`, '');
      if (q.explanation) out.push(toMd(q.explanation, ctx), '');
    } else {
      out.push('（这一单元还没交卷，答案与解析未附）', '');
    }
  } else if (section.type === 'fill') {
    const q = section.questions.find((x) => x.n === n);
    if (!q) throw Object.assign(new Error('题目不存在'), { status: 404 });
    tags = q.tags || [];
    if (tags.length) out.push(mdTags(tags), '');
    out.push(toMd(q.stem, ctx), '');
    if (submitted) out.push('**参考答案**', '', toMd(q.solution, ctx), '');
    else out.push('（这一单元还没交卷，答案未附）', '');
  } else {
    tags = section.tags || [];
    if (tags.length) out.push(mdTags(tags), '');
    if (section.directions) out.push(toMd(section.directions, ctx), '');
    out.push(toMd(section.body, ctx), '');
    if (submitted) out.push('**参考答案**', '', toMd(section.solution, ctx), '');
    else out.push('（这一单元还没交卷，参考答案未附）', '');
  }
  out.push(`来源：${exam.year} 年 ${KIND_NAME[exam.kind] || exam.kindLabel} · [在站内打开](${appUrl(exam.id, n)})`, '');
  return { marker, md: out.join('\n'), tags };
}

/**
 * 把一道题追加到错题本。同一道题只追加一次（靠 marker 去重）。
 * 文件是给 Obsidian 编辑的，所以只追加、不重写已有内容。
 */
export async function exportQuestion(examId, sectionId, n) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw Object.assign(new Error('单元不存在'), { status: 404 });
  const submitted = !!attemptsOf(examId)[sectionId]?.submittedAt;
  const { marker, md, tags } = questionMd(exam, section, n, submitted);

  const folder = path.join(VAULT_ROOT, GROUP_FOLDER[exam.group] || exam.kindLabel, '错题本');
  const file = path.join(folder, `${exam.year} ${KIND_NAME[exam.kind] || exam.kindLabel}.md`);
  await fsp.mkdir(folder, { recursive: true });

  let existing = '';
  try { existing = await fsp.readFile(file, 'utf8'); } catch { /* 新建 */ }
  const rel = path.relative(VAULT_ROOT, file).split(path.sep).join('/');
  if (existing.includes(marker)) return { file: rel, added: false, submitted };

  let body;
  if (!existing) {
    const subject = GROUP_FOLDER[exam.group] || exam.kindLabel;
    body = `---\ntitle: ${exam.year} ${KIND_NAME[exam.kind] || exam.kindLabel} 错题\ntags: [${[subject, '错题', ...tags].map((t) => t.replace(/[,\s]/g, '_')).join(', ')}]\ncreated: ${todayStr()}\nkind: wrong-questions\n---\n\n# ${exam.year} 年 ${KIND_NAME[exam.kind] || exam.kindLabel} · 错题本\n\n${md}\n`;
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
