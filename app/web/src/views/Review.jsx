import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import Prose from '../components/Prose.jsx';
import ReviewBar from '../components/ReviewBar.jsx';
import { Loading, ErrorBox, Empty } from '../components/bits.jsx';
import { Icon } from '../components/Icons.jsx';

const weight = (n) => (n.tags.includes('考研') ? 2 : 0) + (n.folder.startsWith('个人') ? -1 : 0);

export default function Review({ version, onReviewed }) {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(0);
  const [finished, setFinished] = useState([]);
  const { data: queue, loading, error, reload } = useApi(() => api.queue(), [version]);

  // 到期的优先，没有到期的就把还没纳入复习的排进来
  const list = useMemo(() => {
    if (!queue) return [];
    // 到期的先复习；还没纳入复习的按「是否考研笔记」排序，个人随笔排到最后
    const fresh = queue.unscheduled
      .filter((n) => n.status === 'new')
      .sort((a, b) => weight(b) - weight(a));
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
        <motion.div
          className="card" style={{ padding: '60px 40px', textAlign: 'center' }}
          initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        >
          <div style={{ color: 'var(--blue)', marginBottom: 14 }}><Icon.check width={38} height={38} /></div>
          <div style={{ fontSize: 19, fontWeight: 640, color: 'var(--text)' }}>
            {doneCount > 0 ? `完成 ${doneCount} 篇复习` : '今天没有到期的笔记'}
          </div>
          <div style={{ color: 'var(--dim)', marginTop: 8, fontSize: 13 }}>
            {queue?.upcoming?.length ? `最近的一篇在 ${queue.upcoming[0].inDays} 天后` : '去看看还没纳入复习的笔记'}
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 24, gap: 10 }}>
            <button className="btn" onClick={() => navigate('/notes')}>浏览笔记</button>
            <button className="btn primary" onClick={() => navigate('/')}>回到仪表盘</button>
          </div>
        </motion.div>
      </div></div>
    );
  }

  const advance = () => {
    setFinished((f) => [...f, current.id]);
    onReviewed?.();
  };

  return (
    <div className="scroll"><div className="review-stage">
      <div className="review-progress">
        {Array.from({ length: Math.max(total, 1) }).map((_, i) => (
          <i key={i} className={i < doneCount ? 'done' : i === doneCount ? 'current' : ''} />
        ))}
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <span className="chip blue num">{doneCount + 1} / {total}</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setCursor((c) => (c + 1) % Math.max(list.length, 1))} disabled={list.length < 2}>
          跳过这篇 <Icon.arrow width={14} height={14} />
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.article
          key={current.id}
          className="review-card"
          initial={{ opacity: 0, y: 24, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -18, scale: 0.99 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        >
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
            {current.tags.slice(0, 3).map((t) => <span className="chip blue" key={t}>{t}</span>)}
            <span className="chip num">已复习 {current.reviewCount} 次</span>
            {current.overdueDays > 0 && <span className="chip solid num">逾期 {current.overdueDays} 天</span>}
          </div>

          <h1 style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-0.02em', margin: '6px 0 20px' }}>
            {current.title}
          </h1>

          {note ? <Prose html={note.html} /> : <Loading />}

          <div className="review-actions">
            <ReviewBar note={current} compact onDone={advance} />
          </div>
        </motion.article>
      </AnimatePresence>

      <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
        <button className="btn ghost sm" onClick={() => navigate(`/note/${encodeURIComponent(current.id)}`)}>
          在笔记页打开
        </button>
      </div>
    </div></div>
  );
}
