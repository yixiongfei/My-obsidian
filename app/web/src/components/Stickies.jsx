import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, vaultUrl } from '../api.js';
import { renderSticky, SN_PLACEHOLDER } from '../sticky-text.js';
import { anchorAt, pointOf, blockAnchorAt, blockPoint } from '../sticky-anchor.js';
import { tearGeometry, dForGone, clampPull, TEAR_THRESHOLD } from '../sticky-tear.js';

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

/** 一小段 rAF 补间。撕页的形状每帧都要现算，CSS 过渡插不了这种非线性的量 */
function tween(from, to, ms, ease, onFrame, onDone) {
  const t0 = performance.now();
  let raf = requestAnimationFrame(function step(now) {
    const p = Math.min(1, (now - t0) / ms);
    const e = ease(p);
    onFrame({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e }, p);
    if (p < 1) raf = requestAnimationFrame(step);
    else onDone?.();
  });
  return () => cancelAnimationFrame(raf);
}
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeIn = (p) => p * p;
/* 剥离的手感：纸角跟着手指走，但隔着一层胶——
   刚开始胶还粘得牢，弹簧很软；拉开一段之后胶松了，弹簧变硬；阻尼留一点余量，松手时会微微回弹 */
const TEAR_K_HOLD = 0.035;
const TEAR_K_FREE = 0.16;
const TEAR_GLUE_PX = 46;
const TEAR_DAMP = 0.66;
const RELEASE_DURATION = 420;
const RETURN_DURATION = 460;

/**
 * 剥起来的那部分纸。
 *
 * 必须是 .sn 的**兄弟**而不是孩子——.sn 被 content 裁成「还粘着的那半」，
 * 剥起来的部分按定义在裁剪区之外，放进去会被一起裁掉。
 * 两块：绕在圆柱上的「卷」露出纸背的上半圈，渐变从顶棱的亮到轮廓线的暗，凸面感全靠它；
 * 翻平的「片」是平的，颜色几乎均匀，只在离卷远的一头略暗。
 */
