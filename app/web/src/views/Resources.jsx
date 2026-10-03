import { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useScrollMemory } from '../hooks.js';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';

/**
 * 学习资源：几种刷题方式并排，顶上切换。
 *   专题训练  按知识点刷历年题，一题一交（数学、408 有知识点标签）
 *   真题模式  三类历年真题按科目分栏、按年份铺开，点进去就是一张卷子
 * 以后再加一种（比如阅读模式），往 MODES 里添一项、写一个对应的组件就行。
 * 选的模式记在地址栏 ?mode= 和 localStorage：从卷子、专题训练退回来还在原来那个模式。
 * 颜色跟侧栏目录树的学科色一致：英语青、数学蓝、408 玫红。
 */

const MODES = [
  { key: 'topics', label: '专题训练', desc: '按知识点刷历年题，一题一交' },
  { key: 'papers', label: '真题模式', desc: '整套卷子按年份做，做完再对答案' },
];
const MODE_KEY = 'kb-res-mode';

export default function Resources() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('mode');
  let saved = null;
  try { saved = localStorage.getItem(MODE_KEY); } catch { /* 无痕 */ }
  const mode = MODES.find((m) => m.key === asked) || MODES.find((m) => m.key === saved) || MODES[1];
  const scrollRef = useRef(null);
  // 点标签切模式时从顶上看起；从卷子、专题训练退回来才恢复到原来那一屏
  const [restore, setRestore] = useState(true);
  const pick = (key) => {
    if (key === mode.key) return;
    try { localStorage.setItem(MODE_KEY, key); } catch { /* 无痕 */ }
    setRestore(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setParams({ mode: key }, { replace: true });
  };

  return (
    <div className="scroll" ref={scrollRef}><div className="page res-page">
      <div className="band" style={{ borderBottomColor: 'var(--line-2)', marginBottom: 22 }}>
        <span className="band-title">RESOURCES · 学习资源</span>
        <span className="band-meta">{mode.desc}</span>
      </div>
      <nav className="res-modes" role="tablist" aria-label="刷题方式">
        {MODES.map((m) => (
          <button key={m.key} role="tab" aria-selected={m.key === mode.key}
                  className={`res-mode${m.key === mode.key ? ' on' : ''}`} onClick={() => pick(m.key)}>
            {m.label}
          </button>
        ))}
      </nav>
      {mode.key === 'papers'
        ? <PaperMode scrollRef={scrollRef} restore={restore} />
        : <TopicMode scrollRef={scrollRef} restore={restore} />}
    </div></div>
  );
}

/* ------------------------------------------------------------------ *
 * 专题训练：每科一组，组里按分科切换，一个知识点一张卡，点进去就开练
 * ------------------------------------------------------------------ */

const TOPIC_GROUPS = [
  { key: 'math', label: '数学专题训练', hue: 'math' },
  { key: '408', label: '408 专题训练', hue: '408' },
];
const SUBJECT_KEY = 'kb-topic-subjects';

function TopicMode({ scrollRef, restore }) {
  const math = useApi(() => api.examTags('math'), []);
  const cs = useApi(() => api.examTags('408'), []);
  const byKey = { math, 408: cs };
  const ready = Object.values(byKey).every((x) => x.data || x.error);
  useScrollMemory(scrollRef, 'resources:topics', ready, { restore });
  const [subjects, setSubjects] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SUBJECT_KEY) || '{}'); } catch { return {}; }
  });
  const pickSubject = (g, name) => setSubjects((p) => {
    const next = { ...p, [g]: name };
    try { localStorage.setItem(SUBJECT_KEY, JSON.stringify(next)); } catch { /* 无痕 */ }
    return next;
  });

  if (!ready) return <Loading />;
  const shown = TOPIC_GROUPS.filter((g) => byKey[g.key].data?.subjects?.length);
  if (!shown.length) {
    return (
      <Empty>
        还没有知识点标签。在 app/ 目录下运行
        <code style={{ margin: '0 6px', color: 'var(--text-2)' }}>node scripts/import-exams.mjs tags</code>
        后刷新
      </Empty>
    );
  }
  return shown.map((g, gi) => (
    <TopicGroup key={g.key} group={g} index={gi} data={byKey[g.key].data}
                subject={subjects[g.key]} onSubject={(name) => pickSubject(g.key, name)} />
  ));
}

