import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { findTextRange, useWordMarks, wrapRange } from '../wordmarks.js';

const EMPTY = { strokes: [], highlights: [], notes: [] };
const TOOLS = [
  { k: 'hand', label: '选择', icon: 'hand' },
  { k: 'highlight', label: '标记', icon: 'highlight' },
  { k: 'pen', label: '画笔', icon: 'pen' },
  { k: 'eraser', label: '橡皮', icon: 'eraser' },
];
const INK_COLORS = [
  { k: 'ink', label: '墨色', value: '#263044' },
  { k: 'red', label: '红色', value: '#D8524B' },
  { k: 'blue', label: '蓝色', value: '#3F70C9' },
];
const HL_COLORS = [
  { k: 'y', label: '黄色', value: '#F1D669' },
  { k: 'g', label: '绿色', value: '#8FD4A4' },
  { k: 'b', label: '蓝色', value: '#91BEEB' },
  { k: 'p', label: '粉色', value: '#EDA6B3' },
];
// erm-sentence：这篇里已经进了长难句的句子，画一道虚线
const HIGHLIGHT_NAMES = [...HL_COLORS.map((x) => `erm-reading-${x.k}`), 'erm-sentence'];

const html = (s) => ({ __html: s || '' });
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const normalize = (v) => ({
  strokes: Array.isArray(v?.strokes) ? v.strokes : [],
  highlights: Array.isArray(v?.highlights) ? v.highlights : [],
  // 旧版本的翻译便签数据保留在存储中，但阅读模式不再呈现或创建它。
  notes: Array.isArray(v?.notes) ? v.notes : [],
});
const inkHex = (key) => INK_COLORS.find((x) => x.k === key)?.value || INK_COLORS[0].value;

function ToolIcon({ name }) {
  const common = { viewBox: '0 0 24 24', 'aria-hidden': true, focusable: 'false' };
  if (name === 'hand') return (
    <svg {...common}>
      <path d="M7.5 11V6.8a1.6 1.6 0 0 1 3.2 0V10" />
      <path d="M10.7 10V4.9a1.6 1.6 0 0 1 3.2 0V10" />
      <path d="M13.9 10V6.1a1.6 1.6 0 0 1 3.2 0v5" />
      <path d="M17.1 10.2a1.6 1.6 0 0 1 3.2.2v3.4c0 4.7-2.7 7.2-7.1 7.2h-.5c-2.4 0-4.1-1-5.6-2.8l-3.2-4a1.65 1.65 0 0 1 2.5-2.15L8.6 14" />
    </svg>
  );
  if (name === 'highlight') return (
    <svg {...common}>
      <path d="m5 15.5 9.8-11 4.7 4.2-9.8 11H5Z" />
      <path d="m12.8 6.8 4.6 4.1M4 21h11" />
    </svg>
  );
  if (name === 'pen') return (
    <svg {...common}>
      <path d="m4.5 19.5 1-4.1L16.2 4.7a2.2 2.2 0 0 1 3.1 3.1L8.6 18.5Z" />
      <path d="m14.6 6.3 3.1 3.1M5.5 15.4l3.1 3.1" />
    </svg>
  );
  if (name === 'eraser') return (
    <svg {...common}>
      <path d="m4.3 14.4 8.9-9.1a2.2 2.2 0 0 1 3.1 0l2.5 2.5a2.2 2.2 0 0 1 0 3.1L10 20H7.2l-2.9-2.7a2.1 2.1 0 0 1 0-2.9Z" />
      <path d="m9 9.7 5.4 5.2M11.4 20H20" />
    </svg>
  );
  if (name === 'undo') return <svg {...common}><path d="m9 7-5 5 5 5" /><path d="M20 18a8 8 0 0 0-8-8H4" /></svg>;
  if (name === 'redo') return <svg {...common}><path d="m15 7 5 5-5 5" /><path d="M4 18a8 8 0 0 1 8-8h8" /></svg>;
  if (name === 'trash') return (
    <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>
  );
  if (name === 'sentence') return (
    <svg {...common}><path d="M4 6h11M4 11h8M4 16h6" /><path d="M17 12v8M13 16h8" /></svg>
  );
  return null;
}

function unwrapHighlights(root) {
  for (const mark of root?.querySelectorAll('mark.erm-highlight') || []) {
    const p = mark.parentNode;
    while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
    p.removeChild(mark);
    p.normalize();
  }
}

function selectedInside(root) {
  const sel = window.getSelection?.();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (!node || !root.contains(node)) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (text.length < 2) return null;
  return { text, range: range.cloneRange() };
}

/*
 * 荧光笔按「容器里第几个字符」存。题目栏交卷后每题下面会冒出「答案 + 解析」，
 * 这段字不能算进下标，否则一交卷（或重做收起答案），后面的标记整体错位。
 * 想标解析里的字，就以那一题的解析块为容器单独存（part: 'answer'）。
 */
const SKIP = { article: 'textarea, input', questions: 'textarea, input, .erm-answer' };

function textIndexOf(root, skip = SKIP.article) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = []; let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
  return { nodes, text };
}

