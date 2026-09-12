import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
 * 点一行展开编辑：音标、义项、例句都能改——种子里的 ECDICT 释义和 Tatoeba 例句有错就在这儿修。
 */

const VIEWS = [
  { key: 'today', label: '今日' },
  { key: 'new', label: '未学习' },
  { key: 'learning', label: '学习中' },
  { key: 'known', label: '已熟识' },
  { key: 'all', label: '全部' },
];
const WHY = { reviewed: '今天复习', marked: '今天标注', added: '今天添加' };
const dot = (d) => (d ? d.replaceAll('-', '.') : '');
// 列表那一格的释义摘要，和服务端 list() 的拼法保持一致（前两条）
const glossOf = (senses) => senses.slice(0, 2).map((s) => (s.pos ? `${s.pos} ${s.gloss}` : s.gloss)).join('；');

/** 行内编辑面板：整体加载、整体保存，不逐条同步 */
function WordEditor({ id, onSaved, onClose }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api.word(id).then((w) => {
      if (!alive) return;
      setForm({
        term: w.term, inList: w.inList, edited: w.edited,
        phonetic: w.phonetic || '',
        senses: w.senses.length ? w.senses.map((s) => ({ ...s })) : [{ pos: '', gloss: '' }],
        examples: w.examples.length ? w.examples.map((e) => ({ ...e })) : [{ text: '', translation: '' }],
      });
    }).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [id]);

  const patch = (k, i, key, v) => setForm((f) => ({ ...f, [k]: f[k].map((x, j) => (j === i ? { ...x, [key]: v } : x)) }));
  const drop = (k, i) => setForm((f) => ({ ...f, [k]: f[k].filter((_, j) => j !== i) }));
  const push = (k, blank) => setForm((f) => ({ ...f, [k]: [...f[k], blank] }));

  const save = async (e) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true); setErr('');
    try {
      const w = await api.updateWord(id, { phonetic: form.phonetic, senses: form.senses, examples: form.examples });
      onSaved(w);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  if (err && !form) return <div className="word-edit"><div className="vocab-notice">{err}</div></div>;
  if (!form) return <div className="word-edit dim" style={{ fontSize: 12 }}>加载中…</div>;

  return (
    <form className="word-edit" onSubmit={save} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="we-grid">
        <label className="we-lbl">音标</label>
        <div className="we-ph">
          <span className="dim">/</span>
          <input className="input" value={form.phonetic} placeholder="ˌʌndəˈmaɪn" onChange={(e) => setForm((f) => ({ ...f, phonetic: e.target.value }))} />
          <span className="dim">/</span>
        </div>

        <label className="we-lbl">释义</label>
        <div className="we-list">
          {form.senses.map((s, i) => (
            <div className="we-sense" key={i}>
              <input className="input we-pos" value={s.pos} placeholder="n." onChange={(e) => patch('senses', i, 'pos', e.target.value)} />
              <input className="input" value={s.gloss} placeholder="中文释义" autoFocus={i === 0} onChange={(e) => patch('senses', i, 'gloss', e.target.value)} />
              <button type="button" className="we-x" title="删除这条" onClick={() => drop('senses', i)}>×</button>
            </div>
          ))}
          {form.senses.length < 6 && <button type="button" className="we-add" onClick={() => push('senses', { pos: '', gloss: '' })}>+ 义项</button>}
        </div>

        <label className="we-lbl">例句</label>
        <div className="we-list">
          {form.examples.map((ex, i) => (
            <div className="we-ex" key={ex.id ?? `n${i}`}>
              <textarea className="input we-ta" value={ex.text} rows={2} placeholder="英文例句" onChange={(e) => patch('examples', i, 'text', e.target.value)} />
              <input className="input" value={ex.translation || ''} placeholder="译文（可不填）" onChange={(e) => patch('examples', i, 'translation', e.target.value)} />
              <button type="button" className="we-x" title="删除这句" onClick={() => drop('examples', i)}>×</button>
              {ex.source && ex.source !== 'user' && <span className="we-src">{ex.source}</span>}
            </div>
          ))}
          {form.examples.length < 6 && <button type="button" className="we-add" onClick={() => push('examples', { text: '', translation: '' })}>+ 例句</button>}
        </div>
      </div>
      {err && <div className="vocab-notice">{err}</div>}
      <div className="we-actions">
        <span className="dim">{form.edited ? '已人工修订，词表升级不会覆盖' : '保存后词表升级不会覆盖这条'}</span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onClose}>取消</button>
        <button type="submit" className="btn sm primary" disabled={busy}>保存</button>
      </div>
    </form>
  );
}

export default function Words() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialQ = params.get('q') || '';
  const [view, setView] = useState(() => params.get('view') || localStorage.getItem('kb-words-view') || 'today');
  const [q, setQ] = useState(initialQ);
  const [debounced, setDebounced] = useState(initialQ);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ term: '', meaning: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { localStorage.setItem('kb-words-view', view); }, [view]);

  const { data, loading, error, reload } = useApi(() => api.words(view, debounced), [view, debounced]);
  const [items, setItems] = useState([]);
  useEffect(() => { if (data) setItems(data.items); }, [data]);

  const counts = data?.counts || {};
  const stats = useMemo(() => VIEWS.map((v) => ({ ...v, n: v.key === 'all' ? (counts.new || 0) + (counts.learning || 0) + (counts.known || 0) : (counts[v.key] ?? 0) })), [counts]);

  // 保存后只改本行，不整页重拉：列表顺序别跳
  const onSaved = (w) => {
    setItems((list) => list.map((x) => (x.id === w.id ? { ...x, phonetic: w.phonetic, gloss: glossOf(w.senses) } : x)));
    setEditing(null);
  };

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
            <div key={w.id} className={`word-item${editing === w.id ? ' open' : ''}`}>
              <div className={`word-row${w.important ? ' imp' : ''}`} role="button" tabIndex={0} title="点击编辑释义 / 例句"
                   onClick={() => setEditing((cur) => (cur === w.id ? null : w.id))}
                   onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setEditing((cur) => (cur === w.id ? null : w.id)); }}>
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
                <button className={`word-star${w.important ? ' on' : ''}`} title={w.important ? '取消标注' : '标为重要'}
                        onClick={(e) => { e.stopPropagation(); toggleImportant(w); }}>
                  {w.important ? '★' : '☆'}
                </button>
              </div>
              {editing === w.id && <WordEditor id={w.id} onSaved={onSaved} onClose={() => setEditing(null)} />}
            </div>
          ))}
          {!items.length && <div className="empty">这一栏还没有词</div>}
          {items.length >= 200 && <div className="dim" style={{ fontSize: 11, padding: '12px 0' }}>只显示前 200 个，用搜索缩小范围</div>}
        </div>
      )}
    </div></div>
  );
}
