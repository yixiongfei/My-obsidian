import { useState } from 'react';
import { api } from '../api.js';

const INTERVALS = [1, 2, 4, 7, 15, 30];
const nextGap = (count) => INTERVALS[Math.min(count, INTERVALS.length - 1)];
const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10).replaceAll('-', '.');
};

/**
 * 记一次复习：写回笔记 frontmatter、追加 review_log.jsonl、同步进 SQLite。
 * 只动 review_count / last_reviewed / next_review 三个字段，正文一个字不改。
 */
export default function ReviewBar({ note, onDone, compact = false }) {
  const [added, setAdded] = useState('');
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);

  const submit = async (result) => {
    setBusy(result);
    setError(null);
    try {
      const out = await api.review({ path: note.id, result, addedContent: added });
      setDone(out);
      setAdded('');
      onDone?.(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className={compact ? 'row' : 'review-bar'} style={{ gap: 16 }}>
        <span className="lbl-cn">已记录</span>
        <span style={{ color: 'var(--text)', fontSize: 13 }}>
          第 {done.reviewCount} 次复习
        </span>
        <span style={{ color: 'var(--blue)', fontSize: 12 }}>
          下次 {done.nextReview.replaceAll('-', '.')}　{done.gap} 天后
        </span>
      </div>
    );
  }

  return (
    <div className={compact ? 'row' : 'review-bar'} style={compact ? { gap: 16, flexWrap: 'wrap' } : undefined}>
      <span className="lbl-cn" style={{ flex: 'none' }}>记一次复习</span>
      <input
        className="input" style={{ flex: 1, minWidth: 200 }}
        placeholder="本次新增 / 加深的理解（可留空）"
        value={added}
        onChange={(e) => setAdded(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit('good')}
      />
      <button className="btn" onClick={() => submit('again')} disabled={!!busy}>
        需重来　<span style={{ color: 'var(--dim)' }}>1 天</span>
      </button>
      <button className="btn primary" onClick={() => submit('good')} disabled={!!busy}>
        已掌握　{nextGap(note.reviewCount)} 天
      </button>
      {!compact && (
        <span style={{ fontSize: 11, color: 'var(--dim)' }} title="按 review_log_schema.md 的间隔表推算">
          → {plusDays(nextGap(note.reviewCount))}
        </span>
      )}
      {error && <span style={{ color: 'var(--blue)', fontSize: 12 }}>{error}</span>}
    </div>
  );
}
