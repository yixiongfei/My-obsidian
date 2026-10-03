import * as vdb from './vocabulary-db.js';
import * as marks from './vocab-marks.js';
import * as sentences from './sentences.js';
import * as drill from './drill.js';
import { getExam, attemptsOf } from './exams.js';
import { handle } from './db.js';
import { questionMd, exportQuestion } from './exam-marks.js';
import { roughTex } from './katex-tex.js';
import { todayStr, addDays } from './review.js';

/**
 * 助手能动的应用数据：单词、阅读卡片、做过的题 / 错题本。
 *
 * 每个「改」都有一个配套的 preview：算出改前 → 改后给用户确认，不落库；
 * 用户点了允许，才调真正的写函数。纯新增（加词、加句子）不弹确认，结果照样在对话里列出来。
 */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const STATE_NAME = { new: '未学', review: '学习中', mastered: '已熟识' };

/* ------------------------------------------------------------------ *
 * 单词
 * ------------------------------------------------------------------ */

function findWordId(term) {
  const q = vdb.handle().prepare('SELECT id FROM vocab_words WHERE term_key = ?');
  for (const k of marks.lemmaCandidates(term)) {
    const hit = q.get(k);
    if (hit) return hit.id;
  }
  return null;
}

function wordOf(term) {
  const id = findWordId(term);
  if (!id) return null;
  const w = marks.detail(id);
  const c = vdb.handle().prepare('SELECT state, due, interval, repetitions, lapses, last_review FROM vocab_cards WHERE word_id = ?').get(id) || {};
  return {
    id,
    term: w.term,
    phonetic: w.phonetic,
    inList: w.inList,
    important: w.important,
    senses: w.senses,
    examples: w.examples.map((e) => ({ id: e.id, text: e.text, translation: e.translation })),
    state: STATE_NAME[c.state] || c.state || '未学',
    due: c.state === 'review' ? c.due : null,
    reviews: c.repetitions || 0,
    lapses: c.lapses || 0,
    lastReview: c.last_review || null,
  };
}

export function lookupWords(terms) {
  return (Array.isArray(terms) ? terms : []).slice(0, 30).map((t) => wordOf(t) || { term: t, found: false });
}

/**
 * 加词：词表里有的就标注（排到新词队列最前面），没有的建成自定义词。
 * 词表里已有释义的不覆盖——那是 ECDICT 的；自定义词才用这里给的释义 / 例句。
 */
export function addWords(words) {
  const out = [];
  for (const raw of (Array.isArray(words) ? words : []).slice(0, 30)) {
    const term = clip(raw?.term, 40);
    try {
      const existed = !!findWordId(term);
      const r = marks.mark(term, { source: 'assistant', meaning: raw?.senses?.length ? '' : clip(raw?.meaning, 200) });
      const id = r.word.id;
      const cur = marks.detail(id);
      const patch = {};
      if (!cur.senses.length && raw?.senses?.length) patch.senses = raw.senses;
      if (!cur.phonetic && raw?.phonetic) patch.phonetic = raw.phonetic;
      if (raw?.examples?.length) patch.examples = [...cur.examples, ...raw.examples].slice(0, 6);
      if (Object.keys(patch).length) marks.update(id, patch);
      out.push({ term: r.word.term, inList: r.word.inList, created: !existed, ok: true });
    } catch (err) {
      out.push({ term, ok: false, error: err.message });
    }
  }
  return out;
}

const sensesText = (s) => s.map((x, i) => `${i + 1}. ${x.pos ? `${x.pos} ` : ''}${x.gloss}`).join('\n') || '（无）';
const examplesText = (e) => e.map((x) => `· ${x.text}${x.translation ? `\n  ${x.translation}` : ''}`).join('\n') || '（无）';

function wordPatch(input) {
  const w = wordOf(input.term);
  if (!w) throw bad(`单词表里没有 ${input.term}，要加词用 add_words`);
  const patch = {};
  if (typeof input.phonetic === 'string') patch.phonetic = input.phonetic;
  if (Array.isArray(input.senses)) patch.senses = input.senses;
  if (Array.isArray(input.examples)) patch.examples = input.examples;
  if (!Object.keys(patch).length) throw bad('没有要改的内容');
  return { w, patch };
}

