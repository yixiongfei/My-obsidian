import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 笔记目录树：Obsidian 那种可折叠的文件树，一级目录各有一条学科色边。
 *
 * - 一级目录是一张卡，左侧色条按学科取色（数学琥珀、英语青、408 玫红……），
 *   其余目录按顺序轮换六色；颜色变量定义在 base.css，两套主题各一组
 * - 任意层级都能折叠；折叠状态记在 localStorage，默认全部展开
 * - 当前笔记所在的路径会自动展开
 * - 筛选时只留命中的笔记，目录全部强制展开
 */

/** 学科 → 色号；没登记的目录按出现顺序轮换 */
const HUE_BY_NAME = { 数学: 1, 408: 2, 英语: 3, 图像: 4, 个人: 6, 政治: 5 };
export function hueOf(name, index = 0) {
  return HUE_BY_NAME[name] || ((index % 6) + 1);
}

const KEY = 'kb-tree-fold';
const loadFold = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return new Set(); } };

const countNotes = (node) => node.children.reduce((s, c) => s + (c.type === 'note' ? 1 : countNotes(c)), 0);

const Caret = () => <i className="ft-caret" />;
const FolderIcon = () => (
  <svg className="ft-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);
const NoteIcon = () => (
  <svg className="ft-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /><path d="M9 13h7M9 17h5" strokeLinecap="round" />
  </svg>
);

export default function FolderTree({ tree, activeId, filter }) {
  const navigate = useNavigate();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [fold, setFold] = useState(loadFold);

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify([...fold])); }, [fold]);

  // 打开一篇笔记时把它所在的目录链全部展开
  useEffect(() => {
    if (!activeId) return;
    const parts = activeId.split('/').slice(0, -1);
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    setFold((f) => {
      if (!chain.some((p) => f.has(p))) return f;
      const next = new Set(f);
      chain.forEach((p) => next.delete(p));
      return next;
    });
  }, [activeId]);

  const toggle = useCallback((p) => setFold((f) => {
    const next = new Set(f);
    next.has(p) ? next.delete(p) : next.add(p);
    return next;
  }), []);

  const match = (n) => !filter || `${n.title} ${n.id} ${(n.tags || []).join(' ')}`.toLowerCase().includes(filter);

  const renderNote = (n, depth) => (
    <button key={n.id} title={n.title}
            className={`ft-note${n.id === activeId ? ' active' : ''}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => navigate(`/note/${encodeURIComponent(n.id)}`)}>
      <NoteIcon />
      <span className="ft-name">{n.title}</span>
      {n.nextReview && n.nextReview <= today && <i className="ft-due" title="待复习" />}
      {n.empty && <span className="ft-empty">空</span>}
    </button>
  );

  /** 返回 [元素, 命中的笔记数]；筛选时没命中的目录整个不出 */
  const renderFolder = (node, depth) => {
    const kids = [];
    let hits = 0;
    for (const c of node.children) {
      if (c.type === 'folder') {
        const [el, h] = renderFolder(c, depth + 1);
        if (h) { kids.push(el); hits += h; }
      } else if (match(c)) {
        kids.push(renderNote(c, depth + 1));
        hits += 1;
      }
    }
    if (!hits) return [null, 0];
    const open = filter ? true : !fold.has(node.path);
    const el = (
      <div key={node.path} className={`ft-folder${open ? ' open' : ''}`}>
        <button className="ft-folder-h" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggle(node.path)}>
          <Caret />
          <FolderIcon />
          <span className="ft-name">{node.name}</span>
          <span className="ft-count fig">{filter ? hits : countNotes(node)}</span>
        </button>
        {open && <div className="ft-kids">{kids}</div>}
      </div>
    );
    return [el, hits];
  };

  const hitsOf = (node) => node.children.reduce((s, c) => s + (c.type === 'folder' ? hitsOf(c) : (match(c) ? 1 : 0)), 0);
  const folders = tree.filter((n) => n.type === 'folder');
  const rootNotes = tree.filter((n) => n.type === 'note' && match(n));

  return (
    <div className="ft">
      {folders.map((node, i) => {
        const hits = hitsOf(node);
        if (!hits) return null;
        const open = filter ? true : !fold.has(node.path);
        return (
          <section key={node.path} className={`ft-top hue-${hueOf(node.name, i)}${open ? ' open' : ''}`}>
            <button className="ft-top-h" onClick={() => toggle(node.path)}>
              <Caret />
              <span className="ft-top-name">{node.name}</span>
              <span className="ft-count fig">{filter ? hits : countNotes(node)}</span>
            </button>
            {open && (
              <div className="ft-kids">
                {node.children.map((c) => (c.type === 'folder' ? renderFolder(c, 0)[0] : (match(c) ? renderNote(c, 0) : null)))}
              </div>
            )}
          </section>
        );
      })}
      {rootNotes.length > 0 && (
        <section className={`ft-top hue-5${fold.has('') && !filter ? '' : ' open'}`}>
          <button className="ft-top-h" onClick={() => toggle('')}>
            <Caret /><span className="ft-top-name">根目录</span><span className="ft-count fig">{rootNotes.length}</span>
          </button>
          {(!fold.has('') || filter) && <div className="ft-kids">{rootNotes.map((n) => renderNote(n, 0))}</div>}
        </section>
      )}
    </div>
  );
}
