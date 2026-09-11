import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';
import IsoStack from '../components/IsoStack.jsx';

const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : 3);
const dot = (d) => (d ? d.replaceAll('-', '.') : '—');

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, subjects, heatmap, due, upcoming, unscheduled, streak, daysToExam, examDate, today } = data;
  const list = due.length ? due : upcoming;
  const nextDue = upcoming[0]?.nextReview || due[0]?.nextReview;

  // 立柱取 tags.yaml 的一级分类，词表之外的不参与
  const stack = (mind?.groups || []).filter((g) => !g.outside)
    .map((g) => ({ name: g.name, notes: g.count, mastery: g.mastery }));

  const STATS = [
    ['待复习', counts.due, true],
    ['今日已复习', counts.todayDone, false],
    ['连续天数', streak, false],
    ['笔记', counts.notes, false],
    ['累计字数', counts.words.toLocaleString(), false],
    ['复习总次数', counts.reviews, false],
  ];

  return (
    <div className="scroll">
      {/* ── 首屏 ── */}
      <div className="page hero" style={{ paddingBottom: 32 }}>
        <div className="band" style={{ borderBottomColor: 'var(--line-2)' }}>
          <span className="lbl">OVERVIEW</span>
          <span className="band-meta">{dot(today)}</span>
        </div>

        <div className="hero-grid">
          <div style={{ gridColumn: 'span 6' }}>
            <div className="lbl-cn" style={{ marginBottom: 14 }}>距 {examDate?.slice(0, 4)} 初试</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
              <span className="hero-num">{daysToExam ?? '—'}</span>
              <span style={{ fontSize: 17, color: 'var(--text-2)' }}>天</span>
            </div>
            <div className="hero-sub">
              {dot(examDate)} 初试 · 约 {Math.round((daysToExam || 0) / 7)} 周
              {mind && <><br />当前收录 {mind.counts.notes} 篇，词表里还有 {mind.counts.emptyBranches} 个考点没有笔记</>}
            </div>
            <div className="row" style={{ gap: 18, marginTop: 34 }}>
              <button className="btn primary" onClick={() => navigate('/review')}
                      disabled={counts.due === 0 && counts.unscheduled === 0}>
                开始复习
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>
                {counts.due} 篇到期 · {counts.unscheduled} 篇未纳入
              </span>
            </div>
          </div>

          <div style={{ gridColumn: 'span 6', display: 'flex', justifyContent: 'center' }}>
            <IsoStack subjects={stack} nextReview={nextDue} examDate={examDate} />
          </div>
        </div>

        <div className="statline">
          {STATS.map(([k, v, on], i) => (
            <div key={k} style={{ marginTop: (STATS.length - 1 - i) * 8 }}>
              <div className={`stat-v${on ? ' on' : ''}`}>{v}</div>
              <div className="stat-k">{k}</div>
              <div className="rule" />
            </div>
          ))}
        </div>
      </div>

      {/* ── 折线以下 ── */}
      <div className="page g12" style={{ borderTop: '1px solid var(--line)', paddingTop: 44, gap: 48 }}>
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
            <div style={{ marginTop: 44 }}>
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

          <div style={{ marginTop: 44 }}>
            <Band title="标签分布" meta="篇数">
              {subjects.filter((s) => s.tag !== '考研').slice(0, 8).map((s) => (
                <div className="subject-row" key={s.tag}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                    {s.tag}
                    {s.due > 0 && <span style={{ color: 'var(--blue)', marginLeft: 10, fontSize: 11 }}>{s.due} 待复习</span>}
                  </div>
                  <div style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>{s.notes}</div>
                  <div className="meter"><i style={{ width: `${Math.max(2, s.mastery * 100)}%` }} /></div>
                </div>
              ))}
            </Band>
          </div>
        </div>
      </div>
    </div>
  );
}
