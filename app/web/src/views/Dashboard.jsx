import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Band, Loading, ErrorBox, Empty, Item } from '../components/bits.jsx';
import Trend, { SERIES, unitsOf, tipOf } from '../components/Trend.jsx';

/**
 * 仪表盘按学习过程来摆，只留每天要看的：
 *   概览——倒计时、六个数、今天该做什么（建议）
 *   考点层（真题标签）——今天学了哪些考点、有多少要复习、薄弱在哪、每科走到哪
 *   笔记层——学习节奏、到期的笔记
 * 笔记是学某个考点时写下的感悟，所以「学没学」看有没有对上的笔记，
 * 「要不要复习」看那篇笔记到没到期。
 * 最近复习 / 标签分布 / 未纳入复习 这些流水账不放这儿：日历和笔记页各有一份，仪表盘只回答「现在该做什么」。
 */

const dot = (d) => (d ? d.replaceAll('-', '.') : '—');
const GROUP_HUE = { math: 'hue-math', 408: 'hue-408' };
const WEEKS = 26;

/* 热力图的深浅按「单位量」分档：和每日进度同一套折算（笔记 1、做题 0.5、背词 0.2） */
const level = (u) => (u <= 0 ? 0 : u <= 2 ? 1 : u <= 6 ? 2 : 3);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 学习节奏的热力图：近 26 周、从周一起算，一格一天，深浅 = 那天学了多少（四种活动折算后相加）。
 * 数据和右边的每日进度是同一份 daily，所以两边对得上。
 */
function Heat({ daily, today }) {
  const byDate = new Map(daily.map((r) => [r.date, r]));
  const cursor = new Date(`${today}T00:00:00`);
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  const cells = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const date = iso(cursor);
    const r = byDate.get(date);
    // 考点推进不进柱子，但那天也算学过（和日历、连续天数同一口径）
    cells.push({ date, r, units: r ? unitsOf(r) + (r.points || 0) : 0, future: date > today });
    cursor.setDate(cursor.getDate() + 1);
  }
  const totals = SERIES.map((s) => ({ ...s, n: daily.reduce((a, r) => a + (r[s.key] || 0), 0) }));
  const activeDays = cells.filter((c) => c.units > 0).length;
  const tip = (c) => (c.r ? tipOf(c.r) : `${c.date}　—`);
  return (
    <div className="heat-wrap">
      <div className="trend-head">
        <span>近 {WEEKS} 周</span>
        <span className="spacer" />
        <span>{activeDays} 个学习日</span>
      </div>
      <div className="heat" style={{ gridTemplateColumns: `repeat(${WEEKS}, 11px)` }}>
        {cells.map((c) => <i key={c.date} data-l={level(c.units)} data-f={c.future ? 1 : 0} title={tip(c)} />)}
      </div>
      {/* 学了些什么：四种活动在这 26 周里各多少，颜色和每日进度的柱子一致 */}
      <div className="trend-legend">
        {totals.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label} <b className="fig">{s.n}</b></span>)}
      </div>
    </div>
  );
}

