import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { findTextRange, wrapRange } from '../wordmarks.js';

const EMPTY = { strokes: [], highlights: [], notes: [] };
const TOOLS = [
  { k: 'hand', label: '手形', mark: '↕' },
  { k: 'highlight', label: '标记', mark: '▰' },
  { k: 'pen', label: '画笔', mark: '✎' },
  { k: 'translate', label: '翻译', mark: '译' },
  { k: 'eraser', label: '橡皮', mark: '⌫' },
];
const INK_COLORS = [
  { k: 'ink', label: '墨色', value: '#263044' },
  { k: 'red', label: '红色', value: '#D8524B' },
  { k: 'blue', label: '蓝色', value: '#3F70C9' },
];
const HL_COLORS = [
  { k: 'y', label: '黄色' }, { k: 'g', label: '绿色' }, { k: 'b', label: '蓝色' }, { k: 'p', label: '粉色' },
];

const html = (s) => ({ __html: s || '' });
const makeId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const normalize = (v) => ({
  strokes: Array.isArray(v?.strokes) ? v.strokes : [],
  highlights: Array.isArray(v?.highlights) ? v.highlights : [],
  notes: Array.isArray(v?.notes) ? v.notes : [],
});

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
  return { text, range: range.cloneRange(), rect: range.getBoundingClientRect() };
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
  return (
    <button className={`erm-tool${current === tool.k ? ' on' : ''}`} title={tool.label} onClick={() => onPick(tool.k)}>
      <i>{tool.mark}</i><span>{tool.label}</span>
    </button>
  );
}

function TranslationEditor({ draft, onChange, onSave, onCancel }) {
  return (
    <div className="erm-note erm-note-edit" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}>
      <div className="erm-note-quote">{draft.quote}</div>
      <textarea autoFocus value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })}
                placeholder="写下这句话的翻译…" onKeyDown={(e) => {
                  if (e.key === 'Escape') onCancel();
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSave();
                }} />
      <div className="erm-note-actions">
        <button onClick={onCancel}>取消</button><button className="primary" onClick={onSave}>保存</button>
      </div>
    </div>
  );
}

