import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import fsp from 'node:fs/promises';

import { VAULT_ROOT, APP_ROOT, PORT, TAGS_FILE, isIgnoredPath, REPO_ROOT, KB_DIR } from './config.js';
import { index, toAbs, toId } from './lib/vault.js';
import { render } from './lib/markdown.js';
import { recordReview, readLog, todayStr } from './lib/review.js';
import { search, dashboard, bucketNotes, allNotes, getNoteMeta } from './lib/query.js';
import * as points from './lib/points.js';
import * as db from './lib/db.js';
import { syncAll, syncNote } from './lib/sync.js';
import * as schedule from './lib/schedule.js';
import { mindmap } from './lib/mindmap.js';
import * as vocab from './lib/vocabulary.js';
import * as vocabDb from './lib/vocabulary-db.js';
import * as exams from './lib/exams.js';
import * as marks from './lib/vocab-marks.js';
import * as examMarks from './lib/exam-marks.js';
import * as tts from './lib/tts.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/* ------------------------------------------------------------------ *
 * 变更推送（SSE）：在 Obsidian 里保存，网页秒级刷新
 * ------------------------------------------------------------------ */

const clients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) { try { res.write(data); } catch { clients.delete(res); } }
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断开由 close 处理 */ } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

/* ------------------------------------------------------------------ *
 * 笔记
 * ------------------------------------------------------------------ */

app.get('/api/meta', (_req, res) => {
  res.json({
    vault: VAULT_ROOT,
    repo: REPO_ROOT,
    kb: KB_DIR,
    name: path.basename(VAULT_ROOT),
    notes: index.notes.size,
    images: index.images.size,
    version: index.version,
    examDate: schedule.examDate(),
    today: todayStr(),
  });
});

app.get('/api/tree', (_req, res) => res.json(index.tree()));
app.get('/api/notes', (_req, res) => res.json(allNotes()));

app.get('/api/note', wrap(async (req, res) => {
  const id = String(req.query.path || '');
  const note = index.get(id);
  if (!note) throw bad('笔记不存在', 404);

  const backlinks = db.handle().prepare('SELECT src FROM links WHERE dst = ? AND embed = 0').all(id)
    .map((r) => getNoteMeta(r.src)).filter(Boolean);
  const outlinks = db.handle().prepare('SELECT dst FROM links WHERE src = ? AND embed = 0').all(id)
    .map((r) => getNoteMeta(r.dst)).filter(Boolean);

  res.json({ ...getNoteMeta(id), html: render(note.body), outline: note.outline, backlinks, outlinks });
}));

app.get('/api/tags', wrap(async (_req, res) => {
  let vocab = {};
  try { vocab = yaml.load(await fsp.readFile(TAGS_FILE, 'utf8')) || {}; } catch { /* tags.yaml 可选 */ }
  const used = new Map();
  for (const n of index.allMeta()) for (const t of n.tags) used.set(t, (used.get(t) || 0) + 1);
  res.json({ vocab, used: [...used.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count) });
}));

app.get('/api/search', (req, res) => res.json(search(req.query.q, Number(req.query.limit) || 30)));
app.get('/api/mindmap', wrap(async (_req, res) => res.json(await mindmap())));

/* ------------------------------------------------------------------ *
 * 复习
 * ------------------------------------------------------------------ */

app.get('/api/dashboard', (_req, res) => res.json({ ...dashboard(schedule.examDate()), points: points.progress(), vocab: vocab.progress(), milestones: milestones() }));

/* 里程碑：初试 / 复试 / 上岸 三个开关，过了就在设置里勾上；首页知识岛靠它决定小人站在哪座岛 */
const MILESTONES = ['初试', '复试', '上岸'];
const milestones = () => Object.fromEntries(MILESTONES.map((k) => [k, db.getMeta(`milestone:${k}`) || null]));
app.get('/api/milestones', (_req, res) => res.json(milestones()));
app.put('/api/milestones', (req, res) => {
  const b = req.body || {};
  for (const k of MILESTONES) {
    if (!(k in b)) continue;
    // 值是通过的日期；传 false / null 就是取消
    if (b[k]) db.setMeta(`milestone:${k}`, typeof b[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b[k]) ? b[k] : todayStr());
    else db.handle().prepare('DELETE FROM meta WHERE k = ?').run(`milestone:${k}`);
  }
  res.json(milestones());
});

