import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';
import { speak, canSpeak } from '../tts.js';

/**
 * 阅读卡片，两种：
 *   句子（sentence）——自己在真题里划的长难句。练的是「拆得开」：正面只有原句，Space 逐层揭示
 *     主干 → 结构（从句 / 短语 / 插入语，类型标在词的上方，不打断句子）→ 译文，再三档评分。
 *     新卡第一次出现先进解析模式，自己拆一遍、写一句译文——这一步本身就是复习。
 *   短文（passage）——助手用一周没掌握的词写的小阅读。先裸读靠上下文猜词，
 *     再把释义浮到生词上方，最后看译文。释义用的是和句子成分同一套「标在词上」的排版。
 */

const RATINGS = [
  { key: 'again', label: '重来', hint: '1', desc: '主干没找对 / 意思没读通' },
  { key: 'hard', label: '模糊', hint: '2', desc: '拆出来了，但磕磕绊绊' },
  { key: 'good', label: '通透', hint: '3', desc: '一遍读通' },
];

const STEPS = [
  { hint: '先找主干，心里译一遍', next: '显示主干' },
  { hint: '主干找对了吗？', next: '展开结构' },
  { hint: '每一层修饰的是谁？', next: '看译文' },
  { hint: '对照译文，给自己打分', next: '' },
];
/* 短文没有「主干」这一层：0 裸读 → 2 释义 → 3 译文 */
const PASSAGE_STEPS = {
  0: { hint: '通读一遍，划线的生词先靠上下文猜', next: '显示释义' },
  2: { hint: '猜对了吗？带着释义再读一遍', next: '看译文' },
  3: { hint: '对照译文，给自己打分', next: '' },
};
const levelsOf = (card) => (card?.kind === 'passage' ? [0, 2, 3] : [0, 1, 2, 3]);
const stepOf = (card, level) => (card?.kind === 'passage' ? PASSAGE_STEPS[level] : STEPS[level]);

/* 解析时点选的成分：主干可以再细到主谓宾，标签显示在词的上方 */
const PRESETS = [
  { group: '主干', role: 'main', labels: ['', '主语', '谓语', '宾语', '表语'] },
  { group: '从句', role: 'clause', labels: ['定语从句', '状语从句', '宾语从句', '主语从句', '表语从句', '同位语从句'] },
  { group: '短语', role: 'phrase', labels: ['非谓语', '介词短语', '同位语'] },
  { group: '插入', role: 'insert', labels: ['插入语'] },
];
const ROLE_NAME = { main: '主干', clause: '从句', phrase: '短语', insert: '插入语', word: '' };
const labelOf = (sp) => (sp.role === 'main' || sp.role === 'word' ? sp.label : sp.label || ROLE_NAME[sp.role]);

export function ReviewTabs() {
  return (
    <div className="seg rv-tabs">
      <NavLink end to="/review" className={({ isActive }) => (isActive ? 'on' : '')}>单词</NavLink>
      <NavLink to="/review/reading" className={({ isActive }) => (isActive ? 'on' : '')}>阅读</NavLink>
    </div>
  );
}

/** 短文的标题和生词表 */
const PassageTitle = ({ card }) => (card.kind === 'passage'
  ? <div className="sx-title"><span>{card.title}</span><em>{card.words.length} 个生词</em></div>
  : null);
const WordChips = ({ words }) => (
  <div className="sx-wchips">
    {words.map((w) => <span className={`sx-wchip${w.found ? '' : ' miss'}`} key={w.term}><b>{w.term}</b>{w.gloss}</span>)}
  </div>
);

