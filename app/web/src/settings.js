import { useCallback, useEffect, useState } from 'react';

/**
 * 站点设置：全部记在本机 localStorage（kb-settings），网页版和桌面版共用一套；
 * 桌面版多出来的窗口模式 / 仓库路径由 Electron 侧的 config.json 保管，不放这里。
 */

const KEY = 'kb-settings';

export const DEFAULTS = {
  startPage: '/',       // 启动时打开哪一页
  zoom: 100,            // 界面缩放 %
};

export const START_PAGES = [
  { to: '/', label: '首页' },
  { to: '/dashboard', label: '仪表盘' },
  { to: '/notes', label: '笔记' },
  { to: '/review', label: '复习' },
  { to: '/resources', label: '资源' },
];

export const ZOOMS = [90, 100, 110, 125];

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式之类，忽略 */ }
}

/** 把缩放落到根元素上；Chromium 的 zoom 连布局一起缩，比改字号靠谱 */
export function applyZoom(zoom) {
  document.documentElement.style.zoom = zoom === 100 ? '' : `${zoom / 100}`;
}

export function useSettings() {
  const [settings, setState] = useState(loadSettings);
  useEffect(() => { saveSettings(settings); applyZoom(settings.zoom); }, [settings]);
  const update = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);
  return [settings, update];
}

/** 清掉本机记住的界面状态（导图缩放 / 折叠、目录树折叠、单词列表栏位），设置本身不动 */
export function resetUiState() {
  for (const k of ['kb-mind-view', 'kb-mind-fold', 'kb-tree', 'kb-tree-fold', 'kb-words-view', 'kb-exam-kinds']) {
    try { localStorage.removeItem(k); } catch { /* 无 */ }
  }
}

/** 桌面版桥；网页版里是 null */
export const desktop = typeof window !== 'undefined' && window.kbDesktop ? window.kbDesktop : null;
