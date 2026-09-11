import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';

/**
 * 单词列表：词汇库的四个切面。
 *   今日    今天复习过 / 今天标注的 / 今天手动加的
 *   未学习  还没进过卡片队列
 *   学习中  在排期里
 *   已熟识  标过「轻松」毕业的
 * 左侧四个点是重要度：标注 +2，遗忘一次 +1，遗忘三次以上再 +1。
 * 「添加单词」既能加词表外的自定义词（配一句释义），也能把词表内的词直接标为重要。
 */

const VIEWS = [
  { key: 'today', label: '今日' },
  { key: 'new', label: '未学习' },
  { key: 'learning', label: '学习中' },
  { key: 'known', label: '已熟识' },
];
const WHY = { reviewed: '今天复习', marked: '今天标注', added: '今天添加' };
const dot = (d) => (d ? d.replaceAll('-', '.') : '');

export default function Words() {
  const navigate = useNavigate();
  const [view, setView] = useState(() => localStorage.getItem('kb-words-view') || 'today');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ term: '', meaning: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { localStorage.setItem('kb-words-view', view); }, [view]);

  const { data, loading, error, reload } = useApi(() => api.words(view, debounced), [view, debounced]);
  const [items, setItems] = useState([]);
  useEffect(() => { if (data) setItems(data.items); }, [data]);

  const counts = data?.counts || {};
  const stats = useMemo(() => VIEWS.map((v) => ({ ...v, n: counts[v.key] ?? 0 })), [counts]);

  const toggleImportant = async (w) => {
    setItems((list) => list.map((x) => (x.id === w.id ? { ...x, important: !w.important, importance: Math.min(4, Math.max(0, x.importance + (w.important ? -2 : 2))) } : x)));
    try { await api.setWordImportant(w.id, !w.important); } catch (e) { setErr(e.message); reload(); }
  };

  const add = async (e) => {
    e.preventDefault();
    const term = form.term.trim();
    if (!term) return;
    setBusy(true); setErr('');
    try {
      await api.markWord(term, { meaning: form.meaning.trim(), source: 'manual' });
      setForm({ term: '', meaning: '' });
      setAdding(false);
      reload();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  return (
    <div className="scroll"><div className="page words-page">
      <div className="rh-crumb" style={{ marginBottom: 14 }}>
        <button onClick={() => navigate('/review')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>复习</button>
        {'　/　'}单词列表
      </div>
      <div className="res-head" style={{ marginBottom: 18 }}>
        <div>
          <h2 className="res-title">
            单词列表
            <span className="res-sub">标注 {counts.important ?? 0} · 学习中 {counts.learning ?? 0} · 已熟识 {counts.known ?? 0}</span>
          </h2>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <input className="input tags-search" placeholder="搜单词 / 释义…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          <button className={`btn sm${adding ? '' : ' primary'}`} onClick={() => setAdding((a) => !a)}>{adding ? '收起' : '添加单词'}</button>
        </div>
      </div>

      {adding && (
        <form className="word-add" onSubmit={add}>
          <input className="input" placeholder="单词，例如 undermine" value={form.term} autoFocus
                 onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))} />
          <input className="input" placeholder="释义（词表内的词可以不填）" value={form.meaning}
                 onChange={(e) => setForm((f) => ({ ...f, meaning: e.target.value }))} />
          <button className="btn primary sm" type="submit" disabled={busy || !form.term.trim()}>加入并标为重要</button>
          <span className="dim" style={{ fontSize: 11 }}>词表内的词会直接标注在原词条上；词表外的建为自定义词</span>
        </form>
      )}
      {err && <div className="vocab-notice" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="tags-subjects">
        {stats.map((v) => (
          <button key={v.key} className={`tags-subject${view === v.key ? ' on' : ''}`} onClick={() => setView(v.key)}>
            <span>{v.label}</span><span className="fig dim">{v.n}</span>
          </button>
        ))}
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : (
        <div className="word-list">
          {items.map((w) => (
            <div key={w.id} className={`word-row${w.important ? ' imp' : ''}`}>
              <span className="word-dots" title={`重要度 ${w.importance} / 4`}>
                {[1, 2, 3, 4].map((i) => <i key={i} className={i <= w.importance ? 'on' : ''} />)}
              </span>
              <span className={`word-term${w.inList ? '' : ' own'}`}>{w.term}</span>
              <span className="word-ph">{w.phonetic ? `/${w.phonetic}/` : ''}</span>
              <span className="word-gloss">{w.gloss || <em className="dim">（还没有释义）</em>}</span>
              <span className="word-meta">
                {view === 'today' && w.todayWhy && <span>{WHY[w.todayWhy]}</span>}
                {w.state === 'review' && <span>下次 {dot(w.due)}</span>}
                {w.state === 'mastered' && <span>已掌握</span>}
                {w.lapses > 0 && <span className="due">忘 {w.lapses}</span>}
              </span>
              <button className={`word-star${w.important ? ' on' : ''}`} title={w.important ? '取消标注' : '标为重要'} onClick={() => toggleImportant(w)}>
                {w.important ? '★' : '☆'}
              </button>
            </div>
          ))}
          {!items.length && <div className="empty">这一栏还没有词</div>}
          {items.length >= 200 && <div className="dim" style={{ fontSize: 11, padding: '12px 0' }}>只显示前 200 个，用搜索缩小范围</div>}
        </div>
      )}
    </div></div>
  );
}