app.get('/api/review/queue', (_req, res) => res.json(bucketNotes()));
app.get('/api/review/log', wrap(async (_req, res) => res.json(await readLog())));

app.post('/api/review', wrap(async (req, res) => {
  const { path: id, result = 'good', addedContent = '', source } = req.body || {};
  if (!id) throw bad('缺少 path');
  if (!['again', 'hard', 'good', 'easy'].includes(result)) {
    throw bad('result 只能是 again / hard / good / easy');
  }
  const out = await recordReview(id, { result, addedContent, source });
  broadcast({ type: 'review', path: id });
  res.json(out);
}));

/* ------------------------------------------------------------------ *
 * 英语词汇 Anki
 *
 * 与笔记复习严格分离：这里只出英语单词卡，数学/408 那类知识点仍然
 * 回到笔记原文做深度复习，不做成卡片。
 * ------------------------------------------------------------------ */

app.get('/api/review/cards', (_req, res) => res.json(vocab.buildQueue()));

app.post('/api/vocabulary/review', wrap(async (req, res) => {
  const { id, rating } = req.body || {};
  if (id === undefined || id === null || id === '') throw bad('缺少 id');
  try {
    res.json(vocab.rate(Number(id), String(rating)));
  } catch (err) {
    if (err.code === 'BAD_RATING') throw bad(err.message, 400);
    if (err.code === 'NOT_FOUND') throw bad(err.message, 404);
    // 已毕业：多半是这个词在别处已经完成了，前端安静地跳过就行
    if (err.code === 'GRADUATED') throw bad(err.message, 409);
    throw err;
  }
}));

app.post('/api/vocabulary/sync-markdown', (_req, res) => {
  // 202 + 立刻返回：绝不让 UI 等磁盘写入和索引重建
  const queued = vocab.pendingDates();
  vocab.flush().then((dates) => { if (dates.length) broadcast({ type: 'vault', version: index.version }); })
    .catch((err) => console.error('[词汇] Markdown 写入失败', err));
  res.status(202).json({ queued });
});

app.get('/api/vocabulary/overview', (_req, res) => res.json(vocab.overview()));

/* 发音：Worker 合成 + 本地缓存；失败回 502，前端退回系统语音 */
app.get('/api/tts', wrap(async (req, res) => {
  const { file, cached } = await tts.synth(req.query.text, req.query.voice, req.query.speed);
  res.setHeader('X-TTS-Cache', cached ? 'hit' : 'miss');
  res.sendFile(file, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}));

/* 标注词：真题里双击标出来的、或在单词列表里手动加的。
   命中考研词表的标在原词条上（前端画红线），命中不了的建自定义词（蓝线）。 */
app.get('/api/vocabulary/marks', (_req, res) => res.json(marks.marks()));

app.post('/api/vocabulary/mark', (req, res) => {
  const { term, source = '', meaning = '', on = true } = req.body || {};
  try {
    res.json(marks.mark(String(term || ''), { source: String(source || ''), meaning: String(meaning || ''), on: on !== false }));
  } catch (err) {
    if (err.code === 'BAD_TERM') throw bad(err.message, 400);
    throw err;
  }
});

/* 词卡例句摘录：和荧光笔同一张表、同一个 Markdown */
app.post('/api/vocabulary/example-mark', (req, res) => {
  const { term, text } = req.body || {};
  res.json(examMarks.addVocabSentence(String(term || ''), String(text || '')));
});

app.get('/api/vocabulary/words', (req, res) => {
  res.json(marks.list({
    view: String(req.query.view || 'today'),
    q: String(req.query.q || ''),
    limit: Number(req.query.limit) || 200,
    offset: Number(req.query.offset) || 0,
  }));
});

app.get('/api/vocabulary/words/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw bad('id 不合法');
  const w = marks.detail(id);
  if (!w) return res.status(404).json({ error: '没有这个词' });
  res.json(w);
});

