import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VAULT_ROOT } from '../config.js';
import * as vdb from './vocabulary-db.js';
import * as schedule from './schedule.js';
import * as points from './points.js';
import * as sentences from './sentences.js';
import { search, dashboard } from './query.js';
import { todayStr, addDays, daysBetween } from './review.js';
import { handle } from './db.js';
import * as ops from './assistant-ops.js';
import { bucketNotes } from './query.js';

/**
 * 学习助手：跑的是本机的 Claude Code（和 Obsidian 里的 Claudian 同一个登录、同一份额度），
 * 通过 Claude Agent SDK 驱动。
 *
 * 能力边界在这里定死，不交给模型自觉：
 *   - 内置工具只开 Read / Glob / Grep / Edit / Write，没有 Bash、没有联网；
 *   - 读写都只能落在笔记根（My-md）里，.obsidian / .claudian / .git 不让改；
 *   - Edit / Write 每一次都弹给用户确认（可以选「这次对话都允许」）；
 *   - 应用数据只通过下面的 kb 工具读写：读和纯新增（加词、加句子、生成阅读）直接放行；
 *     改 / 删（日程、单词、阅读卡片、错题本）都先弹「改前 → 改后」给用户确认。
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const PROTECTED = ['.obsidian', '.claudian', '.git', '.trash'];

let sdkPromise = null;
/* 按需加载：SDK 装不上（比如打包漏了）只让助手不可用，不拖垮整个服务 */
const loadSdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

/** 优先用用户自己装的 claude（和 Claudian 共用登录）；找不到再交给 SDK 自带的 */
export function claudeExecutable() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [
    process.env.CLAUDE_CODE_PATH && path.dirname(process.env.CLAUDE_CODE_PATH),
    path.join(os.homedir(), '.local', 'bin'),
    ...String(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);
  if (process.env.CLAUDE_CODE_PATH && fs.existsSync(process.env.CLAUDE_CODE_PATH)) return process.env.CLAUDE_CODE_PATH;
  for (const d of dirs) {
    const p = path.join(d, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 下一个 */ }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 路径守卫
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(VAULT_ROOT);
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const absOf = (p) => path.resolve(ROOT, String(p || ''));
const inVault = (p) => {
  const a = norm(absOf(p));
  const r = norm(ROOT);
  return a === r || a.startsWith(r + path.sep);
};
const relOf = (p) => path.relative(ROOT, absOf(p)).split(path.sep).join('/');
const isProtected = (p) => PROTECTED.includes(relOf(p).split('/')[0]);

/* ------------------------------------------------------------------ *
 * 知识库工具
 * ------------------------------------------------------------------ */

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });

function weakWords(days = 7, limit = 20) {
  const since = addDays(todayStr(), -(days - 1));
  return vdb.handle().prepare(`
    SELECT w.term,
           SUM(r.rating = 'again') AS again, SUM(r.rating = 'hard') AS hard, COUNT(*) AS reviews,
           IFNULL(c.lapses, 0) AS lapses, MAX(r.date) AS last,
           IFNULL((SELECT s.gloss FROM vocab_senses s WHERE s.word_id = w.id ORDER BY s.ord LIMIT 1), w.translation) AS gloss
    FROM vocab_reviews r
    JOIN vocab_words w ON w.id = r.word_id
    LEFT JOIN vocab_cards c ON c.word_id = w.id
    WHERE r.date >= ?
    GROUP BY w.id
    HAVING again + hard > 0 AND IFNULL(c.state, '') != 'mastered'
    ORDER BY again * 2 + hard DESC, lapses DESC, reviews DESC
    LIMIT ?`).all(since, limit)
    .map((r) => ({ ...r, gloss: String(r.gloss || '').split('\n')[0].slice(0, 40) }));
}

