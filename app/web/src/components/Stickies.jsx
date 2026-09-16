import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, vaultUrl } from '../api.js';
import { renderSticky, SN_PLACEHOLDER } from '../sticky-text.js';
import { anchorAt, pointOf, blockAnchorAt, blockPoint } from '../sticky-anchor.js';

/* ================================================================== *
 * 便利贴 —— 复习时贴在笔记旁边的纸片
 *
 * 四种颜色各有分工（颜色即语义，别当装饰用）：
 *   黄 疑问 · 蓝 推导 · 绿 结论 · 红 易错
 *
 * 三条硬规矩：
 *   1. 纸片是「纸」，不是浮层：能拖、能缩、能钉住、能撕。钉住之后就是钉住了——
 *      不能动、不能缩、不能撕，只剩读和改字。
 *   2. 箭头指的是**内容**，不是像素。锚点解析见 sticky-anchor.js。
 *   3. 图片保留原图：正文里的图在夜间会被反相以融进暗底，贴纸上的截图不能反——
 *      那是证据，改一个像素都不行。
 * ================================================================== */

export const SN_COLORS = [
  { k: 'y', label: '疑问', hint: '临时思考、卡住的地方' },
  { k: 'b', label: '推导', hint: '自己的推导 / 理解' },
  { k: 'g', label: '结论', hint: '最终总结、关键结论' },
  { k: 'r', label: '易错', hint: '错因 / 易错点' },
];