function DogEar({ id, s, geo, fade }) {
  if (!geo) return null;
  const uid = `sn-peel-${id}`;
  return (
    <svg
      className={`sn-dogear c-${s.color}`} aria-hidden="true"
      style={{ left: s.x, top: s.y, width: s.w, height: s.h, opacity: fade }}
    >
      <defs>
        {/* 正在抬起的正面：离页面越远越背光，压到轮廓线那儿最暗 */}
        <linearGradient id={`${uid}-rise`} gradientUnits="userSpaceOnUse"
                        x1={geo.rise0.x} y1={geo.rise0.y} x2={geo.rise1.x} y2={geo.rise1.y}>
          <stop offset="0" stopColor="#1a1408" stopOpacity="0" />
          <stop offset="0.55" stopColor="#1a1408" stopOpacity="0.16" />
          <stop offset="1" stopColor="#1a1408" stopOpacity="0.36" />
        </linearGradient>
        {/* 纸背：顶棱迎光最亮，绕到轮廓线那儿最暗——凸面感全靠这一条 */}
        <linearGradient id={`${uid}-roll`} gradientUnits="userSpaceOnUse"
                        x1={geo.roll0.x} y1={geo.roll0.y} x2={geo.roll1.x} y2={geo.roll1.y}>
          <stop offset="0" style={{ stopColor: 'var(--sn-back-lit)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--sn-back)' }} />
          <stop offset="1" style={{ stopColor: 'var(--sn-back-deep)' }} />
        </linearGradient>
        <linearGradient id={`${uid}-flap`} gradientUnits="userSpaceOnUse"
                        x1={geo.flap0.x} y1={geo.flap0.y} x2={geo.flap1.x} y2={geo.flap1.y}>
          <stop offset="0" style={{ stopColor: 'var(--sn-back-lit)' }} />
          <stop offset="1" style={{ stopColor: 'var(--sn-back)' }} />
        </linearGradient>
        <filter id={`${uid}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={Math.max(2, geo.r * 0.22)} />
        </filter>
        {/* 很轻的纸纤维。只改变明暗，不给纸染色，四种便签仍保留各自语义色。 */}
        <filter id={`${uid}-paper`} x="-12%" y="-12%" width="124%" height="124%">
          <feTurbulence type="fractalNoise" baseFrequency="0.55 0.12" numOctaves="3" seed="17" result="fiber" />
          <feColorMatrix in="fiber" type="saturate" values="0" result="grayFiber" />
          <feComponentTransfer in="grayFiber" result="softFiber">
            <feFuncA type="table" tableValues="0 0.075" />
          </feComponentTransfer>
          {/* turbulence 本身是一张矩形位图，必须再用纸面的 alpha 裁一次；
              否则透明区也会被它染黑，露出整块滤镜边界。 */}
          <feComposite in="softFiber" in2="SourceAlpha" operator="in" result="paperFiber" />
          <feBlend in="SourceGraphic" in2="paperFiber" mode="soft-light" />
        </filter>
      </defs>
      {/* 正在抬起的正面：半透明的背光，不能带投影——它不是一块纸，是纸上的光 */}
      {geo.rise && <path d={geo.rise} fill={`url(#${uid}-rise)`} />}
      {/* 接触阴影：卷贴着页面的那条轮廓线下面最暗，往外散开 */}
      {geo.contact && (
        <path
          d={geo.contact} fill="none"
          stroke="rgba(10, 14, 22, 0.34)" strokeWidth={Math.max(3, geo.r * 0.55)} strokeLinecap="round"
          transform={`translate(${geo.a.x * geo.r * 0.28} ${geo.a.y * geo.r * 0.28})`}
          filter={`url(#${uid}-blur)`}
        />
      )}
      {/* 真正悬起来的纸：翻平的片和露出的纸背，只有它们投影子 */}
      <g className="sn-lift">
        {/* 整片纸向右下错开一层同色纸芯，只露出下缘和右缘：这是纸的厚度，
            不是悬空投影。两个几何面合成一个 path，内部不会出现接缝。 */}
        <path
          className="sn-paper-depth"
          d={[geo.flap, geo.roll].filter(Boolean).join(' ')}
          transform="translate(1.8 2.2)"
        />
        {/* 两个面一起进入同一个滤镜，浏览器先把它们合成完整纸面再加纹理，
            避免分别光栅化在公共边留下那条斜线。 */}
        <g filter={`url(#${uid}-paper)`}>
          {geo.flap && <path d={geo.flap} fill={`url(#${uid}-flap)`} />}
          {geo.roll && <path d={geo.roll} fill={`url(#${uid}-roll)`} />}
        </g>
      </g>
      {/* 顶棱：纸绕过圆柱最高处那条线，迎光最亮 */}
      {geo.crest && <path className="sn-crease" d={geo.crest} fill="none" strokeWidth="1.1" strokeLinecap="round" />}
    </svg>
  );
}

function Sticky({ s, editing, onDown, onDoubleClick, onPin, onTear, onResize, onDraw, onText, onEditEnd, onOver, tear }) {
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

  /* 撕页：整张纸的形状由一个点 D 推出来（见 sticky-tear.js）。
     这里只做两件事——把还留着的那半当 clip-path 扣在自己身上，
     把剥起来的卷和片交给兄弟节点 DogEar 去画 */
  const geo = tear ? tearGeometry(s.w, s.h, tear.d) : null;
  const torn = !!geo;

  return (
  <>
    <div
      className={`sn c-${s.color}${s.media ? ' media' : ''}${s.pinned ? ' pinned' : ''}${editing ? ' editing' : ''}${torn ? ' tearing' : ''}`}
      style={{
        left: s.x, top: s.y, width: s.w, height: s.h,
        ...(torn ? {
          clipPath: geo.content ? `path('${geo.content}')` : 'path(\'M0 0Z\')',
          opacity: tear.fade,
        } : null),
      }}
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
          className="sn-tear" title="按住右上角向左下拖，慢慢撕开"
          onPointerDown={(e) => { e.stopPropagation(); onTear(e); }}
          onClick={(e) => e.stopPropagation()}
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
          placeholder={'写点什么…\n $x^2$'}
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
    <DogEar id={s.id} s={s} geo={geo} fade={tear ? tear.fade : 1} />
  </>
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
  const [tear, setTear] = useState(null);      // 正在撕的那张：{ id, d:{x,y}, fade }
  const stopTear = useRef(null);               // 取消正在跑的补间
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const lastPt = useRef(null);                 // 最近一次鼠标位置，粘贴时当落点
  const overs = useRef(new Map());             // 哪些纸片装不下自己的内容
  const noteOver = useCallback((id, v) => { overs.current.set(id, v); }, []);
  const canOpen = (s) => !!s.media || overs.current.get(s.id) === true;
  const openExpanded = (s, rect) => setExpanded({
    id: s.id,
    origin: rect ? {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    } : null,
  });

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
    /* 纸片场能有多宽。
       正文栏封在 900px 里，但页面给它的地方宽得多：左边是正文栏自己的留白，
       右边还整整一栏目录——那栏除了顶上几行链接，底下全是空的。两边分开量，
       量到容器**内容区**的边缘为止（不含 padding），所以永远不会撑出横向滚动条。 */
    const fit = () => {
      let l = 0;
      let r = 0;
      const box = host.getBoundingClientRect();
      /* 全屏阅读：纸片不受那张纸的边框约束，纸外左右两侧的整屏都能贴——
         量到整页滚动容器的内容区为止，正文和纸的样子一点不动 */
      const inner = host.closest('.reader-inner');
      const page = host.closest('.readmode-page');
      const field = inner || page;
      if (field) {
        const cs = getComputedStyle(field);
        const fb = field.getBoundingClientRect();
        // clientWidth 不含滚动条，纸片不会钻到滚动条底下、撑出横向滚动
        const left = fb.left + field.clientLeft + parseFloat(cs.paddingLeft);
        const right = fb.left + field.clientLeft + field.clientWidth - parseFloat(cs.paddingRight);
        l = Math.max(0, Math.floor(box.left - left));
        r = Math.max(0, Math.floor(right - box.right));
      }
      host.style.setProperty('--sn-out-l', `${l}px`);
      host.style.setProperty('--sn-out-r', `${r}px`);
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
    /* 右边那片空白的上半截是目录。默认别一上来就压住它——那是导航，
       盖住了得先拖开才能用。目录下面的一整片才是真正没人要的地方 */
    const toc = hostRef.current?.closest('.reader-inner')?.querySelector('.toc');
    if (toc) {
      const t = toc.getBoundingClientRect();
      const tx = t.left - rect.left;
      if (x + w > tx && y < t.bottom - rect.top) y = Math.max(y, t.bottom - rect.top + 16);
    }
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
          ({ w, h } = fitSize(shot.w, shot.h, 300, 460));
        } catch (err) {
          // 渲不出来（加密、损坏、字体缺失）就退回 iframe 预览，别让一张 PDF 把贴纸卡死
          console.warn('[便利贴] PDF 首页渲染失败，退回浏览器预览', err);
        }
      } else if (up.kind === 'image') {
        const nat = await natural(vaultUrl(up.path));
        ({ w, h } = fitSize(nat.w, nat.h, 360, 460));
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
    const sourceRect = e.currentTarget.getBoundingClientRect();
    if (s.pinned) { drag(e, { onMove: () => {}, onUp: (moved) => { if (!moved && canOpen(s)) openExpanded(s, sourceRect); } }); return; }
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
        if (canOpen(s)) openExpanded(s, sourceRect);
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

  /** 真的把它拿掉（撕页动画放完之后才调） */
  const drop = (id) => {
    const p = pending.current.get(id);
    if (p) { clearTimeout(p.timer); pending.current.delete(id); }
    setTear(null);
    setItems((l) => l.filter((s) => s.id !== id));
    api.removeSticky(id).catch(() => {});
  };

  /**
   * 撕：按住右上角的翘角**往左拖**。
   *
   * 手指的位置就是几何模型里的 D——胶从剥离线一点点松开，松开的纸绕成一个卷，
   * 卷、翻平的片、阴影、渐变全是从 D 现算出来的（sticky-tear.js）。拖过 45% 松手才真撕下来，
   * 没拖够就被胶拉回去贴平。点一下就删太轻了：纸片上写的是自己想明白的过程，误删没处找。
   */
  const startTear = (e, s) => {
    e.preventDefault();
    e.stopPropagation();
    setSelArrow(null);
    stopTear.current?.();

    const C = { x: s.w, y: 0 };
    let target = { x: C.x, y: C.y };   // 手指真正在哪
    let d = { x: C.x, y: C.y };        // 纸角实际在哪：隔着胶和弹簧追手指
    let vel = { x: 0, y: 0 };
    let progress = 0;
    let raf = null;
    let released = false;

    const animate = () => {
      const dx = target.x - d.x;
      const dy = target.y - d.y;
      // 已经剥开多远决定胶还剩多少劲：越往后越跟手
      const opened = Math.hypot(d.x - C.x, d.y - C.y);
      const k = TEAR_K_HOLD + (TEAR_K_FREE - TEAR_K_HOLD) * Math.min(1, opened / TEAR_GLUE_PX);
      vel = { x: (vel.x + dx * k) * TEAR_DAMP, y: (vel.y + dy * k) * TEAR_DAMP };
      d = { x: d.x + vel.x, y: d.y + vel.y };
      progress = tearGeometry(s.w, s.h, d)?.progress ?? 0;
      setTear({ id: s.id, d: { ...d }, fade: 1 });
      if (!released) raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    stopTear.current = () => {
      released = true;
      if (raf) cancelAnimationFrame(raf);
    };

    drag(e, {
      onMove: (mx, my) => {
        // 只认往纸里拉的分量，几何那边同样这么压——手往上抖一下纸不会乱翻
        const v = clampPull(s.w, s.h, { x: mx, y: my });
        target = { x: C.x + v.x, y: C.y + v.y };
      },
      onUp: () => {
        released = true;
        if (raf) cancelAnimationFrame(raf);

        if (progress >= TEAR_THRESHOLD) {
          // 过了临界点：胶「啪」地一下整个松开，纸沿着当前方向一路卷走
          const dir = { x: d.x - C.x, y: d.y - C.y };
          const end = dForGone(s.w, s.h, dir.x || dir.y ? dir : { x: -1, y: 0.3 });
          stopTear.current = tween(
            d, end, RELEASE_DURATION, easeIn,
            (p, k) => setTear({ id: s.id, d: p, fade: k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1 }),
            () => drop(s.id),
          );
        } else if (progress > 0) {
          // 没撕够：胶把它慢慢拉回去贴平
          stopTear.current = tween(
            d, C, RETURN_DURATION, easeOut,
            (p) => setTear({ id: s.id, d: p, fade: 1 }),
            () => setTear(null),
          );
        } else {
          setTear(null);
        }
      },
    });
  };

  // 换笔记 / 卸载时别留下跑着的补间
  useEffect(() => () => stopTear.current?.(), [noteId]);

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

  const expandedItem = items.find((s) => s.id === expanded?.id) || null;
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
              tear={tear && tear.id === s.id ? tear : null}
              onDown={(e) => startMove(e, s)}
              onDoubleClick={(e) => {
                if (s.media) openExpanded(s, e.currentTarget.getBoundingClientRect());
                else setEditing(s.id);
              }}
              onPin={() => patch(s.id, { pinned: !s.pinned })}
              onTear={(e) => startTear(e, s)}
              onResize={(e) => startResize(e, s)}
              onDraw={(e, side) => startDraw(e, s, side)}
              onText={(v) => patch(s.id, { text: v }, 600)}
              onEditEnd={() => {
                setEditing(null);
                // 一张什么都没写的空纸没有存在的理由——和现实里一样，随手扔了
                if (!s.text.trim() && !s.media && !(s.arrows || []).length) drop(s.id);
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
          origin={expanded.origin}
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

function Expanded({ s, origin, onClose, onText, onColor }) {
  const [edit, setEdit] = useState(!s.media && !s.text.trim());
  const [naturalSize, setNaturalSize] = useState(null);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const html = useMemo(() => (s.media ? '' : renderSticky(s.text)), [s.text, s.media]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);

  /* 原图有多大就看多大；屏幕放不下时才等比收小。工具条预留 42px，
     四边各留 16px，避免贴着窗口边缘显得像另一个全屏层。 */
  const viewSize = useMemo(() => {
    if (!s.media || s.mediaKind === 'pdf') return null;
    const source = naturalSize || { w: Math.max(s.w, 320), h: Math.max(s.h, 180) };
    const scale = Math.min(1, (viewport.w - 32) / source.w, (viewport.h - 74) / source.h);
    return { w: Math.round(source.w * scale), h: Math.round(source.h * scale) };
  }, [naturalSize, s.h, s.media, s.mediaKind, s.w, viewport]);

  const panelSize = viewSize
    ? { w: viewSize.w, h: viewSize.h + 42 }
    : { w: Math.min(680, viewport.w - 32), h: Math.min(620, viewport.h - 32) };
  const placeBelow = origin ? origin.top + origin.height / 2 < viewport.h / 2 : false;
  const panelStyle = {
    left: Math.max(16, viewport.w - panelSize.w - 16),
    top: placeBelow ? Math.max(16, viewport.h - panelSize.h - 16) : 16,
    width: panelSize.w,
    ...(s.mediaKind === 'pdf' ? { height: panelSize.h } : null),
  };

  return (
    <div className="sn-modal">
      <div className={`sn-full${s.media ? ' media' : ''} c-${s.color}`} style={panelStyle}>
        <div className="sn-full-bar">
          {SN_COLORS.map((c) => (
            <button
              key={c.k} className={`sn-swatch c-${c.k}${c.k === s.color ? ' on' : ''}`}
              title={`${c.label} · ${c.hint}`} onClick={() => onColor(c.k)}
            />
          ))}
          <span className="sn-full-hint">
            {s.mediaKind === 'pdf' ? '原 PDF' : s.media ? '原图 · 双击关闭'
              : <>粗体 <code>**…**</code>　条目 <code>-</code>　公式 <code>$…$</code></>}
          </span>
          {!s.media && (
            <button className="sn-full-btn" onClick={() => setEdit((v) => !v)}>{edit ? '完成' : '编辑'}</button>
          )}
          <button className="sn-full-btn" onClick={onClose}>关闭</button>
        </div>

        <div
          className={`sn-full-body${s.media ? ' media' : ''}`}
          onDoubleClick={s.media && s.mediaKind !== 'pdf' ? onClose : undefined}
          title={s.media && s.mediaKind !== 'pdf' ? '双击关闭原图' : undefined}
        >
          {s.media
            ? (s.mediaKind === 'pdf'
              ? <iframe className="sn-full-pdf" src={vaultUrl(s.media)} title="PDF" />
              : <img
                  className="sn-full-img" src={vaultUrl(s.media)} alt=""
                  style={viewSize ? { width: viewSize.w, height: viewSize.h } : undefined}
                  onLoad={(e) => setNaturalSize({
                    w: e.currentTarget.naturalWidth || s.w,
                    h: e.currentTarget.naturalHeight || s.h,
                  })}
                />)
            : edit
              ? <textarea className="sn-full-edit" value={s.text} autoFocus onChange={(e) => onText(e.target.value)} />
              : <div className="sn-rich" dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      </div>
    </div>
  );
}

/**
 * 图贴上来时纸片该多大：**严格按原图比例**，图正好铺满整张纸——
 * 先等比缩到上限以内，太小再等比放大到最小尺寸。分别夹 w、h 会把比例夹坏，图就贴不合了。
 */
function fitSize(nw, nh, maxW, maxH) {
  const down = Math.min(1, maxW / (nw || 1), maxH / (nh || 1));
  let w = Math.max(1, nw * down);
  let h = Math.max(1, nh * down);
  const up = Math.max(1, MIN_W / w, MIN_H / h);
  w = Math.round(w * up);
  h = Math.round(h * up);
  return { w, h };
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
