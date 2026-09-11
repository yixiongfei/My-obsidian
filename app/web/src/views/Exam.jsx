import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';
import { useWordMarks } from '../wordmarks.js';

/**
 * 一张真卷。按真题的版式铺：
 *   英语  Section I 完形 → Section II 阅读 Part A/B/C → Section III 写作
 *   408   一、单项选择题（按四门拆成四块）→ 二、综合应用题（逐题）
 *   数学  一、选择题 → 二、填空题 → 三、解答题（逐题）
 *
 * 单元是交卷的最小粒度：一个单元里做到一半看不到任何答案，「交卷」之后答案与解析
 * 才从服务端下来。草稿边做边存（防抖 400ms），刷新不丢。
 * 带 ?q=题号 打开时滚到那道题（真题标签页跳过来的）。
 * 英语卷里双击一个词就标进词汇库：考研词表内画红线，词表外建自定义词画蓝线。
 */

const fmt = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));
const html = (s) => ({ __html: s || '' });

const PAPER_NAME = {
  english1: '英语（一）', english2: '英语（二）',
  408: '计算机学科专业基础综合',
  math1: '数学（一）', math2: '数学（二）', math3: '数学（三）',
};

/** 一个单元里包含的题号，给 ?q= 跳转用 */
const numbersOf = (s) => (s.questions ? s.questions.map((q) => q.n) : s.numbers || []);