/* 同一个 PATCH 两种用法：{important} 只切换标注；{phonetic, senses, examples} 改词条内容 */
app.patch('/api/vocabulary/words/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw bad('id 不合法');
  const b = req.body || {};
  if ('important' in b) marks.setImportant(id, !!b.important);
  if ('senses' in b || 'examples' in b || 'phonetic' in b) {
    try { return res.json(marks.update(id, b)); } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
      throw e;
    }
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * 学习资源：历年真题（英语一 / 二、408、数学一 / 二 / 三）与真题标签
 *
 * 题面从 .kb/exams/*.json 来（scripts/import-exams.mjs 抓的），答案与解析
 * 只在某个单元交卷之后才随响应下发——前端拿不到，模拟真卷的「做完再对」。
 * ------------------------------------------------------------------ */

app.get('/api/exams', (_req, res) => res.json(exams.listExams()));

app.get('/api/exams/tags/:group', (req, res) => {
  const tags = exams.getTags(req.params.group);
  if (!tags) throw bad('还没有这一科的标签数据，先运行 scripts/import-exams.mjs tags', 404);
  res.json(tags);
});

app.get('/api/exams/assets/:file', (req, res, next) => {
  const abs = path.join(exams.EXAMS_IMG_DIR, path.basename(req.params.file));
  if (!fs.existsSync(abs)) return next();
  res.sendFile(abs, { headers: { 'Cache-Control': 'public, max-age=86400' } });
});

app.get('/api/exams/:id', (req, res) => {
  const exam = exams.publicExam(req.params.id);
  if (!exam) throw bad('这份真题不存在，先运行 scripts/import-exams.mjs 抓取', 404);
  res.json(exam);
});

/* 荧光笔：只落库 + 脏标记，Markdown 闲置 30 秒或离开卷面时再合并写 */
app.get('/api/exams/:id/marks', (req, res) => res.json(examMarks.listMarks(req.params.id)));
app.post('/api/exams/:id/marks', (req, res) => {
  const { section, text, q, color } = req.body || {};
  res.json(examMarks.addMark(req.params.id, String(section || ''), String(text || ''), Number.isInteger(q) ? q : null, String(color || 'y')));
});
app.patch('/api/exams/marks/:mid', (req, res) => res.json(examMarks.recolorMark(Number(req.params.mid), String(req.body?.color || ''))));
app.delete('/api/exams/marks/:mid', (req, res) => res.json(examMarks.removeMark(Number(req.params.mid))));
app.post('/api/exams/marks/sync', (_req, res) => {
  examMarks.flush().then((wrote) => { if (wrote) broadcast({ type: 'vault', version: index.version }); }).catch((err) => console.error('[真题例句] 写入失败', err));
  res.status(202).json({ ok: true });
});

/* 错题本：显式动作，直接写 Markdown */
app.post('/api/exams/:id/:section/export', wrap(async (req, res) => {
  const n = req.body?.n;
  const out = await examMarks.exportQuestion(req.params.id, req.params.section, Number.isInteger(n) ? n : null);
  res.json(out);
}));

app.put('/api/exams/:id/:section/answers', (req, res) => {
  res.json(exams.saveDraft(req.params.id, req.params.section, req.body?.answers));
});

app.post('/api/exams/:id/:section/submit', (req, res) => {
  res.json(exams.submit(req.params.id, req.params.section, req.body?.answers));
});

app.post('/api/exams/:id/:section/reset', (req, res) => {
  res.json(exams.reset(req.params.id, req.params.section));
});

/* ------------------------------------------------------------------ *
 * 日程：年 → 月 → 日
 * ------------------------------------------------------------------ */

app.get('/api/schedule/year/:year', wrap(async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 1970 || year > 2200) throw bad('年份不合法');
  res.json(await schedule.yearView(year));
}));

app.get('/api/schedule/month/:month', wrap(async (req, res) => {
  if (!/^\d{4}-\d{2}$/.test(req.params.month)) throw bad('月份格式应为 YYYY-MM');
  res.json(await schedule.monthView(req.params.month));
}));

app.get('/api/schedule/day/:date', wrap(async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw bad('日期格式应为 YYYY-MM-DD');
  res.json(schedule.dayView(req.params.date));
}));

app.post('/api/schedule/event', wrap(async (req, res) => {
  const event = schedule.addEvent(req.body || {});
  broadcast({ type: 'schedule' });
  res.json(event);
}));

