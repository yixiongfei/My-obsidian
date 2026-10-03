import { useEffect, useRef } from 'react';

/**
 * 学习计时：在做题、背单词、阅读、看笔记、问助手的页面上，人在用就计时。
 *
 * 「在用」= 窗口可见，且最近有过操作（点、按键、滚动、移动鼠标）。停手超过一段时间就不再计：
 *   做题给 10 分钟——常常是在平板上写过程，电脑这边没动静；
 *   看笔记、阅读、问助手给 5 分钟；背单词一张卡几秒钟，2 分钟没动就是走开了。
 * 每秒按真实流逝的时间累加（一次最多算 5 秒，电脑睡眠、定时器被节流都不会多算），
 * 半分钟交一次；窗口藏起来或关掉时用 sendBeacon 把最后一段交上去。
 */

const IDLE = { exam: 600, notes: 300, reading: 300, assistant: 300, words: 120 };
const FLUSH_MS = 30_000;

/** 路由 → 计时类别；仪表盘、日历、资源列表这些是「在找东西」，不算学习 */
export function kindOf(path) {
  if (path.startsWith('/resources/exam') || path.startsWith('/resources/drill')) return 'exam';
  if (path.startsWith('/review/reading')) return 'reading';
  if (path.startsWith('/review')) return 'words';
  if (path.startsWith('/note/')) return 'notes';
  if (path.startsWith('/assistant')) return 'assistant';
  return null;
}

const pending = {};
let lastActive = Date.now();

function flush(beacon) {
  const items = Object.entries(pending)
    .filter(([, s]) => s >= 1)
    .map(([kind, s]) => ({ kind, seconds: Math.round(s) }));
  if (!items.length) return;
  for (const { kind, seconds } of items) pending[kind] -= seconds;
  const body = JSON.stringify({ items });
  if (beacon && navigator.sendBeacon?.('/api/study-time', new Blob([body], { type: 'application/json' }))) return;
  fetch('/api/study-time', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
    .catch(() => { for (const { kind, seconds } of items) pending[kind] = (pending[kind] || 0) + seconds; });   // 下次再交
}

export function useStudyClock(pathname) {
  const kind = useRef(kindOf(pathname));
  kind.current = kindOf(pathname);

  useEffect(() => {
    const active = () => { lastActive = Date.now(); };
    // 鼠标移动太频繁，5 秒记一次就够判断「人还在」
    let lastMove = 0;
    const move = () => { const now = Date.now(); if (now - lastMove > 5000) { lastMove = now; active(); } };
    const opts = { capture: true, passive: true };
    const EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll', 'input', 'touchstart', 'focus'];
    EVENTS.forEach((e) => window.addEventListener(e, active, opts));
    window.addEventListener('pointermove', move, opts);

    let lastTick = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(5, (now - lastTick) / 1000);
      lastTick = now;
      const k = kind.current;
      if (!k || document.visibilityState !== 'visible') return;
      if ((now - lastActive) / 1000 > IDLE[k]) return;
      pending[k] = (pending[k] || 0) + dt;
    }, 1000);
    const flusher = setInterval(() => flush(false), FLUSH_MS);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(true); else active(); };
    const onHide = () => flush(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);

    return () => {
      EVENTS.forEach((e) => window.removeEventListener(e, active, opts));
      window.removeEventListener('pointermove', move, opts);
      clearInterval(tick);
      clearInterval(flusher);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      flush(true);
    };
  }, []);
}