export default function Exam() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // 真题内容不跟 vault 变化走，只按 id 取一次；重取会冲掉正在写的草稿
  const { data, loading, error, reload } = useApi(() => api.exam(id), [id]);
  const [sections, setSections] = useState(null);
  const [gen, setGen] = useState({}); // 重做计数：让单元组件整个重挂载
  const scrollRef = useRef(null);
  const articleRef = useRef(null);
  const jumpedTo = useRef('');
  const isEnglish = data?.group === 'english' && data.id === id;
  const { toast: markToast, onDoubleClick: onMarkWord } = useWordMarks(articleRef, isEnglish, id);

  // 换卷子时 useApi 会先保留上一份数据再去取新的，别把旧卷子当新卷子渲染（?q= 跳转也会跳错）
  useEffect(() => { setSections(data && data.id === id ? data.sections : null); }, [data, id]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); jumpedTo.current = ''; }, [id]);

  // ?q=10 → 滚到第 10 题所在位置
  const wantQ = Number(params.get('q')) || 0;
  useEffect(() => {
    if (!sections || !wantQ || jumpedTo.current === `${id}:${wantQ}`) return;
    const unit = sections.find((s) => numbersOf(s).includes(wantQ));
    if (!unit) return;
    jumpedTo.current = `${id}:${wantQ}`;
    const t = setTimeout(() => {
      const el = document.getElementById(`q-${unit.id}-${wantQ}`) || document.getElementById(`unit-${unit.id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.classList.add('q-flash');
      setTimeout(() => el?.classList.remove('q-flash'), 2400);
    }, 120);
    return () => clearTimeout(t);
  }, [sections, wantQ, id]);

  const patch = useCallback((sid, fn) => {
    setSections((prev) => prev.map((s) => (s.id === sid ? fn(s) : s)));
  }, []);

  const onSubmit = useCallback(async (sid, answers) => {
    const out = await api.submitExam(id, sid, answers);
    patch(sid, (s) => ({ ...s, attempt: out.attempt, key: out.key }));
    return out;
  }, [id, patch]);

  const onReset = useCallback(async (sid) => {
    await api.resetExam(id, sid);
    patch(sid, (s) => ({ ...s, attempt: null, key: undefined }));
    setGen((g) => ({ ...g, [sid]: (g[sid] || 0) + 1 }));
  }, [id, patch]);

  const jump = useCallback((sid) => {
    document.getElementById(`unit-${sid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !sections) return <Loading />;

  const graded = sections.filter((s) => s.attempt?.submittedAt && s.attempt.score != null);
  const objTotal = sections.filter((s) => s.type === 'choice' || (s.type === 'match' && s.gradable)).reduce((a, s) => a + s.points, 0);
  const objScore = graded.reduce((a, s) => a + s.attempt.score, 0);
  const submitted = sections.filter((s) => s.attempt?.submittedAt).length;
  const groupLabel = data.group === 'english' ? '英语历年真题' : data.group === 'math' ? '数学历年真题' : '408 历年真题';
  const tagGroup = data.group === 'math' ? 'math' : data.group === '408' ? '408' : null;

  const props = { examId: id, onSubmit, onReset };
  const Unit = { choice: ChoiceUnit, match: MatchUnit, free: FreeUnit, fill: FillUnit };

  return (
    <div className="scroll paper-scroll" ref={scrollRef}>
      <div className="paper-layout">
        <article className={`paper paper-${data.group}`} ref={articleRef} onDoubleClick={isEnglish ? onMarkWord : undefined}>
          <header className="paper-head">
            <div className="rh-crumb">
              <button onClick={() => navigate('/resources')} style={{ color: 'var(--dim)', letterSpacing: 'inherit' }}>学习资源</button>
              {'　/　'}{groupLabel}{'　/　'}{data.kindLabel}
            </div>
            <h1 className="paper-title">
              <span className="fig">{data.year}</span> 年全国硕士研究生招生考试
              <span className="paper-kind">{PAPER_NAME[data.kind] || data.kindLabel}</span>
            </h1>
            <div className="reader-meta">
              <span>{sections.length} 个单元 · 已交 {submitted}</span>
              <span>客观题 <b className="fig" style={{ color: 'var(--text)' }}>{fmt(objScore)}</b> / {objTotal}</span>
              {tagGroup && <button className="paper-link" onClick={() => navigate(`/resources/tags/${tagGroup}`)}>知识点标签</button>}
              {isEnglish && <span className="dim" style={{ fontSize: 11 }}>双击单词加入生词本 · <i className="vmark-demo ky">红线</i> 考研词表 · <i className="vmark-demo own">蓝线</i> 词表外</span>}
              <a href={data.source} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>题源 ↗</a>
            </div>
          </header>

          {sections.map((s) => {
            const Comp = Unit[s.type];
            return (
              <div key={s.id} id={`unit-${s.id}`} className="unit-anchor">
                {s.heading && <h2 className="paper-section-h">{s.heading}</h2>}
                {Comp && <Comp key={`${s.id}:${gen[s.id] || 0}`} section={s} {...props} />}
              </div>
            );
          })}
        </article>

        {markToast && <div className={`mark-toast ${markToast.kind}`}>{markToast.text}</div>}

        <nav className="toc paper-rail">
          <div className="toc-label">答题卡</div>
          {sections.map((s) => {
            const a = s.attempt;
            const state = a?.submittedAt ? 'done' : a && Object.keys(a.answers || {}).length ? 'doing' : 'new';
            return (
              <a key={s.id} href={`#unit-${s.id}`} className={`rail-item ${state}`}
                 onClick={(e) => { e.preventDefault(); jump(s.id); }}>
                <i className="rail-dot" />
                <span className="rail-name">{s.label}</span>
                <span className="rail-score fig">
                  {a?.submittedAt ? (a.score == null ? '已交' : `${fmt(a.score)}/${s.points}`) : ''}
                </span>
              </a>
            );
          })}
          <div className="rail-total">
            <span>客观题</span>
            <span className="fig">{fmt(objScore)} / {objTotal}</span>
          </div>
        </nav>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 草稿自动保存
 * ------------------------------------------------------------------ */

function useDraft(examId, section) {
  const [answers, setAnswers] = useState(() => section.attempt?.answers || {});
  const timer = useRef(null);
  const pending = useRef(null);
  const locked = !!section.attempt?.submittedAt;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!pending.current) return;
    const payload = pending.current;
    pending.current = null;
    api.saveExamDraft(examId, section.id, payload).catch(() => { /* 草稿丢了下次再写，别打断作答 */ });
  }, [examId, section.id]);

  const update = useCallback((fn) => {
    if (locked) return;
    setAnswers((prev) => {
      const next = typeof fn === 'function' ? fn(prev) : fn;
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 400);
      return next;
    });
  }, [locked, flush]);

  // 离开页面前把没写完的草稿冲掉
  useEffect(() => flush, [flush]);

  return [answers, update, flush, locked];
}

function useSubmit(section, answers, flush, onSubmit) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { flush(); await onSubmit(section.id, answers); } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  };
  return [submit, busy];
}

/* ------------------------------------------------------------------ *
 * 单元外壳：标题行 + 交卷 / 成绩 / 重做
 * ------------------------------------------------------------------ */

function UnitHead({ section }) {
  return (
    <div className="unit-head">
      <span className="unit-title">{section.title || section.label}</span>
      {section.points != null && <span className="unit-pts">{section.points} 分</span>}
    </div>
  );
}

