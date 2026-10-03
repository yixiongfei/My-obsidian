import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';
import { TodayOrbit, DailyProgress, GoalEditor, unitsOf } from '../components/Vitals.jsx';
import { FocusCard } from '../components/Focus.jsx';
import { prefs, startFocus } from '../focus.js';

/**
 * 仪表盘只回答三件事：今天学得怎么样、现在学什么、这阵子学得怎么样。
 *   概览——倒计时、六个数
 *   今天——学习时间 / 背单词 / 做题三道轨道环；旁边是番茄钟，点一下就开始专注
 *   需要关注——今天该学的：单词、长难句、做题（到期的考点用做题来复习，错题本盖住解析重做）
 *   每日进度——每天做题 / 笔记 / 背单词 / 阅读叠成一根柱子，7 天均线，最近 14 天的坚持
 */

const dot = (d) => (d ? d.replaceAll('-', '.') : '—');

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);
  const [goalOpen, setGoalOpen] = useState(false);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, persistDays = 0, daysToExam, examDate, today, points, wrongBooks = [], daily = [] } = data;
  const goals = data.goals || { minutes: 120, words: 50, exams: 10 };
  const studyDays = data.studyTime?.days || [];
  const studyToday = studyDays.find((d) => d.date === today) || { total: 0, byKind: {} };
  const todayRow = daily.find((d) => d.date === today);
  const pt = points?.totals || { total: 0, learned: 0, unlearned: 0, due: 0, today: 0 };
  const studyMin = Math.round(studyToday.total / 60);
  const wordsDone = todayRow?.words || 0;
  const examsDone = todayRow?.exams || 0;

  const STATS = [
    // 做题、背单词、看笔记、问助手、番茄钟专注时自动计时（见 studyClock.js）
    ['今日学习时间', <>{studyMin}<small className="stat-unit">分钟</small></>, studyMin > 0 ? 'acc' : ''],
    // 琥珀只在真的有到期项时亮起；0 个待复习不是警示状态
    ['待复习考点', pt.due, pt.due > 0 ? 'on' : ''],
    ['未学考点', pt.unlearned, ''],
    ['待复习笔记', counts.due, counts.due > 0 ? 'on' : ''],
    // 整卷 + 专题训练，按题数算，和日历「做题」同一份数
    ['今日做题数', examsDone, ''],
    // 日历上有学习痕迹（复习 / 新建 / 背词 / 做题 / 阅读 / 考点推进）的天数，不要求连续
    ['坚持天数', persistDays, ''],
  ];

  const noteOf = (p) => (p.noteId ? `/note/${encodeURIComponent(p.noteId)}` : `/resources/tags/${p.group}?tag=${encodeURIComponent(p.name)}`);
  // 考点有真题就进专题训练做这个考点的题；没有题才回笔记
  const drillOf = (p) => (p.items ? `/resources/drill/${p.group}?tag=${encodeURIComponent(p.name)}` : noteOf(p));

  /* 需要关注：今天该学的。重点是学，不是翻笔记——
     单词、长难句先列；到期的考点改成「做这个考点的题」，做题本身就算复习；错题本盖住解析重做 */
  const tasks = [];
  const vt = data.vocabToday;
  if (vt) {
    const fresh = Math.min(vt.fresh, vt.sessionNew || 20);
    const done = wordsDone >= goals.words;
    tasks.push({
      key: 'words', kind: 'words', type: '背单词', name: '今天的单词',
      sub: [vt.due && `到期 ${vt.due} 个`, fresh && `新词 ${fresh} 个`].filter(Boolean).join(' · ') || '没有到期的词',
      right: done ? `已背 ${wordsDone} 个` : `${wordsDone} / ${goals.words} 个`, done, to: '/review',
    });
  }
  const rt = data.readingToday;
  if (rt) {
    const done = rt.readToday > 0 && !rt.due;
    tasks.push({
      key: 'reading', kind: 'reading', type: '长难句', name: rt.due ? `${rt.due} 句到期` : '读一句长难句',
      sub: rt.total ? (rt.fresh ? `${rt.fresh} 句还没标注` : `一共 ${rt.total} 句`) : '在真题里收一句',
      right: rt.readToday ? `今天读了 ${rt.readToday} 句` : rt.due ? '读一轮' : '', done, to: '/review/reading',
    });
  }
  const due = (points?.due || []).slice(0, 3);
  for (const p of due) {
    tasks.push({
      key: `p:${p.group}/${p.name}`, kind: 'exam', type: '做题', name: p.name,
      sub: `${p.subject}${p.items ? ` · 真题 ${p.items} 道` : ' · 还没有题，看笔记'}`,
      right: p.overdueDays > 0 ? `逾期 ${p.overdueDays} 天` : '今天到期', warn: p.overdueDays > 0, to: drillOf(p),
    });
  }
  const book = wrongBooks.find((b) => b.nextReview && b.nextReview <= today);
  if (book) {
    tasks.push({
      key: `w:${book.id}`, kind: 'exam', type: '错题', name: book.title, sub: `错题本 · 错 ${book.count} 题`,
      right: '盖住解析重做', to: `/note/${encodeURIComponent(book.id)}`,
    });
  }
  // 没有到期的考点：从没学过、真题最多的那个开始
  const nextPoint = points?.next?.[0];
  if (!due.length && nextPoint) {
    tasks.push({
      key: `n:${nextPoint.group}/${nextPoint.name}`, kind: 'exam', type: '新考点', name: nextPoint.name,
      sub: `${nextPoint.subject} · 真题 ${nextPoint.items} 道`, right: '真题最多', to: drillOf(nextPoint),
    });
  }

  // 「开始」：用默认时长起一个番茄，同时跳到要学的那一页
  const startOn = (t) => {
    startFocus({ minutes: prefs().minutes, label: t.name, to: t.to });
    navigate(t.to);
  };

  /* 最近 14 天哪天学过：日历上有痕迹的都算，和「坚持天数」同一口径 */
  const activeDays = daily.slice(-14).map((r) => ({ date: r.date, on: unitsOf(r) + (r.points || 0) > 0 }));

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

      {/* 今天：三道轨道环（这一页唯一张扬的东西）+ 番茄钟 */}
      <section className="vt-board">
        <div className="vt-card vt-card-today">
          <TodayOrbit today={studyToday} goals={goals} words={wordsDone} exams={examsDone}
                      onEditGoals={() => setGoalOpen(true)} />
          {goalOpen && (
            <GoalEditor goals={goals} onClose={() => setGoalOpen(false)}
                        onSave={async (g) => { await api.setGoals(g); reload(); }} />
          )}
        </div>
        <div className="vt-card vt-card-focus">
          <FocusCard />
        </div>
      </section>

      <section className="vt-board vt-board-2">
        <div className="vt-card">
          <div className="vt-read-h">
            <h3>需要关注</h3>
            <span className="fc-meta">点一行去学，点 ▶ 顺便开一个番茄</span>
          </div>
          <div className="tk-list">
            {tasks.map((t) => (
              <div key={t.key} className={`tk-row${t.done ? ' done' : ''}`}>
                <button className="tk-main" onClick={() => navigate(t.to)}>
                  <i className="tk-sw" style={{ background: `var(--act-${t.kind})` }} aria-hidden="true" />
                  <span className="tk-type">{t.type}</span>
                  <span className="tk-name">{t.name}</span>
                  <span className="tk-sub">{t.sub}</span>
                  <span className={`tk-r${t.warn ? ' warn' : ''}${t.done ? ' ok' : ''}`}>{t.right}</span>
                </button>
                <button className="tk-go" title={`开始专注 ${prefs().minutes} 分钟：${t.name}`} aria-label={`开始专注：${t.name}`} onClick={() => startOn(t)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
                </button>
              </div>
            ))}
            {!tasks.length && <Empty>今天没有特别要学的——开一个番茄，随便做几道题</Empty>}
          </div>
        </div>
        <div className="vt-card">
          <DailyProgress daily={daily} studyDays={studyDays} activeDays={activeDays} today={today} />
        </div>
      </section>
    </div></div>
  );
}
