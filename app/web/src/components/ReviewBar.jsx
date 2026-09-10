import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';

const INTERVALS = [1, 2, 4, 7, 15, 30];
const nextGap = (count) => INTERVALS[Math.min(count, INTERVALS.length - 1)];
const plusDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 记一次复习：写回笔记 frontmatter + 追加 review_log.jsonl。
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
      <motion.div
        className={compact ? '' : 'review-bar'}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      >
        <Icon.check width={16} height={16} style={{ color: 'var(--blue)' }} />
        <span style={{ color: 'var(--text)' }}>
          第 <b className="num">{done.reviewCount}</b> 次复习已记录
        </span>
        <span className="chip blue num">下次 {done.nextReview}（{done.gap} 天后）</span>
      </motion.div>
    );
  }

  return (
    <div className={compact ? '' : 'review-bar'}>
      <div className="row" style={{ flex: 1, minWidth: 220, gap: 10 }}>
        <input
          className="input" style={{ flex: 1 }}
          placeholder="本次新增/加深的理解（可留空）"
          value={added}
          onChange={(e) => setAdded(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit('good')}
        />
      </div>
      <button className="btn" onClick={() => submit('again')} disabled={!!busy}>
        <Icon.again width={15} height={15} />
        需重来
        <span className="chip num" style={{ marginLeft: 2 }}>1 天</span>
      </button>
      <button className="btn primary" onClick={() => submit('good')} disabled={!!busy}>
        <Icon.check width={15} height={15} />
        已掌握
        <span className="chip num" style={{ marginLeft: 2, background: 'rgba(255,255,255,.18)', color: '#fff', borderColor: 'transparent' }}>
          {nextGap(note.reviewCount)} 天
        </span>
      </button>
      <AnimatePresence>
        {error && (
          <motion.span
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ color: 'var(--blue-2)', fontSize: 12.5 }}
          >
            {error}
          </motion.span>
        )}
      </AnimatePresence>
      {!compact && (
        <span className="chip num" title="按 review_log_schema.md 的间隔表推算">
          → {plusDays(nextGap(note.reviewCount))}
        </span>
      )}
    </div>
  );
}