function UnitFoot({ section, unanswered, count, free = false, onSubmit, onReset, busy, children }) {
  const a = section.attempt;
  if (a?.submittedAt) {
    return (
      <div className="unit-foot done">
        {a.score != null
          ? <span className="unit-score"><b className="fig">{fmt(a.score)}</b> / {section.points}{count ? <em>　答对 {Math.round(a.score / (section.points / count))} / {count}</em> : null}</span>
          : <span className="unit-score"><b>已提交</b><em>　{free ? '对照参考答案自评' : '请对照解析自评'}</em></span>}
        <span className="spacer" />
        {children}
        <button className="btn sm" disabled={busy}
                onClick={() => onReset(section.id)}>
          重做
        </button>
      </div>
    );
  }
  const hint = unanswered > 0
    ? (free ? '还没有作答' : `还有 ${unanswered} 题未作答`)
    : (free ? '' : '已全部作答');
  const warn = free ? '还没写内容，直接提交查看参考答案？' : `还有 ${unanswered} 题未作答，未答按错计。确定交卷？`;
  return (
    <div className="unit-foot">
      <span className="dim" style={{ fontSize: 12 }}>{hint}</span>
      <span className="spacer" />
      <button className="btn primary" disabled={busy}
              onClick={() => { if (unanswered > 0 && !window.confirm(warn)) return; onSubmit(); }}>
        {free ? '提交，看参考答案　→' : '交卷　→'}
      </button>
    </div>
  );
}