/** 一个 DOM 位置换算成下标；落在被跳过的字里就算到它前面 */
function pointOffset(index, container, offset) {
  const probe = document.createRange();
  try { probe.setStart(container, offset); } catch { return null; }
  let at = 0;
  for (const { node } of index.nodes) {
    if (node === container) return at + offset;
    if (probe.comparePoint(node, node.nodeValue.length) > 0) break;
    at += node.nodeValue.length;
  }
  return at;
}

function rangeIn(index, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  let first = null; let last = null;
  for (const { node, start: at } of index.nodes) {
    const next = at + node.nodeValue.length;
    if (!first && start >= at && start <= next) first = [node, Math.min(node.nodeValue.length, start - at)];
    if (end >= at && end <= next) { last = [node, Math.min(node.nodeValue.length, end - at)]; break; }
  }
  if (!first || !last) return null;
  try {
    const range = document.createRange();
    range.setStart(first[0], first[1]); range.setEnd(last[0], last[1]);
    return range;
  } catch { return null; }
}

const squashAll = (s) => String(s || '').replace(/\s+/g, '');

/** 文字相同的几处里，挑离原下标最近的那处 */
function nearestText(index, want, near) {
  if (!want) return null;
  const map = []; let compact = '';
  for (let i = 0; i < index.text.length; i++) if (!/\s/.test(index.text[i])) { compact += index.text[i]; map.push(i); }
  let best = -1;
  for (let at = compact.indexOf(want); at >= 0; at = compact.indexOf(want, at + 1)) {
    if (best < 0 || Math.abs(map[at] - near) < Math.abs(map[best] - near)) best = at;
  }
  return best < 0 ? null : rangeIn(index, map[best], map[best + want.length - 1] + 1);
}

/** 一条荧光笔现在该画在哪。先按下标，字对得上就是它；对不上（旧版本交卷后划的，下标里算了解析）再按原文找 */
function locateMark(roots, mark) {
  const scope = mark.scope || 'article';
  let root = roots[scope]; let skip = SKIP[scope];
  if (mark.part === 'answer') {
    root = root?.querySelector(`[data-question="${mark.q}"] .erm-answer`); skip = SKIP.article;
  }
  if (!root) return null;
  if (!Number.isFinite(mark.start)) return findTextRange(root, mark.text);
  const index = textIndexOf(root, skip);
  const want = squashAll(mark.text);
  const direct = rangeIn(index, mark.start, mark.end);
  if (direct && (!want || squashAll(index.text.slice(mark.start, mark.end)) === want)) return direct;
  return nearestText(index, want, mark.start) || (want && findTextRange(root, mark.text)) || direct;
}

/** 选区 → 要存的标记：容器、下标、文字。选区从某题的解析里开始，就存到那一题的解析块上 */
function targetOf(roots, scope, range) {
  let root = roots[scope]; let skip = SKIP[scope]; let anchor = {};
  const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const answer = scope === 'questions' ? start?.closest('.erm-answer') : null;
  if (answer) {
    root = answer; skip = SKIP.article;
    anchor = { q: Number(answer.closest('[data-question]')?.dataset.question) || null, part: 'answer' };
  }
  if (!root) return null;
  const index = textIndexOf(root, skip);
  const s = pointOffset(index, range.startContainer, range.startOffset);
  const e = pointOffset(index, range.endContainer, range.endOffset); // 越过容器的部分自然截掉
  if (s == null || e == null || e <= s) return null;
  const text = index.text.slice(s, e).replace(/\s+/g, ' ').trim();
  return text.length < 2 ? null : { start: s, end: e, text, ...anchor };
}

