import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import Prose from '../components/Prose.jsx';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';
import { Icon } from '../components/Icons.jsx';
import ReviewBar from '../components/ReviewBar.jsx';

/* ------------------------------------------------------------------ *
 * 目录树
 * ------------------------------------------------------------------ */

function TreeNode({ node, activeId, filter, depth = 0 }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'note') {
    const active = node.id === activeId;
    const due = node.nextReview && node.nextReview <= new Date().toISOString().slice(0, 10);
    return (
      <div
        className={`tree-row${active ? ' active' : ''}${due ? ' due' : ''}`}
        onClick={() => navigate(`/note/${encodeURIComponent(node.id)}`)}
        title={node.title}
      >
        <span className="tdot" />
        <span className="tw">{node.title}</span>
        {node.empty && <span className="chip" style={{ fontSize: 10, padding: '0 6px' }}>空</span>}
      </div>
    );
  }

  const visible = filter ? countMatches(node, filter) : node.children.length;
  if (filter && visible === 0) return null;

  return (
    <div className="tree-folder">
      <div className="tree-row" onClick={() => setOpen((o) => !o)}>
        <span className={`tri${open || filter ? ' open' : ''}`} />
        <span className="tw">{node.name}</span>
        <span className="chip num" style={{ fontSize: 10, padding: '0 6px' }}>{visible}</span>
      </div>
      <AnimatePresence initial={false}>
        {(open || filter) && (
          <motion.div
            className="tree-children"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {node.children.map((c) => (
              <TreeNode key={c.id || c.path} node={c} activeId={activeId} filter={filter} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function countMatches(node, filter) {
  if (node.type === 'note') return matches(node, filter) ? 1 : 0;
  return node.children.reduce((s, c) => s + countMatches(c, filter), 0);
}
const matches = (n, f) => `${n.title} ${n.id} ${(n.tags || []).join(' ')}`.toLowerCase().includes(f);

function filterTree(nodes, filter) {
  if (!filter) return nodes;
  const out = [];
  for (const n of nodes) {
    if (n.type === 'note') { if (matches(n, filter)) out.push(n); continue; }
    const kids = filterTree(n.children, filter);
    if (kids.length) out.push({ ...n, children: kids });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 阅读页
 * ------------------------------------------------------------------ */

function Reader({ id, version, onReviewed }) {
  const scrollRef = useRef(null);
  const [activeHeading, setActiveHeading] = useState('');
  const { data: note, loading, error, reload } = useApi(() => api.note(id), [id, version], { skip: !id });

  // 切笔记时回到顶部
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [id]);

  // 大纲高亮跟随滚动
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !note) return undefined;
    const heads = [...root.querySelectorAll('.prose h1, .prose h2, .prose h3, .prose h4')];
    if (!heads.length) return undefined;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 90;
      let current = heads[0];
      for (const h of heads) { if (h.getBoundingClientRect().top <= top) current = h; }
      setActiveHeading(current.id);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [note]);

  if (!id) {
    return <div className="empty" style={{ marginTop: '22vh' }}>从左侧选择一篇笔记，或按 <kbd>Ctrl</kbd> <kbd>K</kbd> 搜索</div>;
  }
  if (loading && !note) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!note) return null;

  const jump = (slug) => {
    const el = scrollRef.current?.querySelector(`#${CSS.escape(slug)}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="reader scroll" ref={scrollRef}>
      <div className="reader-inner">
        <div style={{ minWidth: 0 }}>
          <motion.header
            className="reader-head"
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
          >
            <div className="rh-crumb">{note.folder || '根目录'}</div>
            <h1>{note.title}</h1>
            <div className="row" style={{ flexWrap: 'wrap', gap: 7 }}>
              {note.tags.map((t) => <span className="chip blue" key={t}>{t}</span>)}
              <span className="chip num">{note.words} 字</span>
              {note.created && <span className="chip num">{note.created}</span>}
              <span className="chip num">复习 {note.reviewCount} 次</span>
              {note.nextReview && <span className="chip num">下次 {note.nextReview}</span>}
            </div>
          </motion.header>

          {note.words === 0
            ? <Empty>这篇笔记还是空的，去 Obsidian 里补充内容吧</Empty>
            : <Prose html={note.html} />}

          {(note.backlinks.length > 0 || note.outlinks.length > 0) && (
            <div className="linkbar">
              {note.outlinks.map((l) => <LinkChip key={`o-${l.id}`} note={l} dir="→" />)}
              {note.backlinks.map((l) => <LinkChip key={`b-${l.id}`} note={l} dir="←" />)}
            </div>
          )}

          <ReviewBar note={note} onDone={() => { reload(); onReviewed?.(); }} />
        </div>

        {note.outline.length > 1 && (
          <nav className="toc">
            <div className="toc-label">目录</div>
            {note.outline.map((h, i) => (
              <a
                key={`${h.text}-${i}`} data-lv={h.level}
                className={activeHeading === slug(h.text, note.outline, i) ? 'active' : ''}
                onClick={(e) => { e.preventDefault(); jump(slug(h.text, note.outline, i)); }}
                href={`#${slug(h.text, note.outline, i)}`}
              >
                {h.text.replace(/\$/g, '')}
              </a>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

function LinkChip({ note, dir }) {
  const navigate = useNavigate();
  return (
    <button className="chip" onClick={() => navigate(`/note/${encodeURIComponent(note.id)}`)}
            style={{ cursor: 'pointer' }} title={note.id}>
      <span style={{ color: 'var(--blue)' }}>{dir}</span> {note.title}
    </button>
  );
}

/** 与后端 slug() 保持一致，含重名时的 -2 后缀 */
function slug(text, outline, index) {
  const base = String(text).trim()
    .replace(/\$[^$]*\$/g, '')
    .replace(/[!?？！。，,.:：、`*_~[\]()#]/g, '')
    .replace(/\s+/g, '-').toLowerCase() || 'h';
  let n = 0;
  for (let i = 0; i <= index; i++) {
    const other = String(outline[i].text).trim()
      .replace(/\$[^$]*\$/g, '')
      .replace(/[!?？！。，,.:：、`*_~[\]()#]/g, '')
      .replace(/\s+/g, '-').toLowerCase() || 'h';
    if (other === base) n++;
  }
  return n === 1 ? base : `${base}-${n}`;
}

/* ------------------------------------------------------------------ *
 * 组合
 * ------------------------------------------------------------------ */

export default function Notes({ version, onReviewed }) {
  const { id } = useParams();
  const noteId = id ? decodeURIComponent(id) : null;
  const [filter, setFilter] = useState('');
  const { data: tree } = useApi(() => api.tree(), [version]);

  const shown = useMemo(() => filterTree(tree || [], filter.trim().toLowerCase()), [tree, filter]);

  return (
    <div className="notes-layout">
      <aside className="tree-pane">
        <div className="tree-search">
          <input className="input" placeholder="筛选笔记…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        {!tree && <Loading />}
        {tree && shown.length === 0 && <Empty>无匹配</Empty>}
        {shown.map((n) => <TreeNode key={n.id || n.path} node={n} activeId={noteId} filter={filter.trim().toLowerCase()} />)}
      </aside>
      <Reader id={noteId} version={version} onReviewed={onReviewed} />
    </div>
  );
}