function buildTools(tool, onChange) {
  return [
    tool('study_overview', '学习概况：连续学习天数、距初试天数、今天到期的笔记和考点、最近每天的学习量（笔记复习 / 新建 / 背词 / 做题 / 阅读 / 考点推进）。回答「这周学得怎么样」之类的问题先调它。',
      { days: z.number().int().min(1).max(60).optional().describe('看最近几天，默认 14') },
      async ({ days = 14 }) => {
        const exam = schedule.examDate();
        const dash = dashboard(exam);
        const pts = points.progress();
        return json({
          today: todayStr(),
          examDate: exam,
          daysToExam: daysBetween(todayStr(), exam),
          streak: schedule.streak(),
          notesDue: dash.counts.due,
          dueNotes: bucketNotes().due.slice(0, 12).map((n) => ({ path: n.id, title: n.title, overdueDays: n.overdueDays, reviewCount: n.reviewCount })),
          duePoints: pts?.due?.slice(0, 12).map((p) => ({ name: p.name, subject: p.subject, overdueDays: p.overdueDays, note: p.noteId || null })),
          points: pts?.totals,
          daily: schedule.activity(days),
        });
      }, { annotations: { readOnlyHint: true } }),

    tool('weak_words', '最近一段时间背单词时一直没掌握的词（评过「重来 / 困难」、还没毕业），按难度排序，带中文释义。生成生词阅读前先调它。',
      {
        days: z.number().int().min(1).max(60).optional().describe('统计最近几天，默认 7'),
        limit: z.number().int().min(1).max(60).optional().describe('最多几个，默认 20'),
      },
      async ({ days = 7, limit = 20 }) => json(weakWords(days, limit)),
      { annotations: { readOnlyHint: true } }),

    tool('weak_points', '薄弱考点：错题本（每本记了几题）和做错过的考点，以及一轮复习各科进度。',
      {},
      async () => {
        const st = points.stageSummary();
        return json({ wrongBooks: points.wrongBooks(), weak: st?.weak, stages: st?.names, groups: st?.groups });
      }, { annotations: { readOnlyHint: true } }),

    tool('search_notes', '按关键词搜索笔记（标题、标签、小标题、正文），返回笔记路径和片段。路径相对笔记根，可以接着用 Read 读全文。',
      { query: z.string().min(1), limit: z.number().int().min(1).max(30).optional() },
      async ({ query, limit = 10 }) => json(search(query, limit).map((n) => ({
        path: n.id, title: n.title, tags: n.tags, reviewCount: n.reviewCount, nextReview: n.nextReview, snippet: n.snippet,
      }))),
      { annotations: { readOnlyHint: true } }),

    tool('list_readings', '阅读卡片（用户在真题里划 / 手动加的长难句，和生词短文），新的在前。带 id，改 / 删卡片时用。',
      {
        limit: z.number().int().min(1).max(100).optional(),
        query: z.string().optional().describe('按原文 / 译文 / 出处 / 标题筛'),
        kind: z.enum(['sentence', 'passage']).optional(),
      },
      async ({ limit = 20, query, kind }) => {
        const k = String(query || '').toLowerCase();
        return json(sentences.all().cards
          .filter((c) => (!kind || c.kind === kind) && (!k || [c.text, c.translation, c.source, c.title].some((x) => String(x || '').toLowerCase().includes(k))))
          .slice(0, limit)
          .map((c) => ({
            id: c.id, kind: c.kind, title: c.title, text: c.text, translation: c.translation, note: c.note, source: c.source,
            annotated: c.annotated, reps: c.reps, lapses: c.lapses, due: c.due, words: c.words?.map((w) => w.term),
          })));
      },
      { annotations: { readOnlyHint: true } }),

    tool('add_sentences', '把长难句加进用户的「阅读」卡片（复习页 → 阅读）。不要替用户标句子结构——第一次复习时用户自己拆，这一步本身就是复习；译文和备注也一般留空，除非用户要。',
      {
        items: z.array(z.object({
          text: z.string().describe('英文原句，一张卡一句'),
          source: z.string().optional().describe('出处，如「2020 英语一 Text 3」'),
          translation: z.string().optional(),
          note: z.string().optional(),
        })).min(1).max(20),
      },
      async ({ items }) => { const r = ops.addSentences(items); onChange?.('readings'); return json(r); }),

    tool('edit_reading', '改一张阅读卡片的原文 / 标题 / 译文 / 备注（弹给用户确认）。原文改了会清掉之前的结构标注。',
      {
        id: z.number().int(),
        text: z.string().optional(),
        title: z.string().optional(),
        translation: z.string().optional(),
        note: z.string().optional(),
        reason: z.string().optional().describe('一句话说明为什么改'),
      },
      async (input) => { const c = ops.editReading(input); onChange?.('readings'); return json({ ok: true, id: c.id }); }),

    tool('delete_readings', '删掉阅读卡片（弹给用户确认）。复习记录会保留。',
      { ids: z.array(z.number().int()).min(1).max(50), reason: z.string().optional() },
      async (input) => { const r = ops.deleteReadings(input); onChange?.('readings'); return json(r); }),

    tool('lookup_words', '查单词表里的词：音标、义项、例句、学习状态（未学 / 学习中 / 已熟识）、复习次数、遗忘次数、是否标注。加词、改词前先查。',
      { terms: z.array(z.string()).min(1).max(30) },
      async ({ terms }) => json(ops.lookupWords(terms)),
      { annotations: { readOnlyHint: true } }),

    tool('add_words', '把单词加进用户的背词队列：词表里有的会被标注、排到新词队列最前面；词表里没有的建成自定义词。词表里已有的释义不会被覆盖。',
      {
        words: z.array(z.object({
          term: z.string().describe('单词原形'),
          meaning: z.string().optional().describe('简短中文释义（只用于词表里没有的新词）'),
          senses: z.array(z.object({ pos: z.string().optional(), gloss: z.string() })).max(6).optional().describe('词表里没有的新词：按词性分的义项'),
          phonetic: z.string().optional(),
          examples: z.array(z.object({ text: z.string(), translation: z.string().optional() })).max(3).optional().describe('例句，最好来自真题'),
        })).min(1).max(30),
      },
      async ({ words }) => { const r = ops.addWords(words); onChange?.('vocab'); return json(r); }),

    tool('edit_word', '改一个单词的音标 / 义项 / 例句（弹给用户确认）。senses、examples 是整体替换，要保留的旧条目也得带上。',
      {
        term: z.string(),
        phonetic: z.string().optional(),
        senses: z.array(z.object({ pos: z.string().optional(), gloss: z.string() })).max(6).optional(),
        examples: z.array(z.object({ id: z.number().int().optional().describe('lookup_words 给的例句 id，原句不改就带上'), text: z.string(), translation: z.string().optional() })).max(6).optional(),
        reason: z.string().optional(),
      },
      async (input) => { const r = ops.editWord(input); onChange?.('vocab'); return json({ ok: true, ...r }); }),

    tool('set_word_status', '改单词的学习状态（弹给用户确认）：mark 标注（新词队列优先）、unmark 取消标注、relearn 今天重新复习、master 标为已熟识不再出现。不会写复习记录。',
      {
        terms: z.array(z.string()).min(1).max(50),
        action: z.enum(['mark', 'unmark', 'relearn', 'master']),
        reason: z.string().optional(),
      },
      async (input) => { const r = ops.setWordStatus(input); onChange?.('vocab'); return json({ ok: true, ...r }); }),

    tool('exam_history', '用户最近做过的真题（专题训练 + 整卷），错的在前：卷子、题号、日期、对错（主观题为 null）、考点标签。带 exam / section / n，可以接着用 get_question 看原题。',
      { days: z.number().int().min(1).max(90).optional().describe('最近几天，默认 14'), limit: z.number().int().min(1).max(100).optional() },
      async ({ days = 14, limit = 60 }) => json(ops.examHistory(days, limit)),
      { annotations: { readOnlyHint: true } }),

    tool('get_question', '看一道真题的完整内容：题干、选项、用户的作答；用户交过的附答案和解析（没交的不给答案，你也别直接说出答案）。',
      { exam: z.string(), section: z.string(), n: z.number().int().optional() },
      async ({ exam, section, n }) => ({ content: [{ type: 'text', text: ops.questionOf(exam, section, n) }] }),
      { annotations: { readOnlyHint: true } }),

    tool('add_to_wrong_book', '把一道题加进用户的错题本（按考点归档的 Markdown，弹给用户确认）。同一道题只会加一次。',
      { exam: z.string(), section: z.string(), n: z.number().int().optional(), reason: z.string().optional() },
      async (input) => { const r = await ops.addToWrongBook(input); onChange?.('vault'); return json(r); }),

    tool('list_schedule', '读用户的日程安排（日历里的课程 / 计划）：每条有 id、日期、标题、时间段 start–end、备注、是否完成。改日程前先用它看清现状。',
      {
        from: z.string().describe('开始日期 YYYY-MM-DD'),
        to: z.string().describe('结束日期 YYYY-MM-DD（含），一次最多看 62 天'),
      },
      async ({ from, to }) => {
        if (daysBetween(from, to) > 62) to = addDays(from, 62);
        return json(schedule.listEvents(from, to).map((e) => {
          const t = schedule.timeOf(e.note);
          const note = String(e.note).split(' · ').filter((s) => !/^plan:/.test(s) && !/^\d{1,2}:\d{2}\s*[–—-]/.test(s) && !/^https?:/.test(s)).join(' · ');
          return { id: e.id, date: e.date, start: t?.start || null, end: t?.end || null, title: e.title, note, kind: e.kind, done: e.done };
        }));
      }, { annotations: { readOnlyHint: true } }),

    tool('change_schedule', '改用户的日程：一次提交一批改动（新增 / 修改 / 删除），整批弹给用户确认后一起生效，失败就全部不改。挪课、顺延、拆成两天、改时间段都用它。只改时间段时给 start/end 就行，备注里的视频链接会保留。',
      {
        summary: z.string().describe('一句话说明这批改动的意图，比如「定积分应用往后顺延两天，每天只排 2 节」'),
        changes: z.array(z.object({
          op: z.enum(['add', 'update', 'delete']),
          id: z.string().optional().describe('update / delete 必填：list_schedule 给的 id'),
          date: z.string().optional().describe('YYYY-MM-DD'),
          start: z.string().optional().describe('开始时间 HH:MM'),
          end: z.string().optional().describe('结束时间 HH:MM'),
          title: z.string().optional(),
          note: z.string().optional().describe('备注；update 时一般不用给，给了会整段替换'),
          done: z.boolean().optional(),
        })).min(1).max(200),
      },
      async ({ changes }) => {
        const done = schedule.applyChanges(changes);
        onChange?.('schedule');
        return json({ ok: true, applied: done.length });
      }),

    tool('create_reading', '把一篇英文短文加进用户的「阅读」卡片（复习页 → 阅读），用来复习没掌握的生词。words 可以省略：服务器会自己从最近没掌握的词里找出文中出现的那些，释义取词库里的第一个义项；给了 words 就优先用你按文意写的释义。',
      {
        words: z.array(z.object({
          term: z.string().describe('生词原形'),
          form: z.string().optional().describe('它在短文里出现时的写法，如 abandoned'),
          gloss: z.string().describe('不超过 8 个字的中文释义，按文中意思'),
        })).optional().describe('用到的生词及文中释义'),
        title: z.string().describe('短文标题，英文，简短'),
        text: z.string().describe('英文短文，120–200 词，一段'),
        translation: z.string().describe('整篇的通顺中文译文'),
      },
      async (input) => {
        const extra = weakWords(14, 60).map((w) => ({ term: w.term, gloss: String(w.gloss).split(/[；;，,]/)[0].trim().slice(0, 8) }));
        const card = sentences.addPassage({ ...input, words: input.words || [], extra });
        onChange?.();
        return json({ ok: true, id: card.id, title: card.title, words: card.words.map((w) => `${w.term}（${w.gloss}）`) });
      }),
  ];
}

