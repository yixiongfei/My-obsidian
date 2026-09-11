import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import Prose from '../components/Prose.jsx';
import ReviewBar from '../components/ReviewBar.jsx';
import { Loading, ErrorBox } from '../components/bits.jsx';

/** 到期的先复习；还没纳入的按「是否考研笔记」排序，个人随笔排最后 */
const weight = (n) => (n.tags.includes('考研') ? 2 : 0) + (n.folder.startsWith('个人') ? -1 : 0);

export default function Review({ version, onReviewed }) {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [finished, setFinished] = useState([]);
  const { data: queue, loading, error, reload } = useApi(() => api.queue(), [version]);

  const list = useMemo(() => {
    if (!queue) return [];
    const fresh = queue.unscheduled.filter((n) => n.status === 'new').sort((a, b) => weight(b) - weight(a));
    return [...queue.due, ...fresh].filter((n) => !finished.includes(n.id));
  }, [queue, finished]);

  const current = list[cursor] || null;
  const { data: note } = useApi(() => api.note(current.id), [current?.id], { skip: !current });

  useEffect(() => { if (cursor >= list.length) setCursor(Math.max(0, list.length - 1)); }, [list.length, cursor]);

  if (loading && !queue) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const total = (queue?.due.length || 0) + (queue?.unscheduled.filter((n) => n.status === 'new').length || 0);
  const doneCount = finished.length;

  if (!current) {
    return (
      <div className="scroll"><div className="review-stage">
        <div style={{ borderTop: '1px solid var(--line-2)', paddingTop: 64, textAlign: 'center' }}>
          <div className="lbl-cn" style={{ marginBottom: 20 }}>本轮结束</div>
          <div style={{ fontSize: 46, fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1 }}>
            {doneCount || 0}
          </div>
          <div className="stat-k" style={{ marginBottom: 28 }}>篇已复习</div>
          <div style={{ color: 'var(--dim)', fontSize: 13, marginBottom: 30 }}>
            {queue?.upcoming?.length ? `最近的一篇在 ${queue.upcoming[0].inDays} 天后` : '没有排期中的笔记'}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
            <button className="btn" onClick={() => navigate('/notes')}>浏览笔记</button>
            <button className="btn primary" onClick={() => navigate('/')}>回到仪表盘</button>
          </div>
        </div>
      </div></div>
    );
  }

  const advance = () => { setFinished((f) => [...f, current.id]); onReviewed?.(); };

  return (
    <div className="scroll"><div className="review-stage">
      <div className="review-progress">
        {Array.from({ length: Math.max(total, 1) }).map((_, i) => (
          <i key={i} className={i < doneCount ? 'done' : i === doneCount ? 'current' : ''} />
        ))}
      </div>

      <div className="band" style={{ borderBottom: 'none', paddingBottom: 18 }}>
        <span className="band-title">{String(doneCount + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}</span>
        <button className="band-meta" onClick={() => setCursor((c) => (c + 1) % Math.max(list.length, 1))}
                disabled={list.length < 2} style={{ letterSpacing: '0.14em' }}>
          跳过这篇 →
        </button>
      </div>

      <article className="review-card">
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          {current.tags.filter((t) => t !== '考研').slice(0, 3).map((t) => <span className="tag" key={t}>{t}</span>)}
          <span className="tag">已复习 {current.reviewCount} 次</span>
          {current.overdueDays > 0 && <span className="tag on">逾期 {current.overdueDays} 天</span>}
        </div>

        <h1 style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
          {current.title}
        </h1>

        {note ? <Prose html={note.html} /> : <Loading />}

        <div className="review-actions">
          <ReviewBar note={current} compact onDone={advance} />
        </div>
      </article>

      <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
        <button className="btn ghost sm" onClick={() => navigate(`/note/${encodeURIComponent(current.id)}`)}>
          在笔记页打开
        </button>
      </div>
    </div></div>
  );
}
