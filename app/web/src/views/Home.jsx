import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';
import OrbitMap from '../components/OrbitMap.jsx';
import IsoStack from '../components/IsoStack.jsx';

const dot = (d) => (d ? d.replaceAll('-', '.') : '—');

export default function Home({ version, theme }) {
  const navigate = useNavigate();
  const bodyRef = useRef(null);
  const { data, loading, error, reload } = useApi(() => api.dashboard(), [version]);
  const { data: mind } = useApi(() => api.mindmap(), [version]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;

  const { counts, daysToExam, examDate, upcoming, due } = data;

  // 一级学科：夜间画成等距立柱，白天画成轨道图
  const groups = (mind?.groups || []).filter((g) => !g.outside)
    .map((g) => ({ name: g.name, notes: g.count, mastery: g.mastery }));
  const nextDue = upcoming[0]?.nextReview || due[0]?.nextReview;

  const ENTRIES = [
    { to: '/dashboard', k: '仪表盘', v: counts.due, unit: '篇待复习', d: '倒计时、复习节奏与标签分布' },
    { to: '/notes', k: '笔记', v: counts.notes, unit: '篇', d: '按词表铺开的结构图与阅读页' },
    { to: '/review', k: '复习', v: counts.reviews, unit: '次', d: '到期笔记逐篇过，折叠即自测' },
    { to: '/schedule', k: '日历', v: Math.round((daysToExam || 0) / 7), unit: '周', d: '年 → 月 → 日，含日本の祝日' },
  ];

  return (
    <div className="scroll">
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
            {theme === 'dark'
              ? <IsoStack subjects={groups} nextReview={nextDue} examDate={examDate} />
              : <OrbitMap subjects={groups} caption={groups.map((g) => g.name).join(' · ')} />}
          </div>
        </div>

        <button className="scroll-cue" title="向下"
                onClick={() => bodyRef.current?.scrollIntoView({ behavior: 'smooth' })}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 4v15M6 13l6 6 6-6" />
          </svg>
        </button>
      </section>

      {/* ══════ 折线以下：倒计时 + 四个入口 ══════ */}
      <section className="page" ref={bodyRef} style={{ paddingTop: 56 }}>
        <div className="g12" style={{ alignItems: 'end', gap: 32 }}>
          <div style={{ gridColumn: 'span 5' }}>
            <div className="lbl-cn" style={{ marginBottom: 12 }}>距 {examDate?.slice(0, 4)} 初试</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
              <span className="count-num serif">{daysToExam ?? '—'}</span>
              <span style={{ fontSize: 16, color: 'var(--text-2)' }}>天</span>
            </div>
          </div>
          <div style={{ gridColumn: 'span 7' }}>
            <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 2 }}>
              {dot(examDate)} 初试 · 约 {Math.round((daysToExam || 0) / 7)} 周
              {mind && <><br />收录 {mind.counts.notes} 篇，词表里还有 {mind.counts.emptyBranches} 个考点没有笔记</>}
            </div>
          </div>
        </div>

        <div className="entry-grid">
          {ENTRIES.map((e, i) => (
            <button key={e.to} className="entry" onClick={() => navigate(e.to)}>
              <span className="en-ord">{String(i + 1).padStart(2, '0')}</span>
              <span className="en-k">{e.k}</span>
              <span className="en-v">{e.v}<em>{e.unit}</em></span>
              <span className="en-d">{e.d}</span>
              <span className="en-go">→</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