/** 标注按「开始升序、结束降序」排好就能用一个栈建出嵌套树（保存时已保证不交叉） */
function buildTree(spans) {
  const root = { s: -1, e: Infinity, children: [] };
  const stack = [root];
  for (const sp of [...spans].sort((a, b) => a.s - b.s || b.e - a.e)) {
    while (stack.length > 1 && !(sp.s >= stack.at(-1).s && sp.e <= stack.at(-1).e)) stack.pop();
    const node = { ...sp, children: [] };
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  return root;
}

/**
 * 句子本体。level 0–3 控制揭示到哪一层，mode="edit" 时显示全部结构并可拖选。
 * 同一个词上起头的几层标注，标签往上叠（--lift），不互相压住。
 */
function Sentence({ tokens, spans, level, edit = false, sel = null, onDown, onEnter, passage = false }) {
  const tree = useMemo(() => buildTree(spans), [spans]);
  const main = useMemo(() => {
    const s = new Set();
    for (const x of spans) if (x.role === 'main') for (let i = x.s; i <= x.e; i += 1) s.add(i);
    return s;
  }, [spans]);

  const token = (i) => (
    <span key={`t${i}`}
          className={`tk ${main.has(i) ? 't-main' : 't-rest'}${sel && i >= sel.s && i <= sel.e ? ' sel' : ''}`}
          onMouseDown={edit ? (e) => { e.preventDefault(); onDown(i); } : undefined}
          onMouseEnter={edit ? () => onEnter(i) : undefined}>
      {tokens[i]}
    </span>
  );

  const range = (a, b, kids, ctx) => {
    const out = [];
    let i = a;
    let k = 0;
    while (i <= b) {
      if (out.length) out.push(' ');
      const c = kids[k];
      if (c && c.s === i) { out.push(span(c, ctx)); i = c.e + 1; k += 1; } else { out.push(token(i)); i += 1; }
    }
    return out;
  };

  const span = (n, ctx) => {
    const lbl = labelOf(n);
    // 生词是单个词：句读留在下划线外面（retrospection, 只划 retrospection）
    if (n.role === 'word' && n.s === n.e) {
      const [, core, tail] = tokens[n.s].match(/^(.*?)([,.;:!?"'”’)\]]*)$/) || [null, tokens[n.s], ''];
      return (
        <span key={`w${n.s}`} className="tk t-rest">
          <span className="ss ss-word">{lbl && <span className="ss-lbl">{lbl}</span>}{core}</span>{tail}
        </span>
      );
    }
    const lift = ctx.pos === n.s ? ctx.count : 0;
    const depth = n.role === 'clause' ? ctx.depth % 2 : 0;
    return (
      <span key={`s${n.s}-${n.e}-${n.role}`} className={`ss ss-${n.role}${n.role === 'clause' ? ` cd-${depth}` : ''}`}>
        {lbl && <span className="ss-lbl" style={{ '--lift': lift }}>{lbl}</span>}
        {range(n.s, n.e, n.children, {
          pos: n.s,
          count: lift + (lbl ? 1 : 0),
          depth: ctx.depth + (n.role === 'clause' ? 1 : 0),
        })}
      </span>
    );
  };

  return (
    <p className={`sx ${edit ? 'edit' : `lv-${level}`}${passage ? ' passage' : ''}`}>
      {range(0, tokens.length - 1, tree.children, { pos: -1, count: 0, depth: 0 })}
    </p>
  );
}

/** 第一次复习：拖选词 → 点成分，写一句自己的译文 */
function Annotator({ card, onSave, onCancel }) {
  const tokens = useMemo(() => card.text.split(' '), [card.text]);
  const [spans, setSpans] = useState(card.spans || []);
  const [sel, setSel] = useState(null);
  const [translation, setTranslation] = useState(card.translation || '');
  const [note, setNote] = useState(card.note || '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const anchor = useRef(null);

  useEffect(() => {
    const up = () => { anchor.current = null; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const onDown = (i) => { anchor.current = i; setSel({ s: i, e: i }); setErr(''); };
  const onEnter = (i) => { if (anchor.current != null) setSel({ s: Math.min(anchor.current, i), e: Math.max(anchor.current, i) }); };

  const apply = (role, label) => {
    if (!sel) { setErr('先在句子里拖选几个词'); return; }
    const same = spans.find((x) => x.s === sel.s && x.e === sel.e && x.role === role);
    if (same) { setSpans(spans.map((x) => (x === same ? { ...x, label } : x))); setSel(null); return; }
    const cross = spans.some((x) => !(sel.e < x.s || sel.s > x.e)
      && !(sel.s <= x.s && sel.e >= x.e) && !(sel.s >= x.s && sel.e <= x.e));
    if (cross) { setErr('和已有的标注交叉了——只能嵌套在里面，或者完全分开'); return; }
    setSpans([...spans, { s: sel.s, e: sel.e, role, label }]);
    setSel(null);
    setErr('');
  };

  const submit = async () => {
    if (!spans.some((x) => x.role === 'main')) { setErr('至少标出主干'); return; }
    setSaving(true);
    try { await onSave({ spans, translation: translation.trim(), note: note.trim() }); } catch (e) { setErr(e.message); setSaving(false); }
  };

  const picked = sel ? tokens.slice(sel.s, sel.e + 1).join(' ') : '';
  const ordered = [...spans].sort((a, b) => a.s - b.s || b.e - a.e);

  return (
    <div className="sx-annot">
      <div className="sx-annot-head">
        <span className="lbl">{card.annotated ? '修改解析' : '第一次见这句 · 先自己拆一遍'}</span>
        <span className="sx-annot-tip">{sel ? `已选：${picked}` : '在句子上拖选几个词，再点下面的成分'}</span>
      </div>

      <div className="sx-stage edit-stage">
        <Sentence tokens={tokens} spans={spans} edit sel={sel} onDown={onDown} onEnter={onEnter} />
      </div>

      <div className="sx-tools">
        {PRESETS.map((g) => (
          <div className="sx-tool-group" key={g.role}>
            <span className="sx-tool-cap">{g.group}</span>
            {g.labels.map((l) => (
              <button key={l || 'main'} className={`sx-chip r-${g.role}`} onClick={() => apply(g.role, l)}>{l || '主干'}</button>
            ))}
          </div>
        ))}
      </div>

      {ordered.length > 0 && (
        <div className="sx-marks">
          {ordered.map((x) => (
            <span className={`sx-mark r-${x.role}`} key={`${x.s}-${x.e}-${x.role}`}>
              <b>{labelOf(x) || '主干'}</b>
              <span className="sx-mark-t">{tokens.slice(x.s, x.e + 1).join(' ')}</span>
              <button aria-label="删除这条标注" onClick={() => setSpans(spans.filter((y) => y !== x))}>×</button>
            </span>
          ))}
        </div>
      )}

      <label className="sx-field">
        <span className="lbl">我的译文</span>
        <textarea rows={2} value={translation} onChange={(e) => setTranslation(e.target.value)}
                  placeholder="按拆出来的结构，写一句通顺的中文" />
      </label>
      <label className="sx-field">
        <span className="lbl">备注</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="难点在哪：倒装、省略、长定语……（可空）" />
      </label>

      {err && <div className="vocab-notice">{err}</div>}
      <div className="sx-annot-foot">
        {onCancel && <button className="btn" onClick={onCancel}>取消</button>}
        <span className="spacer" />
        <button className="btn primary" disabled={saving} onClick={submit}>完成解析　→</button>
      </div>
    </div>
  );
}

function AddForm({ onAdded, onClose }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    try {
      const out = await api.addSentence({ text, source });
      if (!out.added) { setErr('这句已经在卡片里了'); return; }
      onAdded(out.card);
      setText(''); setSource(''); setErr('');
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="sx-add">
      <textarea rows={3} autoFocus value={text} onChange={(e) => { setText(e.target.value); setErr(''); }}
                placeholder="粘贴一句英文长难句" />
      <div className="sx-add-row">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="出处（可空），如 2020 英语一 Text 3" />
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit}>加入卡片</button>
      </div>
      {err && <div className="vocab-notice">{err}</div>}
    </div>
  );
}

const dot = (d) => (d ? d.replaceAll('-', '.') : '');
const LIST_KEY = 'kb-sentence-list';
const loadPrefs = () => {
  try { return { structure: true, translation: false, ...JSON.parse(localStorage.getItem(LIST_KEY) || '{}') }; } catch { return { structure: true, translation: false }; }
};

/**
 * 句子列表：平时翻着回顾。结构、译文各一个开关——
 * 开着读是复习，把译文关掉一句句自己译就是自测。
 */
export function SentenceList() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.allSentences(), []);
  const [cards, setCards] = useState(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState('all');
  const [prefs, setPrefs] = useState(loadPrefs);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => { if (data) setCards(data.cards); }, [data]);
  useEffect(() => { try { localStorage.setItem(LIST_KEY, JSON.stringify(prefs)); } catch { /* 无痕窗口 */ } }, [prefs]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (cards || []).filter((c) => {
      if (view === 'fresh' && c.annotated) return false;
      if (view === 'passage' && c.kind !== 'passage') return false;
      if (view === 'due' && !(c.due <= data.today)) return false;
      if (!k) return true;
      return c.text.toLowerCase().includes(k) || c.translation.includes(k) || c.source.toLowerCase().includes(k)
        || c.note.includes(k) || c.title.toLowerCase().includes(k);
    });
  }, [cards, q, view, data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !cards) return null;

  const counts = {
    all: cards.length,
    passage: cards.filter((c) => c.kind === 'passage').length,
    fresh: cards.filter((c) => !c.annotated).length,
    due: cards.filter((c) => c.due <= data.today).length,
  };
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const remove = async (c) => {
    if (!window.confirm('删掉这张阅读卡片？复习记录会保留。')) return;
    await api.removeSentence(c.id);
    setCards((cs) => cs.filter((x) => x.id !== c.id));
  };
  const save = async (c, payload) => {
    const updated = await api.annotateSentence(c.id, payload);
    setCards((cs) => cs.map((x) => (x.id === c.id ? updated : x)));
    setEditing(null);
  };

  return (
    <div className="scroll"><div className="page sx-list">
      <div className="rv-head">
        <ReviewTabs />
        <span className="spacer" />
        <button className="vocab-link" onClick={() => navigate('/review/reading')}>← 回到复习</button>
      </div>

      <div className="sx-list-bar">
        <div className="seg">
          {[['all', '全部'], ['passage', '短文'], ['due', '到期'], ['fresh', '待解析']].map(([k, label]) => (
            <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{label} {counts[k]}</button>
          ))}
        </div>
        <input className="sx-list-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜句子、译文、出处" />
        <span className="spacer" />
        <label className="sx-switch"><input type="checkbox" checked={prefs.structure} onChange={(e) => setPrefs({ ...prefs, structure: e.target.checked })} />结构</label>
        <label className="sx-switch"><input type="checkbox" checked={prefs.translation} onChange={(e) => setPrefs({ ...prefs, translation: e.target.checked })} />译文</label>
      </div>

      {!shown.length && (
        <div className="sx-list-empty">
          {cards.length ? '没有符合条件的卡片' : '还没有阅读卡片——在真题阅读里右键「加入阅读」，或让助手用没掌握的单词写一篇'}
        </div>
      )}

      {shown.map((c, i) => {
        const tokens = c.text.split(' ');
        const showTr = prefs.translation || open.has(c.id);
        return (
          <article className="sx-item" key={c.id}>
            <div className="sx-item-meta">
              <span className="fig sx-item-n">{String(i + 1).padStart(2, '0')}</span>
              {c.source && (c.examId
                ? <button className="vocab-link" onClick={() => navigate(`/resources/exam/${c.examId}${c.q ? `?q=${c.q}` : ''}`)}>{c.source}</button>
                : <span>{c.source}</span>)}
              {!c.annotated && <span className="sx-tag">待解析</span>}
              {c.kind === 'passage' && <span className="sx-tag passage">短文</span>}
              <span className="spacer" />
              <span>{c.reps ? `复习 ${c.reps} 次 · ` : ''}{c.due <= data.today ? '今天到期' : `下次 ${dot(c.due)}`}</span>
              {c.kind !== 'passage' && (
                <button className="vocab-link" onClick={() => setEditing(editing === c.id ? null : c.id)}>{c.annotated ? '改解析' : '去解析'}</button>
              )}
              <button className="vocab-link dim-link" onClick={() => remove(c)}>删除</button>
            </div>

            {editing === c.id ? (
              <Annotator card={c} onSave={(p) => save(c, p)} onCancel={() => setEditing(null)} />
            ) : (
              <>
                <PassageTitle card={c} />
                <Sentence tokens={tokens} spans={c.spans} level={prefs.structure ? 2 : 0} passage={c.kind === 'passage'} />
                {c.translation && (showTr
                  ? <p className="sx-item-tr" onClick={() => !prefs.translation && toggle(c.id)}>{c.translation}</p>
                  : <button className="sx-item-peek" onClick={() => toggle(c.id)}>看译文</button>)}
                {showTr && c.note && <p className="sx-item-note">{c.note}</p>}
                {showTr && c.kind === 'passage' && <WordChips words={c.words} />}
              </>
            )}
          </article>
        );
      })}
    </div></div>
  );
}

export default function Sentences({ onReviewed }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.sentences(), []);
  const [queue, setQueue] = useState(null);
  const [done, setDone] = useState(0);
  const [level, setLevel] = useState(0);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  const fresh = useRef(true);

  useEffect(() => {
    if (!data || !fresh.current) return;
    fresh.current = false;
    setQueue(data.cards);
  }, [data]);

  const card = queue?.[0] || null;
  const tokens = useMemo(() => (card ? card.text.split(' ') : []), [card]);
  const needsAnnot = card && (!card.annotated || editing);

  const newRound = useCallback(() => { fresh.current = true; setDone(0); setLevel(0); reload(); }, [reload]);

  const next = useCallback(() => setLevel((l) => {
    const lv = levelsOf(card);
    return lv[Math.min(lv.length - 1, lv.indexOf(l) + 1)];
  }), [card]);

  const grade = useCallback(async (rating) => {
    if (!card || busy.current || level < 3) return;
    busy.current = true;
    try {
      await api.rateSentence(card.id, rating);
      // 重来的句子本轮末尾再见一次
      setQueue((q) => (rating === 'again' ? [...q.slice(1), q[0]] : q.slice(1)));
      if (rating !== 'again') setDone((n) => n + 1);
      setLevel(0);
      setNotice('');
      if (rating !== 'again' && queue.length === 1) onReviewed?.();
    } catch (e) {
      setNotice(e.message);
    }
    busy.current = false;
  }, [card, level, queue, onReviewed]);

  const saveAnnot = useCallback(async (payload) => {
    const updated = await api.annotateSentence(card.id, payload);
    setQueue((q) => [updated, ...q.slice(1)]);
    setEditing(false);
    setLevel(3);
  }, [card]);

  const remove = useCallback(async () => {
    if (!card || !window.confirm('删掉这张阅读卡片？复习记录会保留。')) return;
    try {
      await api.removeSentence(card.id);
      setQueue((q) => q.slice(1));
      setLevel(0);
    } catch (e) { setNotice(e.message); }
  }, [card]);

  const onAdded = useCallback((added) => {
    setAdding(false);
    setQueue((q) => [...(q || []), added]);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches?.('input, textarea') || !card || needsAnnot) return;
      if ((e.key === ' ' || e.key === 'Enter') && level < 3) { e.preventDefault(); next(); return; }
      const hit = level === 3 && RATINGS.find((r) => r.hint === e.key);
      if (hit) { e.preventDefault(); grade(hit.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, needsAnnot, level, next, grade]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !queue) return null;

  const total = done + queue.length;
  // 一周没出过生词短文，就提醒一下；点了交给助手去写
  const staleDays = data.counts.lastPassage ? Math.round((Date.parse(data.today) - Date.parse(data.counts.lastPassage)) / 864e5) : Infinity;
  const head = (
    <>
      <div className="rv-head">
        <ReviewTabs />
        <span className="spacer" />
        <button className="vocab-link" onClick={() => navigate('/assistant?ask=weekly')}>✦ 生词阅读</button>
        {!adding && <button className="vocab-link" onClick={() => setAdding(true)}>＋ 手动添加</button>}
        <button className="vocab-link" onClick={() => navigate('/review/reading/list')}>阅读列表 →</button>
      </div>
      {staleDays >= 7 && (
        <button className="sx-weekly" onClick={() => navigate('/assistant?ask=weekly')}>
          <span className="sx-weekly-k">本周生词阅读</span>
          <span>{Number.isFinite(staleDays) ? `上一篇是 ${staleDays} 天前` : '还没有生成过'}——让助手用这周没掌握的单词写一篇短文</span>
          <span className="sx-weekly-go">生成 →</span>
        </button>
      )}
    </>
  );
  const addForm = adding && <AddForm onAdded={onAdded} onClose={() => setAdding(false)} />;

  if (!card) {
    const empty = data.counts.total === 0 && done === 0;
    return (
      <div className="scroll"><div className="vocab-stage">
        {head}
        {addForm}
        <div className="vocab-done">
          <div className="lbl">{empty ? 'READING' : 'ROUND COMPLETE'}</div>
          {empty ? (
            <>
              <p className="sx-empty-t">还没有阅读卡片</p>
              <p className="vocab-done-s">
                在真题阅读里选中一句（或点在已划的荧光笔上），右键「加入阅读」，第一次复习时自己拆结构；<br />
                也可以让助手用这周没掌握的单词写一篇短文。
              </p>
              <div className="row" style={{ gap: 12, marginTop: 28, justifyContent: 'center' }}>
                <button className="btn primary lg" onClick={() => navigate('/resources')}>去真题里划句　→</button>
              </div>
            </>
          ) : (
            <>
              <div className="vocab-done-n fig">{done}</div>
              <p className="vocab-done-t">{done ? `本轮读完 ${done} 张` : '今天没有到期的阅读'}</p>
              <div className="row" style={{ gap: 12, marginTop: 28, justifyContent: 'center' }}>
                <button className="btn lg" onClick={newRound}>再看一轮到期的</button>
              </div>
              <div className="vocab-done-meta">共 {data.counts.total} 张 · 待解析 {data.counts.fresh}</div>
            </>
          )}
        </div>
      </div></div>
    );
  }

  const mainText = [...card.spans].filter((x) => x.role === 'main').sort((a, b) => a.s - b.s)
    .map((x) => tokens.slice(x.s, x.e + 1).join(' ')).join(' … ');

  return (
    <div className="scroll"><div className="vocab-stage">
      {head}
      {addForm}
      <div className="vocab-top">
        <div className="vocab-bar"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <div className="vocab-top-meta">
          <span className="fig">{String(done + 1).padStart(2, '0')} / {total}</span>
          <span className="dim">{card.reps ? `第 ${card.reps + 1} 次复习` : card.lapses ? '重学' : '新卡'}</span>
          {card.lapses > 0 && <span className="due">忘过 {card.lapses} 次</span>}
          <span className="spacer" />
          {card.source && (card.examId
            ? <button className="vocab-link" onClick={() => navigate(`/resources/exam/${card.examId}${card.q ? `?q=${card.q}` : ''}`)}>{card.source} →</button>
            : <span className="dim">{card.source}</span>)}
          {canSpeak && (
            <button className="vocab-link" onClick={() => speak(card.text, { rate: 0.9 })}>朗读</button>
          )}
          {card.kind !== 'passage' && card.annotated && !editing && level === 3 && <button className="vocab-link" onClick={() => setEditing(true)}>改解析</button>}
          <button className="vocab-link dim-link" onClick={remove}>删除</button>
        </div>
      </div>

      {needsAnnot ? (
        <div className="sx-card annot">
          <Annotator key={card.id} card={card} onSave={saveAnnot} onCancel={card.annotated ? () => setEditing(false) : undefined} />
        </div>
      ) : (
        <>
          <div className={`sx-card${level < 3 ? ' tappable' : ''}`} role="button" tabIndex={0}
               onClick={() => { if (level < 3 && !window.getSelection?.()?.toString().trim()) next(); }}>
            <div className="sx-stage">
              <PassageTitle card={card} />
              <Sentence tokens={tokens} spans={card.spans} level={level} passage={card.kind === 'passage'} />
              {level === 3 && (
                <div className="sx-reveal">
                  {card.translation && <p className="sx-tr"><span className="lbl">译文</span>{card.translation}</p>}
                  {mainText && <p className="sx-main"><span className="lbl">主干</span>{mainText}</p>}
                  {card.note && <p className="sx-note"><span className="lbl">备注</span>{card.note}</p>}
                  {card.kind === 'passage' && <WordChips words={card.words} />}
                </div>
              )}
            </div>
          </div>

          {notice && <div className="vocab-notice">{notice}</div>}

          {level < 3 ? (
            <div className="sx-steps">
              <div className="sx-dots">{levelsOf(card).map((l) => <i key={l} className={l <= level ? 'on' : ''} />)}</div>
              <span className="sx-hint">{stepOf(card, level).hint}</span>
              <span className="spacer" />
              <button className="btn" onClick={next}>{stepOf(card, level).next}<span className="kbd">Space</span></button>
            </div>
          ) : (
            <div className="vocab-actions three">
              {RATINGS.map((r) => (
                <button key={r.key} className={`vocab-btn v-${r.key}`} title={r.desc} onClick={() => grade(r.key)}>
                  <span className="vb-k">{r.label}</span>
                  <span className="vb-h">{r.hint}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div></div>
  );
}
