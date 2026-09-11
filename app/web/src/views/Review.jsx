import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';

/**
 * 英语词汇 Anki。
 *
 * 与笔记复习严格分离：这里只出英语单词卡，数学/408 那类知识点仍然回到
 * 笔记原文做长时间的深度复习，不做成卡片。
 *
 * 队列一旦开始就是**不可变快照**：给当前卡评分不会往本轮里补新词，
 * 否则"还剩几张"会一直变，用户永远看不到尽头。要新词就点「开始新一轮」。
 */

const RATINGS = [
  { key: 'again', label: '重来', hint: '1', desc: '没想起来' },
  { key: 'hard', label: '困难', hint: '2', desc: '想起来了但很吃力' },
  { key: 'good', label: '掌握', hint: '3', desc: '正常想起来' },
  { key: 'easy', label: '轻松', hint: '4', desc: '以后不再出现' },
];

const dot = (d) => (d ? d.replaceAll('-', '.') : '');

export default function Review({ version, onReviewed }) {
  const { data, loading, error, reload } = useApi(() => api.cards(), [version]);

  // 本轮的不可变快照。只在开新一轮时整体替换
  const [queue, setQueue] = useState(null);
  const [doneIds, setDoneIds] = useState(() => new Set());
  const [flipped, setFlipped] = useState(false);
  const [masteredCount, setMasteredCount] = useState(0);
  const [notice, setNotice] = useState('');

  // 锁住并发：双击、键盘连击、React 还没重绘时的重复提交都会走到这儿
  const inFlight = useRef(false);
  const finished = useRef(false);
  /* 只有首次加载和用户点「开始新一轮」才开新一轮。
     写 Markdown 会触发 SSE、进而让 useApi 重新拉取 cards——
     如果这里无条件跟着 data 重开，本轮计数会在最后一张评完的瞬间被清零。 */
  const wantNewRound = useRef(true);

  const startRound = useCallback((cards) => {
    // 服务端就算混进别的类型也不显示：这一页只认单词卡
    const words = (cards || []).filter((c) => c.type === 'word');
    setQueue(words);
    setDoneIds(new Set());
    setFlipped(false);
    setMasteredCount(0);
    setNotice('');
    finished.current = words.length === 0;
  }, []);

  useEffect(() => {
    if (!data || !wantNewRound.current) return;
    wantNewRound.current = false;
    startRound(data.cards);
  }, [data, startRound]);

  const newRound = useCallback(() => { wantNewRound.current = true; reload(); }, [reload]);

  const remaining = useMemo(
    () => (queue || []).filter((c) => !doneIds.has(c.id)),
    [queue, doneIds],
  );
  const card = remaining[0] || null;
  const total = queue?.length || 0;
  const doneCount = total - remaining.length;

  const finishRound = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    // 非阻塞：合并写当天的 Markdown，不等磁盘
    api.syncVocabMarkdown();
    onReviewed?.();
  }, [onReviewed]);

  const grade = useCallback(async (rating) => {
    if (!card || inFlight.current || !flipped) return;
    inFlight.current = true;
    try {
      const out = await api.rateWord(card.id, rating);
      if (out?.graduated) setMasteredCount((n) => n + 1);
      setNotice('');
    } catch (e) {
      // 409：这个词在别处已经完成了。安静地从本轮移除，别让整轮卡死
      if (/409|毕业/.test(e.message)) setNotice(`${card.term} 已在别处完成，跳过`);
      else { setNotice(e.message); inFlight.current = false; return; }
    }
    setDoneIds((prev) => {
      const next = new Set(prev);
      next.add(card.id);
      if (next.size >= total) finishRound();
      return next;
    });
    setFlipped(false);
    inFlight.current = false;
  }, [card, flipped, total, finishRound]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches?.('input, textarea')) return;
      if (!card) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setFlipped((f) => !f);
        return;
      }
      if (!flipped) return;
      const hit = RATINGS.find((r) => r.hint === e.key);
      if (hit) { e.preventDefault(); grade(hit.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, flipped, grade]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data || !queue) return null;

  const counts = data.counts?.words || {};

  if (!card) {
    return (
      <div className="scroll"><div className="vocab-stage">
        <div className="vocab-done">
          <div className="lbl">ROUND COMPLETE</div>
          <div className="vocab-done-n fig">{doneCount}</div>
          <p className="vocab-done-t">
            本轮完成 {doneCount} 个词
            {masteredCount > 0 && <>，其中 <b>{masteredCount}</b> 个标为「轻松」已掌握</>}
          </p>
          {masteredCount > 0 && (
            <p className="vocab-done-s">标为「轻松」的词已经毕业，后续轮次不会再出现。</p>
          )}
          <div className="row" style={{ gap: 12, marginTop: 28, justifyContent: 'center' }}>
            <button className="btn primary lg" onClick={newRound}>开始新一轮　→</button>
          </div>
          <div className="vocab-done-meta">
            剩余到期 {counts.due ?? 0} · 未学新词 {counts.new ?? 0} · 已掌握 {counts.mastered ?? 0}
          </div>
        </div>
      </div></div>
    );
  }

  const senses = card.senses?.length
    ? card.senses
    // 旧数据没有结构化义项时的回退，绝不能让卡背空白
    : (card.meanings || []).filter(Boolean).map((m) => ({ pos: '', gloss: m }));
  const fallbackText = !senses.length ? (card.translation || card.definition || '') : '';

  return (
    <div className="scroll"><div className="vocab-stage">
      <div className="vocab-top">
        <div className="vocab-bar">
          <i style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
        </div>
        <div className="vocab-top-meta">
          <span className="fig">{String(doneCount + 1).padStart(2, '0')} / {total}</span>
          <span className="dim">本轮 {total} 词</span>
          <span className="spacer" />
          {card.overdueDays > 0
            ? <span className="due">逾期 {card.overdueDays} 天</span>
            : card.due ? <span className="dim">下次 {dot(card.due)}</span> : <span className="dim">新词</span>}
          <span className="dim">复习 {card.reviewCount} 次</span>
          <span className="dim">已掌握 {counts.mastered ?? 0}</span>
        </div>
      </div>

      <button className={`vocab-card${flipped ? ' open' : ''}`}
              onClick={() => setFlipped((f) => !f)}
              aria-label={flipped ? '收起释义' : '查看释义'}>
        <div className="vocab-face">
          <div className="vocab-term">{card.term}</div>
          {card.phonetic && <div className="vocab-ph">/{card.phonetic}/</div>}
          {!flipped && <div className="vocab-cue">点击卡片或按 Space 查看释义</div>}
        </div>

        {flipped && (
          <div className="vocab-back">
            {senses.map((s, i) => (
              <div className="vocab-sense" key={i}>
                <span className="vs-ord fig">{i + 1}</span>
                {s.pos && <span className="vs-pos">{s.pos}</span>}
                <span className="vs-gloss">{s.gloss}</span>
              </div>
            ))}
            {fallbackText && <div className="vocab-sense"><span className="vs-gloss">{fallbackText}</span></div>}

            {card.example?.text && (
              <div className="vocab-usage">
                <div className="lbl">USAGE EXAMPLE</div>
                <p className="vu-en">{card.example.text}</p>
                {card.example.translation && <p className="vu-cn">{card.example.translation}</p>}
              </div>
            )}

            {card.tags?.length > 0 && (
              <div className="vocab-tags">
                {card.tags.slice(0, 5).map((t) => <span className="tag" key={t}>{t}</span>)}
              </div>
            )}
          </div>
        )}
      </button>

      {notice && <div className="vocab-notice">{notice}</div>}

      <div className="vocab-actions">
        {RATINGS.map((r) => (
          <button key={r.key}
                  className={`vocab-btn v-${r.key}`}
                  disabled={!flipped}
                  title={r.desc}
                  onClick={() => grade(r.key)}>
            <span className="vb-k">{r.label}</span>
            <span className="vb-h">{r.hint}</span>
          </button>
        ))}
      </div>
      {!flipped && <div className="vocab-hint">先翻面再评分　·　Space 翻面，1 / 2 / 3 / 4 评分</div>}
    </div></div>
  );
}
