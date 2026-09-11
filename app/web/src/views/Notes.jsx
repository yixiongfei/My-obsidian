import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import Prose from '../components/Prose.jsx';
import ReviewBar from '../components/ReviewBar.jsx';
import MindMap from '../components/MindMap.jsx';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';

/* ------------------------------------------------------------------ *
 * 侧栏：可折叠的目录树
 * ------------------------------------------------------------------ */

function Tree({ tree, activeId, filter }) {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const walk = (nodes, depth = 0) => nodes.flatMap((n) => {
    if (n.type === 'folder') {
      const kids = walk(n.children, depth + 1);
      if (!kids.length) return [];
      // 只有子目录、没有直属笔记的中间层级不单独出标题，省掉「数学 0」这种空行
      const own = n.children.filter((c) => c.type === 'note').length;
      if (!own) return kids;
      return [
        <div className="tree-group" key={n.path}>
          <span>{n.path}</span><span className="c">{own}</span>
        </div>,
        ...kids,
      ];
    }
    if (filter && !`${n.title} ${n.id} ${(n.tags || []).join(' ')}`.toLowerCase().includes(filter)) return [];
    const due = n.nextReview && n.nextReview <= today;
    return [
      <div key={n.id} title={n.title}
           className={`tree-note${n.id === activeId ? ' active' : ''}`}
           onClick={() => navigate(`/note/${encodeURIComponent(n.id)}`)}>
        <span className="tw">{n.title}</span>
        {due && <span style={{ width: 6, height: 6, background: 'var(--blue)', flex: 'none' }} />}
        {n.empty && <span style={{ fontSize: 10, color: 'var(--dim)' }}>空</span>}
      </div>,
    ];
  });

  const root = tree.filter((n) => n.type === 'note');
  return (
    <>
      {walk(tree.filter((n) => n.type === 'folder'))}
      {root.length > 0 && (
        <>
          <div className="tree-group"><span>根目录</span><span className="c">{root.length}</span></div>
          {walk(root)}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 阅读页
 * ------------------------------------------------------------------ */

function Reader({ id, version, onReviewed }) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);
  const [active, setActive] = useState('');
  const { data: note, loading, error, reload } = useApi(() => api.note(id), [id, version]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [id]);

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
      <div className="reader-inner">
        <div style={{ minWidth: 0 }}>
          <header className="reader-head">
            <div className="rh-crumb">
              <button onClick={() => navigate('/notes')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>结构图</button>
              {'　/　'}{note.folder || '根目录'}
            </div>
            <h1>{note.title}</h1>
            <div className="reader-meta">
              <span>{note.words} 字</span>
              {note.created && <span>{note.created.replaceAll('-', '.')} 创建</span>}
              <span>复习 {note.reviewCount} 次</span>
              {note.nextReview && (
                <span style={{ marginLeft: 'auto', color: 'var(--blue)' }}>
                  下次 {note.nextReview.replaceAll('-', '.')}
                </span>
              )}
            </div>
          </header>

          {note.words === 0
            ? <Empty>这篇笔记还是空的，去 Obsidian 里补充内容吧</Empty>
            : <Prose html={note.html} />}

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

          <ReviewBar note={note} onDone={() => { reload(); onReviewed?.(); }} />
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
            {!tree ? <Loading /> : <Tree tree={flat} activeId={noteId} filter={filter.trim().toLowerCase()} />}
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
                {mind ? `按 tags.yaml 受控词表　·　${mind.counts.emptyBranches} 个考点尚无笔记` : ''}
              </span>
            </div>

            {mindLoading && !mind ? <Loading /> : mind ? <MindMap data={mind} currentId={noteId} /> : null}

            <div className="mind-foot">
              <span className="lg"><i style={{ width: 8, height: 8, background: 'var(--blue)' }} />待复习</span>
              <span className="lg"><i style={{ width: 7, height: 7, border: '1px solid var(--text-2)' }} />已排期</span>
              <span className="lg"><i style={{ width: 7, height: 7, border: '1px solid var(--faint)' }} />未纳入</span>
              <span className="lg"><i style={{ width: 8, height: 1, background: 'var(--faint)' }} />空笔记</span>
              <span className="lg"><i style={{ width: 12, height: 1, background: 'repeating-linear-gradient(90deg,var(--faint) 0 2px,transparent 2px 7px)' }} />词表已声明 · 待填充</span>
              <span className="lg"><i style={{ width: 5, height: 5, borderRadius: 5, background: 'var(--blue)' }} />未归类到分支</span>
              <span style={{ marginLeft: 'auto' }}>点击节点进入笔记　·　拖拽平移　·　滚轮缩放</span>
            </div>
          </div>
        )}
    </div>
  );
}