export default function Dashboard({ version }) {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, due, upcoming, streak, daysToExam, examDate, today, points, stages, wrongBooks = [], daily = [] } = data;
  const STAGE_COLORS = ['var(--line-2)', 'var(--hue-2)', 'var(--accent-2)', 'var(--accent)', 'var(--hue-3)'];
  const StageBar = ({ counts: c, total }) => (
    <div className="stage-bar" title={c.map((n, k) => `${stages.names[k]} ${n}`).join(' · ')}>
      {c.map((n, k) => (n > 0 ? <i key={k} style={{ width: `${(n / Math.max(1, total)) * 100}%`, background: STAGE_COLORS[k] }} /> : null))}
    </div>
  );
  const list = due.length ? due : upcoming;
  const pt = points?.totals || { total: 0, learned: 0, unlearned: 0, due: 0, today: 0 };
  const wrongTotal = wrongBooks.reduce((a, b) => a + b.count, 0);

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
    // 连续天数不只看笔记复习，背词 / 做题也算——今天已经学过了，就别再拿「断连续」吓人
    const todayRow = daily.find((d) => d.date === today);
    const todayActive = todayRow ? unitsOf(todayRow) + (todayRow.points || 0) > 0 : false;
    tips.push({
      key: 'streak',
      text: todayActive
        ? `今天还没复习笔记，${counts.due} 篇在等——顺手复习一篇`
        : `今天还没复习笔记，${counts.due} 篇在等——复习一篇就不断连续（已 ${streak} 天）`,
    });
  }
  if (pt.week === 0 && pt.unlearned > 0 && points?.next?.[0]) {
    const n = points.next[0];
    tips.push({ key: 'next', text: `近 7 天没学新考点——「${n.name}」真题最多，从它开始`, go: () => openPoint(n) });
  }

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

      <div className="g12" style={{ marginTop: 48, gap: 48 }}>
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
            {/* 学习节奏：左边热力图看坚持，右边柱线图看每天做了多少；两边同一份 daily */}
            <Band title="学习节奏" meta="笔记复习 · 背词 · 做题 · 长难句 · 新建">
              <div className="rhythm">
                <Heat daily={daily} today={today} />
                <Trend daily={daily} />
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
        </div>

        <div style={{ gridColumn: 'span 5' }}>
          {/* 二轮查漏，放在最上面：先是每本错题本记了几题（多的在前），再是做错过的考点 */}
          <Band title="薄弱考点" meta={wrongTotal ? `错题本 ${wrongTotal} 题` : '没有'}>
            {wrongBooks.map((b) => (
              <button key={b.id} className="pt-row hue-wrong" onClick={() => openNote(b.id)}>
                <i className="pt-sw" />
                <span className="pt-name">{b.title}</span>
                <span className="pt-sub">{b.subject}</span>
                <span className={`pt-r${b.nextReview && b.nextReview <= today ? ' on' : ''}`}>错 {b.count} 题</span>
              </button>
            ))}
            {stages?.weak?.map((p) => (
              <button key={`${p.group}/${p.name}`} className={`pt-row ${GROUP_HUE[p.group] || ''}`} onClick={() => openPoint(p)}>
                <i className="pt-sw" />
                <span className="pt-name">{p.name}</span>
                <span className="pt-sub">{p.subject} · {stages.names[p.stage]}</span>
                <span className={`pt-r${p.wrongAfter ? ' on' : ''}`}>错 {p.wrong} / {p.attempted}{p.wrongAfter ? ` · 总结后 ${p.wrongAfter}` : ''}</span>
              </button>
            ))}
            {!wrongBooks.length && !stages?.weak?.length && <Empty>还没有错题本——真题交卷后点「错题」，做错的题会按考点归档到这里</Empty>}
          </Band>

          <div style={{ marginTop: 48 }}>
            {/* 一轮复习走到哪：每个考点在 概念 / 做题 / 理解 / 复习 / 总结 五段里的哪一段 */}
            <Band title="一轮进度" meta="概念 → 做题 → 理解 → 复习 → 总结">
              {stages?.groups?.map((g) => {
                const pg = points?.groups?.find((x) => x.key === g.key);
                return (
                  <div key={g.key} className={`prog-group ${GROUP_HUE[g.key] || ''}`}>
                    <div className="prog-head">
                      <i className="pt-sw" />
                      <span className="prog-name">{g.label}</span>
                      <span className="prog-n fig">总结 {g.counts[4]} / {g.total}</span>
                      {pg?.due > 0 && <span className="prog-due">{pg.due} 待复习</span>}
                      {pg?.today > 0 && <span className="prog-today">今日 +{pg.today}</span>}
                    </div>
                    <StageBar counts={g.counts} total={g.total} />
                    {g.subjects.map((s) => (
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
        </div>
      </div>
    </div></div>
  );
}
