import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';
import OrbitMap from '../components/OrbitMap.jsx';

const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : 3);
const dot = (d) => (d ? d.replaceAll('-', '.') : '—');

export default function Home({ version }) {
  const navigate = useNavigate();
  const scrollRef = useRef(null);
  const bodyRef = useRef(null);
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, subjects, heatmap, due, upcoming, unscheduled, streak, daysToExam, examDate, today } = data;
  const list = due.length ? due : upcoming;

  const orbit = (mind?.groups || []).filter((g) => !g.outside)
    .map((g) => ({ name: g.name, notes: g.count, mastery: g.mastery }));
  const caption = orbit.map((g) => g.name).join(' · ');

  const STATS = [
    ['待复习', counts.due, true],
    ['今日已复习', counts.todayDone, false],
    ['连续天数', streak, false],
    ['笔记', counts.notes, false],
    ['累计字数', counts.words.toLocaleString(), false],
    ['复习总次数', counts.reviews, false],
  ];

  return (
    <div className="scroll" ref={scrollRef}>
      {/* ══════ 首屏 ══════ */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="lbl" style={{ color: 'var(--accent)' }}>PERSONAL KNOWLEDGE, MADE NAVIGABLE</div>
            <h1 className="hero-title">
              把问题沉淀成<br />
              <span style={{ color: 'var(--accent)' }}>可生长的理解。</span>
            </h1>
            <p className="hero-lede">
              从一篇笔记、一道真题或一次推导开始，让它们互相连接，
              按 1 · 2 · 4 · 7 · 15 · 30 天的节律回到你面前。
            </p>
            <div className="row" style={{ gap: 20, marginTop: 34, flexWrap: 'wrap' }}>
              <button className="btn primary lg" onClick={() => navigate('/notes')}>
                探索知识库　→
              </button>
              {counts.due > 0 && (
                <button className="btn lg" onClick={() => navigate('/review')}>
                  今天有 {counts.due} 篇到期
                </button>
              )}
            </div>
          </div>

          <div className="card hero-art">
            <OrbitMap subjects={orbit} caption={caption} />
          </div>
        </div>

        <button className="scroll-cue" title="向下"
                onClick={() => bodyRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 4v15M6 13l6 6 6-6" />
          </svg>
        </button>
      </section>

      {/* ══════ 折线以下 ══════ */}
      <section className="page" ref={bodyRef} style={{ paddingTop: 52 }}>
        <div className="band">
          <span className="band-title">OVERVIEW</span>
          <span className="band-meta">{dot(today)}</span>
        </div>

        <div className="g12" style={{ marginTop: 34, alignItems: 'end', gap: 32 }}>
          <div style={{ gridColumn: 'span 5' }}>
            <div className="lbl-cn" style={{ marginBottom: 12 }}>距 {examDate?.slice(0, 4)} 初试</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
              <span className="count-num serif">{daysToExam ?? '—'}</span>
              <span style={{ fontSize: 16, color: 'var(--text-2)' }}>天</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 16, lineHeight: 1.8 }}>
              {dot(examDate)} 初试 · 约 {Math.round((daysToExam || 0) / 7)} 周
              {mind && <><br />收录 {mind.counts.notes} 篇，词表里还有 {mind.counts.emptyBranches} 个考点没有笔记</>}
            </div>
          </div>

          <div style={{ gridColumn: 'span 7' }}>
            <div className="statline">
              {STATS.map(([k, v, on]) => (
                <div key={k}>
                  <div className={`stat-v${on ? ' on' : ''}`}>{v}</div>
                  <div className="stat-k">{k}</div>
                  <div className="rule" style={{ marginTop: 9 }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="g12" style={{ marginTop: 56, gap: 48 }}>
          <div style={{ gridColumn: 'span 7' }}>
            <Band title={due.length ? '今日待复习' : '即将到期'} meta="间隔　逾期">
              {list.map((n, i) => (
                <Item key={n.id} note={n} index={i}
                      right={<>
                        <span className="it-r">{n.reviewCount ? `${n.reviewCount} 次` : '首次'}</span>
                        <span className={`it-r${n.overdueDays > 0 ? ' on' : ''}`}>
                          {n.overdueDays > 0 ? `+${n.overdueDays}` : n.inDays ? `${n.inDays} 天后` : '今天'}
                        </span>
                      </>} />
              ))}
              {!list.length && <Empty>没有到期的笔记</Empty>}
            </Band>

            {unscheduled.length > 0 && (
              <div style={{ marginTop: 48 }}>
                <Band title="未纳入复习" meta={`${counts.unscheduled} 篇`}>
                  {unscheduled.slice(0, 6).map((n, i) => (
                    <Item key={n.id} note={n} index={i}
                          right={<span className="it-r">{n.status === 'empty' ? '空' : '新'}</span>} />
                  ))}
                </Band>
              </div>
            )}
          </div>

          <div style={{ gridColumn: 'span 5' }}>
            <Band title="复习节奏" meta={`近 26 周 · ${counts.reviews} 次`}>
              <div className="heat" style={{ marginTop: 18, gridTemplateColumns: `repeat(${Math.ceil(heatmap.length / 7)}, 9px)` }}>
                {heatmap.map((d) => (
                  <i key={d.date} data-l={level(d.count)} data-f={d.future ? 1 : 0} title={`${d.date}　${d.count} 次`} />
                ))}
              </div>
            </Band>

            <div style={{ marginTop: 48 }}>
              <Band title="标签分布" meta="篇数">
                {subjects.filter((s) => s.tag !== '考研').slice(0, 8).map((s) => (
                  <div className="subject-row" key={s.tag}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                      {s.tag}
                      {s.due > 0 && <span style={{ color: 'var(--accent)', marginLeft: 10, fontSize: 11 }}>{s.due} 待复习</span>}
                    </div>
                    <div style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>{s.notes}</div>
                    <div className="meter"><i style={{ width: `${Math.max(2, s.mastery * 100)}%` }} /></div>
                  </div>
                ))}
              </Band>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
