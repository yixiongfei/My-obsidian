import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox, Empty, NoteRow, Section } from '../components/bits.jsx';
import { Icon } from '../components/Icons.jsx';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const WEEK_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => String(n).padStart(2, '0');
const spring = { type: 'spring', stiffness: 300, damping: 32 };

export default function Schedule({ version }) {
  const { year, month, day } = useParams();
  const now = new Date();
  const y = Number(year) || now.getFullYear();

  if (day) return <DayView version={version} date={`${y}-${pad(month)}-${pad(day)}`} />;
  if (month) return <MonthView version={version} monthKey={`${y}-${pad(month)}`} />;
  return <YearView version={version} year={y} />;
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
      <div className="row" style={{ marginBottom: 26, flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h1 className="h-title num">{year}</h1>
          <p className="h-sub num">距初试 {data.daysToExam} 天 · {data.examDate}</p>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 6 }}>
          {data.years.map((yr) => (
            <button
              key={yr}
              className={`btn sm${yr === year ? ' primary' : ''}`}
              onClick={() => navigate(`/schedule/${yr}`)}
            >
              <span className="num">{yr}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid year-grid">
        {data.months.map((m, i) => {
          const doneTasks = m.milestone?.tasks.filter((t) => t.done).length || 0;
          const allTasks = m.milestone?.tasks.length || 0;
          return (
            <motion.div
              key={m.month}
              layoutId={`sched-${m.month}`}
              className={`card interactive month-card${m.isCurrent ? ' current' : ''}${m.isPast ? ' past' : ''}`}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: m.isPast ? 0.62 : 1, y: 0 }}
              transition={{ delay: i * 0.028, duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              whileHover={{ y: -3 }}
              onClick={() => navigate(`/schedule/${year}/${pad(m.index)}`)}
            >
              <div className="row">
                <span className="mc-n num">{pad(m.index)}</span>
                <span className="spacer" />
                {m.isCurrent && <span className="chip solid">本月</span>}
                {allTasks > 0 && <span className="chip num">{doneTasks}/{allTasks}</span>}
              </div>

              <div className="mc-phase">{m.milestone?.phase || '—'}</div>
              {m.milestone?.desc && <div className="mc-desc">{m.milestone.desc}</div>}

              <div className="mc-stats">
                <div className={`mc-stat${m.due ? ' on' : ''}`}><b className="num">{m.due}</b>待复习</div>
                <div className={`mc-stat${m.reviewed ? ' on' : ''}`}><b className="num">{m.reviewed}</b>已复习</div>
                <div className="mc-stat"><b className="num">{m.created}</b>新建</div>
                {m.events > 0 && <div className="mc-stat on"><b className="num">{m.events}</b>日程</div>}
              </div>
            </motion.div>
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

  const doneTasks = data.milestone?.tasks.filter((t) => t.done).length || 0;
  const allTasks = data.milestone?.tasks.length || 0;

  return (
    <div className="scroll"><div className="page">
      <Crumbs items={[
        { label: y, to: `/schedule/${y}` },
        { label: `${Number(m)} 月` },
      ]} />

      <motion.div layoutId={`sched-${monthKey}`} className="card" style={{ padding: '22px 26px', marginBottom: 26 }} transition={spring}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
              <span className="num" style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.04em', color: 'var(--blue)' }}>{m}</span>
              <span style={{ color: 'var(--dim)' }} className="num">{y} 年</span>
            </div>
            <div style={{ color: 'var(--text)', fontWeight: 580, marginTop: 6 }}>{data.milestone?.phase || '本月暂无路线图安排'}</div>
            {data.milestone?.desc && <div style={{ color: 'var(--dim)', fontSize: 12.5, marginTop: 2 }}>{data.milestone.desc}</div>}
          </div>

          <div className="spacer" />

          {allTasks > 0 && (
            <div style={{ minWidth: 220 }}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11.5, color: 'var(--dim)', letterSpacing: '0.1em' }}>本月目标</span>
                <span className="chip blue num">{doneTasks}/{allTasks}</span>
              </div>
              {data.milestone.tasks.map((t, i) => (
                <div className="row" key={`${t.text}-${i}`} style={{ gap: 8, padding: '3px 0' }}>
                  <span className={`checkbox${t.done ? ' on' : ''}`} style={{ pointerEvents: 'none', width: 14, height: 14 }} />
                  <span style={{ fontSize: 12.5, color: t.done ? 'var(--dim)' : 'var(--text-2)', textDecoration: t.done ? 'line-through' : 'none' }}>
                    {t.text}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 8 }}>勾选状态来自路线图画布</div>
            </div>
          )}
        </div>
      </motion.div>

      <div className="cal" style={{ marginBottom: 4 }}>
        {WEEK.map((w) => <div className="cal-head" key={w}>{w}</div>)}
      </div>

      <div className="cal">
        {Array.from({ length: data.leadingBlanks }).map((_, i) => <div className="day-cell blank" key={`b${i}`} />)}
        {data.days.map((d, i) => (
          <motion.div
            key={d.date}
            layoutId={`sched-${d.date}`}
            className={`day-cell${d.isToday ? ' today' : ''}${d.isPast ? ' past' : ''}`}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: d.isPast && !d.isToday ? 0.5 : 1, scale: 1 }}
            transition={{ delay: Math.min(i * 0.008, 0.25), duration: 0.26 }}
            onClick={() => navigate(`/schedule/${y}/${m}/${pad(d.day)}`)}
          >
            <div className="row">
              <span className="dc-n num">{d.day}</span>
              <span className="spacer" />
              {d.due > 0 && <span className="chip blue num" style={{ fontSize: 10, padding: '0 5px' }}>{d.due}</span>}
            </div>
            <div className="dc-dots">
              {Array.from({ length: Math.min(d.reviewed, 8) }).map((_, k) => <i className="rev" key={`r${k}`} />)}
              {Array.from({ length: Math.min(d.created, 6) }).map((_, k) => <i className="new" key={`n${k}`} />)}
              {Array.from({ length: Math.min(d.events, 6) }).map((_, k) => <i className="evt" key={`e${k}`} />)}
            </div>
          </motion.div>
        ))}
      </div>

      <div className="row" style={{ gap: 16, marginTop: 16, color: 'var(--dim)', fontSize: 11.5 }}>
        <span className="row" style={{ gap: 6 }}><i style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--blue)' }} />待复习</span>
        <span className="row" style={{ gap: 6 }}><i style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--blue-deep)' }} />已复习</span>
        <span className="row" style={{ gap: 6 }}><i style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--line-2)' }} />新建笔记</span>
        <span className="row" style={{ gap: 6 }}><i style={{ width: 6, height: 6, borderRadius: 9, background: 'var(--blue-2)' }} />自定义日程</span>
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
  const toggle = async (e) => { await api.patchEvent(e.id, { done: !e.done }); reload(); };
  const remove = async (e) => { await api.deleteEvent(e.id); reload(); };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const due = [...(data.overdue || []), ...data.due];
  const nothing = due.length === 0 && data.reviewed.length === 0 && data.created.length === 0 && data.events.length === 0;

  return (
    <div className="scroll"><div className="page" style={{ maxWidth: 860 }}>
      <Crumbs items={[
        { label: y, to: `/schedule/${y}` },
        { label: `${Number(m)} 月`, to: `/schedule/${y}/${m}` },
        { label: `${Number(d)} 日` },
      ]} />

      <motion.div layoutId={`sched-${date}`} className="card" style={{ padding: '24px 28px', marginBottom: 8 }} transition={spring}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 20 }}>
          <div>
            <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
              <span className="num" style={{ fontSize: 46, fontWeight: 720, letterSpacing: '-0.045em', color: data.isToday ? 'var(--blue)' : 'var(--text)' }}>{Number(d)}</span>
              <div>
                <div className="num" style={{ color: 'var(--text-2)' }}>{y}-{m}</div>
                <div style={{ color: 'var(--dim)', fontSize: 12 }}>{WEEK_FULL[data.weekday]}{data.isToday ? ' · 今天' : ''}</div>
              </div>
            </div>
          </div>
          <div className="spacer" />
          <div className="row" style={{ gap: 24 }}>
            <div><div className="stat-v num accent">{due.length}</div><div className="stat-k">待复习</div></div>
            <div><div className="stat-v num">{data.reviewed.length}</div><div className="stat-k">已复习</div></div>
            <div><div className="stat-v num">{data.daysToExam}</div><div className="stat-k">距初试</div></div>
          </div>
        </div>
      </motion.div>

      {nothing && <Empty>这一天没有安排</Empty>}

      {due.length > 0 && (
        <Section title="待复习" aside={<span className="chip blue num">{due.length}</span>}>
          <div className="card" style={{ padding: 6 }}>
            {due.map((n, i) => <NoteRow key={n.id} note={{ ...n, status: 'due' }} index={i} />)}
          </div>
        </Section>
      )}

      {data.reviewed.length > 0 && (
        <Section title="复习记录" aside={<span className="chip num">{data.reviewed.length}</span>}>
          <div className="card" style={{ padding: '4px 18px' }}>
            {data.reviewed.map((e, i) => (
              <div key={`${e.note_path}-${i}`} style={{ padding: '11px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text)', fontWeight: 550, fontSize: 13.5 }}>{e.title}</span>
                  <span className="chip blue num">第 {e.review_count_after} 次</span>
                  <span className="chip">{e.source}</span>
                </div>
                {e.added_content && <div style={{ color: 'var(--dim)', fontSize: 12.5, marginTop: 4 }}>{e.added_content}</div>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.created.length > 0 && (
        <Section title="当天新建" aside={<span className="chip num">{data.created.length}</span>}>
          <div className="card" style={{ padding: 6 }}>
            {data.created.map((n, i) => <NoteRow key={n.id} note={n} index={i} />)}
          </div>
        </Section>
      )}

      <Section title="日程">
        <div className="grid" style={{ gap: 8 }}>
          <AnimatePresence initial={false}>
            {data.events.map((e) => (
              <motion.div
                key={e.id}
                className={`event-row${e.done ? ' done' : ''}`}
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: e.done ? 0.5 : 1, x: 0 }} exit={{ opacity: 0, x: 10, height: 0 }}
                transition={{ duration: 0.22 }}
              >
                <span className={`checkbox${e.done ? ' on' : ''}`} onClick={() => toggle(e)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="er-title" style={{ color: 'var(--text)', fontSize: 13.5 }}>{e.title}</div>
                  {e.note && <div style={{ color: 'var(--dim)', fontSize: 12 }}>{e.note}</div>}
                </div>
                <button className="btn ghost sm" onClick={() => remove(e)} title="删除">
                  <Icon.x width={14} height={14} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>

          <div className="row" style={{ gap: 8 }}>
            <input
              className="input" placeholder="添加当天安排…" value={title}
              onChange={(ev) => setTitle(ev.target.value)}
              onKeyDown={(ev) => ev.key === 'Enter' && add()}
            />
            <button className="btn primary" onClick={add} disabled={!title.trim() || busy}>
              <Icon.plus width={15} height={15} />添加
            </button>
          </div>
        </div>
      </Section>
    </div></div>
  );
}

/* ------------------------------------------------------------------ */

function Crumbs({ items }) {
  const navigate = useNavigate();
  return (
    <div className="crumbs">
      <button onClick={() => navigate(-1)} className="row" style={{ gap: 6 }}>
        <Icon.back width={14} height={14} />
      </button>
      {items.map((it, i) => (
        <span key={it.label} className="row" style={{ gap: 8 }}>
          {i > 0 && <span className="sep">/</span>}
          {it.to
            ? <button className="num" onClick={() => navigate(it.to)}>{it.label}</button>
            : <span className="now num">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}