export default function ExamReadingMode({ examId, section, answers, locked, onChoose, onClose }) {
  const [tool, setTool] = useState('hand');
  const [inkColor, setInkColor] = useState(() => localStorage.getItem('erm-ink-color') || 'ink');
  const [hlColor, setHlColor] = useState(() => localStorage.getItem('erm-hl-color') || 'y');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('erm-font-size')) || 20);
  const [split, setSplit] = useState(() => Number(localStorage.getItem('erm-split')) || 64);
  const [data, setData] = useState(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState('loading');
  const [surface, setSurface] = useState({ w: 1, h: 1 });
  const [draftStroke, setDraftStroke] = useState(null);
  const [noteDraft, setNoteDraft] = useState(null);
  const [activeQ, setActiveQ] = useState(section.questions[0]?.n || 0);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const passageRef = useRef(null);
  const surfaceRef = useRef(null);
  const questionRef = useRef(null);
  const latestDataRef = useRef(EMPTY);
  const dirtyRef = useRef(false);
  const closingRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false); setSaveState('loading');
    api.readingAnnotations(examId, section.id).then((out) => {
      if (!alive) return;
      const next = normalize(out);
      latestDataRef.current = next; dirtyRef.current = false;
      setData(next); setLoaded(true); setSaveState('saved');
      undoRef.current = []; redoRef.current = [];
    }).catch(() => { if (alive) { setLoaded(true); setSaveState('error'); } });
    return () => { alive = false; };
  }, [examId, section.id]);

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
    const el = surfaceRef.current;
    if (!el) return undefined;
    const measure = () => setSurface({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.scrollHeight) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fontSize, split, section.id]);

  useLayoutEffect(() => {
    const root = passageRef.current;
    if (!root) return;
    unwrapHighlights(root);
    for (const mark of data.highlights) {
      const range = findTextRange(root, mark.text);
      if (range) wrapRange(range, 'erm-highlight', { id: mark.id, color: mark.color || 'y' });
    }
  }, [data.highlights, fontSize, section.id]);

  const commit = useCallback((makeNext) => {
    setData((current) => {
      const next = normalize(typeof makeNext === 'function' ? makeNext(current) : makeNext);
      undoRef.current = [...undoRef.current.slice(-49), current];
      redoRef.current = [];
      latestDataRef.current = next;
      dirtyRef.current = true;
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setData((current) => {
      const previous = undoRef.current.pop();
      if (!previous) return current;
      redoRef.current.push(current);
      latestDataRef.current = previous;
      dirtyRef.current = true;
      return previous;
    });
  }, []);
  const redo = useCallback(() => {
    setData((current) => {
      const next = redoRef.current.pop();
      if (!next) return current;
      undoRef.current.push(current);
      latestDataRef.current = next;
      dirtyRef.current = true;
      return next;
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
        setSaveState('error');
        closingRef.current = false;
        return;
      }
    }
    onClose();
  }, [examId, loaded, onClose, section.id]);

  useEffect(() => {
    document.body.classList.add('erm-open');
    const key = (e) => {
      if (e.key === 'Escape' && !noteDraft) closeMode();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (e.code === 'Space' && !e.repeat && !e.target.closest?.('textarea, input')) setTool('hand');
    };
    window.addEventListener('keydown', key);
    return () => { document.body.classList.remove('erm-open'); window.removeEventListener('keydown', key); };
  }, [closeMode, noteDraft, redo, undo]);

  const pickInk = (c) => { setInkColor(c); localStorage.setItem('erm-ink-color', c); };
  const pickHighlight = (c) => { setHlColor(c); localStorage.setItem('erm-hl-color', c); };
  const changeFont = (d) => setFontSize((v) => {
    const next = Math.min(24, Math.max(17, v + d)); localStorage.setItem('erm-font-size', next); return next;
  });
  const changeSplit = (v) => { setSplit(v); localStorage.setItem('erm-split', v); };

  const addSelectionAnnotation = useCallback((kind) => {
    const picked = selectedInside(passageRef.current);
    if (!picked) return;
    if (kind === 'highlight') {
      if (!data.highlights.some((x) => x.text === picked.text && x.color === hlColor)) {
        commit((d) => ({ ...d, highlights: [...d.highlights, { id: makeId(), text: picked.text, color: hlColor }] }));
      }
      window.getSelection?.()?.removeAllRanges();
      return;
    }
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.min(0.72, Math.max(0.02, (picked.rect.left - box.left) / box.width));
    const y = Math.min(0.94, Math.max(0.01, (picked.rect.bottom - box.top) / Math.max(1, box.height)));
    setNoteDraft({ id: null, quote: picked.text, text: '', x, y });
    window.getSelection?.()?.removeAllRanges();
  }, [commit, data.highlights, hlColor]);

  const onTextUp = () => {
    if (tool !== 'highlight' && tool !== 'translate') return;
    requestAnimationFrame(() => addSelectionAnnotation(tool));
  };

  const pointOf = (e) => {
    const b = surfaceRef.current.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top, p: e.pressure || 0.5 };
  };
  const inkDown = (e) => {
    if (tool !== 'pen' || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraftStroke({ id: makeId(), color: inkColor, width: e.pointerType === 'pen' ? 2.5 : 2.2,
      w: surface.w, h: surface.h, points: [pointOf(e)] });
  };
  const inkMove = (e) => {
    if (!draftStroke || tool !== 'pen') return;
    const pt = pointOf(e);
    setDraftStroke((s) => {
      const last = s.points[s.points.length - 1];
      return Math.hypot(pt.x - last.x, pt.y - last.y) < 1.4 ? s : { ...s, points: [...s.points, pt] };
    });
  };
  const inkUp = (e) => {
    if (!draftStroke) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* pointer already released */ }
    const done = draftStroke;
    setDraftStroke(null);
    if (done.points.length) commit((d) => ({ ...d, strokes: [...d.strokes, done] }));
  };
  const eraseStroke = (e, id) => {
    if (tool !== 'eraser') return;
    e.preventDefault(); e.stopPropagation();
    commit((d) => ({ ...d, strokes: d.strokes.filter((s) => s.id !== id) }));
  };

  const saveNote = () => {
    if (!noteDraft?.text.trim()) { setNoteDraft(null); return; }
    const item = { ...noteDraft, id: noteDraft.id || makeId(), text: noteDraft.text.trim() };
    commit((d) => ({ ...d, notes: [...d.notes.filter((n) => n.id !== item.id), item] }));
    setNoteDraft(null);
  };

  const jumpQuestion = (n) => {
    setActiveQ(n);
    questionRef.current?.querySelector(`[data-question="${n}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const inkValue = INK_COLORS.find((c) => c.k === inkColor)?.value || INK_COLORS[0].value;
  const hasMarks = data.strokes.length || data.highlights.length || data.notes.length;

  const view = (
    <div className="erm" style={{ '--erm-left': `${split}%`, '--erm-font': `${fontSize}px` }}>
      <header className="erm-bar">
        <div className="erm-identity">
          <b>{section.title || section.label}</b>
          <span>{section.points != null ? `${section.points} 分` : ''}</span>
        </div>
        <div className="erm-tools" role="toolbar" aria-label="阅读批注工具">
          {TOOLS.map((x) => <ToolButton key={x.k} tool={x} current={tool} onPick={setTool} />)}
          <span className="erm-sep" />
          {(tool === 'highlight' ? HL_COLORS : INK_COLORS).map((c) => (
            <button key={c.k} className={`erm-color${(tool === 'highlight' ? hlColor : inkColor) === c.k ? ' on' : ''}`}
                    data-color={c.k} title={c.label}
                    onClick={() => (tool === 'highlight' ? pickHighlight(c.k) : pickInk(c.k))} />
          ))}
          <span className="erm-sep" />
          <button className="erm-mini" title="撤销（Ctrl+Z）" disabled={!undoRef.current.length} onClick={undo}>↶</button>
          <button className="erm-mini" title="重做（Ctrl+Y）" disabled={!redoRef.current.length} onClick={redo}>↷</button>
        </div>
        <div className="erm-view-tools">
          <button className="erm-mini" onClick={() => changeFont(-1)} title="缩小字号">A−</button>
          <span className="erm-font-value">{fontSize}</span>
          <button className="erm-mini" onClick={() => changeFont(1)} title="放大字号">A+</button>
          {hasMarks ? <button className="erm-clear" onClick={() => {
            if (window.confirm('清空这篇阅读的全部批注？答案不会被清除。')) commit(EMPTY);
          }}>清空批注</button> : null}
          <span className={`erm-save ${saveState}`}>{saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : saveState === 'loading' ? '读取中' : '已保存'}</span>
          <button className="erm-close" onClick={closeMode}>完成</button>
        </div>
      </header>

      <main className="erm-main">
        <section className="erm-article-pane">
          <div className="erm-paper">
            {section.directions && (
              <details className="erm-directions">
                <summary>Directions</summary>
                <div dangerouslySetInnerHTML={html(section.directions)} />
              </details>
            )}
            <div className={`erm-surface tool-${tool}`} ref={surfaceRef} onPointerUp={onTextUp}>
              <article className="erm-passage" ref={passageRef}>
                <ReadingPassage passage={section.passage || []} />
              </article>
              <svg className="erm-ink" width={surface.w} height={surface.h} viewBox={`0 0 ${surface.w} ${surface.h}`}
                   onPointerDown={inkDown} onPointerMove={inkMove} onPointerUp={inkUp} onPointerCancel={inkUp}>
                {data.strokes.map((stroke) => {
                  const sx = surface.w / Math.max(1, stroke.w || surface.w);
                  const sy = surface.h / Math.max(1, stroke.h || surface.h);
                  const d = pointsPath(stroke.points, sx, sy);
                  const color = INK_COLORS.find((c) => c.k === stroke.color)?.value || INK_COLORS[0].value;
                  const avg = stroke.points?.reduce((a, p) => a + (p.p || 0.5), 0) / Math.max(1, stroke.points?.length || 1);
                  const width = (stroke.width || 2.2) * (0.75 + avg * 0.55);
                  return (
                    <g key={stroke.id}>
                      <path d={d} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />
                      {tool === 'eraser' && <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(16, width + 12)}
                                                   pointerEvents="stroke" onPointerDown={(e) => eraseStroke(e, stroke.id)} />}
                    </g>
                  );
                })}
                {draftStroke && <path d={pointsPath(draftStroke.points)} fill="none" stroke={inkValue}
                                      strokeWidth={draftStroke.width} strokeLinecap="round" strokeLinejoin="round" />}
              </svg>

              {data.notes.map((note) => (
                <div key={note.id} className="erm-note" style={{ left: `${note.x * 100}%`, top: `${note.y * 100}%` }}>
                  <button className="erm-note-x" title="删除翻译" onClick={() => commit((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== note.id) }))}>×</button>
                  <div className="erm-note-quote">{note.quote}</div>
                  <button className="erm-note-text" title="双击编辑" onDoubleClick={() => setNoteDraft({ ...note })}>{note.text}</button>
                </div>
              ))}
              {noteDraft && <TranslationEditor draft={noteDraft} onChange={setNoteDraft} onSave={saveNote} onCancel={() => setNoteDraft(null)} />}
            </div>
          </div>
        </section>

        <div className="erm-divider">
          <input aria-label="调整文章与题目宽度" type="range" min="52" max="74" value={split}
                 onChange={(e) => changeSplit(Number(e.target.value))} />
        </div>

        <aside className="erm-question-pane" ref={questionRef}>
          <nav className="erm-qnav">
            <span>题目</span>
            {section.questions.map((q) => (
              <button key={q.n} className={`${activeQ === q.n ? 'on ' : ''}${answers[q.n] ? 'answered' : ''}`}
                      onClick={() => jumpQuestion(q.n)}>{q.n}</button>
            ))}
          </nav>
          <div className="erm-question-list">
            {section.questions.map((q) => {
              const mine = answers[q.n];
              const right = section.key?.answers?.[q.n];
              return (
                <section key={q.n} data-question={q.n} className="erm-question" onPointerDown={() => setActiveQ(q.n)}>
                  <div className="erm-question-title"><span>{q.n}</span><div dangerouslySetInnerHTML={html(q.stem)} /></div>
                  <div className="erm-options">
                    {q.options.map((o) => {
                      const cls = ['erm-option'];
                      if (mine === o.k) cls.push('on');
                      if (right) {
                        if (right === o.k) cls.push('right');
                        else if (mine === o.k) cls.push('wrong');
                      }
                      return <button key={o.k} className={cls.join(' ')} disabled={locked} onClick={() => onChoose(q.n, o.k)}>
                        <i>{o.k}</i><span dangerouslySetInnerHTML={html(o.text)} />
                      </button>;
                    })}
                  </div>
                  {right && <div className="erm-answer">
                    <b>答案 {right}</b>
                    {section.key?.explanations?.[q.n] && <div dangerouslySetInnerHTML={html(section.key.explanations[q.n])} />}
                  </div>}
                </section>
              );
            })}
          </div>
        </aside>
      </main>
      {!loaded && <div className="erm-loading">正在打开批注纸…</div>}
    </div>
  );
  return createPortal(view, document.body);
}