/* ── 选区扩到整句：划得不准也没关系，往前退到上一个句末（或段首），往后走到下一个句末（或段尾） ── */
const ABBR = /(?:^|[\s(“"'])(?:[A-Z]|Mr|Mrs|Ms|Dr|St|Prof|Jr|Sr|vs|No|e\.g|i\.e|U\.S|U\.K)$/;
const BLOCK = 'p, li, div, blockquote, h1, h2, h3, h4, td';

/** 容器里的全部文字（文章栏里和 textIndexOf 同一套下标），外加段落边界 */
function blocksOf(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = ''; let prev = null; const breaks = [0];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const block = node.parentElement?.closest(BLOCK);
    if (prev && block !== prev) breaks.push(text.length);
    prev = block; text += node.nodeValue;
  }
  breaks.push(text.length);
  return { text, breaks };
}

/** text[i] 是 . ! ? 时：这里是句末就返回句子结束的位置（带上后引号 / 括号），不是返回 -1 */
function sentenceEnd(text, i) {
  let j = i + 1;
  while (j < text.length && /["'”’)\]]/.test(text[j])) j++;
  if (j < text.length && !/\s/.test(text[j])) return -1;
  if (text[i] === '.' && ABBR.test(text.slice(Math.max(0, i - 6), i))) return -1;
  return j;
}

function snapToSentences(root, start, end) {
  const { text, breaks } = blocksOf(root);
  const lo = Math.max(...breaks.filter((b) => b <= start));
  const hi = Math.min(...breaks.filter((b) => b >= end));
  let s = lo; let e = hi;
  for (let i = start - 1; i >= lo; i--) {
    if (/[.!?]/.test(text[i])) { const j = sentenceEnd(text, i); if (j >= 0 && j <= start) { s = j; break; } }
  }
  for (let i = Math.max(start, end - 1); i < hi; i++) {
    if (/[.!?]/.test(text[i])) { const j = sentenceEnd(text, i); if (j >= 0) { e = j; break; } }
  }
  return text.slice(s, e).replace(/\s+/g, ' ').trim();
}

/** 浮窗放在选区上方（贴着松开鼠标的位置）；太靠顶就放下方 */
function anchorOf(range, clientX) {
  const r = range.getBoundingClientRect();
  const x = Math.min(Math.max(clientX ?? r.left + r.width / 2, r.left), r.right);
  return r.top > 130 ? { x, y: r.top - 8, place: 'above' } : { x, y: r.bottom + 8, place: 'below' };
}

/** 选中文字 / 右键时浮出来的一条小工具：加入长难句，右键时再带上标记、复制或取消标记 */
function SentencePop({ pop, added, onAdd, onMark, onUnmark, onCopy }) {
  const edge = pop.place === 'at' ? 230 : 110;
  const style = {
    left: Math.min(Math.max(pop.x, pop.place === 'at' ? 8 : edge), window.innerWidth - edge),
    top: pop.place === 'at' ? Math.min(pop.y, window.innerHeight - 50) : pop.y,
  };
  return (
    <div className={`erm-pop ${pop.place}`} style={style} role="menu" onMouseDown={(e) => e.preventDefault()}>
      {added
        ? <span className="erm-pop-done">已在长难句里</span>
        : <button className="primary" role="menuitem" title={pop.text} onClick={onAdd}><ToolIcon name="sentence" />加入长难句</button>}
      {pop.menu && !pop.markId && <><i /><button role="menuitem" onClick={onMark}>标记</button><button role="menuitem" onClick={onCopy}>复制</button></>}
      {pop.markId && <><i /><button role="menuitem" onClick={onUnmark}>取消标记</button></>}
    </div>
  );
}

function pointsPath(points, sx = 1, sy = 1, dy = 0) {
  if (!points?.length) return '';
  const p = points.map((x) => ({ x: x.x * sx, y: x.y * sy + dy }));
  if (p.length === 1) return `M ${p[0].x} ${p[0].y} l 0.01 0`;
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i].x + p[i + 1].x) / 2;
    const my = (p[i].y + p[i + 1].y) / 2;
    d += ` Q ${p[i].x} ${p[i].y} ${mx} ${my}`;
  }
  const last = p[p.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function ReadingPassage({ passage }) {
  return passage.map((p, i) => (
    p.html
      ? <div key={i} dangerouslySetInnerHTML={html(p.html)} />
      : <p key={i}>{(p.segs || []).map((seg, j) => (
          typeof seg === 'string'
            ? <span key={j} dangerouslySetInnerHTML={html(seg)} />
            : <span key={j}> ______ </span>
        ))}</p>
  ));
}

function ToolButton({ tool, current, onPick }) {
  const on = current === tool.k;
  return (
    <button type="button" className={`erm-tool${on ? ' on' : ''}`} aria-label={tool.label}
            aria-pressed={on} title={tool.label} onClick={() => onPick(tool.k)}>
      <ToolIcon name={tool.icon} /><span>{tool.label}</span>
    </button>
  );
}

const NO_LAYOUT = { tops: {}, shift: {}, answers: 0 };

/** 题号 → 这题在题目栏里的顶边；shift 是它上面各题「答案 + 解析」一共占的高度 */
function questionLayout(pane, list) {
  if (!pane || !list) return NO_LAYOUT;
  const tops = {}; const shift = {}; let answers = 0;
  for (const el of list.querySelectorAll('.erm-question')) {
    const n = el.dataset.question;
    tops[n] = list.offsetTop + el.offsetTop; shift[n] = answers;
    const a = el.querySelector('.erm-answer');
    if (a) answers += a.offsetHeight + (parseFloat(getComputedStyle(a).marginTop) || 0);
  }
  return { tops, shift, answers };
}

/**
 * 笔迹怎么摆。题目栏的笔迹跟着它写在的那道题走（q / qy），前面的题交卷冒出解析也不会错位。
 * 没记题号的旧笔迹：看它当时的画布高度更像「没有解析」时的，就按它落在哪题整体下移；
 * 否则照旧按画布尺寸缩放。
 */
function strokeFrame(stroke, size, layout) {
  const sx = size.w / Math.max(1, stroke.w || size.w);
  if (stroke.q != null && layout.tops[stroke.q] != null) return { sx, sy: 1, dy: layout.tops[stroke.q] - stroke.qy };
  if (layout.answers > 0 && stroke.h) {
    const bare = size.h - layout.answers;
    if (Math.abs(stroke.h - bare) < Math.abs(stroke.h - size.h)) {
      const y0 = stroke.points?.[0]?.y ?? 0;
      let dy = 0;
      for (const [n, top] of Object.entries(layout.tops)) if (top - layout.shift[n] <= y0) dy = layout.shift[n];
      return { sx, sy: 1, dy };
    }
  }
  return { sx, sy: size.h / Math.max(1, stroke.h || size.h), dy: 0 };
}

const InkLayer = memo(function InkLayer({ scope, size, layout = NO_LAYOUT, strokes, tool, color, onDown, onMove, onUp, onErase, mountPreview }) {
  return (
    <svg className={`erm-ink pane-${scope}`} width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}
         style={{ width: `${size.w}px`, height: `${size.h}px` }}
         onPointerDown={(e) => onDown(scope, e)} onPointerMove={(e) => onMove(scope, e)}
         onPointerUp={(e) => onUp(scope, e)} onPointerCancel={(e) => onUp(scope, e)}>
      {strokes.map((stroke) => {
        const { sx, sy, dy } = strokeFrame(stroke, size, layout);
        const d = pointsPath(stroke.points, sx, sy, dy);
        const avg = stroke.points?.reduce((a, p) => a + (p.p || 0.5), 0) / Math.max(1, stroke.points?.length || 1);
        const width = (stroke.width || 2.2) * (0.75 + avg * 0.55);
        const erase = (e) => onErase(e, stroke.id);
        return (
          <g key={stroke.id}>
            <path d={d} fill="none" stroke={inkHex(stroke.color)} strokeWidth={width}
                  strokeLinecap="round" strokeLinejoin="round" />
            {tool === 'eraser' && <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(18, width + 14)}
                                               pointerEvents="stroke" onPointerDown={erase}
                                               onPointerEnter={(e) => { if (e.buttons === 1) erase(e); }} />}
          </g>
        );
      })}
      <path ref={(el) => mountPreview(scope, el)} d="" fill="none" stroke={color}
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

export default function ExamReadingMode({ examId, section, answers, locked, onChoose, onClose }) {
  const [tool, setTool] = useState('hand');
  const [inkColor, setInkColor] = useState(() => localStorage.getItem('erm-ink-color') || 'ink');
  const [hlColor, setHlColor] = useState(() => localStorage.getItem('erm-hl-color') || 'y');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('erm-font-size')) || 20);
  const [split, setSplit] = useState(() => Number(localStorage.getItem('erm-split')) || 64);
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState('loading');
  const [sizes, setSizes] = useState({ article: { w: 1, h: 1 }, questions: { w: 1, h: 1 } });
  const [qLayout, setQLayout] = useState(NO_LAYOUT); // 题目栏里各题的位置，笔迹跟着题走
  const [activeQ, setActiveQ] = useState(section.questions[0]?.n || 0);
  const [wordToast, setWordToast] = useState(null);
  const [pop, setPop] = useState(null);
  const [cards, setCards] = useState([]); // 这篇里已经进了长难句的句子原文

  const popRef = useRef(null);
  popRef.current = pop;
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const passageRef = useRef(null);
  const articlePaneRef = useRef(null);
  const questionPaneRef = useRef(null);
  const questionListRef = useRef(null);
  const mainRef = useRef(null);
  const previewLineRef = useRef(null);
  const resizeRef = useRef(null);
  const previewPathsRef = useRef({});
  const activeStrokeRef = useRef(null);
  const inkRafRef = useRef(0);
  const latestDataRef = useRef(EMPTY);
  const dirtyRef = useRef(false);
  const closingRef = useRef(false);

  const notifyWord = useCallback((text, kind = '') => {
    const at = Date.now();
    setWordToast({ text, kind, at });
    setTimeout(() => setWordToast((t) => (t?.at === at ? null : t)), 1800);
  }, []);
  const { marks: wordMarks, onDoubleClick: onMarkWord } = useWordMarks(passageRef, true, examId, notifyWord);

  const loadCards = useCallback(() => api.allSentences().then((out) => setCards(out.cards
    .filter((c) => c.kind === 'sentence' && c.examId === examId && c.sectionId === section.id)
    .map((c) => c.text))).catch(() => { /* 只影响虚线提示 */ }), [examId, section.id]);
  useEffect(() => { loadCards(); }, [loadCards]);

  const migrateLegacyStrokes = useCallback((value) => {
    const pane = articlePaneRef.current; const passage = passageRef.current;
    if (!pane || !passage || !value.strokes.some((s) => !s.scope && !s.pane)) return { value, migrated: false };
    const paneRect = pane.getBoundingClientRect(); const passageRect = passage.getBoundingClientRect();
    const ox = passageRect.left - paneRect.left + pane.scrollLeft;
    const oy = passageRect.top - paneRect.top + pane.scrollTop;
    const w = Math.max(1, pane.scrollWidth); const h = Math.max(1, pane.scrollHeight);
    const pw = Math.max(1, passage.clientWidth); const ph = Math.max(1, passage.scrollHeight);
    return {
      migrated: true,
      value: {
        ...value,
        strokes: value.strokes.map((stroke) => {
          if (stroke.scope || stroke.pane) return stroke;
          const sx = pw / Math.max(1, stroke.w || pw); const sy = ph / Math.max(1, stroke.h || ph);
          return { ...stroke, scope: 'article', coordVersion: 2, w, h,
            points: (stroke.points || []).map((p) => ({ ...p, x: ox + p.x * sx, y: oy + p.y * sy })) };
        }),
      },
    };
  }, []);

  useEffect(() => {
    let alive = true; let frame = 0;
    setLoaded(false); setSaveState('loading');
    api.readingAnnotations(examId, section.id).then((out) => {
      frame = requestAnimationFrame(() => {
        if (!alive) return;
        const migrated = migrateLegacyStrokes(normalize(out));
        latestDataRef.current = migrated.value; dirtyRef.current = migrated.migrated;
        setData(migrated.value); setLoaded(true); setSaveState(migrated.migrated ? 'saving' : 'saved');
        undoRef.current = []; redoRef.current = [];
      });
    }).catch(() => { if (alive) { setLoaded(true); setSaveState('error'); } });
    return () => { alive = false; cancelAnimationFrame(frame); };
  }, [examId, migrateLegacyStrokes, section.id]);

  useEffect(() => {
    if (!loaded || !dirtyRef.current) return undefined;
    setSaveState('saving');
    const pending = data;
    const t = setTimeout(() => {
      api.saveReadingAnnotations(examId, section.id, pending)
        .then(() => {
          if (latestDataRef.current === pending) dirtyRef.current = false;
          setSaveState('saved');
        }).catch(() => setSaveState('error'));
    }, 500);
    return () => clearTimeout(t);
  }, [data, examId, loaded, section.id]);

  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = {};
        for (const [scope, ref] of [['article', articlePaneRef], ['questions', questionPaneRef]]) {
          const el = ref.current;
          next[scope] = { w: Math.max(1, el?.scrollWidth || 1), h: Math.max(1, el?.scrollHeight || 1) };
        }
        setSizes((old) => (
          old.article.w === next.article.w && old.article.h === next.article.h
          && old.questions.w === next.questions.w && old.questions.h === next.questions.h ? old : next
        ));
        const layout = questionLayout(questionPaneRef.current, questionListRef.current);
        setQLayout((old) => (JSON.stringify(old) === JSON.stringify(layout) ? old : layout));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    [articlePaneRef.current, articlePaneRef.current?.firstElementChild, questionPaneRef.current, questionListRef.current]
      .filter(Boolean).forEach((el) => ro.observe(el));
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [section.id]);

  useEffect(() => {
    const roots = { article: passageRef.current, questions: questionListRef.current };
    Object.values(roots).forEach(unwrapHighlights);
    const cssHighlights = globalThis.CSS?.highlights;
    const HighlightCtor = globalThis.Highlight;
    HIGHLIGHT_NAMES.forEach((name) => cssHighlights?.delete(name));
    if (cssHighlights && HighlightCtor) {
      const buckets = Object.fromEntries(HL_COLORS.map((x) => [x.k, []]));
      for (const mark of data.highlights) {
        const range = locateMark(roots, mark);
        if (range) (buckets[mark.color] || buckets.y).push(range);
      }
      for (const c of HL_COLORS) if (buckets[c.k].length) {
        cssHighlights.set(`erm-reading-${c.k}`, new HighlightCtor(...buckets[c.k]));
      }
      const added = cards.map((t) => (roots.article && findTextRange(roots.article, t))
        || (roots.questions && findTextRange(roots.questions, t))).filter(Boolean);
      if (added.length) cssHighlights.set('erm-sentence', new HighlightCtor(...added));
      return () => HIGHLIGHT_NAMES.forEach((name) => cssHighlights.delete(name));
    }
    // 极旧 Chromium 的兜底；CSS 已保证 mark 不增加行宽。
    for (const mark of data.highlights) {
      const range = locateMark(roots, mark);
      if (range) wrapRange(range, 'erm-highlight', { id: mark.id, color: mark.color || 'y' });
    }
    return () => Object.values(roots).forEach(unwrapHighlights);
  }, [cards, data.highlights, fontSize, section.id, section.key, wordMarks]);

  const commit = useCallback((makeNext) => {
    setData((current) => {
      const next = normalize(typeof makeNext === 'function' ? makeNext(current) : makeNext);
      undoRef.current = [...undoRef.current.slice(-49), current]; redoRef.current = [];
      latestDataRef.current = next; dirtyRef.current = true;
      return next;
    });
  }, []);
  const undo = useCallback(() => {
    setData((current) => {
      const previous = undoRef.current.pop(); if (!previous) return current;
      redoRef.current.push(current); latestDataRef.current = previous; dirtyRef.current = true; return previous;
    });
  }, []);
  const redo = useCallback(() => {
    setData((current) => {
      const next = redoRef.current.pop(); if (!next) return current;
      undoRef.current.push(current); latestDataRef.current = next; dirtyRef.current = true; return next;
    });
  }, []);

  const closeMode = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (loaded && dirtyRef.current) {
      setSaveState('saving');
      const pending = latestDataRef.current;
      try {
        await api.saveReadingAnnotations(examId, section.id, pending);
        if (latestDataRef.current === pending) dirtyRef.current = false;
      } catch {
        setSaveState('error'); closingRef.current = false; return;
      }
    }
    onClose();
  }, [examId, loaded, onClose, section.id]);

  useEffect(() => {
    document.body.classList.add('erm-open');
    const key = (e) => {
      if (e.key === 'Escape') { if (popRef.current) setPop(null); else closeMode(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', key);
    return () => { document.body.classList.remove('erm-open'); window.removeEventListener('keydown', key); };
  }, [closeMode, redo, undo]);

  const pickInk = (c) => { setInkColor(c); localStorage.setItem('erm-ink-color', c); };
  const pickHighlight = (c) => { setHlColor(c); localStorage.setItem('erm-hl-color', c); };
  const changeFont = (d) => setFontSize((v) => {
    const next = Math.min(24, Math.max(17, v + d)); localStorage.setItem('erm-font-size', next); return next;
  });
  const applySplit = (value) => {
    const next = Math.min(74, Math.max(52, Math.round(value)));
    setSplit(next); localStorage.setItem('erm-split', next);
  };

  const startResize = (e) => {
    if (e.button !== 0 || !mainRef.current) return;
    e.preventDefault();
    const rect = mainRef.current.getBoundingClientRect();
    resizeRef.current = { pointerId: e.pointerId, rect, value: split };
    e.currentTarget.setPointerCapture(e.pointerId);
    mainRef.current.classList.add('resizing');
    if (previewLineRef.current) {
      previewLineRef.current.style.transform = `translate3d(${rect.width * split / 100}px,0,0)`;
      previewLineRef.current.hidden = false;
    }
  };
  const moveResize = (e) => {
    const drag = resizeRef.current; if (!drag || drag.pointerId !== e.pointerId) return;
    drag.value = Math.min(74, Math.max(52, ((e.clientX - drag.rect.left) / drag.rect.width) * 100));
    if (previewLineRef.current) previewLineRef.current.style.transform = `translate3d(${drag.rect.width * drag.value / 100}px,0,0)`;
  };
  const endResize = (e) => {
    const drag = resizeRef.current; if (!drag || drag.pointerId !== e.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    resizeRef.current = null; mainRef.current?.classList.remove('resizing');
    if (previewLineRef.current) previewLineRef.current.hidden = true;
    applySplit(drag.value);
  };

  const rootsNow = () => ({ article: passageRef.current, questions: questionListRef.current });

  /* 记下「要加进长难句的是哪句」：文章里扩到整句；题干 / 选项本来就短，按选中的原样 */
  const offer = useCallback((scope, picked, target, at, extra = {}) => {
    const whole = scope === 'article' && target ? snapToSentences(passageRef.current, target.start, target.end) : picked.text;
    const text = whole.length > 1200 && picked.text.length <= 1200 ? picked.text : whole;
    const qEl = picked.range.startContainer.parentElement?.closest('[data-question]');
    setPop({ ...at, ...extra, scope, text, raw: picked.text, target, q: qEl ? Number(qEl.dataset.question) || null : null });
  }, []);

  const addHighlight = useCallback((scope, target) => {
    const same = (x) => (x.scope || 'article') === scope && x.start === target.start && x.end === target.end
      && x.color === hlColor && (x.part || null) === (target.part || null) && (x.q ?? null) === (target.q ?? null);
    if (data.highlights.some(same)) return;
    commit((d) => ({ ...d, highlights: [...d.highlights, { id: makeId(), scope, ...target, color: hlColor }] }));
  }, [commit, data.highlights, hlColor]);

  const addSelectionAnnotation = useCallback((scope, clientX) => {
    const roots = { article: passageRef.current, questions: questionListRef.current };
    const picked = selectedInside(roots[scope]); if (!picked) return;
    const target = targetOf(roots, scope, picked.range); if (!target) return;
    const at = anchorOf(picked.range, clientX);
    addHighlight(scope, target);
    window.getSelection?.()?.removeAllRanges();
    offer(scope, picked, target, at); // 刚划的这句读不懂，顺手就能加进长难句
  }, [addHighlight, offer]);

  const onTextUp = (scope, e) => {
    if (e.button !== 0 || e.detail > 1) return; // 双击是标生词
    const x = e.clientX;
    if (tool === 'highlight') requestAnimationFrame(() => addSelectionAnnotation(scope, x));
    else if (tool === 'hand') requestAnimationFrame(() => {
      const roots = rootsNow(); const picked = selectedInside(roots[scope]);
      if (picked) offer(scope, picked, targetOf(roots, scope, picked.range), anchorOf(picked.range, x));
    });
  };

  /* 右键：有选区就对选区；没有就看是不是点在一段荧光笔上 */
  const onTextMenu = (scope, e) => {
    if (tool === 'pen' || tool === 'eraser') return;
    const roots = rootsNow();
    const at = { x: e.clientX, y: e.clientY, place: 'at', menu: true };
    const picked = selectedInside(roots[scope]);
    if (picked) { e.preventDefault(); offer(scope, picked, targetOf(roots, scope, picked.range), at); return; }
    const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!caret) return;
    for (const mark of data.highlights) {
      if ((mark.scope || 'article') !== scope) continue;
      const range = locateMark(roots, mark);
      if (!range?.isPointInRange(caret.startContainer, caret.startOffset)) continue;
      e.preventDefault();
      offer(scope, { text: mark.text, range }, targetOf(roots, scope, range), at, { markId: mark.id });
      return;
    }
  };

  const dropPop = () => { if (popRef.current) setPop(null); };
  const addToSentences = async () => {
    const p = pop; setPop(null);
    window.getSelection?.()?.removeAllRanges();
    try {
      const out = await api.addSentence({ text: p.text, examId, sectionId: section.id, q: p.q });
      notifyWord(out.added ? '已加入长难句——到「复习 · 阅读」里拆解它' : '这句已经在长难句里了', 'ok');
      loadCards();
    } catch (err) { notifyWord(err.message, 'err'); }
  };
  const markFromPop = () => {
    const p = pop; setPop(null);
    if (p.target) addHighlight(p.scope, p.target);
    window.getSelection?.()?.removeAllRanges();
  };
  const copyFromPop = () => {
    const p = pop; setPop(null);
    navigator.clipboard?.writeText(p.raw).then(() => notifyWord('已复制'), () => notifyWord('复制失败', 'err'));
  };
  const unmarkFromPop = () => {
    const p = pop; setPop(null);
    commit((d) => ({ ...d, highlights: d.highlights.filter((x) => x.id !== p.markId) }));
  };

  // 点到浮窗外面就收起（这一下本身照常生效：开始新的选区、点选项……）
  useEffect(() => {
    if (!pop) return undefined;
    const off = (e) => { if (!e.target.closest?.('.erm-pop')) setPop(null); };
    window.addEventListener('pointerdown', off, true);
    return () => window.removeEventListener('pointerdown', off, true);
  }, [pop]);

  const pointOf = (e, size) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - box.left) * size.w / Math.max(1, box.width),
      y: (e.clientY - box.top) * size.h / Math.max(1, box.height),
      p: e.pressure || 0.5,
    };
  };
  const mountPreview = useCallback((scope, el) => { previewPathsRef.current[scope] = el; }, []);
  const paintDraft = () => {
    inkRafRef.current = 0;
    const stroke = activeStrokeRef.current; if (!stroke) return;
    previewPathsRef.current[stroke.scope]?.setAttribute('d', pointsPath(stroke.points));
  };
  const inkDown = (scope, e) => {
    if (tool !== 'pen' || e.button !== 0) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const size = sizes[scope];
    const first = pointOf(e, size);
    // 题目栏的笔迹记下写在哪道题上（和那题当时的顶边），之后跟着题走
    let anchor = {};
    if (scope === 'questions') {
      const layout = questionLayout(questionPaneRef.current, questionListRef.current);
      for (const [n, top] of Object.entries(layout.tops)) if (top <= first.y || !anchor.q) anchor = { q: Number(n), qy: top };
    }
    activeStrokeRef.current = { id: makeId(), scope, coordVersion: 2, color: inkColor,
      width: e.pointerType === 'pen' ? 2.5 : 2.2, w: size.w, h: size.h, ...anchor, points: [first] };
    paintDraft();
  };
  const inkMove = (scope, e) => {
    const stroke = activeStrokeRef.current; if (!stroke || stroke.scope !== scope || tool !== 'pen') return;
    const pt = pointOf(e, sizes[scope]); const last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1.4) return;
    stroke.points.push(pt);
    if (!inkRafRef.current) inkRafRef.current = requestAnimationFrame(paintDraft);
  };
  const inkUp = (scope, e) => {
    const stroke = activeStrokeRef.current; if (!stroke || stroke.scope !== scope) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* pointer already released */ }
    cancelAnimationFrame(inkRafRef.current); inkRafRef.current = 0;
    activeStrokeRef.current = null; previewPathsRef.current[scope]?.setAttribute('d', '');
    if (stroke.points.length) commit((d) => ({ ...d, strokes: [...d.strokes, stroke] }));
  };
  const eraseStroke = (e, id) => {
    if (tool !== 'eraser') return;
    e.preventDefault(); e.stopPropagation();
    commit((d) => ({ ...d, strokes: d.strokes.filter((s) => s.id !== id) }));
  };

  const jumpQuestion = (n) => {
    setActiveQ(n);
    questionPaneRef.current?.querySelector(`[data-question="${n}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const strokesBy = (scope) => data.strokes.filter((s) => (s.scope || s.pane || 'article') === scope);
  const currentInk = inkHex(inkColor);
  const highlightValue = HL_COLORS.find((x) => x.k === hlColor)?.value || HL_COLORS[0].value;
  const hasMarks = !!(data.strokes.length || data.highlights.length || data.notes.length);

  const view = (
    <div className={`erm tool-${tool}`} style={{ '--erm-left': `${split}%`, '--erm-font': `${fontSize}px`, '--erm-highlight-color': highlightValue }}>
      <header className="erm-bar">
        <div className="erm-identity">
          <b>{section.title || section.label}</b>
          <span>{section.points != null ? `${section.points} 分` : ''}</span>
          {cards.length > 0 && <span className="erm-count" title="这篇里已经加进长难句的句子，文中画了虚线">长难句 {cards.length}</span>}
        </div>
        <div className="erm-tools" role="toolbar" aria-label="阅读批注工具">
          {TOOLS.map((x) => <ToolButton key={x.k} tool={x} current={tool} onPick={setTool} />)}
          {(tool === 'highlight' || tool === 'pen') && <span className="erm-sep" />}
          {(tool === 'highlight' ? HL_COLORS : tool === 'pen' ? INK_COLORS : []).map((c) => (
            <button key={c.k} type="button" className={`erm-color${(tool === 'highlight' ? hlColor : inkColor) === c.k ? ' on' : ''}`}
                    data-color={c.k} aria-label={c.label} title={c.label}
                    onClick={() => (tool === 'highlight' ? pickHighlight(c.k) : pickInk(c.k))}><i /></button>
          ))}
          <span className="erm-sep" />
          <button className="erm-mini icon" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={!undoRef.current.length} onClick={undo}><ToolIcon name="undo" /></button>
          <button className="erm-mini icon" aria-label="重做" title="重做（Ctrl+Y）" disabled={!redoRef.current.length} onClick={redo}><ToolIcon name="redo" /></button>
        </div>
        <div className="erm-view-tools">
          <button className="erm-mini" onClick={() => changeFont(-1)} title="缩小字号">A−</button>
          <span className="erm-font-value">{fontSize}</span>
          <button className="erm-mini" onClick={() => changeFont(1)} title="放大字号">A+</button>
          <button className="erm-clear" disabled={!hasMarks} onClick={() => commit(EMPTY)} title="清空全部批注">
            <ToolIcon name="trash" /><span>清空</span>
          </button>
          <span className={`erm-save ${saveState}`} aria-live="polite">{saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : saveState === 'loading' ? '读取中' : '已保存'}</span>
          <button className="erm-close" onClick={closeMode}>完成</button>
        </div>
      </header>

      <main className="erm-main" ref={mainRef}>
        <section className="erm-article-pane" ref={articlePaneRef} onScroll={dropPop}>
          <div className="erm-paper">
            {section.directions && (
              <details className="erm-directions">
                <summary>Directions</summary><div dangerouslySetInnerHTML={html(section.directions)} />
              </details>
            )}
            <article className="erm-passage" ref={passageRef}
                     onMouseUp={(e) => onTextUp('article', e)} onContextMenu={(e) => onTextMenu('article', e)}
                     onDoubleClick={tool === 'pen' || tool === 'eraser' ? undefined : onMarkWord}>
              <ReadingPassage passage={section.passage || []} />
            </article>
          </div>
          <InkLayer scope="article" size={sizes.article} strokes={strokesBy('article')} tool={tool} color={currentInk}
                    onDown={inkDown} onMove={inkMove} onUp={inkUp} onErase={eraseStroke} mountPreview={mountPreview} />
        </section>

        <div className="erm-divider" role="separator" aria-label="调整文章与题目宽度" aria-valuemin="52" aria-valuemax="74" aria-valuenow={split}
             tabIndex="0" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}
             onKeyDown={(e) => {
               if (e.key === 'ArrowLeft') { e.preventDefault(); applySplit(split - 2); }
               if (e.key === 'ArrowRight') { e.preventDefault(); applySplit(split + 2); }
             }}>
          <span />
        </div>
        <i className="erm-resize-preview" ref={previewLineRef} hidden />

        <aside className="erm-question-pane" ref={questionPaneRef} onScroll={dropPop}>
          <nav className="erm-qnav">
            <span>题目</span>
            {section.questions.map((q) => (
              <button key={q.n} className={`${activeQ === q.n ? 'on ' : ''}${answers[q.n] ? 'answered' : ''}`}
                      onClick={() => jumpQuestion(q.n)}>{q.n}</button>
            ))}
          </nav>
          <div className="erm-question-list" ref={questionListRef} onMouseUp={(e) => onTextUp('questions', e)}
               onContextMenu={(e) => onTextMenu('questions', e)}>
            {section.questions.map((q) => {
              const mine = answers[q.n]; const right = section.key?.answers?.[q.n];
              return (
                <section key={q.n} data-question={q.n} className="erm-question" onPointerDown={() => setActiveQ(q.n)}>
                  <div className="erm-question-title"><span>{q.n}</span><div dangerouslySetInnerHTML={html(q.stem)} /></div>
                  <div className="erm-options">
                    {q.options.map((o) => {
                      const cls = ['erm-option'];
                      if (mine === o.k) cls.push('on');
                      if (right) { if (right === o.k) cls.push('right'); else if (mine === o.k) cls.push('wrong'); }
                      return <button key={o.k} className={cls.join(' ')} disabled={locked}
                                     onClick={(e) => { if (tool === 'highlight') { e.preventDefault(); return; } onChoose(q.n, o.k); }}>
                        <i>{o.k}</i><span dangerouslySetInnerHTML={html(o.text)} />
                      </button>;
                    })}
                  </div>
                  {right && <div className="erm-answer"><b>答案 {right}</b>
                    {section.key?.explanations?.[q.n] && <div dangerouslySetInnerHTML={html(section.key.explanations[q.n])} />}
                  </div>}
                </section>
              );
            })}
          </div>
          <InkLayer scope="questions" size={sizes.questions} layout={qLayout} strokes={strokesBy('questions')} tool={tool} color={currentInk}
                    onDown={inkDown} onMove={inkMove} onUp={inkUp} onErase={eraseStroke} mountPreview={mountPreview} />
        </aside>
      </main>
      {pop && <SentencePop pop={pop} added={cards.includes(pop.text)} onAdd={addToSentences}
                           onMark={markFromPop} onUnmark={unmarkFromPop} onCopy={copyFromPop} />}
      {wordToast && <div className={`erm-toast ${wordToast.kind}`}>{wordToast.text}</div>}
      {!loaded && <div className="erm-loading">正在打开批注纸…</div>}
    </div>
  );
  return createPortal(view, document.body);
}