export function editWordPreview(input) {
  const { w, patch } = wordPatch(input);
  const rows = [];
  if ('phonetic' in patch) rows.push({ op: '调整', title: `${w.term} · 音标`, before: w.phonetic ? `/${w.phonetic}/` : '（无）', after: `/${clip(patch.phonetic, 80).replace(/^\/|\/$/g, '')}/` });
  if (patch.senses) rows.push({ op: '调整', title: `${w.term} · 释义`, before: sensesText(w.senses), after: sensesText(patch.senses.filter((s) => s?.gloss).slice(0, 6)) });
  if (patch.examples) rows.push({ op: '调整', title: `${w.term} · 例句`, before: examplesText(w.examples), after: examplesText(patch.examples.filter((e) => e?.text).slice(0, 6)) });
  return { summary: input.reason || '', rows };
}

export function editWord(input) {
  const { w, patch } = wordPatch(input);
  const d = marks.update(w.id, patch);
  return { term: d.term, senses: d.senses.length, examples: d.examples.length };
}

const ACTION = {
  mark: { label: '标注', desc: '标注（新词队列优先出）' },
  unmark: { label: '取消标注', desc: '不再标注' },
  relearn: { label: '重学', desc: '今天重新出现在复习里' },
  master: { label: '已熟识', desc: '毕业，不再出现' },
};

function statusTargets(terms, action) {
  if (!ACTION[action]) throw bad(`不认识的动作：${action}`);
  const list = (Array.isArray(terms) ? terms : []).slice(0, 50).map((t) => ({ t, w: wordOf(t) }));
  const missing = list.filter((x) => !x.w).map((x) => x.t);
  if (missing.length) throw bad(`单词表里没有：${missing.join('、')}`);
  return list.map((x) => x.w);
}

export function wordStatusPreview({ terms, action, reason }) {
  const ws = statusTargets(terms, action);
  return {
    summary: reason || '',
    rows: ws.map((w) => ({
      op: ACTION[action].label,
      title: w.term,
      before: `${w.state}${w.important ? ' · 已标注' : ''}${w.lapses ? ` · 忘过 ${w.lapses} 次` : ''}`,
      after: ACTION[action].desc,
    })),
  };
}

/** 改学习状态只动卡片，不写复习记录——不是真的背了一遍，不该算进每日背词和连续天数 */
export function setWordStatus({ terms, action }) {
  const ws = statusTargets(terms, action);
  const today = todayStr();
  return vdb.tx((d) => {
    const run = {
      mark: (id) => d.prepare("UPDATE vocab_cards SET important = 1, marked_at = ?, mark_source = 'assistant' WHERE word_id = ?").run(today, id),
      unmark: (id) => d.prepare('UPDATE vocab_cards SET important = 0, marked_at = NULL WHERE word_id = ?').run(id),
      relearn: (id) => d.prepare("UPDATE vocab_cards SET state = 'review', due = ?, interval = 0, repetitions = 0 WHERE word_id = ?").run(today, id),
      master: (id) => d.prepare("UPDATE vocab_cards SET state = 'mastered', due = '9999-12-31' WHERE word_id = ?").run(id),
    }[action];
    for (const w of ws) run(w.id);
    return { action, count: ws.length };
  });
}

/* ------------------------------------------------------------------ *
 * 阅读卡片（长难句 / 短文）
 * ------------------------------------------------------------------ */

export function addSentences(items) {
  return (Array.isArray(items) ? items : []).slice(0, 20).map((it) => {
    try {
      const r = sentences.add({ text: it.text, source: clip(it.source, 60) || '助手' });
      if (r.added && (it.translation || it.note)) sentences.setFields(r.card.id, { translation: it.translation, note: it.note });
      return { id: r.card.id, added: r.added, text: r.card.text.slice(0, 60) };
    } catch (err) {
      return { text: clip(it?.text, 60), added: false, error: err.message };
    }
  });
}

const cardOf = (id) => {
  const c = sentences.all().cards.find((x) => x.id === Number(id));
  if (!c) throw bad(`阅读卡片不存在：${id}`);
  return c;
};

export function editReadingPreview(input) {
  const c = cardOf(input.id);
  const rows = [];
  const label = c.kind === 'passage' ? `短文《${c.title}》` : `#${c.id}`;
  if (input.text != null && clip(input.text, 4000) !== c.text) rows.push({ op: '调整', title: `${label} · 原文`, before: c.text, after: clip(input.text, 4000) + (c.spans.length ? '\n（原文变了，之前的结构标注会清掉）' : '') });
  if (input.title != null) rows.push({ op: '调整', title: `${label} · 标题`, before: c.title || '（无）', after: input.title });
  if (input.translation != null) rows.push({ op: '调整', title: `${label} · 译文`, before: c.translation || '（无）', after: input.translation || '（清空）' });
  if (input.note != null) rows.push({ op: '调整', title: `${label} · 备注`, before: c.note || '（无）', after: input.note || '（清空）' });
  if (!rows.length) throw bad('没有要改的内容');
  return { summary: input.reason || '', rows };
}

