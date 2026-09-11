import { useNavigate } from 'react-router-dom';

/** 一条带标题的发丝线分区 */
export const Band = ({ title, meta, children }) => (
  <>
    <div className="band">
      <span className="band-title">{title}</span>
      {meta != null && <span className="band-meta">{meta}</span>}
    </div>
    {children}
  </>
);

export const Loading = () => <div className="spinner" />;

export const ErrorBox = ({ error, onRetry }) => (
  <div className="empty">
    <div style={{ color: 'var(--text-2)', marginBottom: 14 }}>{error}</div>
    {onRetry && <button className="btn sm" onClick={onRetry}>重试</button>}
  </div>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Stat = ({ value, label, on }) => (
  <div>
    <div className={`stat-v${on ? ' on' : ''}`}>{value}</div>
    <div className="stat-k">{label}</div>
  </div>
);

/** 统一的笔记条目：仪表盘、复习队列、日程日表都用它 */
export function Item({ note, index = 0, right }) {
  const navigate = useNavigate();
  const meta = [
    note.tags?.filter((t) => t !== '考研').slice(0, 2).join(' · '),
    note.reviewCount ? `复习 ${note.reviewCount} 次` : '未复习',
  ].filter(Boolean).join('　');

  const overdue = note.overdueDays > 0 ? `+${note.overdueDays}` : note.inDays ? `${note.inDays} 天后` : '今天';

  return (
    <div className="item" onClick={() => navigate(`/note/${encodeURIComponent(note.id)}`)}>
      <span className="it-ord">{String(index + 1).padStart(2, '0')}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="it-title">{note.title}</div>
        <div className="it-meta">{meta}</div>
      </div>
      {right ?? <span className={`it-r${note.overdueDays > 0 ? ' on' : ''}`}>{overdue}</span>}
    </div>
  );
}
