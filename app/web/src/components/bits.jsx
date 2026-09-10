import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

export const Section = ({ title, aside, children }) => (
  <>
    <div className="section-head">
      <h2>{title}</h2>
      <span className="rule" />
      {aside}
    </div>
    {children}
  </>
);

export const Loading = () => <div className="spinner" />;

export const ErrorBox = ({ error, onRetry }) => (
  <div className="empty">
    <div style={{ color: 'var(--text-2)', marginBottom: 12 }}>{error}</div>
    {onRetry && <button className="btn sm" onClick={onRetry}>重试</button>}
  </div>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Stat = ({ value, label, accent }) => (
  <div>
    <div className={`stat-v num${accent ? ' accent' : ''}`}>{value}</div>
    <div className="stat-k">{label}</div>
  </div>
);

/** 统一的笔记条目：仪表盘、复习队列、日程日表都用它 */
export function NoteRow({ note, right, index = 0 }) {
  const navigate = useNavigate();
  const meta = [
    note.tags?.slice(0, 2).join(' · '),
    note.reviewCount ? `复习 ${note.reviewCount} 次` : '未复习',
    note.overdueDays > 0 ? `逾期 ${note.overdueDays} 天` : note.inDays ? `${note.inDays} 天后` : null,
  ].filter(Boolean).join('　');

  return (
    <motion.div
      className="note-item"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.025, 0.3), duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      onClick={() => navigate(`/note/${encodeURIComponent(note.id)}`)}
    >
      <span className={`ni-dot${note.status === 'due' ? '' : ' mute'}`} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ni-title">{note.title}</div>
        <div className="ni-meta num">{meta}</div>
      </div>
      {right}
    </motion.div>
  );
}