function TopicGroup({ group, index, data, subject, onSubject }) {
  const navigate = useNavigate();
  const available = useMemo(() => new Set(data.available || []), [data]);
  const progress = data.drill?.tags || {};
  const subjects = data.subjects;
  const cur = subjects.find((s) => s.name === subject) || subjects[0];
  const all = subjects.flatMap((s) => s.tags);
  const practiced = all.filter((t) => progress[t.name]).length;
  const doneQ = Object.values(progress).reduce((a, p) => a + p.done, 0);
  const rightQ = Object.values(progress).reduce((a, p) => a + p.right, 0);

  return (
    <section className={`res-group hue-${group.hue}`}>
      <div className="res-head">
        <div className="res-head-l">
          <div className="lbl-cn">{String(index + 1).padStart(2, '0')} · {group.label}</div>
          <h2 className="res-title">
            <i className="res-swatch" />
            {group.label}
            <span className="res-sub">{all.length} 个知识点 · 练过 {practiced} 个 · 已做 {doneQ} 题{doneQ ? ` · 对 ${rightQ}` : ''}</span>
          </h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {subjects.length > 1 && subjects.map((s) => (
            <button key={s.name} className={`tag${cur.name === s.name ? ' on' : ''}`} onClick={() => onSubject(s.name)}>{s.name}</button>
          ))}
          <button className="btn sm res-tags-btn" onClick={() => navigate(`/resources/tags/${group.key}`)}>按题号看　→</button>
        </div>
      </div>

      <div className="topic-grid">
        {cur.tags.map((t) => {
          // 只数本地有卷子的题：专题训练只能做这些
          const total = t.items.filter((it) => available.has(it.exam)).length;
          const p = progress[t.name];
          const done = Math.min(p?.done || 0, total);
          const state = !total ? 'off' : done >= total ? 'done' : done ? 'doing' : 'new';
          return (
            <button key={t.name} className={`topic-card ${state}`} disabled={!total}
                    title={total ? `${t.name}：${total} 道题${done ? `，已做 ${done}` : ''}` : '本地没有这些年份的卷子'}
                    onClick={() => navigate(`/resources/drill/${group.key}?tag=${encodeURIComponent(t.name)}`)}>
              <span className="tc-name">{t.name}</span>
              <span className="tc-meta">
                {!total ? '本地没有卷子'
                  : done ? <><b className="fig">{done}</b> / {total} 题{p.right ? ` · 对 ${p.right}` : ''}</>
                    : `${total} 道题`}
              </span>
              <span className="tc-bar" aria-hidden="true"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
              <span className="ec-go">→</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 真题模式：三类历年真题按科目分栏、按年份铺开；英语下面挂着标注词
 * ------------------------------------------------------------------ */

const GROUPS = [
  { key: 'english', label: '英语历年真题', hue: 'english', kinds: [{ key: 'english2', label: '英语二' }, { key: 'english1', label: '英语一' }] },
  { key: 'math', label: '数学历年真题', hue: 'math', tags: 'math', kinds: [{ key: 'math1', label: '数学一' }, { key: 'math2', label: '数学二' }, { key: 'math3', label: '数学三' }] },
  { key: '408', label: '408 历年真题', hue: '408', tags: '408', kinds: [{ key: '408', label: '408' }] },
];

const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function PaperMode({ scrollRef, restore }) {
  const { data, loading, error, reload } = useApi(() => api.exams(), []);
  const { data: marked } = useApi(() => api.vocabMarks(), []);
  const [picked, setPicked] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kb-exam-kinds') || '{}'); } catch { return {}; }
  });
  const pick = (g, k) => setPicked((p) => { const next = { ...p, [g]: k }; localStorage.setItem('kb-exam-kinds', JSON.stringify(next)); return next; });

  // 从卷子、专题训练切回来，还停在刚才那一屏
  useScrollMemory(scrollRef, 'resources:papers', !!data, { restore });

  const exams = data?.exams || [];
  const byKind = useMemo(() => {
    const m = new Map();
    for (const e of exams) { if (!m.has(e.kind)) m.set(e.kind, []); m.get(e.kind).push(e); }
    return m;
  }, [exams]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  if (!exams.length) {
    return (
      <Empty>
        还没有抓取到真题。在 app/ 目录下运行
        <code style={{ margin: '0 6px', color: 'var(--text-2)' }}>node scripts/import-exams.mjs</code>
        后刷新
      </Empty>
    );
  }
  return GROUPS.map((g, gi) => {
    const kind = g.kinds.some((k) => k.key === picked[g.key]) ? picked[g.key] : g.kinds[0].key;
    const list = byKind.get(kind) || [];
    const all = g.kinds.flatMap((k) => byKind.get(k.key) || []);
    if (!all.length) return null;
    const done = all.filter((e) => e.submitted >= e.units).length;
    const doing = all.filter((e) => e.started > 0 && e.submitted < e.units).length;
    const tagInfo = g.tags && data?.tags?.[g.tags];
    return (
      <ResGroup key={g.key} group={g} index={gi} kind={kind} list={list}
                stats={{ total: all.length, done, doing }} tagInfo={tagInfo} onPick={(k) => pick(g.key, k)}>
        {g.key === 'english' && <MarkedWords words={marked || []} />}
      </ResGroup>
    );
  });
}

function ResGroup({ group, index, kind, list, stats, tagInfo, onPick, children }) {
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
      {children}
    </section>
  );
}

/** 真题里双击标出来的生词：词表内红、词表外蓝，点一个就去单词列表里看它 */
function MarkedWords({ words }) {
  const navigate = useNavigate();
  const ky = words.filter((w) => w.inList);
  const own = words.filter((w) => !w.inList);
  return (
    <div className="marked-words">
      <div className="mw-head">
        <span className="lbl-cn">我的标注词　{words.length}</span>
        <button className="paper-link" onClick={() => navigate('/review/words?view=today')}>单词列表 →</button>
      </div>
      {!words.length ? (
        <div className="dim" style={{ fontSize: 12, padding: '6px 0 2px' }}>还没有标注。做英语卷时双击一个单词就会记到这里。</div>
      ) : (
        <>
          <div className="mw-row">
            <span className="mw-l">考研词表内 <b className="fig">{ky.length}</b></span>
            <span className="mw-chips">{ky.map((w) => <button key={w.id} className="mw-chip ky" onClick={() => navigate(`/review/words?q=${encodeURIComponent(w.term)}&view=all`)}>{w.term}</button>)}</span>
          </div>
          <div className="mw-row">
            <span className="mw-l">词表外 <b className="fig">{own.length}</b></span>
            <span className="mw-chips">{own.length ? own.map((w) => <button key={w.id} className="mw-chip own" onClick={() => navigate(`/review/words?q=${encodeURIComponent(w.term)}&view=all`)}>{w.term}</button>) : <span className="dim" style={{ fontSize: 12 }}>—</span>}</span>
          </div>
        </>
      )}
    </div>
  );
}