const DEF_W = 216;
const DEF_H = 132;
const MIN_W = 132;
const MIN_H = 76;
const SIDES = ['t', 'r', 'b', 'l'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* 认不认这个文件：MIME 优先，认不出来就看扩展名。
   剪贴板、某些文件管理器、跨盘拖拽给过来的 File 常常是空 type 或 octet-stream，
   只信 MIME 的话，用户拖一张图进来什么都不会发生，还没有任何提示 */
const isMedia = (f) => /^image\//.test(f.type)
  || f.type === 'application/pdf'
  || /\.(png|jpe?g|gif|webp|avif|bmp|pdf)$/i.test(f.name || '');

/** 纸片某条边的中点（相对 host 左上角）——箭头从这儿出发 */
const sidePoint = (s, side) => ({
  t: { x: s.x + s.w / 2, y: s.y },
  r: { x: s.x + s.w, y: s.y + s.h / 2 },
  b: { x: s.x + s.w / 2, y: s.y + s.h },
  l: { x: s.x, y: s.y + s.h / 2 },
}[side] || { x: s.x + s.w / 2, y: s.y + s.h / 2 });

/** 按住不放的通用拖拽：走 window 监听，指针跑出纸片也不丢 */
function drag(e, { onMove, onUp }) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    // 4px 的迟钝带：手抖不该把「点一下展开」变成「拖了一下」
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    onMove(dx, dy, ev);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onUp?.(moved, ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ------------------------------------------------------------------ *
 * 箭头
 * ------------------------------------------------------------------ */

/** 一条带弧度的二次贝塞尔 + 箭头尖。直线在正文上像一道划痕，弧线才像手画的引线 */
function arrowPath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // 垂线方向鼓出去一点；长了也不让它鼓过头，48px 封顶
  const bow = Math.min(len * 0.18, 48);
  const cx = (from.x + to.x) / 2 - (dy / len) * bow;
  const cy = (from.y + to.y) / 2 + (dx / len) * bow;
  // 尖端留 4px，别扎进字里
  const tx = to.x - ((to.x - cx) / (Math.hypot(to.x - cx, to.y - cy) || 1)) * 4;
  const ty = to.y - ((to.y - cy) / (Math.hypot(to.x - cx, to.y - cy) || 1)) * 4;
  const ang = Math.atan2(ty - cy, tx - cx);
  const head = 8.5;
  const wing = 0.42;
  return {
    d: `M ${from.x} ${from.y} Q ${cx} ${cy} ${tx} ${ty}`,
    head: `M ${tx - head * Math.cos(ang - wing)} ${ty - head * Math.sin(ang - wing)} L ${tx} ${ty} `
        + `L ${tx - head * Math.cos(ang + wing)} ${ty - head * Math.sin(ang + wing)}`,
    mid: { x: (from.x + 2 * cx + to.x) / 4, y: (from.y + 2 * cy + to.y) / 4 },
  };
}

/* ------------------------------------------------------------------ *
 * 一张纸片
 * ------------------------------------------------------------------ */

function Sticky({ s, editing, onDown, onDoubleClick, onPin, onTear, onResize, onDraw, onText, onEditEnd, onOver, tearing }) {
  const bodyRef = useRef(null);
  const taRef = useRef(null);
  const [over, setOver] = useState(false);

  const html = useMemo(() => (s.media ? '' : renderSticky(s.text)), [s.text, s.media]);

  // 内容比纸片高就挂一个「⤢」，告诉用户点开还有下文
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 图片在纸片上永远是缩略图，点开才是原图，所以它一定挂角标
    const full = !!s.media || el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
    setOver(full);
    onOver(s.id, full);
  }, [html, s.w, s.h, s.media, editing, s.id, onOver]);

  useEffect(() => {
    if (editing) taRef.current?.focus({ preventScroll: true });
  }, [editing]);

  return (
    <div
      className={`sn c-${s.color}${s.pinned ? ' pinned' : ''}${editing ? ' editing' : ''}${tearing ? ' tearing' : ''}`}
      style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
      onPointerDown={onDown}
      onDoubleClick={onDoubleClick}
    >
      <button
        className="sn-pin"
        title={s.pinned ? '拔掉图钉（之后才能移动、放缩、撕去）' : '按下图钉，把它定在这儿'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onPin(); }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle className="pin-head" cx="8" cy="5.4" r="3.4" />
          <path className="pin-needle" d="M8 8.9 L8 14.4" />
          <circle className="pin-spark" cx="6.9" cy="4.3" r="0.95" />
        </svg>
      </button>

      {!s.pinned && (
        <button
          className="sn-tear" title="撕去这张便利贴"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onTear(); }}
        />
      )}

      <div className="sn-body" ref={bodyRef}>
        {s.media
          ? (s.mediaKind === 'pdf' && !s.poster
            ? <iframe className="sn-pdf" src={`${vaultUrl(s.media)}#toolbar=0&navpanes=0&view=FitH`} title="PDF" />
            : <img className="sn-img" src={vaultUrl(s.poster || s.media)} alt="" draggable={false} />)
          : (s.text.trim()
            ? <div className="sn-rich" dangerouslySetInnerHTML={{ __html: html }} />
            : <div className="sn-rich sn-empty">{SN_PLACEHOLDER}</div>)}
      </div>

      {editing && (
        <textarea
          ref={taRef} className="sn-edit" value={s.text}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onText(e.target.value)}
          onBlur={onEditEnd}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); onEditEnd(); }
          }}
          placeholder={'写点什么…\n- 条目  **粗体**  $x^2$'}
        />
      )}

      {over && !editing && <span className="sn-more" title="点一下展开成完整笔记">⤢</span>}

      {!s.pinned && (
        <span className="sn-grip" title="拖动放缩" onPointerDown={(e) => { e.stopPropagation(); onResize(e); }} />
      )}

      {/* 四条边的中点：从这儿拉出箭头，指向正文里的具体位置 */}
      {SIDES.map((side) => (
        <span
          key={side} className={`sn-hand h-${side}`} title="拉出一根箭头，指到正文里"
          onPointerDown={(e) => { e.stopPropagation(); onDraw(e, side); }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 图层
 * ------------------------------------------------------------------ */

/**
 * active：一页上可能同时挂着两层便利贴——阅读页底下一层，全屏阅读模式上面一层。
 * 被盖住的那层必须交出粘贴、指针、键盘这些全局监听，否则 Ctrl+V 会一次贴出两张纸。
 */
export default function Stickies({ noteId, scrollRef, children, active = true }) {
  const hostRef = useRef(null);
  const fieldRef = useRef(null);   // 纸片场：向正文栏两侧的留白借出来的那块地
  const [items, setItems] = useState([]);
  const [live, setLive] = useState(null);      // 正在拖 / 缩的那张：{ id, x, y, w, h }
  const [draw, setDraw] = useState(null);      // 正在拉的箭头：{ id, side, from, to }
  const [editing, setEditing] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [selArrow, setSelArrow] = useState(null);
  const [tearing, setTearing] = useState(null);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const lastPt = useRef(null);                 // 最近一次鼠标位置，粘贴时当落点
  const overs = useRef(new Map());             // 哪些纸片装不下自己的内容
  const noteOver = useCallback((id, v) => { overs.current.set(id, v); }, []);
  const canOpen = (s) => !!s.media || overs.current.get(s.id) === true;

  /* ---- 落盘。拖动只在松手时发一次；改字防抖 600ms ---- */
  const pending = useRef(new Map());
  const save = useCallback((id, patch, delay = 0) => {
    const map = pending.current;
    const prev = map.get(id);
    if (prev) clearTimeout(prev.timer);
    const merged = { ...(prev?.patch || {}), ...patch };
    const fire = () => { map.delete(id); api.patchSticky(id, merged).catch(() => {}); };
    if (!delay) { fire(); return; }
    map.set(id, { patch: merged, timer: setTimeout(fire, delay) });
  }, []);
  // 走开之前把还没写的补上：换一篇笔记不该吃掉最后敲的那句话
  useEffect(() => () => {
    for (const [id, p] of pending.current) { clearTimeout(p.timer); api.patchSticky(id, p.patch).catch(() => {}); }
    pending.current.clear();
  }, [noteId]);

  const patch = useCallback((id, delta, delay = 0) => {
    setItems((l) => l.map((s) => (s.id === id ? { ...s, ...delta } : s)));
    save(id, delta, delay);
  }, [save]);

  /* ---- 取纸片 ----
     active 也在依赖里：阅读模式那层贴的纸，退出来之后这层要重新取一次，
     否则两层各记各的，回到阅读页会发现刚写的那张不见了 */
  useEffect(() => {
    let alive = true;
    setEditing(null); setExpanded(null); setSelArrow(null);
    if (!noteId || !active) return undefined;
    api.stickies(noteId).then((l) => { if (alive) setItems(l); }).catch(() => {});
    return () => { alive = false; };
  }, [noteId, active]);

  // 换一篇笔记先清空，别让上一篇的纸片在新正文上闪一下
  useEffect(() => { setItems([]); }, [noteId]);

  /* ---- 布局一变，箭头就要重算 ---- */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    /* 正文栏封在 900px 里，但它所在的那一格往往宽得多（1600px 窗口下有三百多像素富余）。
       把这段留白量出来借给纸片场，便利贴就能贴在正文**旁边**，而不是只能压在字上。
       量的是 grid 解析后的真实列宽，比自己按 padding、gap 推算靠得住。 */
    const fit = () => {
      let out = 0;
      const inner = host.closest('.reader-inner');
      const paper = host.closest('.readmode-paper');
      if (inner) {
        const col = parseFloat(getComputedStyle(inner).gridTemplateColumns.split(' ')[0]);
        if (Number.isFinite(col)) out = Math.max(0, Math.floor((col - host.clientWidth) / 2));
      } else if (paper) {
        // 阅读模式：那张素白纸左右各有近百像素的天地，纸片正好贴在页边空白上
        const pad = parseFloat(getComputedStyle(paper).paddingRight);
        if (Number.isFinite(pad)) out = Math.max(0, Math.floor(pad) - 12);
      }
      host.style.setProperty('--sn-out', `${out}px`);
    };
    const bump = () => { fit(); setTick((t) => t + 1); };
    fit();
    const ro = new ResizeObserver(bump);
    ro.observe(host);
    const prose = host.querySelector('.prose');
    if (prose) ro.observe(prose);
    window.addEventListener('resize', bump);
    document.fonts?.ready?.then(bump).catch(() => {});
    // 图片是后到的，它一落地上面的行就全下移了
    const imgs = [...host.querySelectorAll('img')].filter((i) => !i.complete);
    imgs.forEach((i) => i.addEventListener('load', bump, { once: true }));
    return () => { ro.disconnect(); window.removeEventListener('resize', bump); };
  }, [noteId, children]);

  /* ---- 纸片落在哪儿：段落锚说了算，锚不上才退回绝对坐标 ----
     纸片贴的是「这一段旁边」，不是「屏幕上这个像素」。所以在 Obsidian 里往前面
     插一段、或者换到全屏阅读模式（字号行距纸宽全不同），纸片都跟着它那一段走。 */
  const placed = useMemo(() => {
    const field = fieldRef.current;
    const host = hostRef.current;
    if (!field || !host) return items;
    const rect = field.getBoundingClientRect();
    const prose = host.querySelector('.prose');
    return items.map((s) => {
      const p = s.anchor ? blockPoint(s.anchor, prose, rect) : null;
      if (!p) return s;
      return { ...s, x: clamp(p.x, 0, Math.max(0, rect.width - s.w)), y: Math.max(0, p.y) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tick]);

  const viewOf = useCallback((s) => (live && live.id === s.id ? { ...s, ...live } : s), [live]);

  /* ---- 几何：纸片边中点 → 正文锚点 ---- */
  const geom = useMemo(() => {
    const field = fieldRef.current;
    const host = hostRef.current;
    if (!field || !host) return { w: 0, h: 0, arrows: [] };
    const rect = field.getBoundingClientRect();
    const prose = host.querySelector('.prose');
    const arrows = [];
    for (const raw of placed) {
      const s = viewOf(raw);
      (s.arrows || []).forEach((a, i) => {
        arrows.push({ id: s.id, i, color: s.color, from: sidePoint(s, a.side), to: pointOf(a, prose, rect) });
      });
    }
    return { w: rect.width, h: rect.height, arrows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, live, tick, viewOf]);

  /* 所有坐标都相对纸片场左上角 */
  const hostRect = () => fieldRef.current?.getBoundingClientRect();

  /* ---- 新建 ---- */
  const spot = useCallback((w, h) => {
    const rect = fieldRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const sc = scrollRef?.current?.getBoundingClientRect();
    // 落在当前看得见的那一屏里，靠右——正文在左，批注在右，和纸质笔记一个习惯
    const top = sc ? Math.max(0, sc.top - rect.top) : 0;
    let x = Math.max(0, rect.width - w - 8);
    let y = top + 72;
    for (let i = 0; i < 60; i++) {
      const hit = placed.some((s) => Math.abs(s.x - x) < w * 0.5 && Math.abs(s.y - y) < h * 0.5);
      if (!hit) break;
      y += 28;
      x -= 16;
      if (x < 0) { x = Math.max(0, rect.width - w - 8); y += 18; }
    }
    return { x: clamp(x, 0, Math.max(0, rect.width - w)), y: Math.max(0, y) };
  }, [placed, scrollRef]);

  const add = useCallback(async (color, at, extra = {}) => {
    if (!noteId) return null;
    const w = extra.w ?? DEF_W;
    const h = extra.h ?? DEF_H;
    const rect = hostRect();
    const pos = at
      ? { x: clamp(at.x - w / 2, 0, Math.max(0, (rect?.width || w) - w)), y: Math.max(0, at.y - 16) }
      : spot(w, h);
    const prose = hostRef.current?.querySelector('.prose');
    const anchor = rect ? blockAnchorAt(pos.x, pos.y, prose, rect) : null;
    const row = await api.addSticky({ path: noteId, color, ...pos, w, h, text: '', anchor, ...extra });
    setItems((l) => [...l, row]);
    if (!row.media && !row.text) setEditing(row.id);
    return row;
  }, [noteId, spot]);

  /* ---- 图片 / PDF：拖进来、粘贴、导入 ---- */
  const addMedia = useCallback(async (file, at, color = 'y') => {
    setBusy(true);
    try {
      const up = await api.uploadStickyMedia(file);
      let w = 300;
      let h = 380;
      let poster = '';

      if (up.kind === 'pdf') {
        /* PDF 在纸片上要的是一张封面图，不是一个带滚动条的阅读器。
           首页在前端光栅化成 PNG 存成第二份素材；原 PDF 留着，点开纸片仍是完整阅读器。
           pdf.js 近 1MB，只在真的拖进来 PDF 时才动态加载 */
        try {
          const { pdfPoster } = await import('../pdf-poster.js');
          const shot = await pdfPoster(vaultUrl(up.path));
          const name = file.name?.replace(/\.pdf$/i, '') || 'pdf';
          const cover = await api.uploadStickyMedia(new File([shot.blob], `${name}-p1.png`, { type: 'image/png' }));
          poster = cover.path;
          w = clamp(shot.w, MIN_W, 300);
          h = clamp(Math.round((w * shot.h) / (shot.w || 1)), MIN_H, 460);
        } catch (err) {
          // 渲不出来（加密、损坏、字体缺失）就退回 iframe 预览，别让一张 PDF 把贴纸卡死
          console.warn('[便利贴] PDF 首页渲染失败，退回浏览器预览', err);
        }
      } else if (up.kind === 'image') {
        const nat = await natural(vaultUrl(up.path));
        // 原图比例照搬，只限个上限：贴纸是缩略，点开才是原图
        w = clamp(nat.w, MIN_W, 360);
        h = clamp(Math.round((w * nat.h) / (nat.w || 1)), MIN_H, 460);
      }

      return await add(color, at, { media: up.path, mediaKind: up.kind, poster, w, h });
    } catch (err) {
      console.warn('[便利贴] 贴图失败', err);
      return null;
    } finally { setBusy(false); }
  }, [add]);

  const takeFiles = useCallback(async (files, at) => {
    const rect = hostRect();
    let i = 0;
    for (const f of [...files].slice(0, 8)) {
      if (!isMedia(f)) continue;
      const pt = at ? { x: at.x + i * 22, y: at.y + i * 22 } : null;
      // eslint-disable-next-line no-await-in-loop
      await addMedia(f, pt && rect ? pt : null);
      i += 1;
    }
  }, [addMedia]);

  /* ---- 粘贴：截图直接变纸片 ---- */
  useEffect(() => {
    if (!noteId || !active) return undefined;
    const onPaste = (e) => {
      const el = document.activeElement;
      if (el && el.closest?.('input, textarea, [contenteditable="true"]')) return;  // 正在打字，别抢
      const files = [...(e.clipboardData?.files || [])];
      const rect = hostRect();
      const at = lastPt.current && rect
        ? { x: lastPt.current.x - rect.left, y: lastPt.current.y - rect.top }
        : null;
      if (files.length) { e.preventDefault(); takeFiles(files, at); return; }
      const txt = e.clipboardData?.getData('text/plain')?.trim();
      if (txt && txt.length <= 2000) { e.preventDefault(); add('y', at, { text: txt }); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [noteId, takeFiles, add, active]);

  useEffect(() => {
    if (!active) return undefined;
    const track = (e) => { lastPt.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointermove', track, { passive: true });
    return () => window.removeEventListener('pointermove', track);
  }, [active]);

  /* ---- 点到别处就取消选中，别让那个叉一直悬着 ---- */
  useEffect(() => {
    if (!selArrow || !active) return undefined;
    const onDown = (e) => {
      if (e.target.closest?.('.sn-wire, .sn')) return;
      setSelArrow(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [selArrow, active]);

  /* ---- 键盘：选中箭头后按 Delete 删掉 ---- */
  useEffect(() => {
    if (!selArrow || !active) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement;
      if (el && el.closest?.('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      dropArrow(selArrow.id, selArrow.i);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selArrow, active]);

  /* ---- 拖动 / 放缩 / 撕去 / 图钉 ---- */
  /* 拖动过程中位置只在 live 里，松手时用 live 的值落盘 */
  const liveRef = useRef(null);
  useEffect(() => { liveRef.current = live; }, [live]);
  const placedRef = useRef([]);
  useEffect(() => { placedRef.current = placed; }, [placed]);
  const commitLive = useCallback((id) => {
    const l = liveRef.current;
    if (!l || l.id !== id) return;
    const { id: _drop, ...geo } = l;
    // 落到哪一段旁边，这时候才算得准
    const rect = fieldRef.current?.getBoundingClientRect();
    const prose = hostRef.current?.querySelector('.prose');
    const cur = placedRef.current.find((s) => s.id === id);
    const x = geo.x ?? cur?.x ?? 0;
    const y = geo.y ?? cur?.y ?? 0;
    const anchor = rect ? blockAnchorAt(x, y, prose, rect) : null;
    patch(id, { ...geo, x, y, ...(anchor ? { anchor } : {}) });
    setLive(null);
  }, [patch]);

  const startMove = (e, s) => {
    if (e.button !== 0) return;
    if (e.target.closest('.sn-pin, .sn-tear, .sn-hand, .sn-grip, .sn-edit, a')) return;
    setSelArrow(null);
    const rect = hostRect();
    if (!rect) return;
    if (s.pinned) { drag(e, { onMove: () => {}, onUp: (moved) => { if (!moved && canOpen(s)) setExpanded(s.id); } }); return; }
    const x0 = s.x;
    const y0 = s.y;
    drag(e, {
      onMove: (dx, dy) => setLive({
        id: s.id,
        x: clamp(x0 + dx, 0, Math.max(0, rect.width - s.w)),
        y: Math.max(0, y0 + dy),
      }),
      onUp: (moved) => {
        if (moved) { commitLive(s.id); return; }
        setLive(null);
        // 内容在纸片里放得下就没什么好展开的——点一下不该平白弹个窗
        if (canOpen(s)) setExpanded(s.id);
      },
    });
  };

  const startResize = (e, s) => {
    const rect = hostRect();
    if (!rect) return;
    const w0 = s.w;
    const h0 = s.h;
    drag(e, {
      onMove: (dx, dy) => setLive({
        id: s.id,
        w: clamp(w0 + dx, MIN_W, Math.max(MIN_W, rect.width - s.x)),
        h: clamp(h0 + dy, MIN_H, 1200),
      }),
      onUp: (moved) => { if (moved) commitLive(s.id); else setLive(null); },
    });
  };

  const tear = (id) => {
    const p = pending.current.get(id);
    if (p) { clearTimeout(p.timer); pending.current.delete(id); }
    setTearing(id);
    api.removeSticky(id).catch(() => {});
    setTimeout(() => {
      setItems((l) => l.filter((s) => s.id !== id));
      setTearing(null);
    }, 240);
  };

  /* ---- 拉箭头 ---- */
  const startDraw = (e, s, side) => {
    e.preventDefault();
    e.stopPropagation();
    setSelArrow(null);
    const from = sidePoint(s, side);
    const at = (ev) => {
      const rect = hostRect();
      return rect ? { x: ev.clientX - rect.left, y: ev.clientY - rect.top } : from;
    };
    setDraw({ id: s.id, side, from, to: at(e) });
    const move = (ev) => setDraw((d) => (d ? { ...d, to: at(ev) } : d));
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDraw(null);
      const rect = hostRect();
      const prose = hostRef.current?.querySelector('.prose');
      if (!rect) return;
      const a = { side, ...anchorAt(ev.clientX, ev.clientY, prose, rect) };
      // 拉得太短当误触，别留一截毛刺在纸边上
      if (Math.hypot(a.x - from.x, a.y - from.y) < 26) return;
      // 函数式更新：连着画两根，第二根不会拿旧数组把第一根盖掉
      setItems((l) => {
        const next = l.map((it) => (it.id === s.id ? { ...it, arrows: [...(it.arrows || []), a] } : it));
        save(s.id, { arrows: next.find((it) => it.id === s.id).arrows });
        return next;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dropArrow = (id, i) => {
    const s = items.find((it) => it.id === id);
    if (!s) return;
    patch(id, { arrows: (s.arrows || []).filter((_a, k) => k !== i) });
    setSelArrow(null);
  };

  const expandedItem = items.find((s) => s.id === expanded) || null;
  const drawn = draw ? arrowPath(draw.from, draw.to) : null;

  return (
    <div
      className={`sn-host${dropping ? ' dropping' : ''}`}
      ref={hostRef}
      onDragOver={(e) => {
        if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => { if (!hostRef.current?.contains(e.relatedTarget)) setDropping(false); }}
      onDrop={(e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        setDropping(false);
        const rect = hostRect();
        takeFiles(e.dataTransfer.files, rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
      }}
    >
      {children}

      <div className={`sn-layer${draw ? ' drawing' : ''}`} ref={fieldRef}>
        <svg className="sn-wires" width={geom.w} height={geom.h} aria-hidden="true">
          {geom.arrows.map((a) => {
            const p = arrowPath(a.from, a.to);
            const on = selArrow && selArrow.id === a.id && selArrow.i === a.i;
            return (
              <g key={`${a.id}-${a.i}`} className={`sn-wire c-${a.color}${on ? ' on' : ''}`}>
                <path className="hit" d={p.d} onPointerDown={(e) => { e.stopPropagation(); setSelArrow({ id: a.id, i: a.i }); }} />
                <path className="line" d={p.d} />
                <path className="head" d={p.head} />
                {on && (
                  <g className="sn-wire-x" onPointerDown={(e) => { e.stopPropagation(); dropArrow(a.id, a.i); }}>
                    <circle cx={p.mid.x} cy={p.mid.y} r="8.5" />
                    <path d={`M ${p.mid.x - 3.2} ${p.mid.y - 3.2} L ${p.mid.x + 3.2} ${p.mid.y + 3.2}
                              M ${p.mid.x + 3.2} ${p.mid.y - 3.2} L ${p.mid.x - 3.2} ${p.mid.y + 3.2}`} />
                  </g>
                )}
              </g>
            );
          })}
          {drawn && (
            <g className={`sn-wire c-${items.find((s) => s.id === draw.id)?.color || 'y'} ghost`}>
              <path className="line" d={drawn.d} />
              <path className="head" d={drawn.head} />
            </g>
          )}
        </svg>

        {placed.map((raw) => {
          const s = viewOf(raw);
          return (
            <Sticky
              key={s.id} s={s}
              editing={editing === s.id}
              tearing={tearing === s.id}
              onDown={(e) => startMove(e, s)}
              onDoubleClick={() => setEditing(s.id)}
              onPin={() => patch(s.id, { pinned: !s.pinned })}
              onTear={() => tear(s.id)}
              onResize={(e) => startResize(e, s)}
              onDraw={(e, side) => startDraw(e, s, side)}
              onText={(v) => patch(s.id, { text: v }, 600)}
              onEditEnd={() => {
                setEditing(null);
                // 一张什么都没写的空纸没有存在的理由——和现实里一样，随手扔了
                if (!s.text.trim() && !s.media && !(s.arrows || []).length) tear(s.id);
              }}
              onOver={noteOver}
            />
          );
        })}
      </div>

      {active && (
        <Dock busy={busy} onAdd={(c) => add(c)} onDrop={(c, at) => add(c, at)} hostRef={hostRef} onFiles={takeFiles} />
      )}

      {expandedItem && createPortal(
        <Expanded
          s={expandedItem}
          onClose={() => setExpanded(null)}
          onText={(v) => patch(expandedItem.id, { text: v }, 600)}
          onColor={(c) => patch(expandedItem.id, { color: c })}
        />, document.body)}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 取纸台
 * ------------------------------------------------------------------ */

function Dock({ onAdd, onDrop, hostRef, onFiles, busy }) {
  const [drop, setDrop] = useState(null);       // 正从取纸台往外拖的那张
  const fileRef = useRef(null);

  const start = (e, c) => {
    drag(e, {
      onMove: (_dx, _dy, ev) => setDrop({ c, x: ev.clientX, y: ev.clientY }),
      onUp: (didMove, ev) => {
        setDrop(null);
        const rect = hostRef.current?.getBoundingClientRect();
        if (!didMove) { onAdd(c); return; }
        if (!rect) return;
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        if (x < -40 || y < -40 || x > rect.width + 40 || y > rect.height + 40) return;
        onDrop(c, { x, y });
      },
    });
  };

  return (
    <>
      <div className="sn-dock" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sn-dock-lbl">便利贴</div>
        {SN_COLORS.map((c) => (
          <button
            key={c.k} className={`sn-chip c-${c.k}`}
            title={`${c.label} · ${c.hint}　（点一下贴一张，或拖到正文旁边）`}
            onPointerDown={(e) => start(e, c.k)}
          >
            <span>{c.label}</span>
          </button>
        ))}
        <button
          className="sn-chip sn-file" title="导入图片 / PDF，做成便利贴（也可以直接拖进来或 Ctrl+V 粘贴截图）"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => fileRef.current?.click()}
        >
          <span>{busy ? '…' : '图'}</span>
        </button>
        <input
          ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden
          onChange={(e) => { onFiles(e.target.files, null); e.target.value = ''; }}
        />
      </div>
      {drop && createPortal(
        <div className={`sn-ghost c-${drop.c}`} style={{ left: drop.x - 40, top: drop.y - 22 }} />,
        document.body)}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 展开：纸片装不下的内容在这儿看全
 * ------------------------------------------------------------------ */

function Expanded({ s, onClose, onText, onColor }) {
  const [edit, setEdit] = useState(!s.media && !s.text.trim());
  const html = useMemo(() => (s.media ? '' : renderSticky(s.text)), [s.text, s.media]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sn-modal" onPointerDown={onClose}>
      <div className={`sn-full c-${s.color}`} onPointerDown={(e) => e.stopPropagation()}>
        <div className="sn-full-bar">
          {SN_COLORS.map((c) => (
            <button
              key={c.k} className={`sn-swatch c-${c.k}${c.k === s.color ? ' on' : ''}`}
              title={`${c.label} · ${c.hint}`} onClick={() => onColor(c.k)}
            />
          ))}
          <span className="sn-full-hint">
            {s.mediaKind === 'pdf' ? '原 PDF' : s.media ? '原图'
              : <>粗体 <code>**…**</code>　条目 <code>-</code>　公式 <code>$…$</code></>}
          </span>
          {!s.media && (
            <button className="sn-full-btn" onClick={() => setEdit((v) => !v)}>{edit ? '完成' : '编辑'}</button>
          )}
          <button className="sn-full-btn" onClick={onClose}>关闭</button>
        </div>

        <div className="sn-full-body">
          {s.media
            ? (s.mediaKind === 'pdf'
              ? <iframe className="sn-full-pdf" src={vaultUrl(s.media)} title="PDF" />
              : <img className="sn-full-img" src={vaultUrl(s.media)} alt="" />)
            : edit
              ? <textarea className="sn-full-edit" value={s.text} autoFocus onChange={(e) => onText(e.target.value)} />
              : <div className="sn-rich" dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      </div>
    </div>
  );
}

/** 量一下原图尺寸：纸片按原比例落下来，不要一上来就把图压扁 */
function natural(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 300, h: img.naturalHeight || 200 });
    img.onerror = () => resolve({ w: 300, h: 200 });
    img.src = src;
  });
}
