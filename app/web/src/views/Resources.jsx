import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';

/**
 * 学习资源：三类历年真题 + 两份知识点标签。
 * 题面由 scripts/import-exams.mjs 抓到 .kb/exams/，这里按科目分栏、按年份铺开，点进去就是一张卷子。
 * 颜色跟侧栏目录树的学科色一致：英语青、数学琥珀、408 玫红。
 */

const GROUPS = [
  { key: 'english', label: '英语历年真题', hue: 'english', kinds: [{ key: 'english2', label: '英语二' }, { key: 'english1', label: '英语一' }] },
  { key: 'math', label: '数学历年真题', hue: 'math', tags: 'math', kinds: [{ key: 'math1', label: '数学一' }, { key: 'math2', label: '数学二' }, { key: 'math3', label: '数学三' }] },
  { key: '408', label: '408 历年真题', hue: '408', tags: '408', kinds: [{ key: '408', label: '408' }] },
];

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function Resources() {
  const { data, loading, error, reload } = useApi(() => api.exams(), []);
  const [picked, setPicked] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kb-exam-kinds') || '{}'); } catch { return {}; }
  });
  const pick = (g, k) => setPicked((p) => { const next = { ...p, [g]: k }; localStorage.setItem('kb-exam-kinds', JSON.stringify(next)); return next; });

  const exams = data?.exams || [];
  const byKind = useMemo(() => {
    const m = new Map();
    for (const e of exams) { if (!m.has(e.kind)) m.set(e.kind, []); m.get(e.kind).push(e); }
    return m;
  }, [exams]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const doneAll = exams.filter((e) => e.submitted >= e.units).length;
  const doingAll = exams.filter((e) => e.started > 0 && e.submitted < e.units).length;

  return (
    <div className="scroll"><div className="page res-page">
      <div className="band" style={{ borderBottomColor: 'var(--line-2)', marginBottom: 34 }}>
        <span className="band-title">RESOURCES · 学习资源</span>
        <span className="band-meta">{exams.length} 套真题 · 已完成 {doneAll} · 进行中 {doingAll}</span>
      </div>

      {!exams.length ? (
        <Empty>
          还没有抓取到真题。在 app/ 目录下运行
          <code style={{ margin: '0 6px', color: 'var(--text-2)' }}>node scripts/import-exams.mjs</code>
          后刷新
        </Empty>
      ) : GROUPS.map((g, gi) => {
        const kind = g.kinds.some((k) => k.key === picked[g.key]) ? picked[g.key] : g.kinds[0].key;
        const list = byKind.get(kind) || [];
        const all = g.kinds.flatMap((k) => byKind.get(k.key) || []);
        if (!all.length) return null;
        const done = all.filter((e) => e.submitted >= e.units).length;
        const doing = all.filter((e) => e.started > 0 && e.submitted < e.units).length;
        const tagInfo = g.tags && data?.tags?.[g.tags];
        return (
          <ResGroup key={g.key} group={g} index={gi} kind={kind} list={list}
                    stats={{ total: all.length, done, doing }} tagInfo={tagInfo} onPick={(k) => pick(g.key, k)} />
        );
      })}
    </div></div>
  );
}

function ResGroup({ group, index, kind, list, stats, tagInfo, onPick }) {
  const navigate = useNavigate();
  return (
    <section className={`res-group hue-${group.hue}`}>
      <div className="res-head">
        <div className="res-head-l">
          <div className="lbl-cn">{String(index + 1).padStart(2, '0')} · {group.label}</div>
          <h2 className="res-title">
            <i className="res-swatch" />
            {group.label}
            <span className="res-sub">{stats.total} 套 · 已完成 {stats.done} · 进行中 {stats.doing}</span>
          </h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {group.kinds.length > 1 && group.kinds.map((k) => (
            <button key={k.key} className={`tag${kind === k.key ? ' on' : ''}`} onClick={() => onPick(k.key)}>{k.label}</button>
          ))}
          {tagInfo && (
            <button className="btn sm res-tags-btn" onClick={() => navigate(`/resources/tags/${group.tags}`)}>
              知识点标签　<span className="dim">{tagInfo.tags}</span>　→
            </button>
          )}
        </div>
      </div>

      <div className="exam-grid">
        {list.map((e) => {
          const state = e.submitted >= e.units ? 'done' : e.started > 0 ? 'doing' : 'new';
          return (
            <button key={e.id} className={`exam-card ${state}`} onClick={() => navigate(`/resources/exam/${e.id}`)}>
              <span className="ec-year fig">{e.year}</span>
              <span className="ec-meta">
                {state === 'new' && <span className="dim">未开始</span>}
                {state === 'doing' && <span className="due">{e.submitted} / {e.units} 已交</span>}
                {state === 'done' && <span className="ec-done">已完成</span>}
              </span>
              {e.gradedTotal > 0 && (
                <span className="ec-score"><b className="fig">{fmt(e.score)}</b><em>/ {fmt(e.gradedTotal)}</em></span>
              )}
              <span className="ec-go">→</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
