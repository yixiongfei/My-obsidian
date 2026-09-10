import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';
import fsp from 'node:fs/promises';

import { VAULT_ROOT, APP_ROOT, PORT, TAGS_FILE, IGNORED_DIRS } from './config.js';
import { index, toAbs } from './lib/vault.js';
import { render } from './lib/markdown.js';
import { recordReview, readLog, bucketNotes, todayStr } from './lib/review.js';
import { search, graph, dashboard } from './lib/query.js';
import * as schedule from './lib/schedule.js';

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

app.get('/api/meta', wrap(async (_req, res) => {
  const cfg = await schedule.loadSchedule();
  res.json({
    vault: VAULT_ROOT,
    name: path.basename(VAULT_ROOT),
    notes: index.notes.size,
    images: index.images.size,
    version: index.version,
    examDate: cfg.examDate,
    today: todayStr(),
  });
}));

app.get('/api/tree', (_req, res) => res.json(index.tree()));
app.get('/api/notes', (_req, res) => res.json(index.allMeta()));

app.get('/api/note', wrap(async (req, res) => {
  const id = String(req.query.path || '');
  const note = index.get(id);
  if (!note) throw bad('笔记不存在', 404);

  const backlinks = [...(index.backlinks.get(id) || [])]
    .map((b) => index.get(b)).filter(Boolean).map((n) => index.meta(n));
  const outlinks = [...new Set(note.linkTargets.map((t) => index.resolve(t)).filter((x) => x && index.notes.has(x)))]
    .map((x) => index.meta(index.get(x)));

  res.json({ ...index.meta(note), html: render(note.body), outline: note.outline, backlinks, outlinks });
}));

app.get('/api/tags', wrap(async (_req, res) => {
  let vocab = {};
  try { vocab = yaml.load(await fsp.readFile(TAGS_FILE, 'utf8')) || {}; } catch { /* tags.yaml 可选 */ }
  const used = new Map();
  for (const n of index.allMeta()) for (const t of n.tags) used.set(t, (used.get(t) || 0) + 1);
  res.json({ vocab, used: [...used.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count) });
}));

app.get('/api/search', (req, res) => res.json(search(req.query.q, Number(req.query.limit) || 30)));
app.get('/api/graph', (_req, res) => res.json(graph()));

/* ------------------------------------------------------------------ *
 * 复习
 * ------------------------------------------------------------------ */

app.get('/api/dashboard', wrap(async (_req, res) => {
  const cfg = await schedule.loadSchedule();
  res.json(await dashboard(cfg.examDate));
}));

app.get('/api/review/queue', (_req, res) => res.json(bucketNotes()));
app.get('/api/review/log', wrap(async (_req, res) => res.json(await readLog())));

app.post('/api/review', wrap(async (req, res) => {
  const { path: id, result = 'good', addedContent = '', source } = req.body || {};
  if (!id) throw bad('缺少 path');
  if (!['good', 'again'].includes(result)) throw bad('result 只能是 good 或 again');
  const out = await recordReview(id, { result, addedContent, source });
  broadcast({ type: 'review', path: id });
  res.json(out);
}));

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
  res.json(await schedule.dayView(req.params.date));
}));

app.post('/api/schedule/event', wrap(async (req, res) => {
  const event = await schedule.addEvent(req.body || {});
  broadcast({ type: 'schedule' });
  res.json(event);
}));

app.patch('/api/schedule/event/:id', wrap(async (req, res) => {
  const event = await schedule.patchEvent(req.params.id, req.body || {});
  broadcast({ type: 'schedule' });
  res.json(event);
}));

app.delete('/api/schedule/event/:id', wrap(async (req, res) => {
  const out = await schedule.removeEvent(req.params.id);
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
    clearTimeout(debounce);
    debounce = setTimeout(() => broadcast({ type: 'vault', version: index.version }), 120);
  });
}

export async function start() {
  await index.scan();
  console.log(`[知识库] vault: ${VAULT_ROOT}`);
  console.log(`[知识库] 已索引 ${index.notes.size} 篇笔记 / ${index.images.size} 张图片`);

  chokidar
    .watch(VAULT_ROOT, {
      ignoreInitial: true,
      ignored: (p) => p.split(path.sep).some((seg) => IGNORED_DIRS.has(seg)),
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