/** 知识点标签：交卷后才露出来，交卷前它也算提示 */
function Tags({ tags }) {
  if (!tags?.length) return null;
  return (
    <span className="q-tags">
      {tags.map((t) => <span key={t} className="q-tag">{t}</span>)}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * 选择题单元：完形（正文带空）、阅读（正文 + 题干）、408 / 数学（题干可能带代码和公式）
 * ------------------------------------------------------------------ */

function ChoiceUnit({ section, examId, onSubmit, onReset }) {
  const [answers, update, flush, locked] = useDraft(examId, section);
  const [submit, busy] = useSubmit(section, answers, flush, onSubmit);
  const [open, setOpen] = useState(() => new Set());
  const key = section.key;
  const isCloze = section.id === 'cloze';

  const unanswered = section.questions.filter((q) => !answers[q.n]).length;
  const choose = (n, k) => update((prev) => ({ ...prev, [n]: prev[n] === k ? undefined : k }));
  const toggle = (n) => setOpen((s) => { const next = new Set(s); next.has(n) ? next.delete(n) : next.add(n); return next; });
  const allOpen = open.size >= section.questions.length;
  const toggleAll = () => setOpen(allOpen ? new Set() : new Set(section.questions.map((q) => q.n)));
  const jumpTo = (n) => document.getElementById(`q-${section.id}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <section className={`unit${locked ? ' locked' : ''}`}>
      <UnitHead section={section} />
      {section.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(section.directions)} />}

      {section.passage?.length > 0 && (
        <Passage passage={section.passage} answers={answers} questions={section.questions} keyAnswers={key?.answers} onJump={jumpTo} />
      )}

      <div className={`q-list${isCloze ? ' cloze' : ''}`}>
        {section.questions.map((q) => {
          const mine = answers[q.n];
          const right = key?.answers[q.n];
          return (
            <div key={q.n} id={`q-${section.id}-${q.n}`} className={`q${key ? (mine === right ? ' ok' : ' bad') : ''}`}>
              {q.stem && (
                <div className="q-stem">
                  <span className="q-n fig">{q.n}.</span>
                  <div className="q-stem-body paper-body" dangerouslySetInnerHTML={html(q.stem)} />
                </div>
              )}
              <div className={`q-row${q.stem ? '' : ' inline'}`}>
                {!q.stem && <span className="q-n fig">{q.n}.</span>}
                <div className={`q-opts${isCloze ? ' cols4' : ''}`}>
                  {q.options.map((o) => {
                    const cls = ['opt'];
                    if (mine === o.k) cls.push('on');
                    if (key) {
                      if (o.k === right) cls.push('right');
                      else if (mine === o.k) cls.push('wrong');
                    }
                    return (
                      <button key={o.k} className={cls.join(' ')} disabled={locked} onClick={() => choose(q.n, o.k)}>
                        <i className="opt-k">{o.k}</i>
                        <span className="opt-t" dangerouslySetInnerHTML={html(o.text)} />
                      </button>
                    );
                  })}
                </div>
                {key && (
                  <button className={`q-exp-btn${open.has(q.n) ? ' on' : ''}`} onClick={() => toggle(q.n)}>
                    {mine === right ? '✓' : mine ? '✗' : '—'}　解析
                  </button>
                )}
              </div>
              {key && open.has(q.n) && (
                <div className="q-exp">
                  <div className="q-exp-a">
                    正确答案 <b>{right}</b>{mine && mine !== right && <>　你选了 <s>{mine}</s></>}
                    <Tags tags={key.tags?.[q.n]} />
                  </div>
                  <div className="paper-body" dangerouslySetInnerHTML={html(key.explanations[q.n])} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <UnitFoot section={section} unanswered={unanswered} count={section.questions.length}
                onSubmit={submit} onReset={onReset} busy={busy}>
        {key && <button className="btn sm ghost" onClick={toggleAll}>{allOpen ? '收起解析' : '展开全部解析'}</button>}
      </UnitFoot>

      {key?.extras?.length > 0 && (
        <details className="paper-extra">
          <summary>{key.extras[0].title}{key.extras.length > 1 ? ` 等 ${key.extras.length} 项` : ''}</summary>
          {key.extras.map((x, i) => <div key={i} className="paper-ref-body" dangerouslySetInnerHTML={html(x.html)} />)}
        </details>
      )}
    </section>
  );
}

/** 正文。完形的段落被拆成片段，空格处画一条下划线，选了答案就把词写上去 */
function Passage({ passage, answers, questions, keyAnswers, onJump }) {
  const wordOf = useMemo(() => {
    const m = new Map();
    for (const q of questions) for (const o of q.options) m.set(`${q.n}${o.k}`, o.text);
    return (n, k) => (k ? m.get(`${n}${k}`) : null);
  }, [questions]);

  return (
    <div className="paper-passage">
      {passage.map((p, i) => (
        p.html
          ? <div key={i} dangerouslySetInnerHTML={html(p.html)} />
          : (
            <p key={i}>
              {p.segs.map((seg, j) => (typeof seg === 'string'
                ? <span key={j} dangerouslySetInnerHTML={html(seg)} />
                : (
                  <Blank key={j} n={seg.n} mine={answers[seg.n]} word={wordOf(seg.n, answers[seg.n])}
                         right={keyAnswers ? keyAnswers[seg.n] : null}
                         rightWord={keyAnswers ? wordOf(seg.n, keyAnswers[seg.n]) : null}
                         onClick={() => onJump(seg.n)} />
                )))}
            </p>
          )
      ))}
    </div>
  );
}

function Blank({ n, mine, word, right, rightWord, onClick }) {
  const graded = right != null;
  const cls = ['blank'];
  if (mine) cls.push('on');
  if (graded) cls.push(mine === right ? 'right' : 'wrong');
  return (
    <button className={cls.join(' ')} onClick={onClick} title={`第 ${n} 题`}>
      <sup className="fig">{n}</sup>
      {graded && mine && mine !== right && <s dangerouslySetInnerHTML={html(word)} />}
      {graded
        ? <span dangerouslySetInnerHTML={html(rightWord || '')} />
        : word ? <span dangerouslySetInnerHTML={html(word)} /> : <span className="bl-empty" />}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 新题型：题面照排，答题卡在下面
 * ------------------------------------------------------------------ */

function MatchUnit({ section, examId, onSubmit, onReset }) {
  const [answers, update, flush, locked] = useDraft(examId, section);
  const [submit, busy] = useSubmit(section, answers, flush, onSubmit);
  const key = section.key;
  const letters = section.letters || ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const unanswered = section.numbers.filter((n) => !answers[n]).length;

  return (
    <section className={`unit${locked ? ' locked' : ''}`}>
      <UnitHead section={section} />
      {section.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(section.directions)} />}
      <div className="paper-body" dangerouslySetInnerHTML={html(section.body)} />

      <div className="sheet">
        {section.numbers.map((n, i) => {
          const mine = answers[n];
          const right = key?.answers ? key.answers[i] : null;
          return (
            <div key={n} id={`q-${section.id}-${n}`} className={`sheet-row${right ? (mine === right ? ' ok' : ' bad') : ''}`}>
              <span className="q-n fig">{n}.</span>
              <div className="sheet-letters">
                {letters.map((k) => {
                  const cls = ['opt', 'sq'];
                  if (mine === k) cls.push('on');
                  if (right) { if (k === right) cls.push('right'); else if (mine === k) cls.push('wrong'); }
                  return (
                    <button key={k} className={cls.join(' ')} disabled={locked}
                            onClick={() => update((prev) => ({ ...prev, [n]: prev[n] === k ? undefined : k }))}>
                      {k}
                    </button>
                  );
                })}
              </div>
              {right && <span className="sheet-mark">{mine === right ? '✓' : `✗ 正确 ${right}`}</span>}
            </div>
          );
        })}
        {key && !key.answers && (
          <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>这一年的答案格式没法自动判分，请对照下面的解析自评。</div>
        )}
      </div>

      <UnitFoot section={section} unanswered={unanswered} count={key?.answers ? section.numbers.length : 0}
                onSubmit={submit} onReset={onReset} busy={busy} />

      {key && (
        <div className="paper-ref">
          <div className="lbl">ANSWER KEY · 答案与解析</div>
          <div className="paper-ref-body" dangerouslySetInnerHTML={html(key.solution)} />
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 填空题（数学）：六个短答一起交，交了才看六个答案
 * ------------------------------------------------------------------ */

function FillUnit({ section, examId, onSubmit, onReset }) {
  const [answers, update, flush, locked] = useDraft(examId, section);
  const [submit, busy] = useSubmit(section, answers, flush, onSubmit);
  const key = section.key;
  const unanswered = section.questions.filter((q) => !String(answers[q.n] || '').trim()).length;

  return (
    <section className={`unit${locked ? ' locked' : ''}`}>
      <UnitHead section={section} />
      <div className="q-list">
        {section.questions.map((q) => (
          <div key={q.n} id={`q-${section.id}-${q.n}`} className="q">
            <div className="q-stem">
              <span className="q-n fig">{q.n}.</span>
              <div className="q-stem-body paper-body" dangerouslySetInnerHTML={html(q.stem)} />
            </div>
            <div className="fill-row">
              <input className="fill-input" value={answers[q.n] || ''} readOnly={locked} placeholder="答案"
                     onChange={(e) => update((prev) => ({ ...prev, [q.n]: e.target.value }))} />
            </div>
            {key && (
              <div className="q-exp">
                <div className="q-exp-a">参考答案<Tags tags={key.tags?.[q.n]} /></div>
                {key.solutions[q.n]
                  ? <div className="paper-body" dangerouslySetInnerHTML={html(key.solutions[q.n])} />
                  : <div className="dim">题源暂无参考答案</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <UnitFoot section={section} unanswered={unanswered} count={0} onSubmit={submit} onReset={onReset} busy={busy} />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * 翻译 / 作文 / 解答题：写完提交，参考答案才出现
 * ------------------------------------------------------------------ */

const countWords = (t) => {
  const cjk = (t.match(/[一-龥]/g) || []).length;
  const latin = (t.match(/[A-Za-z0-9'’-]+/g) || []).length;
  return { cjk, latin };
};

function FreeUnit({ section, examId, onSubmit, onReset }) {
  const [answers, update, flush, locked] = useDraft(examId, section);
  const [submit, busy] = useSubmit(section, answers, flush, onSubmit);
  const key = section.key;
  const text = answers.text || '';
  const { cjk, latin } = countWords(text);
  const english = section.id === 'writing-a' || section.id === 'writing-b';
  const rows = section.id.startsWith('writing') ? 12 : 8;
  const n = section.numbers?.[0];

  return (
    <section className={`unit${locked ? ' locked' : ''}`} id={n ? `q-${section.id}-${n}` : undefined}>
      <UnitHead section={section} />
      {section.directions && <div className="paper-directions" dangerouslySetInnerHTML={html(section.directions)} />}
      <div className="paper-body" dangerouslySetInnerHTML={html(section.body)} />

      <div className="paper-answer">
        <div className="paper-answer-h">
          <span className="lbl">ANSWER SHEET</span>
          <span className="dim" style={{ fontSize: 11 }}>{english ? `${latin} words` : `${cjk + latin} 字`}</span>
        </div>
        <textarea className="paper-input" rows={rows} value={text} readOnly={locked}
                  placeholder={english ? 'Write your answer here…' : '在这里作答（解题过程也可以写在纸上，这里只记要点）…'}
                  onChange={(e) => update({ text: e.target.value })} />
      </div>

      <UnitFoot section={section} unanswered={text.trim() ? 0 : 1} count={0} free
                onSubmit={submit} onReset={onReset} busy={busy} />

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