app.patch('/api/schedule/event/:id', wrap(async (req, res) => {
  const event = schedule.patchEvent(req.params.id, req.body || {});
  broadcast({ type: 'schedule' });
  res.json(event);
}));

app.delete('/api/schedule/event/:id', wrap(async (req, res) => {
  const out = schedule.removeEvent(req.params.id);
  broadcast({ type: 'schedule' });
  res.json(out);
}));

/* ------------------------------------------------------------------ *
 * 仓库内的静态资源（图片）
 * ------------------------------------------------------------------ */

app.get(/^\/vault\/(.+)/, (req, res, next) => {
  const rel = decodeURIComponent(req.params[0] || '');
  const abs = path.resolve(VAULT_ROOT, rel);
  // 目录穿越防护：解析后必须仍在 vault 内
  if (abs !== VAULT_ROOT && !abs.startsWith(VAULT_ROOT + path.sep)) return res.status(403).end();
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return next();
  res.sendFile(abs, { headers: { 'Cache-Control': 'no-cache' } });
});

/* ------------------------------------------------------------------ *
 * 生产环境下托管打包好的前端
 * ------------------------------------------------------------------ */

const DIST = path.join(APP_ROOT, 'dist-web');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api|\/vault).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

/* ------------------------------------------------------------------ *
 * 启动 + 文件监听
 * ------------------------------------------------------------------ */

let debounce = null;
function onFsEvent(type, abs) {
  const changed = type === 'unlink' ? index.remove(abs) : index.update(abs);
  Promise.resolve(changed).then((ok) => {
    if (!ok) return;
    if (abs.toLowerCase().endsWith('.md')) syncNote(toId(abs));
    clearTimeout(debounce);
    debounce = setTimeout(() => broadcast({ type: 'vault', version: index.version }), 120);
  });
}

export async function start() {
  db.open();
  await index.scan();
  const synced = await syncAll();
  console.log(`[知识库] vault: ${VAULT_ROOT}`);
  console.log(`[知识库] 索引 ${index.notes.size} 篇笔记 / ${index.images.size} 张图片`);
  console.log(`[知识库] SQLite ${db.DB_PATH}（全文检索 ${db.hasFts() ? '开启' : '降级为 LIKE'}，复习记录 +${synced.reviews}）`);

  /* 词汇库。顺序不能换：
     先从旧 index.db 迁移，再 seed——反过来的话 seed 会先把词条建出来，
     迁移就分不清"这些词条是种子基线还是旧数据"了。 */
  vocabDb.open();
  const moved = vocab.migrateFromIndexDb(db.handle());
  if (moved.status === 'conflict') {
    console.warn(`[词汇] 迁移已停止：${moved.reason}`);
  } else if (moved.status === 'migrated') {
    console.log(`[词汇] 从 index.db 迁移了 ${moved.moved} 张卡片`);
  }
  const seeded = vocab.seed();
  const vq = vocab.buildQueue().counts.words;
  console.log(`[词汇] ${vocabDb.VOCAB_DB_PATH}（词条 ${vq.total}${seeded.skipped ? '' : '，本次已更新词表'}）`);
  console.log(`[词汇] 到期 ${vq.due} · 新词 ${vq.new} · 已掌握 ${vq.mastered}`);

  // 上次进程没来得及写完的日志，开机补上
  const pending = vocab.recoverPendingLogs();
  if (pending.length) console.log(`[词汇] 补写遗留日志：${pending.join(', ')}`);
  // 早期的按天日志收进按周文件（只收没有手写内容的）
  vocab.migrateDailyLogs().then((moved) => { if (moved.length) console.log(`[词汇] 日志改为按周：合并了 ${moved.join(', ')}`); }).catch((err) => console.error('[词汇] 日志迁移失败', err));
  examMarks.recoverPending();

  chokidar
    .watch(VAULT_ROOT, {
      ignoreInitial: true,
      ignored: isIgnoredPath,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    })
    .on('add', (p) => onFsEvent('add', p))
    .on('change', (p) => onFsEvent('change', p))
    .on('unlink', (p) => onFsEvent('unlink', p));

  return new Promise((resolve) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`[知识库] http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

if (process.env.ELECTRON_RUN_AS_NODE !== '1' && !process.env.NO_AUTOSTART) start();

export { app, toAbs };
