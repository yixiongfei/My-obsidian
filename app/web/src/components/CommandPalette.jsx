import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const PAGES = [
  { id: '/', title: '仪表盘', kind: 'page' },
  { id: '/notes', title: '笔记 · 结构图', kind: 'page' },
  { id: '/review', title: '复习', kind: 'page' },
  { id: '/schedule', title: '日程', kind: 'page' },
];

export default function CommandPalette({ open, onClose }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) { setQ(''); setHits([]); setCursor(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (!term) { setHits([]); return undefined; }
    const t = setTimeout(() => {
      api.search(term).then((r) => { setHits(r); setCursor(0); }).catch(() => setHits([]));
    }, 110);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    const pages = term ? PAGES.filter((p) => p.title.toLowerCase().includes(term)) : PAGES;
    return [...pages, ...hits.map((h) => ({ ...h, kind: 'note' }))];
  }, [q, hits]);

  const go = (item) => {
    if (!item) return;
    onClose();
    navigate(item.kind === 'page' ? item.id : `/note/${encodeURIComponent(item.id)}`);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); go(items[cursor]); }
  };

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          <span className="lbl-cn" style={{ color: 'var(--blue)' }}>搜索</span>
          <input ref={inputRef} value={q} placeholder="笔记标题、标签、正文…"
                 onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} />
        </div>

        <div className="palette-list">
          {items.length === 0 && <div className="empty">没有匹配结果</div>}
          {items.map((item, i) => (
            <div key={`${item.kind}-${item.id}`} className="palette-item" data-active={i === cursor}
                 onMouseEnter={() => setCursor(i)}
                 onMouseDown={(e) => { e.preventDefault(); go(item); }}>
              <span className="pi-ord">{String(i + 1).padStart(2, '0')}</span>
              <div className="pi-body">
                <div className="pi-title">{item.title}</div>
                {item.snippet && <div className="pi-snip">{item.snippet}</div>}
              </div>
              <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                {item.kind === 'page' ? '页面' : item.hits > 0 ? `${item.hits} 处` : item.tags?.filter((t) => t !== '考研')[0] || ''}
              </span>
            </div>
          ))}
        </div>

        <div className="palette-foot">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  );
}
