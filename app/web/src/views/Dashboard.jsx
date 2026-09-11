import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';

const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : 3);
const dot = (d) => (d ? d.replaceAll('-', '.') : '—');

export default function Dashboard({ version }) {
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, subjects, heatmap, due, upcoming, unscheduled, streak, daysToExam, examDate, today, recent } = data;
  const list = due.length ? due : upcoming;

  const STATS = [
    // 琥珀只在真的有到期项时亮起；0 篇待复习不是警示状态
    ['待复习', counts.due, counts.due > 0],
    ['今日已复习', counts.todayDone, false],
    ['连续天数', streak, false],
    ['笔记', counts.notes, false],
    ['累计字数', counts.words.toLocaleString(), false],
    ['复习总次数', counts.reviews, false],
  ];

  return (
    <div className="scroll"><div className="page">
      <div className="band">
        <span className="band-title">OVERVIEW</span>
        <span className="band-meta">{dot(today)}</span>
      </div>

      <div className="g12" style={{ marginTop: 34, alignItems: 'end', gap: 32 }}>
        <div style={{ gridColumn: 'span 5' }}>
          <div className="lbl-cn" style={{ marginBottom: 12 }}>距 {examDate?.slice(0, 4)} 初试</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span className="count-num fig">{daysToExam ?? '—'}</span>
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

          {recent?.length > 0 && (
            <div style={{ marginTop: 48 }}>
              <Band title="最近复习" meta={`${counts.reviews} 次`}>
                {recent.map((e, i) => (
                  <div key={`${e.note_path}-${i}`} style={{ padding: '13px 0', borderBottom: '1px solid var(--line)' }}>
                    <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: 'var(--dim)', width: 42 }}>{e.date.slice(5).replace('-', '.')}</span>
                      <span style={{ color: 'var(--text)', fontSize: 13.5 }}>{e.title}</span>
                      <span style={{ fontSize: 11, color: 'var(--accent)' }}>第 {e.review_count_after} 次</span>
                    </div>
                    {e.added_content && <div style={{ color: 'var(--dim)', fontSize: 12, marginTop: 4, paddingLeft: 54 }}>{e.added_content}</div>}
                  </div>
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
              {subjects.filter((s) => s.tag !== '考研').slice(0, 9).map((s) => (
                <div className="subject-row" key={s.tag}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                    {s.tag}
                    {s.due > 0 && <span style={{ color: 'var(--due)', marginLeft: 10, fontSize: 11 }}>{s.due} 待复习</span>}
                  </div>
                  <div style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>{s.notes}</div>
                  <div className="meter"><i style={{ width: `${Math.max(2, s.mastery * 100)}%` }} /></div>
                </div>
              ))}
            </Band>
          </div>
        </div>
      </div>
    </div></div>
  );
}
