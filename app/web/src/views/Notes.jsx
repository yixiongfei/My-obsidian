import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import Prose from '../components/Prose.jsx';
import MindMap from '../components/MindMap.jsx';
import ReviewBar from '../components/ReviewBar.jsx';
import ReadMode from '../components/ReadMode.jsx';
import FolderTree from '../components/FolderTree.jsx';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';

/* ------------------------------------------------------------------ *
 * 阅读页
 * ------------------------------------------------------------------ */

function Reader({ id, version, onReviewed }) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);
  const reviewRef = useRef(null);
  const [active, setActive] = useState('');
  const [reading, setReading] = useState(false);
  const { data: note, loading, error, reload } = useApi(() => api.note(id), [id, version]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); setReading(false); }, [id]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !note) return undefined;
    const heads = [...root.querySelectorAll('.prose h1, .prose h2, .prose h3, .prose h4')];
    if (!heads.length) return undefined;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 90;
      let cur = heads[0];
      for (const h of heads) if (h.getBoundingClientRect().top <= top) cur = h;
      setActive(cur.id);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [note]);

  if (loading && !note) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!note) return null;

  const jump = (s) => scrollRef.current?.querySelector(`#${CSS.escape(s)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="reader scroll" ref={scrollRef}>
      {reading && note.words > 0 && (
        <ReadMode note={note} onClose={() => setReading(false)} onReviewed={() => { reload(); onReviewed?.(); }} />
      )}
      <div className="reader-inner">
        <div className="reader-article">
          <header className="reader-head">
            <div className="rh-crumb">
              <button onClick={() => navigate('/notes')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>结构图</button>
              {'　/　'}{note.folder || '根目录'}
            </div>
            <div className="rh-title">
              <h1>{note.title}</h1>
              {/* 不再跳去 /review——那儿现在是英语词汇 Anki。
                  深度复习 = 全屏阅读模式：只剩标题和正文，读完在底部记一次 */}
              <button className="btn primary" title="全屏阅读模式，只显示知识本身；Esc 退出"
                      onClick={() => setReading(true)}>
                复习这篇　⤢
              </button>
            </div>
            <div className="reader-meta">
              <span>{note.words} 字</span>
              {note.created && <span>{note.created.replaceAll('-', '.')} 创建</span>}
              <span>复习 {note.reviewCount} 次</span>
              {note.nextReview && (
                <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>
                  下次 {note.nextReview.replaceAll('-', '.')}
                </span>
              )}
            </div>
          </header>

          {note.words === 0
            ? <Empty>这篇笔记还是空的，去 Obsidian 里补充内容吧</Empty>
            : <Prose html={note.html} />}

          <section className="note-review" ref={reviewRef}>
            <div className="band">
              <span className="band-title">REVIEW · 复习记录</span>
              <span className="band-meta">已复习 {note.reviewCount} 次</span>
            </div>
            <div style={{ marginTop: 18 }}>
              <ReviewBar note={note} onDone={() => { reload(); onReviewed?.(); }} />
            </div>
          </section>

          {(note.backlinks.length > 0 || note.outlinks.length > 0) && (
            <div className="linkbar">
              {note.outlinks.map((l) => (
                <button className="tag" key={`o${l.id}`} onClick={() => navigate(`/note/${encodeURIComponent(l.id)}`)}>→ {l.title}</button>
              ))}
              {note.backlinks.map((l) => (
                <button className="tag" key={`b${l.id}`} onClick={() => navigate(`/note/${encodeURIComponent(l.id)}`)}>← {l.title}</button>
              ))}
            </div>
          )}
        </div>

        {note.outline.length > 1 && (
          <nav className="toc">
            <div className="toc-label">目录</div>
            {note.outline.map((h, i) => {
              const s = slug(h.text, note.outline, i);
              return (
                <a key={`${h.text}-${i}`} href={`#${s}`} className={active === s ? 'active' : ''}
                   style={{ paddingLeft: (h.level - 2) * 12 }}
                   onClick={(e) => { e.preventDefault(); jump(s); }}>
                  {h.text.replace(/\$/g, '')}
                </a>
              );
            })}
          </nav>
        )}
      </div>
    </div>
  );
}

