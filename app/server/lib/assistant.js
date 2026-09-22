import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VAULT_ROOT } from '../config.js';
import * as vdb from './vocabulary-db.js';
import * as schedule from './schedule.js';
import * as points from './points.js';
import * as sentences from './sentences.js';
import { search, dashboard } from './query.js';
import { todayStr, addDays, daysBetween } from './review.js';

/**
 * 学习助手：跑的是本机的 Claude Code（和 Obsidian 里的 Claudian 同一个登录、同一份额度），
 * 通过 Claude Agent SDK 驱动。
 *
 * 能力边界在这里定死，不交给模型自觉：
 *   - 内置工具只开 Read / Glob / Grep / Edit / Write，没有 Bash、没有联网；
 *   - 读写都只能落在笔记根（My-md）里，.obsidian / .claudian / .git 不让改；
 *   - Edit / Write 每一次都弹给用户确认（可以选「这次对话都允许」）；
 *   - 数据库只通过下面的 kb 工具读，唯一的写是「生成阅读」往阅读卡片里加一篇短文。
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

    tool('list_readings', '阅读卡片（用户在真题里划的长难句，和之前生成的生词短文），新的在前。',
      { limit: z.number().int().min(1).max(50).optional() },
      async ({ limit = 15 }) => json(sentences.all().cards.slice(0, limit).map((c) => ({
        id: c.id, kind: c.kind, title: c.title, text: c.text, source: c.source, reps: c.reps, lapses: c.lapses, due: c.due,
        words: c.words?.map((w) => w.term),
      }))),
      { annotations: { readOnlyHint: true } }),

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

const KB_TOOLS = ['study_overview', 'weak_words', 'weak_points', 'search_notes', 'list_readings', 'create_reading']
  .map((n) => `mcp__kb__${n}`);

function systemPrompt() {
  const today = todayStr();
  const exam = schedule.examDate();
  return [
    `你是「星图知识库」里的学习助手，陪用户备考考研初试（英语二、数学、408）。今天是 ${today}，初试 ${exam}，还有 ${daysBetween(today, exam)} 天。`,
    '',
    '你能用的：',
    '- 知识库工具（mcp__kb__*）：学习概况、没掌握的单词、薄弱考点与错题本、搜索笔记、阅读卡片、生成阅读。问到学习数据先调工具，不要凭空估计。',
    '- Read / Glob / Grep：读 Obsidian 笔记。当前目录就是笔记根；笔记是 Markdown，带 YAML frontmatter，用 [[wiki 链接]]，公式写成 $…$。',
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
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? cut(v, 200) : Array.isArray(v) ? `[${v.length}]` : v;
  return out;
}

async function permit(run, name, input, { signal }) {
  const allow = { behavior: 'allow', updatedInput: input };
  const deny = (message) => ({ behavior: 'deny', message });

  if (name.startsWith('mcp__kb__')) return allow;
  if (READ_TOOLS.has(name)) {
    const p = input.file_path || input.path;
    return !p || inVault(p) ? allow : deny('只能读知识库（笔记根）里的文件。');
  }
  if (EDIT_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path;
    if (!p || !inVault(p) || isProtected(p)) return deny('只能修改笔记根里的 Markdown 笔记，.obsidian / .claudian / .git 不能动。');
    if (run.autoEdit) return allow;

    const id = randomUUID();
    run.send({ type: 'permission', id, tool: name, input: brief(name, input), exists: fs.existsSync(absOf(p)) });
    const decision = await new Promise((resolve) => {
      run.pending.set(id, resolve);
      signal?.addEventListener('abort', () => resolve({ allow: false }), { once: true });
    });
    run.pending.delete(id);
    if (decision.always) run.autoEdit = true;
    run.send({ type: 'permission_done', id, allow: !!decision.allow });
    return decision.allow ? allow : deny('用户没有同意这次修改。先停下来问用户想怎么改，不要换个方式绕过去。');
  }
  return deny(`${name} 在这里不可用。`);
}

const AUTH_HINT = '本机的 Claude Code 没有登录或登录过期了：在终端里运行 claude，按提示登录后再试。';

export async function chat(req, res, { onChange } = {}) {
  const { prompt, sessionId, model } = req.body || {};
  const text = String(prompt || '').trim();
  if (!text) { res.status(400).json({ error: '说点什么吧' }); return; }

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
    const q = query({
      prompt: text,
      options: {
        cwd: ROOT,
        model: model || undefined,
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
