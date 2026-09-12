import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';

/**
 * 真题标签：知识点 → 历年出现过的题号。
 * 数据来自站点的「真题标签」页（scripts/import-exams.mjs tags），
 * 点一个题号就跳到那张卷子里的那道题（?q=题号）。本地没抓到的年份只显示不能点。
 * 结构图里点一个还没学的考点会带 ?tag=考点名 过来：切到它所在的科目、展开并滚到那一行。
 */

const KIND_SHORT = { 408: '', math1: '数一', math2: '数二', math3: '数三' };
const TYPE_ORDER = ['选择题', '填空题', '解答题'];

export default function ExamTags() {
  const { group } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const want = params.get('tag') || '';
  const { data, loading, error, reload } = useApi(() => api.examTags(group), [group]);
  const [subject, setSubject] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set(want ? [want] : []));

  const subjects = data?.subjects || [];

  // ?tag= 深链：数据到了再定位
  useEffect(() => {
    if (!data || !want) return;
    const owner = data.subjects.find((s) => s.tags.some((t) => t.name === want));
    if (!owner) return;
    setSubject(owner.name);
    setOpen((s) => new Set(s).add(want));
    const id = setTimeout(() => document.getElementById(`tag-${want}`)?.scrollIntoView({ block: 'center' }), 60);
    return () => clearTimeout(id);
  }, [data, want]);
  const cur = subjects.find((s) => s.name === subject) || subjects[0];
  const available = useMemo(() => new Set(data?.available || []), [data]);
  const needle = q.trim().toLowerCase();
  const tags = useMemo(() => {
    if (!cur) return [];
    return needle ? cur.tags.filter((t) => t.name.toLowerCase().includes(needle)) : cur.tags;
  }, [cur, needle]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const toggle = (name) => setOpen((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const hue = group === 'math' ? 'math' : '408';

  return (
    <div className="scroll"><div className={`page res-page hue-${hue}`}>
      <div className="rh-crumb" style={{ marginBottom: 14 }}>
        <button onClick={() => navigate('/resources')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>学习资源</button>
        {'　/　'}{data.label}
      </div>
      <div className="res-head" style={{ marginBottom: 18 }}>
        <div>
          <h2 className="res-title">
            <i className="res-swatch" />
            {data.label}
            <span className="res-sub">{data.counts.tags} 个知识点 · {data.counts.items} 处题目 · 本地已有 {available.size} 套卷子</span>
          </h2>
        </div>
        <input className="input tags-search" placeholder="搜知识点…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
      </div>

      <div className="tags-subjects">
        {subjects.map((s) => (
          <button key={s.name} className={`tags-subject${cur?.name === s.name ? ' on' : ''}`} onClick={() => setSubject(s.name)}>
            <span>{s.name}</span>
            <span className="fig dim">{s.tags.length}</span>
          </button>
        ))}
      </div>

      <div className="tags-list">
        {tags.map((t) => {
          const isOpen = open.has(t.name);
          const groups = TYPE_ORDER.filter((ty) => t.items.some((it) => it.type === ty))
            .map((ty) => ({ type: ty, items: t.items.filter((it) => it.type === ty) }));
          const others = t.items.filter((it) => !TYPE_ORDER.includes(it.type));
          if (others.length) groups.push({ type: '其他', items: others });
          return (
            <div key={t.name} id={`tag-${t.name}`} className={`tag-row${isOpen ? ' open' : ''}${t.name === want ? ' want' : ''}`}>
              <button className="tag-row-h" onClick={() => toggle(t.name)}>
                <i className="tag-caret" />
                <span className="tag-name">{t.name}</span>
                <span className="tag-bar"><i style={{ width: `${Math.min(100, t.items.length * 4)}%` }} /></span>
                <span className="tag-count fig">{t.items.length}</span>
              </button>
              {isOpen && (
                <div className="tag-panel">
                  {groups.map((g) => (
                    <div key={g.type} className="tag-group">
                      <span className="tag-group-l">{g.type}</span>
                      <span className="tag-links">
                        {g.items.map((it, i) => {
                          const ok = available.has(it.exam);
                          const label = `${KIND_SHORT[it.kind] ?? it.kind} ${String(it.year).slice(2)}#${it.n}`.trim();
                          return ok
                            ? <button key={i} className="tag-link" onClick={() => navigate(`/resources/exam/${it.exam}?q=${it.n}`)}>{label}</button>
                            : <span key={i} className="tag-link off" title="本地没有这一年的卷子">{label}</span>;
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!tags.length && <div className="empty">没有匹配的知识点</div>}
      </div>
    </div></div>
  );
}
