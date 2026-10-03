import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useScrollMemory } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';
import AnswerSheet, { splitAnswer } from '../components/AnswerSheet.jsx';
import AssistantDock from '../components/AssistantDock.jsx';
import { SN_COLORS } from '../components/Stickies.jsx';
import { renderSticky } from '../sticky-text.js';
import { assistant } from '../assistantStore.js';

/**
 * 专题训练：一个知识点（真题标签）名下历年出现过的题，按年份从新到旧排成一列。
 *
 * 和整卷的区别只有一条：一题一交——选好 / 写好就能看这一题的答案和解析，不用等整个单元做完。
 * 题面、选项、解析、错题按钮的样式和卷面一致（复用 .paper / .unit / .q 那套）。
 * 作答记在服务端 exam_drill 表，与整卷的成绩互不影响；每题都能单独重做。
 */

const html = (s) => ({ __html: s || '' });
const KIND_SHORT = { 408: '408', math1: '数一', math2: '数二', math3: '数三' };
const PAGE = 30;

const DRILL_SUGS = [
  { t: '从哪儿下手', d: '先给思路提示，不直接给答案', p: '这道题从哪儿下手？先给我思路提示，别直接给出答案。' },
  { t: '检查我的作答', d: '看看我的过程哪一步有问题', p: '帮我检查一下我的作答，哪一步有问题？' },
  { t: '考的是什么', d: '知识点、公式和常见套路', p: '这道题考的是哪个知识点？相关的公式和常见套路是什么？' },
  { t: '出一道同类题', d: '照这个考法再练一道', p: '照这道题的考法，出一道同类型的题给我练，先别给答案。' },
];

const shortLabel = (it) => `${KIND_SHORT[it.kind] || it.kindLabel} ${it.year} · 第 ${it.n} 题`;

/* 每个专题加载到第几题：切走再回来接着看，不用一页页重新「继续加载」 */
const SHOWN_KEY = 'kb-drill-shown';
const shownMemo = new Map();
const shownOf = (key) => {
  if (!shownMemo.has(key)) { try { shownMemo.set(key, JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '{}')[key]); } catch { /* 无痕 */ } }
  return shownMemo.get(key) || PAGE;
};
const rememberShown = (key, n) => {
  shownMemo.set(key, n);
  try { sessionStorage.setItem(SHOWN_KEY, JSON.stringify({ ...JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '{}'), [key]: n })); } catch { /* 无痕 */ }
};

/* 没交的草稿存在本机：切去笔记、甚至关掉程序，回来还在；交了或重做就清掉。
   按题存（卷子:单元:题号），同一道题出现在两个专题里也是同一份草稿 */
const DRAFT = 'kb-drill-draft:';
const loadDraft = (id) => { try { return localStorage.getItem(DRAFT + id) || ''; } catch { return ''; } };
const saveDraft = (id, value) => {
  try { if (value) localStorage.setItem(DRAFT + id, value); else localStorage.removeItem(DRAFT + id); } catch { /* 无痕 */ }
};
/* 作答指纹：同一道题、作答没变，侧栏助手就不必把整道题再发一遍 */
const sigOf = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };

export default function Drill() {
  const { group } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tag = params.get('tag') || '';
  const { data, loading, error, reload } = useApi(() => api.drill(group, tag), [group, tag]);
  const [items, setItems] = useState(null);
  const [toast, setToast] = useState(null);
  // 大专题（一元函数微分学有近两百题）分批渲染，别一次把几百段 KaTeX 塞进页面
  const memoKey = `drill:${group}:${tag}`;
  const [shown, setShown] = useState(() => shownOf(memoKey));
  const scrollRef = useRef(null);

  // 跳去笔记再回来：加载到第几题、滚到哪儿都还原（先把题加载够，再滚回去）
  useEffect(() => { setItems(data && data.tag === tag ? data.items : null); setShown(shownOf(memoKey)); }, [data, tag, memoKey]);
  useEffect(() => { if (items) rememberShown(memoKey, shown); }, [items, memoKey, shown]);
  useScrollMemory(scrollRef, memoKey, !!items);

  const notify = useCallback((text, kind = '') => {
    const at = Date.now();
    setToast({ text, kind, at });
    setTimeout(() => setToast((t) => (t && t.at === at ? null : t)), 1800);
  }, []);

  const patch = useCallback((id, fn) => setItems((prev) => prev.map((it) => (it.id === id ? fn(it) : it))), []);

  const onAnswer = useCallback(async (it, answer) => {
    const out = await api.drillAnswer(it.exam, it.section.id, it.n, answer);
    patch(it.id, (x) => ({ ...x, attempt: out.attempt, key: out.key }));
    // 做题也算复习：对上的到期笔记已经记了一次
    if (out.reviewed?.length) notify(`已算作复习：${out.reviewed.map((r) => r.title).join('、')}`, 'md');
  }, [patch, notify]);

  const onReset = useCallback(async (it) => {
    await api.drillReset(it.exam, it.section.id, it.n);
    patch(it.id, (x) => ({ ...x, attempt: null, key: undefined, gen: (x.gen || 0) + 1 }));
  }, [patch]);

  // AI 批改 / 便利贴总结用助手那边选的模型
  const model = () => assistant.get().model || undefined;
  const onGrade = useCallback(async (it) => {
    const out = await api.drillGrade(it.exam, it.section.id, it.n, model());
    patch(it.id, (x) => ({ ...x, attempt: out.attempt }));
  }, [patch]);
  const onNoteSave = useCallback(async (it, note) => {
    const out = await api.saveDrillNote(it.exam, it.section.id, it.n, note);
    patch(it.id, (x) => ({ ...x, note: out.note }));
  }, [patch]);
  const onNoteAi = useCallback((it) => api.drillNoteAi(it.exam, it.section.id, it.n, model()), []);

  const onExport = useCallback(async (it) => {
    try {
      const out = await api.exportQuestion(it.exam, it.section.id, it.n, true);
      notify(out.added ? `已加入 ${out.file}${out.submitted ? '' : '（未作答，未附答案）'}` : `已经在 ${out.file} 里了`, 'md');
    } catch (err) { notify(err.message, 'err'); }
  }, [notify]);

  /* ── 侧栏助手要知道「正在做哪道题」 ──
     默认跟着阅读位置走：视口上方三成处压着的那道。点过、写过、问过的那道会被「钉住」，
     直到它整个滚出视野——不然一边写下面那道一边问，题号签却跳回上一道。 */
  const railRef = useRef(null);
  const drafts = useRef(new Map());
  const pinned = useRef(null);
  const raf = useRef(0);
  const [focusId, setFocusId] = useState(null);
  const [openSig, setOpenSig] = useState(0);
  const [focusSig, setFocusSig] = useState(0);

  const track = useCallback(() => {
    const box = scrollRef.current;
    if (!box || !items?.length) return;
    const top = box.getBoundingClientRect().top;
    const h = box.clientHeight;
    if (pinned.current) {
      const r = document.getElementById(`drill-${pinned.current}`)?.getBoundingClientRect();
      if (r && r.bottom > top + 40 && r.top < top + h - 40) return;
      pinned.current = null;
    }
    let cur = items[0].id;
    for (const it of items.slice(0, shown)) {
      const el = document.getElementById(`drill-${it.id}`);
      if (!el) continue;
      if (el.getBoundingClientRect().top - top <= h * 0.35) cur = it.id; else break;
    }
    setFocusId(cur);
  }, [items, shown]);
  useEffect(() => { track(); }, [track]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const onScroll = () => { cancelAnimationFrame(raf.current); raf.current = requestAnimationFrame(track); };

  const touch = useCallback((id) => { pinned.current = id; setFocusId(id); }, []);
  const ask = useCallback((id) => { touch(id); setOpenSig((n) => n + 1); setFocusSig((n) => n + 1); }, [touch]);
  const onDraft = useCallback((id, value) => { drafts.current.set(id, value); saveDraft(id, value); }, []);

  // 题单跟着当前题走：只滚题单自己，别带动外层
  useEffect(() => {
    const rail = railRef.current;
    const el = rail?.querySelector('.rail-item.cur');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = rail.getBoundingClientRect();
    const delta = r.top < b.top + 48 ? r.top - b.top - 48 : r.bottom > b.bottom - 24 ? r.bottom - b.bottom + 24 : 0;
    if (delta) rail.scrollBy({ top: delta, behavior: 'smooth' });
  }, [focusId]);

  const jump = (id) => {
    const i = items.findIndex((it) => it.id === id);
    if (i >= shown) setShown(Math.ceil((i + 1) / PAGE) * PAGE);
    touch(id);
    setTimeout(() => document.getElementById(`drill-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), i >= shown ? 120 : 0);
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !items) return <Loading />;

  const done = items.filter((it) => it.attempt).length;
  const gradable = items.filter((it) => it.section.type === 'choice');
  const right = gradable.filter((it) => it.attempt?.correct).length;
  const hue = group === 'math' ? 'math' : '408';

  const focusItem = items.find((it) => it.id === focusId) || null;
  const dockCtx = focusItem && { key: focusItem.id, label: shortLabel(focusItem) };
  const getContext = () => {
    const it = focusItem;
    if (!it) return null;
    const draft = it.attempt ? '' : String(drafts.current.get(it.id) || '');
    const answer = it.attempt ? String(it.attempt.answer ?? '') : draft;
    // 批改结果、便利贴变了也算「这道题变了」，助手要重新看一遍
    const sig = `${it.attempt ? 'a' : 'd'}${sigOf(`${answer}\u0000${it.attempt?.ai?.score ?? ''}\u0000${it.note?.text || ''}`)}`;
    return { exam: it.exam, section: it.section.id, n: it.n, label: shortLabel(it), key: it.id, sig, draft };
  };

  return (
    <div className="drill-wrap">
      <nav className={`toc paper-rail drill-rail hue-${hue}`} ref={railRef} aria-label="题单">
        <div className="toc-label drill-rail-h">
          <span>题单</span>
          <span className="fig">{done} / {items.length}</span>
        </div>
        {items.map((it, i) => {
          const a = it.attempt;
          const state = a ? (a.ai?.verdict === 'partial' ? 'part' : a.correct === false ? 'bad' : 'done') : 'new';
          return (
            <a key={it.id} href={`#drill-${it.id}`} className={`rail-item ${state}${it.id === focusId ? ' cur' : ''}`}
               aria-current={it.id === focusId ? 'true' : undefined}
               onClick={(e) => { e.preventDefault(); jump(it.id); }}>
              <i className="rail-dot" />
              <span className="rail-name">{i + 1}. {KIND_SHORT[it.kind] || it.kindLabel} {it.year} #{it.n}</span>
              <span className="rail-score fig">{a ? (a.ai ? `${a.ai.score}/${a.ai.total}` : a.correct == null ? '已交' : a.correct ? '✓' : '✗') : ''}</span>
            </a>
          );
        })}
      </nav>

      <div className="scroll paper-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="paper-layout solo">
          <article className={`paper paper-${group} drill`}>
            <header className="paper-head">
              <div className="rh-crumb">
                <button onClick={() => navigate('/resources')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>学习资源</button>
                {'　/　'}
                <button onClick={() => navigate(`/resources/tags/${group}?tag=${encodeURIComponent(tag)}`)} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>{data.label}</button>
                {'　/　'}专题训练
              </div>
              <h1 className="paper-title">
                {data.tag}
                <span className="paper-kind">{data.subject} · 专题训练</span>
              </h1>
              <div className="reader-meta">
                <span>历年 {data.total} 题 · 本地 {items.length} 题 · 已做 {done}</span>
                {gradable.length > 0 && <span>选择题答对 <b className="fig" style={{ color: 'var(--text)' }}>{right}</b> / {gradable.filter((it) => it.attempt).length}</span>}
                {data.missing > 0 && <span className="dim" style={{ fontSize: 11 }}>有 {data.missing} 题所在年份本地没有卷子</span>}
              </div>
            </header>

            {items.slice(0, shown).map((it, i) => (
              <div key={it.id} id={`drill-${it.id}`} className="unit-anchor">
                <DrillQuestion key={`${it.id}:${it.gen || 0}`} item={it} index={i + 1}
                               onAnswer={onAnswer} onReset={onReset} onExport={onExport}
                               onAsk={ask} onTouch={touch} onDraft={onDraft}
                               onGrade={onGrade} onNoteSave={onNoteSave} onNoteAi={onNoteAi}
                               onOpenPaper={() => navigate(`/resources/exam/${it.exam}?q=${it.n}`)} />
              </div>
            ))}
            {!items.length && <div className="empty">这个知识点的题所在年份本地都还没有卷子</div>}
            {shown < items.length && (
              <div className="unit-foot" style={{ justifyContent: 'center' }}>
                <button className="btn" onClick={() => setShown((n) => n + PAGE)}>继续加载　{Math.min(PAGE, items.length - shown)} 题（剩 {items.length - shown}）</button>
              </div>
            )}
          </article>

          {toast && <div className={`mark-toast ${toast.kind}`}>{toast.text}</div>}
        </div>
      </div>

      <AssistantDock context={dockCtx} getContext={getContext} suggestions={DRILL_SUGS}
                     openSignal={openSig} focusSignal={focusSig} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 一道题：选择 / 填空 / 解答，各自一交
 * ------------------------------------------------------------------ */

function Tags({ tags }) {
  if (!tags?.length) return null;
  return <span className="q-tags">{tags.map((t) => <span key={t} className="q-tag">{t}</span>)}</span>;
}

const VERDICT = { right: '全对', partial: '部分对', wrong: '错' };

function DrillQuestion({ item, index, onAnswer, onReset, onExport, onOpenPaper, onAsk, onTouch, onDraft, onGrade, onNoteSave, onNoteAi }) {
  const { section, question: q, attempt, key, note } = item;
  const locked = !!attempt;
  const gradable = section.type !== 'choice';
  const [mine, setMine] = useState(() => (attempt ? attempt.answer || '' : loadDraft(item.id)));
  const [busy, setBusy] = useState(false);
  // 答案与解析默认收起：以前交过的题回来翻，不至于一屏全是解析；刚交的这一道展开
  const [showExp, setShowExp] = useState(false);
  const [grading, setGrading] = useState(false);
  const [gradeErr, setGradeErr] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const paperLabel = `${KIND_SHORT[item.kind] || item.kindLabel} ${item.year} · ${section.title} 第 ${item.n} 题`;
  const pts = section.points == null ? null : section.type === 'free' ? section.points : Math.round((section.points / section.count) * 10) / 10;
  // 没交的草稿报给页面：侧栏助手问到这道题时一起带上，也存到本机；交了就清掉
  useEffect(() => { onDraft(item.id, locked ? '' : mine); }, [onDraft, item.id, mine, locked]);
  // 点过、写过的这道就是「正在做的题」
  const unit = {
    className: `unit${locked ? ' locked' : ''}`,
    onPointerDownCapture: () => onTouch(item.id),
    onFocusCapture: () => onTouch(item.id),
  };

  const grade = async () => {
    setGrading(true);
    setGradeErr('');
    try { await onGrade(item); } catch (e) { setGradeErr(e.message); } finally { setGrading(false); }
  };
  const submit = async (value = mine) => {
    setBusy(true);
    let ok = false;
    try { await onAnswer(item, value); setShowExp(true); ok = true; } catch (e) { window.alert(e.message); } finally { setBusy(false); }
    // 填空 / 解答题交了就让 AI 批改；空着交（只是想看答案）就不批
    if (ok && gradable && String(value).trim()) grade();
  };
  const reset = async () => {
    setBusy(true);
    setGradeErr('');
    try { await onReset(item); } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };

  const head = (
    <div className="unit-head">
      <button className="unit-title unit-title-link" onClick={onOpenPaper} title="在卷面里看这道题">
        <span className="fig dim" style={{ marginRight: 10 }}>{String(index).padStart(2, '0')}</span>{paperLabel}
      </button>
      {pts != null && <span className="unit-pts">{pts} 分</span>}
      <span className="spacer" />
      <button className="paper-link ask-link" onClick={() => onAsk(item.id)} title="在右边的助手里问这道题">✦ 问助手</button>
      {!note && !noteOpen && (
        <button className="paper-link ask-link" onClick={() => setNoteOpen(true)} title="给这道题贴一张便利贴，写做完后的总结">便利贴</button>
      )}
      {attempt && <button className="q-md-btn" title="加入错题本（Markdown）" onClick={() => onExport(item)}>错题</button>}
    </div>
  );

  const ai = attempt?.ai;
  const score = () => {
    if (!gradable) {
      return attempt.correct ? <b>✓ 答对了</b> : <><b>✗ 答错了</b><em>　正确答案 {key?.answer}</em></>;
    }
    if (grading) return <b className="ai-wait">AI 批改中<i /><i /><i /></b>;
    if (ai) {
      return (
        <>
          <b className={`ai-score v-${ai.verdict}`}>{ai.score}<small>/{ai.total}</small></b>
          <span className={`ai-verdict v-${ai.verdict}`}>{VERDICT[ai.verdict]}</span>
          <span className="ai-brief" title={ai.brief}>{ai.brief}</span>
        </>
      );
    }
    if (gradeErr) return <><b>已提交</b><em className="ai-err" title={gradeErr}>　AI 批改没成功：{gradeErr}</em></>;
    return <><b>已提交</b><em>　{String(attempt.answer || '').trim() ? '对照参考答案自评' : '没写作答'}</em></>;
  };

  const foot = () => (
    attempt
      ? (
        <>
          <div className="unit-foot done">
            <span className="unit-score">{score()}</span>
            <span className="spacer" />
            <span className="unit-acts">
              <button className="btn sm ghost" onClick={() => setShowExp((v) => !v)}>{showExp ? '收起解析' : '看解析'}</button>
              {gradable && String(attempt.answer || '').trim() && !grading && (
                <button className="btn sm ghost" onClick={grade} title="让 AI 按考研口径打分、判对错">{ai ? '重新批改' : 'AI 批改'}</button>
              )}
              <button className="btn sm" disabled={busy || grading} onClick={reset}>重做</button>
            </span>
          </div>
          {showExp && ai?.points?.length > 0 && (
            <ul className="ai-points">{ai.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
          )}
        </>
      ) : (
        <div className="unit-foot">
          <span className="spacer" />
          <button className="btn primary" disabled={busy || (section.type !== 'free' && !String(mine).trim())} onClick={() => submit()}>
            看答案　→
          </button>
        </div>
      )
  );

  const sticky = (note || noteOpen) && (
    <DrillNote item={item} note={note} autoEdit={noteOpen && !note}
               onSave={onNoteSave} onAi={onNoteAi} onClose={() => setNoteOpen(false)} />
  );

  if (section.type === 'choice') {
    const right = key?.answer;
    return (
      <section {...unit}>
        {head}
        {q.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(q.directions)} />}
        <div className="q-list">
          <div className={`q${key ? (mine === right ? ' ok' : ' bad') : ''}`}>
            <div className="q-stem">
              <span className="q-n fig">{q.n}.</span>
              <div className="q-stem-body paper-body" dangerouslySetInnerHTML={html(q.stem)} />
            </div>
            <div className="q-row">
              <div className="q-opts">
                {q.options.map((o) => {
                  const cls = ['opt'];
                  if (mine === o.k) cls.push('on');
                  if (key) { if (o.k === right) cls.push('right'); else if (mine === o.k) cls.push('wrong'); }
                  return (
                    <button key={o.k} className={cls.join(' ')} disabled={locked} onClick={() => setMine((m) => (m === o.k ? '' : o.k))}>
                      <i className="opt-k">{o.k}</i>
                      <span className="opt-t" dangerouslySetInnerHTML={html(o.text)} />
                    </button>
                  );
                })}
              </div>
            </div>
            {key && showExp && (
              <div className="q-exp">
                <div className="q-exp-a">
                  正确答案 <b>{right}</b>{mine && mine !== right && <>　你选了 <s>{mine}</s></>}
                  <Tags tags={key.tags} />
                </div>
                {key.explanation
                  ? <div className="paper-body" dangerouslySetInnerHTML={html(key.explanation)} />
                  : <div className="dim">题源暂无解析</div>}
              </div>
            )}
          </div>
        </div>
        {foot()}
        {sticky}
      </section>
    );
  }

  if (section.type === 'fill') {
    return (
      <section {...unit}>
        {head}
        <div className="q-list">
          <div className="q">
            <div className="q-stem">
              <span className="q-n fig">{q.n}.</span>
              <div className="q-stem-body paper-body" dangerouslySetInnerHTML={html(q.stem)} />
            </div>
            <div className="fill-row">
              <input className="fill-input" value={mine} readOnly={locked} placeholder="答案"
                     onChange={(e) => setMine(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter' && mine.trim() && !locked) submit(); }} />
            </div>
            {key && showExp && (
              <div className="q-exp">
                <div className="q-exp-a">参考答案<Tags tags={key.tags} /></div>
                {key.solution
                  ? <div className="paper-body" dangerouslySetInnerHTML={html(key.solution)} />
                  : <div className="dim">题源暂无参考答案</div>}
              </div>
            )}
          </div>
        </div>
        {foot()}
        {sticky}
      </section>
    );
  }

  // 解答题
  return (
    <section {...unit}>
      {head}
      {q.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(q.directions)} />}
      <div className="paper-body" dangerouslySetInnerHTML={html(q.body)} />
      <div className="paper-answer">
        <div className="paper-answer-h">
          <span className="lbl">ANSWER SHEET</span>
          <span className="dim" style={{ fontSize: 11 }}>{splitAnswer(mine).text.length} 字</span>
        </div>
        <AnswerSheet value={mine} locked={locked} onChange={setMine}
                     onLockedImages={async (images) => {
                       const out = await api.setDrillImages(item.exam, section.id, item.n, images);
                       setMine(out.answer);
                       return out.answer;
                     }}
                     placeholder="在这里作答；平板上手写的过程截个图，直接 Ctrl+V 贴进来…" />
      </div>
      {foot()}
      {key && showExp && (
        <div className="paper-ref">
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <span className="lbl">REFERENCE · 参考答案与解析</span>
            <Tags tags={key.tags} />
          </div>
          {key.solution
            ? <div className="paper-ref-body" dangerouslySetInnerHTML={html(key.solution)} />
            : <div className="paper-ref-body dim">题源暂无参考答案</div>}
        </div>
      )}
      {sticky}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 做题便利贴：贴在题目下面，写做完后的总结
 *
 * 和笔记里的便利贴同一套纸色（颜色即语义：黄 疑问 / 蓝 推导 / 绿 结论 / 红 易错），
 * 同一套写法（$公式$、**粗**、- 条目）。点一下改，点外面存；清空就是撕掉。
 * 「AI 总结」让 AI 写两三行：做题关键、易错点、错因，接在已有内容后面，可以再改。
 * ------------------------------------------------------------------ */

function DrillNote({ item, note, autoEdit, onSave, onAi, onClose }) {
  const [text, setText] = useState(note?.text || '');
  const [color, setColor] = useState(note?.color || 'y');
  const [editing, setEditing] = useState(!!autoEdit);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const card = useRef(null);
  const ta = useRef(null);
  const saved = useRef({ text: note?.text || '', color: note?.color || 'y' });

  useEffect(() => { if (editing) ta.current?.focus(); }, [editing]);
  // 跟着字数长高
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, editing]);

  const save = async (next) => {
    if (next.text === saved.current.text && next.color === saved.current.color) return;
    if (!next.text.trim() && !saved.current.text.trim()) return;   // 从没写过字：不用去库里删
    setErr('');
    try {
      await onSave(item, next);
      saved.current = next;
    } catch (e) { setErr(e.message); }
  };
  const finish = async () => {
    setEditing(false);
    await save({ text, color });
    if (!text.trim()) onClose();   // 清空了就是撕掉
  };
  const pick = (c) => {
    setColor(c);
    if (text.trim()) save({ text, color: c });
    if (editing) ta.current?.focus();
  };
  const summarize = async () => {
    setBusy(true);
    setErr('');
    try {
      const out = await onAi(item);
      const next = text.trim() ? `${text.trim()}\n${out.text}` : out.text;
      setText(next);
      setEditing(false);
      await save({ text: next, color });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const tear = async () => {
    if (text.trim() && !window.confirm('撕掉这张便利贴？')) return;
    setText('');
    setEditing(false);
    await save({ text: '', color });
    onClose();
  };

  const tag = SN_COLORS.find((c) => c.k === color);
  return (
    <div className={`dnote c-${color}${editing ? ' editing' : ''}`} ref={card}>
      <div className="dnote-bar">
        <span className="dnote-lbl">{tag?.label || '便利贴'}</span>
        <span className="spacer" />
        <span className="dnote-sws">
          {SN_COLORS.map((c) => (
            <button key={c.k} className={`dnote-sw c-${c.k}${color === c.k ? ' on' : ''}`} title={`${c.label}：${c.hint}`}
                    aria-label={c.label} onClick={() => pick(c.k)} />
          ))}
        </span>
        <button className="dnote-btn" disabled={busy} onClick={summarize} title="让 AI 写两三行：做题关键、易错点、错因">
          {busy ? 'AI 在写…' : '✦ AI 总结'}
        </button>
        <button className="dnote-btn x" onClick={tear} title="撕掉" aria-label="撕掉">×</button>
      </div>
      {editing ? (
        <textarea ref={ta} className="dnote-ta" value={text} rows={3}
                  placeholder="这题的关键一步、容易错的地方、这次为什么错……支持 $公式$、**粗体**、- 条目"
                  onChange={(e) => setText(e.target.value)}
                  onBlur={(e) => { if (!card.current?.contains(e.relatedTarget)) finish(); }}
                  onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finish(); } }} />
      ) : (
        <div className="dnote-body sn-rich" role="button" tabIndex={0} title="点一下修改"
             onClick={() => setEditing(true)}
             onKeyDown={(e) => { if (e.key === 'Enter') setEditing(true); }}
             dangerouslySetInnerHTML={{ __html: text.trim() ? renderSticky(text) : '<span class="dnote-empty">点这里写总结…</span>' }} />
      )}
      {err && <div className="dnote-err">{err}</div>}
    </div>
  );
}