/* 权限分三档：
     只读 / 纯新增 —— 直接放行（加词、加句子、生成阅读，结果都会在对话里列出来）
     改、删、挪 —— 每批弹给用户确认，卡片上是改前 → 改后（这里每个工具配一个 preview）
     其余一律拒绝 */
const KB_TOOLS = ['study_overview', 'weak_words', 'weak_points', 'search_notes', 'list_readings', 'create_reading', 'list_schedule',
  'add_sentences', 'lookup_words', 'add_words', 'exam_history', 'get_question']
  .map((n) => `mcp__kb__${n}`);
const PREVIEW = {
  mcp__kb__change_schedule: (i) => ({ kind: 'schedule', ...schedulePreview(i) }),
  mcp__kb__edit_word: (i) => ({ kind: 'changes', ...ops.editWordPreview(i) }),
  mcp__kb__set_word_status: (i) => ({ kind: 'changes', ...ops.wordStatusPreview(i) }),
  mcp__kb__edit_reading: (i) => ({ kind: 'changes', ...ops.editReadingPreview(i) }),
  mcp__kb__delete_readings: (i) => ({ kind: 'changes', ...ops.deleteReadingsPreview(i) }),
  mcp__kb__add_to_wrong_book: (i) => ({ kind: 'changes', ...ops.wrongBookPreview(i) }),
};

