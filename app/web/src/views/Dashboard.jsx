import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';
import Trend from '../components/Trend.jsx';

/**
 * 仪表盘按学习过程来摆：
 *   考点层（真题标签）——今天学了哪些考点、还剩多少没学、有多少要复习、每科走到哪了
 *   笔记层——到期的笔记、最近复习、复习节奏
 * 笔记是学某个考点时写下的感悟，所以「学没学」看有没有对上的笔记，
 * 「要不要复习」看那篇笔记到没到期。
 */

const level = (n) => (n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : 3);
const dot = (d) => (d ? d.replaceAll('-', '.') : '—');
const GROUP_HUE = { math: 'hue-math', 408: 'hue-408' };

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, subjects, heatmap, due, upcoming, unscheduled, streak, daysToExam, examDate, today, recent, points } = data;
  const list = due.length ? due : upcoming;
  const pt = points?.totals || { total: 0, learned: 0, unlearned: 0, due: 0, today: 0 };

  const STATS = [
    // 琥珀只在真的有到期项时亮起；0 个待复习不是警示状态
    ['今日学习考点', pt.today, pt.today > 0 ? 'acc' : ''],
    ['待复习考点', pt.due, pt.due > 0 ? 'on' : ''],
    ['未学考点', pt.unlearned, ''],
    ['待复习笔记', counts.due, counts.due > 0 ? 'on' : ''],
    ['今日已复习', counts.todayDone, ''],
    ['连续天数', streak, ''],
  ];

  const openPoint = (p) => {
    if (p.noteId) navigate(`/note/${encodeURIComponent(p.noteId)}`);
    else navigate(`/resources/tags/${p.group}?tag=${encodeURIComponent(p.name)}`);
  };

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
            <br />
            考点已学 <b className="fig" style={{ color: 'var(--text)' }}>{pt.learned}</b> / {pt.total}
            {pt.week > 0 && pt.unlearned > 0 && <>，近 7 天学了 {pt.week} 个，照此还要 {Math.ceil(pt.unlearned / (pt.week / 7))} 天学完</>}
            {mind && <>；收录 {mind.counts.notes} 篇笔记</>}
          </div>
        </div>

        <div style={{ gridColumn: 'span 7' }}>
          <div className="statline">
            {STATS.map(([k, v, tone]) => (
              <div key={k}>
                <div className={`stat-v${tone === 'on' ? ' on' : tone === 'acc' ? ' acc' : ''}`}>{v}</div>
                <div className="stat-k">{k}</div>
                <div className="rule" style={{ marginTop: 9 }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="g12" style={{ marginTop: 56, gap: 48 }}>
        <div style={{ gridColumn: 'span 7' }}>
          {/* 今天学了什么：对上考点的笔记今天新建 / 首次复习 */}
          <Band title="今日学习" meta={pt.today ? `${pt.today} 个考点` : '还没有'}>
            {points?.todayLearned?.map((p) => (
              <button key={`${p.group}/${p.name}`} className={`pt-row ${GROUP_HUE[p.group] || ''}`} onClick={() => openPoint(p)}>
                <i className="pt-sw" />
                <span className="pt-name">{p.name}</span>
                <span className="pt-sub">{p.subject}</span>
                <span className="pt-r">真题 {p.items} 题</span>
              </button>
            ))}
            {!points?.todayLearned?.length && <Empty>今天还没有学新的考点——写一篇以考点命名的笔记就算学过了</Empty>}
          </Band>

          <div style={{ marginTop: 48 }}>
            <Band title="待复习考点" meta={pt.due ? `${pt.due} 个` : '没有'}>
              {points?.due?.map((p) => (
                <button key={`${p.group}/${p.name}`} className={`pt-row ${GROUP_HUE[p.group] || ''}`} onClick={() => openPoint(p)}>
                  <i className="pt-sw" />
                  <span className="pt-name">{p.name}</span>
                  <span className="pt-sub">{p.subject}</span>
                  <span className={`pt-r${p.overdueDays > 0 ? ' on' : ''}`}>{p.overdueDays > 0 ? `逾期 ${p.overdueDays} 天` : '今天到期'}</span>
                </button>
              ))}
              {!points?.due?.length && <Empty>没有到期的考点</Empty>}
            </Band>
          </div>

          <div style={{ marginTop: 48 }}>
            <Band title="复习节奏" meta={`近 26 周 · ${counts.reviews} 次`}>
              <div className="rhythm">
                <div className="heat" style={{ gridTemplateColumns: `repeat(${Math.ceil(heatmap.length / 7)}, 9px)` }}>
                  {heatmap.map((d) => (
                    <i key={d.date} data-l={level(d.count)} data-f={d.future ? 1 : 0} title={`${d.date}　${d.count} 次`} />
                  ))}
                </div>
                <Trend daily={data.daily || []} />
              </div>
            </Band>
          </div>

          <div style={{ marginTop: 48 }}>
            <Band title={due.length ? '今日待复习笔记' : '即将到期的笔记'} meta="间隔　逾期">
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
          </div>

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
          {/* 每科走到哪了：已学 / 考点总数 */}
          <Band title="考点进度" meta="已学 / 总数">
            {points?.groups?.map((g) => (
              <div key={g.key} className={`prog-group ${GROUP_HUE[g.key] || ''}`}>
                <div className="prog-head">
                  <i className="pt-sw" />
                  <span className="prog-name">{g.label}</span>
                  <span className="prog-n fig">{g.learned} / {g.total}</span>
                  {g.due > 0 && <span className="prog-due">{g.due} 待复习</span>}
                  {g.today > 0 && <span className="prog-today">今日 +{g.today}</span>}
                </div>
                {g.subjects.map((s) => (
                  <div className="subject-row" key={s.name}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                      {s.name}
                      {s.due > 0 && <span style={{ color: 'var(--due)', marginLeft: 10, fontSize: 11 }}>{s.due} 待复习</span>}
                      {s.today > 0 && <span style={{ color: 'var(--accent)', marginLeft: 10, fontSize: 11 }}>+{s.today}</span>}
                    </div>
                    <div style={{ color: 'var(--dim)', fontSize: 12, textAlign: 'right' }}>{s.learned}<span style={{ opacity: 0.6 }}>/{s.total}</span></div>
                    <div className="meter"><i style={{ width: `${s.total ? Math.max(s.learned ? 2 : 0, (s.learned / s.total) * 100) : 0}%` }} /></div>
                  </div>
                ))}
              </div>
            ))}
            {!points?.groups?.length && <Empty>还没有考点清单（.kb/exams/tags-*.json）</Empty>}
          </Band>

          {points?.next?.length > 0 && (
            <div style={{ marginTop: 48 }}>
              <Band title="接下来可以学" meta="未学 · 真题最多">
                {points.next.map((p) => (
                  <button key={`${p.group}/${p.name}`} className={`pt-row ${GROUP_HUE[p.group] || ''}`} onClick={() => openPoint(p)}>
                    <i className="pt-sw" />
                    <span className="pt-name">{p.name}</span>
                    <span className="pt-sub">{p.subject}</span>
                    <span className="pt-r">{p.items} 题</span>
                  </button>
                ))}
              </Band>
            </div>
          )}


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
