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
const HIGHLIGHT_NAMES = HL_COLORS.map((x) => `erm-reading-${x.k}`);

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

function offsetsOf(root, range) {
  try {
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const selected = range.toString();
    return { start: before.toString().length, end: before.toString().length + selected.length };
  } catch { return null; }
}

function rangeAtOffsets(root, start, end) {
  if (!root || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('textarea, input') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let at = 0; let first = null; let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const next = at + node.nodeValue.length;
    if (!first && start >= at && start <= next) first = [node, Math.min(node.nodeValue.length, start - at)];
    if (end >= at && end <= next) { last = [node, Math.min(node.nodeValue.length, end - at)]; break; }
    at = next;
  }
  if (!first || !last) return null;
  try {
    const range = document.createRange();
    range.setStart(first[0], first[1]); range.setEnd(last[0], last[1]);
    return range;
  } catch { return null; }
}

function pointsPath(points, sx = 1, sy = 1) {
  if (!points?.length) return '';
  const p = points.map((x) => ({ x: x.x * sx, y: x.y * sy }));
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

const InkLayer = memo(function InkLayer({ scope, size, strokes, tool, color, onDown, onMove, onUp, onErase, mountPreview }) {
  return (
    <svg className={`erm-ink pane-${scope}`} width={size.w} height={size.h} viewBox={`0 0 ${size.w} ${size.h}`}
         style={{ width: `${size.w}px`, height: `${size.h}px` }}
         onPointerDown={(e) => onDown(scope, e)} onPointerMove={(e) => onMove(scope, e)}
         onPointerUp={(e) => onUp(scope, e)} onPointerCancel={(e) => onUp(scope, e)}>
      {strokes.map((stroke) => {
        const sx = size.w / Math.max(1, stroke.w || size.w);
        const sy = size.h / Math.max(1, stroke.h || size.h);
        const d = pointsPath(stroke.points, sx, sy);
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
  const [activeQ, setActiveQ] = useState(section.questions[0]?.n || 0);
  const [wordToast, setWordToast] = useState(null);

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
        const root = roots[mark.scope || 'article'];
        if (!root) continue;
        const range = Number.isFinite(mark.start) ? rangeAtOffsets(root, mark.start, mark.end) : findTextRange(root, mark.text);
        if (range) (buckets[mark.color] || buckets.y).push(range);
      }
      for (const c of HL_COLORS) if (buckets[c.k].length) {
        cssHighlights.set(`erm-reading-${c.k}`, new HighlightCtor(...buckets[c.k]));
      }
      return () => HIGHLIGHT_NAMES.forEach((name) => cssHighlights.delete(name));
    }
    // 极旧 Chromium 的兜底；CSS 已保证 mark 不增加行宽。
    for (const mark of data.highlights) {
      const root = roots[mark.scope || 'article'];
      const range = root && (Number.isFinite(mark.start) ? rangeAtOffsets(root, mark.start, mark.end) : findTextRange(root, mark.text));
      if (range) wrapRange(range, 'erm-highlight', { id: mark.id, color: mark.color || 'y' });
    }
    return () => Object.values(roots).forEach(unwrapHighlights);
  }, [data.highlights, fontSize, section.id, wordMarks]);

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
      if (e.key === 'Escape') closeMode();
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

  const addSelectionAnnotation = useCallback((scope) => {
    const root = scope === 'article' ? passageRef.current : questionListRef.current;
    const picked = selectedInside(root); if (!picked) return;
    const offsets = offsetsOf(root, picked.range); if (!offsets) return;
    if (!data.highlights.some((x) => (x.scope || 'article') === scope && x.start === offsets.start && x.end === offsets.end && x.color === hlColor)) {
      commit((d) => ({ ...d, highlights: [...d.highlights, {
        id: makeId(), scope, text: picked.text, start: offsets.start, end: offsets.end, color: hlColor,
      }] }));
    }
    window.getSelection?.()?.removeAllRanges();
  }, [commit, data.highlights, hlColor]);
  const onTextUp = (scope, e) => {
    if (tool !== 'highlight' || e.detail > 1) return;
    requestAnimationFrame(() => addSelectionAnnotation(scope));
  };

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
    activeStrokeRef.current = { id: makeId(), scope, coordVersion: 2, color: inkColor,
      width: e.pointerType === 'pen' ? 2.5 : 2.2, w: size.w, h: size.h, points: [pointOf(e, size)] };
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
        <section className="erm-article-pane" ref={articlePaneRef}>
          <div className="erm-paper">
            {section.directions && (
              <details className="erm-directions">
                <summary>Directions</summary><div dangerouslySetInnerHTML={html(section.directions)} />
              </details>
            )}
            <article className="erm-passage" ref={passageRef}
                     onMouseUp={(e) => onTextUp('article', e)}
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

        <aside className="erm-question-pane" ref={questionPaneRef}>
          <nav className="erm-qnav">
            <span>题目</span>
            {section.questions.map((q) => (
              <button key={q.n} className={`${activeQ === q.n ? 'on ' : ''}${answers[q.n] ? 'answered' : ''}`}
                      onClick={() => jumpQuestion(q.n)}>{q.n}</button>
            ))}
          </nav>
          <div className="erm-question-list" ref={questionListRef} onMouseUp={(e) => onTextUp('questions', e)}>
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
          <InkLayer scope="questions" size={sizes.questions} strokes={strokesBy('questions')} tool={tool} color={currentInk}
                    onDown={inkDown} onMove={inkMove} onUp={inkUp} onErase={eraseStroke} mountPreview={mountPreview} />
        </aside>
      </main>
      {wordToast && <div className={`erm-toast ${wordToast.kind}`}>{wordToast.text}</div>}
      {!loaded && <div className="erm-loading">正在打开批注纸…</div>}
    </div>
  );
  return createPortal(view, document.body);
}