/** 用户亲手写 / 认可的记忆：每次对话整篇读进来。在 Obsidian 里改，下一句话就生效 */
export const MEMORY_REL = '个人/memory.md';
function memory() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, MEMORY_REL), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    return raw.slice(0, 12000);
  } catch { return ''; }
}

function systemPrompt() {
  const today = todayStr();
  const exam = schedule.examDate();
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const mem = memory();
  return [
    `你是「星图知识库」里用户的私人老师，陪用户备考考研初试（英语二、数学、408）。今天是 ${today}，现在 ${hhmm}；初试 ${exam}，还有 ${daysBetween(today, exam)} 天。`,
    '',
    '像一个了解用户的私人老师那样教，而不是像百科或客服：先弄清卡在哪，按用户自己的学习方式带着推出来，而不是直接把答案倒出来。怎么教，以下面的记忆为准（记忆是用户用第一人称写的，「我」指用户）。',
    '',
    ...(mem ? [`<memory path="${MEMORY_REL}">`, mem, '</memory>', ''] : []),
    `记忆的维护：对话里发现值得长期记住的新东西（新的薄弱点、偏好、状态变化、定下的计划），用 Edit 往 ${MEMORY_REL} 的「近况」一节追加一行，开头写日期；这会弹给用户确认。琐事不记，已有的不重复。`,
    '',
    '你能用的：',
    '- 知识库工具（mcp__kb__*）：学习概况、没掌握的单词、薄弱考点与错题本、搜索笔记、阅读卡片、生成阅读。问到学习数据先调工具，不要凭空估计。',
    '- Read / Glob / Grep：读 Obsidian 笔记。当前目录就是笔记根；笔记是 Markdown，带 YAML frontmatter，用 [[wiki 链接]]，公式写成 $…$。',
    '- 日程：list_schedule 看日历里的课程安排（带时间段），change_schedule 一次提交一批改动（整批给用户确认）。重新规划时先看清现状、按用户的真实进度排，别只按视频时长排；一天别排满，留出做题和复盘的时间。用户拒绝就问清楚再改。日程到点会自动给用户弹提醒，所以时间段要写准。',
    '- 单词：lookup_words 查词和学习状态；add_words 加进背词队列（词表里有的只是标注、排到新词最前，没有的建成自定义词，给简短中文释义，最好附一句真题例句）；edit_word 改释义 / 例句 / 音标，set_word_status 标注 / 取消标注 / 重学 / 标为已熟识——这两个会弹给用户确认。',
    '- 阅读卡片：list_readings 看，add_sentences 加长难句（不要替用户标结构，第一次复习时用户自己拆），edit_reading / delete_readings 改 / 删（弹确认）。',
    '- 做题：exam_history 看最近做过的题（错的在前），get_question 看原题、用户的作答和解析；讲题前先看原题。add_to_wrong_book 把题加进错题本（弹确认）。用户没交的题，别直接说出答案。',
    '- 用户说「把 X 加进单词表 / 长难句」时直接做，做完一句话说清楚加了什么；不确定是哪个词形、哪句话时先问。',
    '- Edit / Write：改笔记。每一次修改都会弹给用户确认。用户拒绝就停下来问清楚想怎么改，不要换个办法绕过去。能用 Edit 做小改动就不要整篇重写；不要动 frontmatter 里的 review_count、next_review、last_reviewed 这些复习字段。',
    '',
    '回答用中文，简洁直接，用 Markdown；数学公式用 $…$ 或 $$…$$。',
    '工具报错时，把错误原样告诉用户，不要用测试数据反复试探——你写进去的东西都会出现在用户的真实数据里。',
    '',
    '生成生词阅读（create_reading）：先用 weak_words 拿到最近没掌握的词（一般取 8–15 个），写一篇 120–200 词、难度接近考研英语二阅读的英文短文，话题贴近真题（社会、科技、教育、经济、文化）。每个词都要自然地出现，不要生硬堆砌；words 里给出每个词在文中的写法 form 和按文中意思的中文释义；translation 给整篇的通顺译文。加好以后告诉用户用了哪些词、去「复习 → 阅读」里读。',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 一次对话请求 = 一次 query()，结果用 SSE 推回前端
 * ------------------------------------------------------------------ */

const runs = new Map();

/** 给前端展示用的工具参数：只留关键字段，长文本截断 */
function brief(name, input = {}) {
  const cut = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
  if (name === 'Edit') return { file: relOf(input.file_path), old: cut(input.old_string, 6000), new: cut(input.new_string, 6000), all: !!input.replace_all };
  if (name === 'MultiEdit') return { file: relOf(input.file_path), edits: (input.edits || []).slice(0, 20).map((e) => ({ old: cut(e.old_string, 3000), new: cut(e.new_string, 3000) })) };
  if (name === 'Write') return { file: relOf(input.file_path), content: cut(input.content, 8000) };
  if (name === 'Read') return { file: relOf(input.file_path) };
  if (name === 'Glob' || name === 'Grep') return { pattern: input.pattern, path: input.path ? relOf(input.path) : '' };
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' ? cut(v, 200)
      : Array.isArray(v) ? (v.every((x) => typeof x === 'string' || typeof x === 'number') ? cut(v.join('、'), 80)
        : v.every((x) => x?.term || x?.text) ? cut(v.map((x) => x.term || cut(x.text, 24)).join('、'), 80) : `[${v.length}]`)
        : v;
  }
  return out;
}

/** 日程改动的预览：每条「改前 → 改后」，给确认卡片用 */
function schedulePreview(input) {
  const show = (e) => (e ? { date: e.date, time: schedule.timeOf(e.note), title: e.title } : null);
  return {
    summary: String(input.summary || '').slice(0, 200),
    rows: schedule.applyChanges(input.changes, { preview: true }).map((x) => ({ op: x.op, before: show(x.before), after: show(x.after) })),
  };
}

/** 弹给用户确认，等答复 */
async function ask(run, tool, preview, signal, extra = {}) {
  const id = randomUUID();
  run.send({ type: 'permission', id, tool, input: preview, ...extra });
  const decision = await new Promise((resolve) => {
    run.pending.set(id, resolve);
    signal?.addEventListener('abort', () => resolve({ allow: false }), { once: true });
  });
  run.pending.delete(id);
  if (decision.always) run.autoEdit = true;
  run.send({ type: 'permission_done', id, allow: !!decision.allow });
  return !!decision.allow;
}

async function permit(run, name, input, { signal }) {
  const allow = { behavior: 'allow', updatedInput: input };
  const deny = (message) => ({ behavior: 'deny', message });
  const refused = '用户没有同意这次修改。先停下来问用户想怎么改，不要换个方式绕过去。';

  if (PREVIEW[name]) {
    let preview;
    try { preview = PREVIEW[name](input); } catch (err) { return deny(`改动有问题，没有弹给用户：${err.message}`); }
    if (run.autoEdit) return allow;
    const { kind, ...rest } = preview;
    return (await ask(run, kind, rest, signal)) ? allow : deny(refused);
  }
  if (name.startsWith('mcp__kb__')) return allow;
  if (READ_TOOLS.has(name)) {
    const p = input.file_path || input.path;
    return !p || inVault(p) ? allow : deny('只能读知识库（笔记根）里的文件。');
  }
  if (EDIT_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path;
    if (!p || !inVault(p) || isProtected(p)) return deny('只能修改笔记根里的 Markdown 笔记，.obsidian / .claudian / .git 不能动。');
    if (run.autoEdit) return allow;
    return (await ask(run, name, brief(name, input), signal, { exists: fs.existsSync(absOf(p)) })) ? allow : deny(refused);
  }
  return deny(`${name} 在这里不可用。`);
}

const AUTH_HINT = '本机的 Claude Code 没有登录或登录过期了：在终端里运行 claude，按提示登录后再试。';

/* ------------------------------------------------------------------ *
 * 附件：输入框里 + 号导入 / 粘贴 / 拖进来的图和文件
 *   图  → 图像/助手/，小图直接作为图片块发给模型；太大的（API 单张约 5MB）只给路径让它 Read（Read 会缩图）
 *   文件 → 附件/助手/，给路径让它 Read（PDF、Markdown、纯文本它都读得了）
 * ------------------------------------------------------------------ */

const IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const FILE_EXT = new Set(['pdf', 'md', 'txt', 'csv', 'json', 'tex']);
const IMG_REL = /^图像\/助手\/[\w.-]+\.(png|jpe?g|webp|gif)$/i;
const FILE_REL = /^附件\/助手\/[^/\\]+$/;

export async function saveUpload(buf, rawName = '', mime = '') {
  if (!buf?.length) throw bad('空文件');
  if (buf.length > 24 * 1024 * 1024) throw bad('单个文件最多 24MB');
  const name = path.basename(String(rawName || 'paste.png')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
  const byMime = Object.entries(IMG_EXT).find(([, m]) => m === String(mime).split(';')[0].trim().toLowerCase())?.[0];
  const ext = (byMime || path.extname(name).slice(1)).toLowerCase();
  const isImg = !!IMG_EXT[ext];
  if (!isImg && !FILE_EXT.has(ext)) throw bad(`不支持 .${ext || '?'}：图片、PDF、Markdown、纯文本可以`);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const day = todayStr().replaceAll('-', '');
  const rel = isImg
    ? `图像/助手/${day}-${hash}.${ext === 'jpeg' ? 'jpg' : ext}`
    : `附件/助手/${day}-${hash}-${name.endsWith(`.${ext}`) ? name : `${name}.${ext}`}`;
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
  return { path: rel, kind: isImg ? 'image' : 'file', name };
}

function userContent(text, images, files) {
  const blocks = [];
  const read = [];
  for (const rel of images) {
    const abs = path.join(ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.length > 3_700_000) { read.push(abs); continue; }
    blocks.push({ type: 'image', source: { type: 'base64', media_type: IMG_EXT[rel.split('.').pop().toLowerCase()], data: buf.toString('base64') } });
  }
  for (const rel of files) read.push(path.join(ROOT, rel));
  const note = read.length ? `\n\n（附件，先用 Read 打开看：${read.join('、')}）` : '';
  blocks.push({ type: 'text', text: (text || (files.length ? '看看这个文件。' : '看看这张图。')) + note });
  return blocks;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 一次性问 Claude（批改、做题总结）：不进对话、不带工具，按 schema 拿结构化结果。
 * 和助手对话同一条通道——本机 Claude Code 的登录，不需要 API key。
 * 图片太大没法内联时，放开只读的 Read 让它自己打开。
 */
export async function askOnce({ text, images = [], schema, system, model, effort = 'medium' }) {
  const { query } = await loadSdk();
  const content = userContent(text, images.filter((p) => IMG_EXT[p.split('.').pop().toLowerCase()]), []);
  const needRead = content.some((b) => b.type === 'text' && b.text.includes('先用 Read 打开看'));
  let finish;
  const done = new Promise((r) => { finish = r; });
  async function* input() {
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    await done;
  }
  const q = query({
    prompt: input(),
    options: {
      cwd: ROOT,
      model: model || undefined,
      effort: EFFORTS.has(effort) ? effort : 'medium',
      systemPrompt: system,
      tools: needRead ? ['Read'] : [],
      allowedTools: needRead ? ['Read'] : [],
      strictMcpConfig: true,
      settingSources: [],
      // 结构化输出本身走一个收尾工具，留几轮余量
      maxTurns: needRead ? 6 : 4,
      ...(schema ? { outputFormat: { type: 'json_schema', schema } } : {}),
      pathToClaudeCodeExecutable: claudeExecutable(),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'kb-study-assistant/1.0' },
    },
  });
  try {
    for await (const m of q) {
      if (m.type === 'assistant' && m.error) throw bad(m.error === 'authentication_failed' ? AUTH_HINT : `Claude 出错了：${m.error}`, 502);
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success') throw bad(`Claude 没能完成：${m.errors?.join('；') || m.subtype}`, 502);
      return { data: m.structured_output, text: m.result, cost: m.total_cost_usd };
    }
    throw bad('Claude 没有返回结果', 502);
  } finally {
    finish();
  }
}

export async function chat(req, res, { onChange } = {}) {
  const { prompt, sessionId, model, context, effort } = req.body || {};
  const images = (Array.isArray(req.body?.images) ? req.body.images : []).map(String).filter((p) => IMG_REL.test(p)).slice(0, 8);
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).map(String).filter((p) => FILE_REL.test(p)).slice(0, 8);
  let text = String(prompt || '').trim();
  if (!text && !images.length && !files.length) { res.status(400).json({ error: '说点什么吧' }); return; }

  // 做题页侧栏：附上正在做的那道题。同一道题、作答没变时前端只给 brief，不再重复整道题
  if (context?.exam && context?.section) {
    const n = context.n == null ? null : Number(context.n);
    try {
      if (context.brief) {
        text = `（还是刚才那道：${String(context.label || '').slice(0, 60)}）\n\n${text}`;
      } else {
        const q = ops.questionContext(String(context.exam), String(context.section), n, String(context.draft || '').slice(0, 20000));
        text = `【我正在做的题：${q.label}（exam=${context.exam} section=${context.section}${n != null ? ` n=${n}` : ''}）】\n\n${q.text}\n\n【我的问题】\n${text}`;
        for (const p of q.images) if (images.length < 8 && !images.includes(p)) images.push(p);
      }
    } catch { /* 题找不到就只发问题本身 */ }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* 连接已断 */ } };

  const runId = randomUUID();
  const abort = new AbortController();
  const run = { pending: new Map(), autoEdit: false, send, abort, query: null };
  runs.set(runId, run);
  send({ type: 'run', runId });

  let finished = false;
  res.on('close', () => { if (!finished) abort.abort(); });

  try {
    const { query, tool, createSdkMcpServer } = await loadSdk();
    const kb = createSdkMcpServer({ name: 'kb', version: '1.0.0', tools: buildTools(tool, onChange) });
    /* 有图就用流式输入发一条带图片块的消息；输入流保持打开直到拿到 result，
       别让 SDK 以为输入结束了提前收工 */
    let finish;
    const done = new Promise((r) => { finish = r; });
    async function* input() {
      yield { type: 'user', message: { role: 'user', content: userContent(text, images, files) }, parent_tool_use_id: null };
      await done;
    }
    abort.signal.addEventListener('abort', () => finish(), { once: true });
    const q = query({
      prompt: images.length || files.length ? input() : text,
      options: {
        cwd: ROOT,
        model: model || undefined,
        // 默认「快速」：看图讲题时 high 的思考要等很久；要深挖时前端切成 high
        effort: EFFORTS.has(effort) ? effort : 'medium',
        resume: sessionId || undefined,
        systemPrompt: systemPrompt(),
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
        allowedTools: KB_TOOLS,
        mcpServers: { kb },
        strictMcpConfig: true,
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 40,
        abortController: abort,
        pathToClaudeCodeExecutable: claudeExecutable(),
        canUseTool: (name, input, opts) => permit(run, name, input, opts),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'kb-study-assistant/1.0' },
      },
    });
    run.query = q;

    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        send({ type: 'session', sessionId: m.session_id, model: m.model });
      } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        const ev = m.event;
        if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') send({ type: 'text_block' });
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') send({ type: 'text', delta: ev.delta.text });
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        if (m.error) send({ type: 'error', message: m.error === 'authentication_failed' ? AUTH_HINT : `Claude 出错了：${m.error}` });
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') send({ type: 'tool', id: b.id, name: b.name, input: brief(b.name, b.input) });
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result') send({ type: 'tool_result', id: b.tool_use_id, error: !!b.is_error });
        }
      } else if (m.type === 'result') {
        finish();
        send({
          type: 'result',
          cost: m.total_cost_usd,
          turns: m.num_turns,
          error: run.stopped ? '已停止' : m.subtype === 'success' ? null : (m.errors?.join('；') || m.subtype),
        });
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      const msg = String(err?.message || err);
      send({ type: 'error', message: /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(msg)
        ? '没找到 Claude Agent SDK：在 app/ 下运行 npm install。'
        : /ENOENT|spawn/i.test(msg) ? '没找到 Claude Code：先安装 Claude Code 并在终端里登录一次。' : msg });
    }
  } finally {
    finished = true;
    for (const resolve of run.pending.values()) resolve({ allow: false });
    runs.delete(runId);
    send({ type: 'end' });
    res.end();
  }
}

