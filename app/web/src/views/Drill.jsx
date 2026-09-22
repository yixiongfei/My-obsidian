import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';
import AnswerSheet, { splitAnswer } from '../components/AnswerSheet.jsx';

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

export default function Drill() {
  const { group } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tag = params.get('tag') || '';
  const { data, loading, error, reload } = useApi(() => api.drill(group, tag), [group, tag]);
  const [items, setItems] = useState(null);
  const [toast, setToast] = useState(null);
  // 大专题（一元函数微分学有近两百题）分批渲染，别一次把几百段 KaTeX 塞进页面
  const [shown, setShown] = useState(PAGE);
  const scrollRef = useRef(null);

  useEffect(() => { setItems(data && data.tag === tag ? data.items : null); setShown(PAGE); }, [data, tag]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [tag]);

  const notify = useCallback((text, kind = '') => {
    const at = Date.now();
    setToast({ text, kind, at });
    setTimeout(() => setToast((t) => (t && t.at === at ? null : t)), 1800);
  }, []);

  const patch = useCallback((id, fn) => setItems((prev) => prev.map((it) => (it.id === id ? fn(it) : it))), []);

  const onAnswer = useCallback(async (it, answer) => {
    const out = await api.drillAnswer(it.exam, it.section.id, it.n, answer);
    patch(it.id, (x) => ({ ...x, attempt: out.attempt, key: out.key }));
  }, [patch]);

  const onReset = useCallback(async (it) => {
    await api.drillReset(it.exam, it.section.id, it.n);
    patch(it.id, (x) => ({ ...x, attempt: null, key: undefined, gen: (x.gen || 0) + 1 }));
  }, [patch]);

  const onExport = useCallback(async (it) => {
    try {
      const out = await api.exportQuestion(it.exam, it.section.id, it.n, true);
      notify(out.added ? `已加入 ${out.file}${out.submitted ? '' : '（未作答，未附答案）'}` : `已经在 ${out.file} 里了`, 'md');
    } catch (err) { notify(err.message, 'err'); }
  }, [notify]);

  const jump = (id) => {
    const i = items.findIndex((it) => it.id === id);
    if (i >= shown) setShown(Math.ceil((i + 1) / PAGE) * PAGE);
    setTimeout(() => document.getElementById(`drill-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), i >= shown ? 120 : 0);
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !items) return <Loading />;

  const done = items.filter((it) => it.attempt).length;
  const gradable = items.filter((it) => it.section.type === 'choice');
  const right = gradable.filter((it) => it.attempt?.correct).length;
  const hue = group === 'math' ? 'math' : '408';

  return (
    <div className="scroll paper-scroll" ref={scrollRef}>
      <div className="paper-layout">
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

        <nav className={`toc paper-rail hue-${hue}`}>
          <div className="toc-label">题单</div>
          {items.map((it, i) => {
            const a = it.attempt;
            const state = a ? (a.correct === false ? 'bad' : 'done') : 'new';
            return (
              <a key={it.id} href={`#drill-${it.id}`} className={`rail-item ${state}`}
                 onClick={(e) => { e.preventDefault(); jump(it.id); }}>
                <i className="rail-dot" />
                <span className="rail-name">{i + 1}. {KIND_SHORT[it.kind] || it.kindLabel} {it.year} #{it.n}</span>
                <span className="rail-score fig">{a ? (a.correct == null ? '已交' : a.correct ? '✓' : '✗') : ''}</span>
              </a>
            );
          })}
          <div className="rail-total">
            <span>已做</span>
            <span className="fig">{done} / {items.length}</span>
          </div>
        </nav>
      </div>
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

function DrillQuestion({ item, index, onAnswer, onReset, onExport, onOpenPaper }) {
  const { section, question: q, attempt, key } = item;
  const locked = !!attempt;
  const [mine, setMine] = useState(attempt?.answer || '');
  const [busy, setBusy] = useState(false);
  const [showExp, setShowExp] = useState(!!attempt);
  const paperLabel = `${KIND_SHORT[item.kind] || item.kindLabel} ${item.year} · ${section.title} 第 ${item.n} 题`;

  const submit = async (value = mine) => {
    setBusy(true);
    try { await onAnswer(item, value); setShowExp(true); } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true);
    try { await onReset(item); } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };

  const head = (
    <div className="unit-head">
      <span className="unit-title"><span className="fig dim" style={{ marginRight: 10 }}>{String(index).padStart(2, '0')}</span>{paperLabel}</span>
      {section.points != null && <span className="unit-pts">{section.type === 'free' ? `${section.points} 分` : `${Math.round((section.points / section.count) * 10) / 10} 分`}</span>}
      <span className="spacer" />
      <button className="paper-link" onClick={onOpenPaper}>在卷面里看</button>
      {attempt && <button className="q-md-btn" title="加入错题本（Markdown）" onClick={() => onExport(item)}>错题</button>}
    </div>
  );

  const foot = () => (
    attempt
      ? (
        <div className="unit-foot done">
          <span className="unit-score">
            {attempt.correct == null
              ? <><b>已提交</b><em>　对照参考答案自评</em></>
              : attempt.correct ? <><b>✓ 答对了</b></> : <><b>✗ 答错了</b><em>　正确答案 {key?.answer}</em></>}
          </span>
          <span className="spacer" />
          {section.type === 'choice' && (
            <button className="btn sm ghost" onClick={() => setShowExp((v) => !v)}>{showExp ? '收起解析' : '看解析'}</button>
          )}
          <button className="btn sm" disabled={busy} onClick={reset}>重做</button>
        </div>
      ) : (
        <div className="unit-foot">
          <span className="spacer" />
          <button className="btn primary" disabled={busy || (section.type !== 'free' && !String(mine).trim())} onClick={() => submit()}>
            看答案　→
          </button>
        </div>
      )
  );

  if (section.type === 'choice') {
    const right = key?.answer;
    return (
      <section className={`unit${locked ? ' locked' : ''}`}>
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
      </section>
    );
  }

  if (section.type === 'fill') {
    return (
      <section className={`unit${locked ? ' locked' : ''}`}>
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
            {key && (
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
      </section>
    );
  }

  // 解答题
  return (
    <section className={`unit${locked ? ' locked' : ''}`}>
      {head}
      {q.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(q.directions)} />}
      <div className="paper-body" dangerouslySetInnerHTML={html(q.body)} />
      <div className="paper-answer">
        <div className="paper-answer-h">
          <span className="lbl">ANSWER SHEET</span>
          <span className="dim" style={{ fontSize: 11 }}>{splitAnswer(mine).text.length} 字</span>
        </div>
        <AnswerSheet value={mine} locked={locked} onChange={setMine}
                     placeholder="在这里作答，或把平板上手写的过程截图粘贴进来…" />
      </div>
      {foot()}
      {key && (
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
    </section>
  );
}
