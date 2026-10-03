import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty } from '../components/bits.jsx';
import { unitsOf } from '../components/Trend.jsx';
import { TodayOrbit, TimeTrend, GoalEditor, fmtDur } from '../components/Vitals.jsx';

/**
 * 仪表盘只回答两件事：今天学得怎么样、接下来该做什么。
 *   概览——倒计时、六个数、今天该做什么（建议）
 *   今天——学习时间 / 背单词 / 做题三道轨道环；旁边是学习时间的 7 / 30 天走势和最近 14 天的坚持
 *   需要关注——到期的考点、到期的错题本、到期的笔记，合成一张单子
 *   一轮进度——每科走到哪，点开看分支
 * 笔记是学某个考点时写下的感悟，所以「学没学」看有没有对上的笔记，「要不要复习」看那篇笔记到没到期。
 */

const dot = (d) => (d ? d.replaceAll('-', '.') : '—');
const GROUP_HUE = { math: 'hue-math', 408: 'hue-408' };

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);
  const [goalOpen, setGoalOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState(null);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, due, persistDays = 0, daysToExam, examDate, today, points, stages, wrongBooks = [], daily = [] } = data;
  const goals = data.goals || { minutes: 120, words: 50, exams: 10 };
  const studyDays = data.studyTime?.days || [];
  const studyToday = studyDays.find((d) => d.date === today) || { total: 0, byKind: {} };
  const todayRow = daily.find((d) => d.date === today);
  const STAGE_COLORS = ['var(--line-2)', 'var(--hue-2)', 'var(--accent-2)', 'var(--accent)', 'var(--hue-3)'];
  const StageBar = ({ counts: c, total }) => (
    <div className="stage-bar" title={c.map((n, k) => `${stages.names[k]} ${n}`).join(' · ')}>
      {c.map((n, k) => (n > 0 ? <i key={k} style={{ width: `${(n / Math.max(1, total)) * 100}%`, background: STAGE_COLORS[k] }} /> : null))}
    </div>
  );
  const pt = points?.totals || { total: 0, learned: 0, unlearned: 0, due: 0, today: 0 };
  const studyMin = Math.round(studyToday.total / 60);

  const STATS = [
    // 做题、背单词、看笔记、问助手时自动计时（见 studyClock.js）
    ['今日学习时间', <>{studyMin}<small className="stat-unit">分钟</small></>, studyMin > 0 ? 'acc' : ''],
    // 琥珀只在真的有到期项时亮起；0 个待复习不是警示状态
    ['待复习考点', pt.due, pt.due > 0 ? 'on' : ''],
    ['未学考点', pt.unlearned, ''],
    ['待复习笔记', counts.due, counts.due > 0 ? 'on' : ''],
    // 整卷 + 专题训练，按题数算，和日历「做题」同一份数
    ['今日做题数', todayRow?.exams || 0, ''],
    // 日历上有学习痕迹（复习 / 新建 / 背词 / 做题 / 阅读 / 考点推进）的天数，不要求连续
    ['坚持天数', persistDays, ''],
  ];

  const openPoint = (p) => {
    if (p.noteId) navigate(`/note/${encodeURIComponent(p.noteId)}`);
    else navigate(`/resources/tags/${p.group}?tag=${encodeURIComponent(p.name)}`);
  };
  const openNote = (id) => navigate(`/note/${encodeURIComponent(id)}`);

  /* 今天该做什么：从已有的数据里挑最该动手的几件，按紧迫排。
     规则很少、很硬——逾期的先复习，错题本重做，做过题没写笔记的补笔记，别断连续。 */
  const tips = [];
  const firstDue = points?.due?.[0];
  if (firstDue) {
    tips.push({
      key: 'due', tone: 'on',
      text: `${pt.due} 个考点到期${firstDue.overdueDays > 0 ? `，最久逾期 ${firstDue.overdueDays} 天` : ''}——先复习「${firstDue.name}」`,
      go: () => openPoint(firstDue),
    });
  }
  const book = wrongBooks.find((b) => b.nextReview && b.nextReview <= today) || wrongBooks[0];
  if (book) {
    tips.push({
      key: 'wrong',
      text: `错题本「${book.title}」记了 ${book.count} 题${book.nextReview && book.nextReview <= today ? '，今天到期' : ''}——盖住解析重做一遍`,
      go: () => openNote(book.id),
    });
  }
  const gap = (stages?.groups || [])
    .flatMap((g) => g.subjects.map((s) => ({ ...s, group: g.key })))
    .filter((s) => s.counts[1] > 0)
    .sort((a, b) => b.counts[1] - a.counts[1])[0];
  if (gap) {
    tips.push({
      key: 'gap',
      text: `${gap.name}有 ${gap.counts[1]} 个考点做过题还没写笔记——写一篇以考点命名的笔记，才算学过`,
      go: () => navigate(`/resources/tags/${gap.group}`),
    });
  }
  if (counts.todayDone === 0 && counts.due > 0) {
    // 背词 / 做题也算学过——今天已经学过了，只提醒还有笔记在等
    const todayActive = todayRow ? unitsOf(todayRow) + (todayRow.points || 0) > 0 : false;
    tips.push({
      key: 'streak',
      text: todayActive
        ? `今天还没复习笔记，${counts.due} 篇在等——顺手复习一篇，或者做几道对应考点的题`
        : `今天还没开始，${counts.due} 篇笔记在等——复习一篇或做几道题，就是坚持的第 ${persistDays + 1} 天`,
    });
  }
  if (pt.week === 0 && pt.unlearned > 0 && points?.next?.[0]) {
    const n = points.next[0];
    tips.push({ key: 'next', text: `近 7 天没学新考点——「${n.name}」真题最多，从它开始`, go: () => openPoint(n) });
  }

  /* 需要关注：到期的考点、到期的错题本、到期的笔记，逾期最久的排前面，最多 6 条 */
  const attention = [
    ...(points?.due || []).map((p) => ({
      key: `p:${p.group}/${p.name}`, hue: GROUP_HUE[p.group] || '', name: p.name, sub: p.subject,
      right: p.overdueDays > 0 ? `逾期 ${p.overdueDays} 天` : '今天到期', on: p.overdueDays > 0, weight: p.overdueDays + 1, go: () => openPoint(p),
    })),
    ...wrongBooks.filter((b) => b.nextReview && b.nextReview <= today).map((b) => ({
      key: `w:${b.id}`, hue: 'hue-wrong', name: b.title, sub: `错题本 · 错 ${b.count} 题`,
      right: '盖住解析重做', on: false, weight: 0.5, go: () => openNote(b.id),
    })),
    ...(counts.due > 0 && due[0] ? [{
      key: 'notes', hue: '', name: `${counts.due} 篇笔记到期`, sub: due.slice(0, 2).map((n) => n.title).join('、'),
      right: due[0].overdueDays > 0 ? `最久逾期 ${due[0].overdueDays} 天` : '今天到期', on: due[0].overdueDays > 0,
      weight: (due[0].overdueDays || 0) + 0.8, go: () => openNote(due[0].id),
    }] : []),
  ].sort((a, b) => b.weight - a.weight).slice(0, 6);

  /* 最近 14 天哪天学过：日历上有痕迹的都算，和「坚持天数」同一口径 */
  const byDate = new Map(daily.map((r) => [r.date, r]));
  const activeDays = daily.slice(-14).map((r) => ({ date: r.date, on: unitsOf(byDate.get(r.date)) + (r.points || 0) > 0 }));

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

      <div style={{ marginTop: 44 }}>
        <Band title="今天该做什么" meta={tips.length ? `${tips.length} 件` : '没有'}>
          {tips.slice(0, 4).map((t, i) => (
            <button key={t.key} className={`tip-row${t.go ? '' : ' still'}`} onClick={t.go} disabled={!t.go}>
              <span className={`tip-n fig${t.tone === 'on' ? ' on' : ''}`}>{String(i + 1).padStart(2, '0')}</span>
              <span className="tip-text">{t.text}</span>
              {t.go && <span className="tip-go">→</span>}
            </button>
          ))}
          {!tips.length && <Empty>没有特别要提醒的——按下面待复习的顺序走就好</Empty>}
        </Band>
      </div>

      {/* 今天：三道轨道环（这一页唯一张扬的东西）+ 学习时间走势 */}
      <section className="vt-board">
        <div className="vt-card vt-card-today">
          <TodayOrbit today={studyToday} goals={goals} words={todayRow?.words || 0} exams={todayRow?.exams || 0}
                      onEditGoals={() => setGoalOpen(true)} />
          {goalOpen && (
            <GoalEditor goals={goals} onClose={() => setGoalOpen(false)}
                        onSave={async (g) => { await api.setGoals(g); reload(); }} />
          )}
        </div>
        <div className="vt-card">
          <TimeTrend days={studyDays} since={data.studyTime?.since} goalMinutes={goals.minutes} activeDays={activeDays} />
        </div>
      </section>

      <div className="g12" style={{ marginTop: 48, gap: 48 }}>
        <div style={{ gridColumn: 'span 7' }}>
          {/* 到期的考点、错题本、笔记合成一张单子：逾期最久的在前 */}
          <Band title="需要关注" meta={attention.length ? `${attention.length} 项` : '没有'}>
            {attention.map((a) => (
              <button key={a.key} className={`pt-row ${a.hue}`} onClick={a.go}>
                <i className="pt-sw" />
                <span className="pt-name">{a.name}</span>
                <span className="pt-sub">{a.sub}</span>
                <span className={`pt-r${a.on ? ' on' : ''}`}>{a.right}</span>
              </button>
            ))}
            {!attention.length && <Empty>没有到期的考点、笔记和错题本</Empty>}
          </Band>
        </div>

        <div style={{ gridColumn: 'span 5' }}>
          {/* 一轮复习走到哪：每科一条，点开看各分支 */}
          <Band title="一轮进度" meta="概念 → 做题 → 理解 → 复习 → 总结">
            {stages?.groups?.map((g) => {
              const pg = points?.groups?.find((x) => x.key === g.key);
              const open = openGroup === g.key;
              return (
                <div key={g.key} className={`prog-group ${GROUP_HUE[g.key] || ''}`}>
                  <button className="prog-head prog-toggle" aria-expanded={open} onClick={() => setOpenGroup(open ? null : g.key)}>
                    <i className="pt-sw" />
                    <span className="prog-name">{g.label}</span>
                    <span className="prog-n fig">总结 {g.counts[4]} / {g.total}</span>
                    {pg?.due > 0 && <span className="prog-due">{pg.due} 待复习</span>}
                    <span className={`prog-chev${open ? ' open' : ''}`} aria-hidden="true" />
                  </button>
                  <StageBar counts={g.counts} total={g.total} />
                  {open && g.subjects.map((s) => (
                    <div className="stage-row" key={s.name}>
                      <div className="stage-name">{s.name}</div>
                      <div className="stage-nums fig">{s.counts.slice(1).map((n, k) => <span key={k} style={{ color: n ? STAGE_COLORS[k + 1] : 'var(--line-2)' }}>{n}</span>)}</div>
                      <StageBar counts={s.counts} total={s.total} />
                    </div>
                  ))}
                </div>
              );
            })}
            {stages?.names && (
              <div className="stage-legend">
                {stages.names.map((n, k) => <span key={n}><i style={{ background: STAGE_COLORS[k] }} />{n}</span>)}
              </div>
            )}
            {!stages?.groups?.length && <Empty>还没有考点清单（.kb/exams/tags-*.json）</Empty>}
          </Band>
        </div>
      </div>
    </div></div>
  );
}