export function answerPermission(runId, id, allow, always = false) {
  const resolve = runs.get(runId)?.pending.get(id);
  if (!resolve) return { ok: false };
  resolve({ allow: !!allow, always: !!always });
  return { ok: true };
}

export async function stop(runId) {
  const run = runs.get(runId);
  if (!run) return { ok: false };
  run.stopped = true;
  try { await run.query?.interrupt(); } catch { run.abort.abort(); }
  return { ok: true };
}

export function status() {
  return { claude: claudeExecutable() || null, vault: ROOT };
}

/* ------------------------------------------------------------------ *
 * 对话记录（SQLite）
 * ------------------------------------------------------------------ */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const listConversations = () => handle().prepare(
  'SELECT id, title, project_id AS projectId, updated_at AS updatedAt FROM assistant_conversations ORDER BY updated_at DESC LIMIT 300',
).all();

export function getConversation(id) {
  const r = handle().prepare('SELECT * FROM assistant_conversations WHERE id = ?').get(id);
  if (!r) throw bad('对话不存在', 404);
  let messages = [];
  try { messages = JSON.parse(r.messages); } catch { /* 坏数据当空 */ }
  return { id: r.id, title: r.title, sessionId: r.session_id, model: r.model, projectId: r.project_id, messages, updatedAt: r.updated_at };
}

