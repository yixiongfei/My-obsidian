import { useCallback, useEffect, useRef } from 'react';
import Prose from './Prose.jsx';
import ReviewBar from './ReviewBar.jsx';

/**
 * 阅读模式：只剩标题和正文，铺在一张细格子的素白笔记纸上，全屏，没有顶栏侧栏。
 * 最直白的复习就是把知识点本身摆在眼前——所以这里连字数、日期、链接都不显示。
 *
 * 退出：Esc、右上角 ×，或底部记一次复习（记完自动退出）。
 * 进入时会请求浏览器 / 窗口全屏（拿不到也不要紧，遮罩本身就是整页）；
 * 纸永远是白的，夜间主题下临时把根元素切到 light，退出时切回来。
 */
export default function ReadMode({ note, onClose, onReviewed }) {
  const closing = useRef(false);
  const pageRef = useRef(null);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const root = document.documentElement;
    const prevTheme = root.dataset.theme;
    if (prevTheme !== 'light') root.dataset.theme = 'light';
    document.body.classList.add('readmode-open');

    let wentFullscreen = false;
    try {
      const p = root.requestFullscreen?.({ navigationUI: 'hide' });
      if (p?.then) p.then(() => { wentFullscreen = true; }).catch(() => {});
    } catch { /* 拿不到全屏就算了 */ }

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    // 浏览器自己处理 Esc 退出全屏时页面收不到 keydown，靠这个事件兜住
    const onFs = () => { if (wentFullscreen && !document.fullscreenElement) close(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    pageRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      document.body.classList.remove('readmode-open');
      if (prevTheme !== 'light') root.dataset.theme = prevTheme || 'dark';
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
    };
  }, [close]);

  return (
    <div className="readmode" role="dialog" aria-label="阅读模式">
      <button className="readmode-x" onClick={close} title="退出阅读模式（Esc）">×</button>
      <div className="readmode-page scroll" ref={pageRef} tabIndex={-1}>
        <article className="readmode-paper">
          <h1 className="readmode-title">{note.title}</h1>
          <Prose html={note.html} />
        </article>
        {/* 记一次复习放在纸的最底下，读完自然就到这儿；不悬浮，不挡正文 */}
        <div className="readmode-foot">
          <ReviewBar note={note} onDone={(out) => { onReviewed?.(out); close(); }} />
          <span className="readmode-hint">Esc 退出</span>
        </div>
      </div>
    </div>
  );
}
