import { useCallback, useEffect, useRef, useState } from 'react';

function browserReminder(r) {
  if (!r || !('Notification' in window)) return;
  const show = () => {
    const n = new Notification(r.title, { body: r.body, tag: `${r.id}:${r.stage}` });
    n.onclick = () => { window.focus(); const [y, m, d] = r.date.split('-'); location.hash = `#/schedule/${y}/${m}/${d}`; n.close(); };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
}

/** vault 变更版本号：Obsidian 里保存文件 → SSE 推送 → 相关视图自动重取 */
export function useVaultVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // 日程提醒不是数据变更：桌面版由主进程弹 Windows 通知，网页版在这里用浏览器通知
        if (msg.type === 'reminder') { if (!window.kbDesktop) browserReminder(msg.reminder); return; }
        if (msg.type) setVersion((v) => v + 1);
      } catch { /* 忽略心跳等非 JSON 帧 */ }
    };
    return () => es.close();
  }, []);
  return version;
}

/** 带 loading / error / 重取的数据获取；deps 变化时自动重取 */
export function useApi(fetcher, deps = [], { skip = false } = {}) {
  const [state, setState] = useState({ data: null, loading: !skip, error: null });
  const seq = useRef(0);

  const run = useCallback(() => {
    if (skip) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(fetcher())
      .then((data) => { if (id === seq.current) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (id === seq.current) setState({ data: null, loading: false, error: error.message }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, skip]);

  useEffect(run, [run]);
  return { ...state, reload: run };
}

/** 全局快捷键 */
export function useHotkey(combo, handler) {
  useEffect(() => {
    const fn = (e) => {
      const parts = combo.toLowerCase().split('+');
      const key = parts.pop();
      if (parts.includes('mod') && !(e.metaKey || e.ctrlKey)) return;
      if (parts.includes('shift') && !e.shiftKey) return;
      if (e.key.toLowerCase() !== key) return;
      handler(e);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [combo, handler]);
}

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('kb-theme') || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('kb-theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), setTheme];
}

/* ------------------------------------------------------------------ *
 * 滚动位置记忆：从专题训练跳到笔记、再切回来，还停在原来那道题 / 那一段
 * ------------------------------------------------------------------ */

const SCROLL_KEY = 'kb-scroll';
const scrollMemo = new Map();
const readScrolls = () => { try { return JSON.parse(sessionStorage.getItem(SCROLL_KEY) || '{}'); } catch { return {}; } };

/** 某个页面上次滚到哪儿（没记过就是 0） */
export const rememberedScroll = (key) => scrollMemo.get(key) ?? readScrolls()[key] ?? 0;

/**
 * ref 指向页面自己的滚动容器，key 认页面（如 note:<id>、drill:math:泰勒公式），
 * ready 为真时内容已经渲染好，这时滚回上次的位置；之后一直记着滚到哪儿。
 * restore: false 只记不恢复——比如带 ?q= 进来要跳到某道题，不能被旧位置盖掉。
 *
 * 公式、手写图是慢慢撑开的，内容还没那么高时滚不到位：隔一帧再试，最多一秒，用户一动就停。
 */
export function useScrollMemory(ref, key, ready = true, { restore = true } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !key || !ready) return undefined;
    const target = restore ? rememberedScroll(key) : null;
    let raf = 0;
    let tries = 0;
    let stopped = false;
    const stop = () => { stopped = true; cancelAnimationFrame(raf); };
    const apply = () => {
      if (stopped) return;
      const smooth = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = target;
      el.style.scrollBehavior = smooth;
      if (Math.abs(el.scrollTop - target) > 2 && tries++ < 60) raf = requestAnimationFrame(apply);
    };
    if (target != null) apply();
    const save = () => { scrollMemo.set(key, el.scrollTop); };
    el.addEventListener('scroll', save, { passive: true });
    // 用户在页面任何地方动一下就停：比如刚进来就点题单跳题，别和那次跳转抢滚动条
    const opts = { capture: true, passive: true };
    window.addEventListener('wheel', stop, opts);
    window.addEventListener('touchstart', stop, opts);
    window.addEventListener('keydown', stop, opts);
    window.addEventListener('pointerdown', stop, opts);
    return () => {
      stop();
      el.removeEventListener('scroll', save);
      window.removeEventListener('wheel', stop, opts);
      window.removeEventListener('touchstart', stop, opts);
      window.removeEventListener('keydown', stop, opts);
      window.removeEventListener('pointerdown', stop, opts);
      // 刷新窗口也不丢：落一份到 sessionStorage
      if (scrollMemo.has(key)) {
        try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ ...readScrolls(), [key]: scrollMemo.get(key) })); } catch { /* 无痕 */ }
      }
    };
  }, [ref, key, ready, restore]);
}