/** 与后端 slug() 保持一致，含重名时的 -2 后缀 */
const base = (t) => String(t).trim()
  .replace(/\$[^$]*\$/g, '')
  .replace(/[!?？！。，,.:：、`*_~[\]()#]/g, '')
  .replace(/\s+/g, '-').toLowerCase() || 'h';

function slug(text, outline, index) {
  const b = base(text);
  let n = 0;
  for (let i = 0; i <= index; i++) if (base(outline[i].text) === b) n++;
  return n === 1 ? b : `${b}-${n}`;
}

/* ------------------------------------------------------------------ *
 * 组合
 * ------------------------------------------------------------------ */

export default function Notes({ version, onReviewed }) {
  const { id } = useParams();
  const noteId = id ? decodeURIComponent(id) : null;
  const [open, setOpen] = useState(() => localStorage.getItem('kb-tree') !== 'shut');
  const [filter, setFilter] = useState('');

  const { data: tree } = useApi(() => api.tree(), [version]);
  const { data: mind, loading: mindLoading } = useApi(() => api.mindmap(), [version]);

  useEffect(() => { localStorage.setItem('kb-tree', open ? 'open' : 'shut'); }, [open]);

  const flat = useMemo(() => tree || [], [tree]);

  return (
    <div className={`notes-layout ${open ? 'open' : 'shut'}`}>
      <aside className="tree-pane">
        <div className="tree-head">
          <button className="tree-toggle" onClick={() => setOpen((o) => !o)}
                  title={open ? '折叠侧栏' : '展开侧栏'}>
            <span />
          </button>
          {open && <span className="lbl-cn">目录树</span>}
        </div>

        {open ? (
          <div className="tree-body">
            <div className="tree-search">
              <input className="input" placeholder="筛选…" value={filter}
                     onChange={(e) => setFilter(e.target.value)} />
            </div>
            {!tree ? <Loading /> : <FolderTree tree={flat} activeId={noteId} filter={filter.trim().toLowerCase()} />}
          </div>
        ) : (
          <div className="tree-rail">
            <div className="vert"><span>目录树</span></div>
            <div className="line" />
            <div className="vert" style={{ height: 64 }}>
              <span style={{ color: 'var(--faint)' }}>{mind?.counts.notes ?? ''} NOTES</span>
            </div>
          </div>
        )}
      </aside>

      {noteId
        ? <Reader id={noteId} version={version} onReviewed={onReviewed} />
        : (
          <div className="mind">
            <div className="mind-head">
              <div className="mind-tabs">
                <button className="on">结构</button>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                {mind?.counts.points
                  ? <>考点已学 <b className="fig">{mind.counts.points.learned}</b> / {mind.counts.points.total}
                      {mind.counts.points.today > 0 && <span style={{ color: 'var(--accent)', marginLeft: 12 }}>今日 {mind.counts.points.today}</span>}
                      {mind.counts.points.due > 0 && <span style={{ color: 'var(--due)', marginLeft: 12 }}>{mind.counts.points.due} 待复习</span>}
                      <span className="dim" style={{ marginLeft: 12 }}>点学科 / 分支可折叠</span></>
                  : ''}
              </span>
            </div>

            {mindLoading && !mind ? <Loading /> : mind ? <MindMap data={mind} currentId={noteId} /> : null}

            <div className="mind-foot">
              <span className="lg"><i style={{ width: 8, height: 8, background: 'var(--accent)' }} />今日学习</span>
              <span className="lg"><i style={{ width: 8, height: 8, background: 'var(--due)' }} />待复习</span>
              <span className="lg"><i style={{ width: 7, height: 7, border: '1px solid var(--text-2)' }} />已学 / 已排期</span>
              <span className="lg"><i style={{ width: 7, height: 7, border: '1px solid var(--line-2)' }} />未学考点 / 未纳入</span>
              <span className="lg"><i style={{ width: 8, height: 1, background: 'var(--line-2)' }} />空笔记</span>
              <span className="lg"><i style={{ width: 12, height: 1, background: 'repeating-linear-gradient(90deg,var(--line-2) 0 2px,transparent 2px 7px)' }} />词表已声明 · 待填充</span>
              <span className="lg"><i style={{ width: 5, height: 5, borderRadius: 5, background: 'var(--accent)' }} />未归类到分支</span>
            </div>
          </div>
        )}
    </div>
  );
}
