import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Section, Loading, ErrorBox, Empty, Stat, NoteRow } from '../components/bits.jsx';
import { Icon } from '../components/Icons.jsx';

const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 7 ? 3 : 4);
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, subjects, heatmap, due, upcoming, unscheduled, recent, streak, daysToExam, examDate } = data;
  const weeks = Math.ceil(heatmap.length / 7);

  return (
    <div className="scroll"><div className="page">
      {/* 倒计时 */}
      <motion.section
        className="hero"
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        <div>
          <div className="hero-label">距离初试</div>
          <div className="hero-num num">{daysToExam ?? '—'}</div>
          <div className="hero-foot num">
            {examDate} · 约 {Math.round((daysToExam || 0) / 7)} 周
          </div>
        </div>
        <div className="hero-stats">
          <Stat value={counts.due} label="今日待复习" accent={counts.due > 0} />
          <Stat value={counts.todayDone} label="今日已复习" />
          <Stat value={streak} label="连续天数" />
          <Stat value={counts.notes} label="笔记总数" />
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={() => navigate('/review')} disabled={counts.due === 0 && counts.unscheduled === 0}>
          <Icon.review width={15} height={15} />
          开始复习
          <Icon.arrow width={15} height={15} />
        </button>
      </motion.section>

      {/* 概览 */}
      <Section title="概览">
        <div className="grid tiles">
          {[
            { v: counts.words.toLocaleString(), k: '累计字数' },
            { v: counts.reviews, k: '复习总次数' },
            { v: counts.upcoming, k: '7 天内到期' },
            { v: counts.unscheduled, k: '未纳入复习' },
            { v: counts.empty, k: '空笔记待填' },
          ].map((t, i) => (
            <motion.div
              key={t.k} className="card tile"
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.04, duration: 0.3 }}
            >
              <div className="stat-v num">{t.v}</div>
              <div className="stat-k">{t.k}</div>
            </motion.div>
          ))}
        </div>
      </Section>

      {/* 复习热力图 */}
      <Section title="复习节奏" aside={<span className="chip num">近 26 周</span>}>
        <div className="card" style={{ padding: '18px 20px' }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateRows: 'repeat(7,11px)', gap: 3, fontSize: 9, color: 'var(--dim)' }}>
              {WEEK.map((w, i) => <span key={w} style={{ lineHeight: '11px' }}>{i % 2 ? w : ''}</span>)}
            </div>
            <div className="heat" style={{ gridTemplateColumns: `repeat(${weeks}, 11px)` }}>
              {heatmap.map((d) => (
                <i key={d.date} data-l={level(d.count)} data-f={d.future ? 1 : 0}
                   title={`${d.date}　${d.count} 次复习`} />
              ))}
            </div>
          </div>
        </div>
      </Section>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)', gap: 26, alignItems: 'start' }}>
        <div>
          <Section
            title={counts.due > 0 ? '今日待复习' : '即将到期'}
            aside={<span className="chip blue num">{counts.due || counts.upcoming}</span>}
          >
            <div className="card" style={{ padding: 6 }}>
              {(due.length ? due : upcoming).map((n, i) => <NoteRow key={n.id} note={n} index={i} />)}
              {due.length === 0 && upcoming.length === 0 && <Empty>没有到期的笔记</Empty>}
            </div>
          </Section>

          {unscheduled.length > 0 && (
            <Section title="未纳入复习" aside={<span className="chip num">{counts.unscheduled}</span>}>
              <div className="card" style={{ padding: 6 }}>
                {unscheduled.map((n, i) => (
                  <NoteRow key={n.id} note={n} index={i}
                           right={n.status === 'empty' ? <span className="chip">空</span> : <span className="chip blue">新</span>} />
                ))}
              </div>
            </Section>
          )}
        </div>

        <div>
          <Section title="学科掌握度">
            <div className="card" style={{ padding: '14px 18px' }}>
              {subjects.slice(0, 8).map((s) => (
                <div className="subject-row" key={s.tag}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.tag}
                    {s.due > 0 && <span className="chip blue num" style={{ marginLeft: 8 }}>{s.due} 待复习</span>}
                  </div>
                  <div className="num" style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>{s.notes} 篇</div>
                  <div className="meter">
                    <motion.i
                      initial={{ width: 0 }} animate={{ width: `${Math.max(3, s.mastery * 100)}%` }}
                      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="最近复习">
            <div className="card" style={{ padding: '10px 18px' }}>
              {recent.length === 0 && <Empty>还没有复习记录</Empty>}
              {recent.map((e, i) => (
                <div key={`${e.date}-${e.note_path}-${i}`} style={{ padding: '9px 0', borderTop: i ? '1px solid var(--line)' : 'none' }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="num" style={{ color: 'var(--blue)', fontSize: 12 }}>{e.date.slice(5)}</span>
                    <span style={{ color: 'var(--text)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
                    <span className="chip num">#{e.review_count_after}</span>
                  </div>
                  {e.added_content && <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 3 }}>{e.added_content}</div>}
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div></div>
  );
}
