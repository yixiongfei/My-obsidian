/* eslint-disable no-console */
const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const isDev = process.env.ELECTRON_DEV === '1';
const APP_ROOT = path.join(__dirname, '..');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

let win = null;
let server = null;
let port = 0;

/* 只允许一个实例：两份程序同时开会各起一个服务、各监听一次仓库，
   SQLite 虽然扛得住，但复习记录会被写两遍。第二次启动只把已有窗口拉到前面 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

/* ---------------------------------------------------------------- *
 * 配置：记住用户选的 Obsidian 仓库路径
 * ---------------------------------------------------------------- */

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true }); } catch { /* 已存在 */ }
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2));
}

const looksLikeVault = (dir) =>
  !!dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory();

async function pickVault(promptTitle = '选择你的 Obsidian 仓库文件夹（含 .kb 的那一层，不是 My-md）') {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: promptTitle,
    properties: ['openDirectory'],
    buttonLabel: '就用这个文件夹',
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
}

async function resolveVault() {
  const cfg = readConfig();
  if (looksLikeVault(cfg.vaultRoot)) return cfg.vaultRoot;

  // 开发态默认用仓库自身；打包后让用户自己选
  const fallback = path.resolve(APP_ROOT, '..');
  if (isDev && looksLikeVault(fallback)) return fallback;

  const picked = await pickVault();
  if (!picked) return null;
  writeConfig({ ...cfg, vaultRoot: picked });
  return picked;
}

/* ---------------------------------------------------------------- *
 * 后端：直接在主进程里跑同一份 Express 服务
 * ---------------------------------------------------------------- */

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });

async function startServer(vaultRoot) {
  port = await freePort();
  process.env.VAULT_ROOT = vaultRoot;
  process.env.PORT = String(port);
  process.env.NO_AUTOSTART = '1';
  const mod = await import(`file://${path.join(APP_ROOT, 'server', 'index.js')}`);
  server = await mod.start();
}

async function restartWithVault(vaultRoot) {
  writeConfig({ ...readConfig(), vaultRoot });
  app.relaunch();
  app.exit(0);
}

/* ---------------------------------------------------------------- *
 * 窗口
 * ---------------------------------------------------------------- */

/* 窗口模式：window（记住上次大小位置）/ maximized / fullscreen。
   设置面板改了就立刻生效并写进 config.json，下次启动照用 */
const WINDOW_MODES = new Set(['window', 'maximized', 'fullscreen']);

function applyWindowMode(mode) {
  if (!win) return;
  if (mode === 'fullscreen') { win.setFullScreen(true); return; }
  if (win.isFullScreen()) win.setFullScreen(false);
  if (mode === 'maximized') win.maximize();
  else if (win.isMaximized()) win.unmaximize();
}

function createWindow() {
  const cfg = readConfig();
  const bounds = cfg.bounds && cfg.bounds.width > 400 ? cfg.bounds : {};
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    ...bounds,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#05070b',
    title: '知识库',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => {
    applyWindowMode(WINDOW_MODES.has(cfg.windowMode) ? cfg.windowMode : 'window');
    win.show();
  });
  // 普通窗口模式下记住大小位置；最大化 / 全屏时 getNormalBounds 给的还是还原后的尺寸
  win.on('close', () => {
    try { writeConfig({ ...readConfig(), bounds: win.getNormalBounds() }); } catch { /* 无所谓 */ }
  });
  win.loadURL(isDev ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`);

  // KB_SMOKE=1：无人值守地过一遍 preload 桥和窗口模式，打印结果就退出（CI / 本机自检用）
  if (process.env.KB_SMOKE === '1') {
    win.webContents.once('did-finish-load', async () => {
      try {
        const info = await win.webContents.executeJavaScript('window.kbDesktop.getInfo()');
        const results = { info };
        for (const mode of ['maximized', 'fullscreen', 'window']) {
          await win.webContents.executeJavaScript(`window.kbDesktop.setWindowMode(${JSON.stringify(mode)})`);
          await new Promise((r) => setTimeout(r, 400));
          results[mode] = { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
        }
        results.savedMode = readConfig().windowMode;
        console.log('KB_SMOKE ' + JSON.stringify(results));
      } catch (err) {
        console.log('KB_SMOKE_ERROR ' + err.message);
      }
      app.exit(0);
    });
  }

  // 外链交给系统浏览器，不在应用里开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '知识库',
      submenu: [
        {
          label: '切换仓库文件夹…',
          click: async () => {
            const picked = await pickVault('选择另一个 Obsidian 仓库');
            if (picked) restartWithVault(picked);
          },
        },
        { type: 'separator' },
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]));
}

/* ---------------------------------------------------------------- *
 * 设置面板走的 IPC
 * ---------------------------------------------------------------- */

function registerIpc(vaultRoot) {
  ipcMain.handle('kb:info', () => ({
    vaultRoot,
    windowMode: WINDOW_MODES.has(readConfig().windowMode) ? readConfig().windowMode : 'window',
    version: app.getVersion(),
    port,
  }));
  ipcMain.handle('kb:window-mode', (_e, mode) => {
    if (!WINDOW_MODES.has(mode)) return false;
    writeConfig({ ...readConfig(), windowMode: mode });
    applyWindowMode(mode);
    return true;
  });
  ipcMain.handle('kb:pick-vault', async () => {
    const picked = await pickVault('选择另一个 Obsidian 仓库（含 .kb 的那一层）');
    if (picked) restartWithVault(picked);
    return !!picked;
  });
  ipcMain.handle('kb:open-path', async (_e, p) => {
    const target = path.resolve(String(p || ''));
    // 只开仓库里面的路径，别让页面拿这个口子开任意目录
    if (!target.startsWith(path.resolve(vaultRoot))) return false;
    return (await shell.openPath(target)) === '';
  });
}

/* ---------------------------------------------------------------- */

app.whenReady().then(async () => {
  const vaultRoot = await resolveVault();
  if (!vaultRoot) { app.quit(); return; }

  try {
    await startServer(vaultRoot);
  } catch (err) {
    dialog.showErrorBox('启动失败', `无法读取知识库：\n${err.message}`);
    app.quit();
    return;
  }

  registerIpc(vaultRoot);
  buildMenu();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
