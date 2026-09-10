import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';

const PAGES = [
  { id: '/', title: '仪表盘', kind: 'page' },
  { id: '/notes', title: '笔记', kind: 'page' },
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
    const pages = term ? PAGES.filter((p) => p.title.toLowerCase().includes(term) || p.id.includes(term)) : PAGES;
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

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="overlay"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className="palette"
            initial={{ opacity: 0, y: -14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            <div className="palette-input">
              <Icon.search width={18} height={18} style={{ color: 'var(--blue)' }} />
              <input
                ref={inputRef} value={q} placeholder="搜索笔记、标题、标签…"
                onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
              />
            </div>

            <div className="palette-list">
              {items.length === 0 && <div className="empty">没有匹配结果</div>}
              {items.map((item, i) => (
                <div
                  key={`${item.kind}-${item.id}`}
                  className="palette-item"
                  data-active={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => { e.preventDefault(); go(item); }}
                >
                  <span className="chip blue">{item.kind === 'page' ? '页面' : item.tags?.[0] || '笔记'}</span>
                  <div className="pi-body">
                    <div className="pi-title">{item.title}</div>
                    {item.snippet && <div className="pi-snip">{item.snippet}</div>}
                  </div>
                  {item.hits > 0 && <span className="chip num">{item.hits}</span>}
                </div>
              ))}
            </div>

            <div className="palette-foot">
              <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
              <span><kbd>↵</kbd> 打开</span>
              <span><kbd>esc</kbd> 关闭</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
