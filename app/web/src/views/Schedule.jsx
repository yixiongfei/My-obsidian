import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';

// 周日起头，和日本日历一致
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const WEEK_CN = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n) => String(n).padStart(2, '0');

export default function Schedule({ version }) {
  const { year, month, day } = useParams();
  const y = Number(year) || new Date().getFullYear();
  if (day) return <DayView version={version} date={`${y}-${pad(month)}-${pad(day)}`} />;
  if (month) return <MonthView version={version} monthKey={`${y}-${pad(month)}`} />;
  return <YearView version={version} year={y} />;
}

function Crumbs({ items }) {
  const navigate = useNavigate();
  return (
    <div className="crumbs">
      {items.map((it, i) => (
        <span key={it.label} className="row" style={{ gap: 10 }}>
          {i > 0 && <span style={{ opacity: 0.4 }}>/</span>}
          {it.to ? <button onClick={() => navigate(it.to)}>{it.label}</button> : <span className="now">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 年表
 * ------------------------------------------------------------------ */

function YearView({ version, year }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.year(year), [year, version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  return (
    <div className="scroll"><div className="page">
      <div className="band" style={{ borderBottomColor: 'var(--line-2)', marginBottom: 32 }}>
        <span className="band-title">{year}</span>
        <div className="row" style={{ gap: 18 }}>
          <span className="band-meta">距初试 {data.daysToExam} 天 · {data.examDate.replaceAll('-', '.')}</span>
          <div className="row" style={{ gap: 8 }}>
            {data.years.map((yr) => (
              <button key={yr} className={`tag${yr === year ? ' on' : ''}`} onClick={() => navigate(`/schedule/${yr}`)}>
                {yr}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="year-grid">
        {data.months.map((m) => {
          const done = m.milestone?.tasks.filter((t) => t.done).length || 0;
          const all = m.milestone?.tasks.length || 0;
          return (
            <div key={m.month}
                 className={`month-card${m.isCurrent ? ' current' : ''}${m.isPast ? ' past' : ''}`}
                 onClick={() => navigate(`/schedule/${year}/${pad(m.index)}`)}>
              <div className="row">
                <span className="mc-n">{pad(m.index)}</span>
                <span className="spacer" />
                {m.isCurrent && <span className="tag on">本月</span>}
                {all > 0 && <span style={{ fontSize: 11, color: 'var(--dim)' }}>{done}/{all}</span>}
              </div>
              <div className="mc-phase">{m.milestone?.phase || '—'}</div>
              {m.milestone?.desc && <div className="mc-desc">{m.milestone.desc}</div>}
              <div className="mc-stats">
                <div className={`mc-stat${m.due ? ' on' : ''}`}><b>{m.due}</b>待复习</div>
                <div className="mc-stat"><b>{m.reviewed}</b>已复习</div>
                <div className="mc-stat"><b>{m.created}</b>新建</div>
                {m.events > 0 && <div className="mc-stat"><b>{m.events}</b>日程</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

/* ------------------------------------------------------------------ *
 * 月表
 * ------------------------------------------------------------------ */

function MonthView({ version, monthKey }) {
  const navigate = useNavigate();
  const [y, m] = monthKey.split('-');
  const { data, loading, error, reload } = useApi(() => api.month(monthKey), [monthKey, version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const done = data.milestone?.tasks.filter((t) => t.done).length || 0;
  const all = data.milestone?.tasks.length || 0;
  const totals = data.days.reduce((a, d) => ({ due: a.due + d.due, reviewed: a.reviewed + d.reviewed }), { due: 0, reviewed: 0 });

  return (
    <div className="scroll"><div className="page">
      <Crumbs items={[{ label: y, to: `/schedule/${y}` }, { label: `${Number(m)} 月` }]} />

      <div style={{ borderTop: 'var(--hair) solid var(--line-2)', paddingTop: 26, display: 'flex', alignItems: 'flex-end', gap: 40, flexWrap: 'wrap' }}>
        <div className="row" style={{ alignItems: 'baseline', gap: 16 }}>
          <span className="fig" style={{ fontSize: 96, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 0.85 }}>{m}</span>
          <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{y} 年</span>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 32, paddingBottom: 6 }}>
          <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16 }}>
            <div className="stat-k" style={{ marginTop: 0, marginBottom: 6 }}>本月阶段</div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{data.milestone?.phase || '暂无安排'}</div>
            {data.milestone?.desc && <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{data.milestone.desc}</div>}
          </div>

          {all > 0 && (
            <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16 }}>
              <div className="stat-k" style={{ marginTop: 0, marginBottom: 6 }}>本月目标　{done}/{all}</div>
              {data.milestone.tasks.map((t, i) => (
                <div className="row" key={`${t.text}-${i}`} style={{ gap: 9, padding: '3px 0' }}>
                  <span className={`checkbox${t.done ? ' on' : ''}`} style={{ pointerEvents: 'none', width: 11, height: 11 }} />
                  <span style={{ fontSize: 12, color: t.done ? 'var(--dim)' : 'var(--text-2)', textDecoration: t.done ? 'line-through' : 'none' }}>
                    {t.text}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 8 }}>勾选状态来自路线图画布</div>
            </div>
          )}

          {data.holidays?.length > 0 && (
            <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16 }}>
              <div className="stat-k" style={{ marginTop: 0, marginBottom: 6 }}>本月の祝日</div>
              {data.holidays.map((h) => (
                <div className="row" key={h.day} style={{ gap: 9, padding: '2px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--holiday)', flex: 'none' }} />
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{h.day} 日</span>
                  <span style={{ fontSize: 12, color: 'var(--dim)' }}>{h.name}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16 }}>
            <div className="stat-k" style={{ marginTop: 0, marginBottom: 10 }}>本月合计</div>
            <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
              <div><div className="stat-v on">{totals.due}</div><div className="stat-k">待复习</div></div>
              <div><div className="stat-v">{totals.reviewed}</div><div className="stat-k">已复习</div></div>
            </div>
          </div>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', margin: '40px 0 14px' }}>
        <div className="cal-legend">
          <span className="lg"><i style={{ background: 'var(--accent)' }} />待复习</span>
          <span className="lg"><i style={{ background: 'var(--accent-2)' }} />已复习</span>
          <span className="lg"><i style={{ background: 'var(--line-2)' }} />新建</span>
          <span className="lg"><i style={{ background: 'var(--holiday)' }} />日本の祝日</span>
        </div>
      </div>

      <div className="cal-head">
        {WEEK.map((w, i) => (
          <div key={w} className={i === 0 ? 'sun' : i === 6 ? 'sat' : undefined}>{w}</div>
        ))}
      </div>

      <div className="cal">
        {Array.from({ length: data.leadingBlanks }).map((_, i) => <div className="day-cell blank" key={`b${i}`} />)}
        {data.days.map((d) => (
          <div key={d.date}
               title={d.holiday || undefined}
               className={[
                 'day-cell',
                 d.isToday ? 'today' : '',
                 d.isPast && !d.isToday ? 'past' : '',
                 d.weekday === 0 ? 'sun' : '',
                 d.holiday ? 'holiday' : '',
               ].filter(Boolean).join(' ')}
               onClick={() => navigate(`/schedule/${y}/${m}/${pad(d.day)}`)}>
            <div className="dc-n">{pad(d.day)}</div>
            {d.holiday && <div className="dc-hol">{d.holiday}</div>}
            <div className="dc-dots">
              {d.holiday && <i className="hol" />}
              {d.due > 0 && <i className="due" />}
              {d.reviewed > 0 && <i className="rev" />}
              {d.created > 0 && <i className="new" />}
              {d.events > 0 && <i className="due" />}
            </div>
            <div className="dc-rows" style={{ marginTop: 0 }}>
              {d.due > 0 && <div className="dc-row" style={{ color: 'var(--accent)' }}><span>待复习</span><span>{d.due}</span></div>}
              {d.reviewed > 0 && <div className="dc-row" style={{ color: 'var(--text-2)' }}><span>已复习</span><span>{d.reviewed}</span></div>}
            </div>
          </div>
        ))}
      </div>
    </div></div>
  );
}

/* ------------------------------------------------------------------ *
 * 日表
 * ------------------------------------------------------------------ */

function DayView({ version, date }) {
  const [y, m, d] = date.split('-');
  const { data, loading, error, reload } = useApi(() => api.day(date), [date, version]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await api.addEvent({ date, title }); setTitle(''); reload(); } finally { setBusy(false); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const due = [...(data.overdue || []), ...data.due];
  const vocabDone = data.vocabReviewed?.done || 0;
  // 只背了单词、没碰笔记的日子也是有安排的，不该显示成空白
  const nothing = !due.length && !data.reviewed.length && !data.created.length
    && !data.events.length && !vocabDone;

  return (
    <div className="scroll"><div className="page" style={{ maxWidth: 900 }}>
      <Crumbs items={[
        { label: y, to: `/schedule/${y}` },
        { label: `${Number(m)} 月`, to: `/schedule/${y}/${m}` },
        { label: `${Number(d)} 日` },
      ]} />

      <div style={{ borderTop: 'var(--hair) solid var(--line-2)', paddingTop: 26, display: 'flex', alignItems: 'flex-end', gap: 40, flexWrap: 'wrap', marginBottom: 8 }}>
        <div className="row" style={{ alignItems: 'baseline', gap: 14 }}>
          <span className="fig" style={{ fontSize: 88, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 0.85, color: data.holiday ? 'var(--holiday)' : data.isToday ? 'var(--accent)' : 'var(--text)' }}>
            {pad(Number(d))}
          </span>
          <div>
            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>{y}.{m}</div>
            <div style={{ color: 'var(--dim)', fontSize: 11 }}>
              {WEEK_CN[data.weekday]}曜日{data.isToday ? ' · 今天' : ''}
            </div>
            {data.holiday && (
              <div className="row" style={{ gap: 7, marginTop: 5 }}>
                <span style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--holiday)', flex: 'none' }} />
                <span style={{ fontSize: 12, color: 'var(--holiday)' }}>{data.holiday}</span>
              </div>
            )}
          </div>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 32, alignItems: 'flex-start' }}>
          <div><div className={`stat-v${due.length ? ' on' : ''}`}>{due.length}</div><div className="stat-k">待复习</div></div>
          <div><div className="stat-v">{data.reviewed.length}</div><div className="stat-k">已复习</div></div>
          <div><div className="stat-v">{vocabDone}</div><div className="stat-k">已复习单词</div></div>
          <div><div className="stat-v">{data.daysToExam}</div><div className="stat-k">距初试</div></div>
        </div>
      </div>

      {nothing && <Empty>这一天没有安排</Empty>}

      {due.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <Band title="待复习" meta={`${due.length} 篇`}>
            {due.map((n, i) => <Item key={n.id} note={{ ...n, status: 'due' }} index={i} />)}
          </Band>
        </div>
      )}

      {(data.reviewed.length > 0 || vocabDone > 0) && (
        <div style={{ marginTop: 40 }}>
          <Band title="复习记录"
                meta={`笔记 ${data.reviewed.length} 次 · 单词 ${vocabDone} 个`}>
            {vocabDone > 0 && (
              <div style={{ padding: '13px 0', borderBottom: 'var(--hair) solid var(--line)' }}>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text)', fontWeight: 500, fontSize: 13.5 }}>英语词汇</span>
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>完成复习 {vocabDone} 个单词</span>
                  {data.vocabReviewed?.mastered > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--dim)' }}>
                      其中 {data.vocabReviewed.mastered} 个标为轻松
                    </span>
                  )}
                </div>
              </div>
            )}
            {data.reviewed.map((e, i) => (
              <div key={`${e.note_path}-${i}`} style={{ padding: '13px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text)', fontWeight: 500, fontSize: 13.5 }}>{e.title}</span>
                  <span style={{ fontSize: 11, color: 'var(--accent)' }}>第 {e.review_count_after} 次</span>
                  <span style={{ fontSize: 11, color: 'var(--dim)' }}>{e.source}</span>
                </div>
                {e.added_content && <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4 }}>{e.added_content}</div>}
              </div>
            ))}
          </Band>
        </div>
      )}

      {data.created.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <Band title="当天新建" meta={`${data.created.length} 篇`}>
            {data.created.map((n, i) => <Item key={n.id} note={n} index={i} right={<span className="it-r" />} />)}
          </Band>
        </div>
      )}

      <div style={{ marginTop: 40 }}>
        <Band title="日程" meta={data.events.length ? `${data.events.length} 条` : null}>
          {data.events.map((e) => (
            <div key={e.id} className={`event-row${e.done ? ' done' : ''}`}>
              <span className={`checkbox${e.done ? ' on' : ''}`}
                    onClick={async () => { await api.patchEvent(e.id, { done: !e.done }); reload(); }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="er-title" style={{ color: 'var(--text)', fontSize: 13.5 }}>{e.title}</div>
                {e.note && <div style={{ color: 'var(--dim)', fontSize: 11.5 }}>{e.note}</div>}
              </div>
              <button className="btn ghost sm" title="删除"
                      onClick={async () => { await api.deleteEvent(e.id); reload(); }}>删除</button>
            </div>
          ))}

          <div className="row" style={{ gap: 14, paddingTop: 14 }}>
            <input className="input" placeholder="添加当天安排…" value={title}
                   onChange={(e) => setTitle(e.target.value)}
                   onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button className="btn primary" onClick={add} disabled={!title.trim() || busy}>添加</button>
          </div>
        </Band>
      </div>
    </div></div>
  );
}