export function editReading(input) {
  cardOf(input.id);
  return sentences.setFields(Number(input.id), input);
}

export function deleteReadingsPreview({ ids, reason }) {
  return {
    summary: reason || '',
    rows: (ids || []).slice(0, 50).map((id) => {
      const c = cardOf(id);
      return { op: '删除', title: c.kind === 'passage' ? `短文《${c.title}》` : c.text.slice(0, 80), before: `复习 ${c.reps} 次${c.source ? ` · ${c.source}` : ''}`, after: '' };
    }),
  };
}

export function deleteReadings({ ids }) {
  return { removed: (ids || []).slice(0, 50).filter((id) => sentences.remove(Number(id)).ok).length };
}

/* ------------------------------------------------------------------ *
 * 做过的题：专题训练 + 整卷
 * ------------------------------------------------------------------ */

const localDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const KIND = { english1: '英语一', english2: '英语二', math1: '数一', math2: '数二', math3: '数三', 408: '408' };
const labelOf = (exam, section, n) => `${KIND[exam.kind] || exam.kindLabel} ${exam.year} · ${section.label || section.title || section.id}${n ? ` 第 ${n} 题` : ''}`;

function tagsOf(section, n) {
  const q = section.questions?.find((x) => x.n === n);
  return q?.tags || section.tags || [];
}

/** 最近做过的题，错的在前：{ exam, section, n, label, date, mode, correct, tags } */
export function examHistory(days = 14, limit = 60) {
  const since = addDays(todayStr(), -(days - 1));
  const cache = new Map();
  const examOf = (id) => { if (!cache.has(id)) cache.set(id, getExam(id)); return cache.get(id); };
  const out = [];

  for (const r of handle().prepare('SELECT * FROM exam_drill ORDER BY answered_at DESC').all()) {
    const date = localDate(r.answered_at);
    if (date < since) continue;
    const exam = examOf(r.exam_id);
    const section = exam?.sections.find((s) => s.id === r.section_id);
    if (!section) continue;
    out.push({ exam: exam.id, section: section.id, n: r.n, label: labelOf(exam, section, r.n), date, mode: '专题训练', correct: r.correct == null ? null : !!r.correct, tags: tagsOf(section, r.n) });
  }

  for (const r of handle().prepare('SELECT * FROM exam_attempts WHERE submitted_at IS NOT NULL ORDER BY submitted_at DESC').all()) {
    const date = localDate(r.submitted_at);
    if (date < since) continue;
    const exam = examOf(r.exam_id);
    const section = exam?.sections.find((s) => s.id === r.section_id);
    if (!section) continue;
    let answers = {};
    try { answers = JSON.parse(r.answers || '{}'); } catch { /* 坏行 */ }
    if (section.type === 'choice') {
      for (const q of section.questions) {
        if (!answers[q.n]) continue;
        out.push({ exam: exam.id, section: section.id, n: q.n, label: labelOf(exam, section, q.n), date, mode: '整卷', correct: answers[q.n] === q.answer, tags: q.tags || [] });
      }
    } else {
      out.push({ exam: exam.id, section: section.id, n: section.numbers?.[0] ?? null, label: labelOf(exam, section, null), date, mode: '整卷', correct: null, tags: section.tags || [], score: r.score, total: r.total });
    }
  }
  // 错的在前，其次按日期新到旧
  const rank = (x) => (x.correct === false ? 0 : x.correct == null ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date)).slice(0, limit);
}

/** 一道题交没交、交了什么：专题训练按小题，整卷按单元 */
function attemptOfQuestion(examId, sectionId, num) {
  const d = num != null ? drill.attemptOf(examId, sectionId, num) : null;
  const a = attemptsOf(examId)[sectionId];
  return { submitted: !!d || !!a?.submittedAt, mine: d ? d.answer : num != null ? a?.answers?.[num] : a?.answers?.text, ai: d?.ai || null };
}

const VERDICT = { right: '全对', partial: '部分对', wrong: '错' };

