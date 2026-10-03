/* npm run build && node scripts/test-home-effects.cjs
 * 在独立 Electron 窗口验证首页动效的路由生命周期；API 全部使用内存样本，不碰 vault。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

if (!process.versions.electron) {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const root = path.resolve(__dirname, '../dist-web');
  assert.ok(fs.existsSync(path.join(root, 'index.html')), '先运行 npm run build');
  const fixtures = {
    '/api/meta': { name: '测试知识库' },
    '/api/dashboard': {
      counts: { notes: 4, due: 0, reviews: 2 }, daysToExam: 80, examDate: '2026-12-20',
      upcoming: [], due: [], vocab: { total: 100, learned: 2 }, milestones: {},
      points: { groups: [{ key: 'math', total: 10, learned: 1 }] },
    },
    '/api/mindmap': {
      groups: [{ name: '数学', count: 3, mastery: 0.4 }, { name: '英语', count: 1, mastery: 0.2 }],
      counts: { notes: 4, emptyBranches: 0 },
    },
    '/api/exams': { exams: [] },
    '/api/vocabulary/marks': [],
  };
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': isolated test\n\n');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixtures[url.pathname] || {}));
      return;
    }
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, `http://127.0.0.1:${server.address().port}`], { env, stdio: 'inherit', windowsHide: true });
    const timeout = setTimeout(() => { console.error('测试超时'); child.kill(); }, 45000);
    child.on('error', (err) => { console.error(err); process.exitCode = 1; server.close(); });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      process.exitCode = code ?? 1;
      server.closeAllConnections();
      server.close();
    });
  });
} else {
  const { app, BrowserWindow } = require('electron');
  // 独立配置目录 + 非持久 session，避免接触已安装应用的配置、登录或界面记忆。
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kb-home-effects-')));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1440, height: 940,
      webPreferences: { partition: 'test-home-effects', offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const errors = [];
    win.webContents.on('console-message', (details) => { if (details.level === 'error') errors.push(details.message); });
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i += 1) { if (await js(code)) return; await sleep(50); }
      throw new Error(`等待超时：${code}`);
    };
    const state = () => js(`({
      stars: !!document.querySelector('.home-starfield'),
      canvases: document.querySelectorAll('.hero-art canvas').length,
      bodyAnimation: getComputedStyle(document.body, '::before').animationName,
      pending: window.__gpuTest.pending.size,
      contexts: window.__gpuTest.contexts.size,
      lost: window.__gpuTest.lost.size,
      draws: window.__gpuTest.draws,
      hidden: document.hidden,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    })`);
    try {
      await win.loadURL(`${process.argv[2]}/#/resources`);
      await waitFor(`!!document.querySelector('.res-page')`);
      assert.equal(await js(`performance.getEntriesByType('resource').some(r => /(stage|KnowledgeIslands3D|Orrery3D)-/.test(r.name))`), false, '非首页启动不下载 3D 分块');
      await js(`(() => {
        const data = window.__gpuTest = { pending: new Set(), contexts: new Set(), lost: new Set(), draws: 0 };
        const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
        window.requestAnimationFrame = cb => {
          const id = raf(now => { data.pending.delete(id); cb(now); }); data.pending.add(id); return id;
        };
        window.cancelAnimationFrame = id => { data.pending.delete(id); cancel(id); };
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          const ctx = getContext.call(this, type, ...args);
          if (ctx && /webgl/.test(type) && !data.contexts.has(ctx)) {
            data.contexts.add(ctx);
            const ext = ctx.getExtension('WEBGL_lose_context');
            if (ext) { const lose = ext.loseContext.bind(ext); ext.loseContext = () => { data.lost.add(ctx); lose(); }; }
          }
          return ctx;
        };
        for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
          for (const key of ['drawArrays', 'drawElements']) {
            const draw = proto[key]; proto[key] = function(...args) { data.draws++; return draw.apply(this, args); };
          }
        }
      })()`);
      assert.equal((await state()).stars, false);
      assert.equal((await state()).bodyAnimation, 'none');
      console.log('PASS 非首页：无星空动画层，未加载 3D');

      for (const theme of ['dark', 'light']) {
        await js(`location.hash = '#/'`);
        await waitFor(`!!document.querySelector('.hero-art canvas') && window.__gpuTest.draws > 0`);
        if (theme === 'light') {
          await js(`document.querySelector('button[title="切换日夜模式"]').click()`);
          await waitFor(`document.documentElement.dataset.theme === 'light' && !!document.querySelector('.orbit3d-stage canvas')`);
        }
        assert.equal((await state()).stars, true);
        assert.equal(await js(`getComputedStyle(document.querySelector('.home-starfield')).animationName`), 'starfield');
        assert.equal(await js(`getComputedStyle(document.querySelector('.home-starfield')).animationDuration`), '150s');
        const before = await state();
        await sleep(250);
        assert.ok((await state()).draws > before.draws, '首页仍持续绘制，未降帧或关闭动效');
        console.log(`PASS ${theme} 首页：原星空动画与 3D 正常运行`);

        await js(`location.hash = '#/resources'`);
        await waitFor(`!document.querySelector('.home-starfield') && !document.querySelector('.hero-art canvas')`);
        const left = await state();
        // 整个应用只留一个上下文反复借用；强制丢上下文会让换页时窗口白闪
        assert.equal(left.contexts, 1, '来回切首页、切主题都只用同一个 WebGL 上下文');
        assert.equal(left.lost, 0, '离开首页不丢上下文');
        await waitFor(`!!document.querySelector('.res-page')`);
        await sleep(350);
        const idle = await state();
        await sleep(250);
        assert.equal((await state()).draws, idle.draws, '非首页不再进行 GPU 绘制');
        assert.equal((await state()).pending, 0, '非首页无残留 RAF 循环');
        assert.equal((await state()).canvases, 0);
        console.log(`PASS 离开 ${theme} 首页：动画停止，canvas 移除，WebGL 释放，无残留 RAF`);
      }
      assert.deepEqual(errors, [], '无页面运行时错误');
      win.destroy();
      app.exit(0);
    } catch (err) {
      console.error(err);
      console.error('页面错误：', errors);
      win.destroy();
      app.exit(1);
    }
  }).catch((err) => { console.error(err); app.exit(1); });
}