const projectOk = (pid) => !pid || !!handle().prepare('SELECT 1 FROM assistant_projects WHERE id = ?').get(pid);

/** 整段存；projectId 只在新建时生效——对话挪项目走 moveConversation，别让两处来回覆盖 */
export function saveConversation(id, { title = '', sessionId = null, model = '', messages = [], projectId = null }) {
  if (!/^[\w-]{8,64}$/.test(String(id))) throw bad('对话 id 不合法');
  const body = JSON.stringify(Array.isArray(messages) ? messages : []);
  if (body.length > 900_000) throw bad('这段对话太长了，开个新对话吧');
  const now = new Date().toISOString();
  handle().prepare(`
    INSERT INTO assistant_conversations (id, title, session_id, model, messages, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, session_id = excluded.session_id,
      model = excluded.model, messages = excluded.messages, updated_at = excluded.updated_at`)
    .run(id, String(title).slice(0, 80), sessionId || null, String(model || ''), body, projectOk(projectId) ? projectId || null : null, now, now);
  return { ok: true, updatedAt: now };
}

export function moveConversation(id, projectId) {
  if (!projectOk(projectId)) throw bad('项目不存在', 404);
  const r = handle().prepare('UPDATE assistant_conversations SET project_id = ? WHERE id = ?').run(projectId || null, id);
  return { ok: r.changes > 0 };
}

export const listProjects = () => handle().prepare('SELECT id, name, created_at AS createdAt FROM assistant_projects ORDER BY created_at').all();

export function createProject(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw bad('项目名不能为空');
  const p = { id: randomUUID(), name: n, createdAt: new Date().toISOString() };
  handle().prepare('INSERT INTO assistant_projects (id, name, created_at) VALUES (?, ?, ?)').run(p.id, p.name, p.createdAt);
  return p;
}

export function renameProject(id, name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) throw bad('项目名不能为空');
  const r = handle().prepare('UPDATE assistant_projects SET name = ? WHERE id = ?').run(n, id);
  if (!r.changes) throw bad('项目不存在', 404);
  return { ok: true };
}

export function removeProject(id) {
  const d = handle();
  d.prepare('UPDATE assistant_conversations SET project_id = NULL WHERE project_id = ?').run(id);
  return { ok: d.prepare('DELETE FROM assistant_projects WHERE id = ?').run(id).changes > 0 };
}

export function removeConversation(id) {
  return { ok: handle().prepare('DELETE FROM assistant_conversations WHERE id = ?').run(id).changes > 0 };
}