/**
 * 错题本那边倒推 TeX 校验没过的公式，会原样嵌着 KaTeX 的 HTML——一个公式三千多字的 span。
 * 给模型读的话换成未经校验的 TeX（roughTex）；连这也猜不出就退成公式的可见文字。
 */
const KATEX_OPEN = /<span class=(?:"katex(?:-display)?"|katex(?:-display)?)[\s>]/g;
function plainFormulas(md) {
  let out = '';
  let from = 0;
  KATEX_OPEN.lastIndex = 0;
  for (let m; (m = KATEX_OPEN.exec(md));) {
    const tag = /<\/?span\b[^>]*>/g;
    tag.lastIndex = m.index;
    let depth = 0;
    let end = -1;
    for (let t; (t = tag.exec(md));) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (!depth) { end = tag.lastIndex; break; }
    }
    if (end < 0) break;
    const html = md.slice(m.index, end);
    const tex = roughTex(html);
    const display = m[0].includes('katex-display');
    out += md.slice(from, m.index) + (tex
      ? (display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`)
      : html.replace(/<[^>]+>/g, '').replace(/​/g, ''));
    from = end;
    KATEX_OPEN.lastIndex = end;
  }
  return out + md.slice(from);
}

/** 一道题的完整 Markdown：题干、选项、我的作答；交过的附答案和解析 */
export function questionOf(examId, sectionId, n) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw bad('题目不存在', 404);
  const num = n == null ? null : Number(n);
  const { submitted, mine } = attemptOfQuestion(examId, sectionId, num);
  const { md } = questionMd(exam, section, num, submitted, section.type === 'choice' ? mine : null);
  const extra = mine && section.type !== 'choice' ? `\n\n**我的作答**\n\n${String(mine).replace(/!\[\]\(([^)]+)\)/g, '（手写图：$1）')}` : '';
  return `${plainFormulas(md.replace(/<!--[\s\S]*?-->/g, '')).trim()}${extra}`;
}

/* 作答里的手写图：独占一行的 ![](图像/作答/xxx.png) */
const ANSWER_IMG = /!\[\]\((图像\/作答\/[^)/\\]+\.(?:png|jpe?g|webp|gif))\)/gi;

/**
 * 做题页侧栏助手随消息附上的「正在做的这道题」。
 * 题面和交过的作答同 questionOf（没交不给答案）；没交时把正在写的草稿也带上并注明还没提交。
 * 作答里的手写图另外列出来，由调用方当图片发给模型。
 * extras: false 不带 AI 上次的批改和便利贴——重新批改时只看题、答案和作答，免得被上一次的分数带偏。
 */
export function questionContext(examId, sectionId, n, draft = '', { extras = true } = {}) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw bad('题目不存在', 404);
  const num = n == null ? null : Number(n);
  const { submitted, mine, ai } = attemptOfQuestion(examId, sectionId, num);
  let text = questionOf(examId, sectionId, num);
  const wip = submitted ? '' : String(draft || '').trim();
  if (wip) {
    text += section.type === 'choice'
      ? `\n\n**我现在选的是 ${wip}（还没提交）**`
      : `\n\n**我正在写的作答（还没提交）**\n\n${wip.replace(ANSWER_IMG, '（手写图，见附图）')}`;
  }
  if (ai && extras) {
    text += `\n\n**AI 批改**：${ai.score} / ${ai.total} 分（${VERDICT[ai.verdict] || ai.verdict}）——${ai.brief}`;
    if (ai.points?.length) text += `\n${ai.points.map((p) => `- ${p}`).join('\n')}`;
  }
  const note = extras && num != null ? drill.noteOf(examId, sectionId, num) : null;
  if (note?.text) text += `\n\n**我的便利贴**\n\n${note.text}`;
  const images = [...String((submitted ? mine : wip) || '').matchAll(ANSWER_IMG)].map((m) => m[1]);
  return { text, images, submitted, label: labelOf(exam, section, num) };
}

export function wrongBookPreview({ exam, section, n, reason }) {
  const e = getExam(exam);
  const s = e?.sections.find((x) => x.id === section);
  if (!s) throw bad('题目不存在', 404);
  return { summary: reason || '', rows: [{ op: '新增', title: labelOf(e, s, n), before: '', after: '追加到对应的错题本（Markdown），题干、选项、答案解析一起' }] };
}

export async function addToWrongBook({ exam, section, n }) {
  const num = n == null ? null : Number(n);
  const drilled = num != null && !!drill.attemptOf(exam, section, num);
  return exportQuestion(exam, section, num, { drill: drilled });
}
