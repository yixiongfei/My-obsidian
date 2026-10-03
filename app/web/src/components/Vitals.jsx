import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 仪表盘的「运动健康」那一块：今天的三道轨道环、学习时长的周 / 月柱状图、最近 14 天的坚持点。
 *
 * 轨道环是这一页唯一张扬的东西——星图的气质：三道同心轨道，进度头上一颗「卫星」，外圈一圈刻度。
 *   外圈  学习时间，按做什么分段上色（做题 / 笔记 / 助手 / 阅读 / 背单词），一圈 = 当天目标
 *   中圈  背单词个数 / 目标
 *   内圈  做题道数 / 目标
 * 颜色跟着「做什么」走，全页一致；五个色经过色盲校验（深浅两套各自校验，相邻对 CVD ΔE ≥ 8）。
 * 动效只有一次：进页面时三道环从 0 扫到当前进度、数字跟着数上去；柱子从底线长出来。减少动效时直接到位。
 */

/** 顺序就是色盲安全的机制：冷暖交替，蓝紫不相邻 */
export const ACTS = [
  { key: 'exam', label: '做题' },
  { key: 'notes', label: '笔记' },
  { key: 'assistant', label: '助手' },
  { key: 'reading', label: '阅读' },
  { key: 'words', label: '背单词' },
];
const actColor = (k) => `var(--act-${k})`;

/** 秒 → 「1 小时 25 分」/「25 分钟」/「不到 1 分钟」 */
export function fmtDur(sec, { short = false } = {}) {
  const m = Math.round((sec || 0) / 60);
  if (!sec || sec < 30) return short ? '0 分' : '0 分钟';
  if (m < 60) return short ? `${m} 分` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t) => 1 - (1 - t) ** 3;

/** 进页面跑一次 0 → 1 的进度（约 1.1 秒），给环和数字用 */
function useIntro(deps) {
  const [t, setT] = useState(() => (reduceMotion() ? 1 : 0));
  useEffect(() => {
    if (reduceMotion()) { setT(1); return undefined; }
    let raf = 0;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1100);
      setT(easeOut(p));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setT(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return t;
}

/* ------------------------------------------------------------------ *
 * 今天：三道轨道环 + 读数
 * ------------------------------------------------------------------ */

const SIZE = 264;
const C0 = SIZE / 2;
const STROKE = 14;
// 轨道之间留 8px：外圈末段的背单词青色和中圈同色，挨太近会糊成一条宽带
const RINGS = { time: 106, words: 84, exams: 62 };
const GAP = 2.5;   // 外圈分段之间留一道底色缝

const polar = (r, frac) => {
  const a = -Math.PI / 2 + frac * Math.PI * 2;
  return [C0 + r * Math.cos(a), C0 + r * Math.sin(a)];
};

/** 一段弧：从 from 到 to（都按整圈的比例），用 dasharray 画在一整个圆上 */
function Arc({ r, from, to, color, dim, onEnter, onLeave, label }) {
  const c = 2 * Math.PI * r;
  const len = Math.max(0, (to - from) * c);
  if (len < 0.5) return null;
  return (
    <circle cx={C0} cy={C0} r={r} fill="none" stroke={color} strokeWidth={STROKE}
            strokeDasharray={`${len} ${c}`} transform={`rotate(${from * 360 - 90} ${C0} ${C0})`}
            className={`vt-arc${dim ? ' dim' : ''}`} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <title>{label}</title>
    </circle>
  );
}

/** 进度头上的卫星：外面一圈底色描边，压在轨道上也看得清 */
function Satellite({ r, frac, color, dim }) {
  if (frac <= 0.002) return null;
  const [x, y] = polar(r, Math.min(frac, 1));
  return <circle cx={x} cy={y} r={STROKE / 2 + 1.5} fill={color} className={`vt-sat${dim ? ' dim' : ''}`} />;
}

function Ticks() {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const [x1, y1] = polar(RINGS.time + STROKE / 2 + 6, i / 60);
    const [x2, y2] = polar(RINGS.time + STROKE / 2 + (major ? 13 : 9), i / 60);
    out.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? 'vt-tick major' : 'vt-tick'} />);
  }
  return <g aria-hidden="true">{out}</g>;
}

export function TodayOrbit({ today, goals, words, exams, onEditGoals }) {
  const [hover, setHover] = useState(null);   // 'time' | 'words' | 'exams' | 活动 key
  const goalSec = goals.minutes * 60;
  const total = today?.total || 0;
  const t = useIntro([total, words, exams, goals.minutes, goals.words, goals.exams]);

  // 外圈的分段：按 ACTS 顺序首尾相接，总长 = 学习时间 / 目标（超过一圈就封顶在一圈）
  const segs = useMemo(() => {
    const out = [];
    let at = 0;
    const scale = total > goalSec ? total : goalSec;
    for (const a of ACTS) {
      const s = today?.byKind?.[a.key] || 0;
      if (!s) continue;
      const len = s / scale;
      out.push({ ...a, sec: s, from: at, to: at + len });
      at += len;
    }
    return out;
  }, [today, total, goalSec]);
  const timeFrac = Math.min(1, total / goalSec);
  const wordsFrac = Math.min(1, words / goals.words);
  const examsFrac = Math.min(1, exams / goals.exams);

  const shownTime = timeFrac * t;
  const multi = segs.length > 1;
  const dimOf = (key) => hover != null && hover !== key && !(hover === 'time' && segs.some((s) => s.key === key));

  const minutes = Math.round((total / 60) * t);
  const left = goalSec - total;
  const insight = !total && !words && !exams
    ? '今天还没开始。做题、背单词、看笔记的时间会自动记进来。'
    : left > 60 ? `离今天的学习目标还差 ${fmtDur(left)}。`
      : words < goals.words ? `学习时间够了，背单词还差 ${goals.words - words} 个。`
        : exams < goals.exams ? `学习时间够了，做题还差 ${goals.exams - exams} 道。`
          : '今天三个目标都完成了。';

  const center = hover && hover !== 'time'
    ? hover === 'words' ? { v: words, u: `/ ${goals.words} 个`, k: '背单词' }
      : hover === 'exams' ? { v: exams, u: `/ ${goals.exams} 道`, k: '做题' }
        : { v: Math.round((today?.byKind?.[hover] || 0) / 60), u: '分钟', k: ACTS.find((a) => a.key === hover)?.label }
    : { v: minutes, u: '分钟', k: '今日学习' };   // 目标写在右边的读数里，圆心放不下

  const rows = [
    { key: 'time', label: '学习时间', value: <><b>{fmtDur(total)}</b><span> / {goals.minutes} 分钟</span></>, done: total >= goalSec },
    { key: 'words', label: '背单词', value: <><b>{words}</b><span> / {goals.words} 个</span></>, done: words >= goals.words },
    { key: 'exams', label: '做题', value: <><b>{exams}</b><span> / {goals.exams} 道</span></>, done: exams >= goals.exams },
  ];

  return (
    <div className="vt-today">
      <div className="vt-orbit">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img"
             aria-label={`今天学习 ${fmtDur(total)}，目标 ${goals.minutes} 分钟；背单词 ${words} 个，目标 ${goals.words}；做题 ${exams} 道，目标 ${goals.exams}`}>
          <Ticks />
          {Object.entries(RINGS).map(([k, r]) => <circle key={k} cx={C0} cy={C0} r={r} className="vt-track" strokeWidth={STROKE} fill="none" />)}

          {segs.map((s) => {
            const from = Math.min(s.from, shownTime);
            const to = Math.min(s.to, shownTime);
            const g = multi ? GAP / (2 * Math.PI * RINGS.time) : 0;
            return (
              <Arc key={s.key} r={RINGS.time} from={from} to={Math.max(from, to - g)} color={actColor(s.key)}
                   dim={dimOf(s.key)} label={`${s.label} ${fmtDur(s.sec)}`}
                   onEnter={() => setHover(s.key)} onLeave={() => setHover(null)} />
            );
          })}
          <Arc r={RINGS.words} from={0} to={wordsFrac * t} color={actColor('words')} dim={dimOf('words')}
               label={`背单词 ${words} / ${goals.words}`} onEnter={() => setHover('words')} onLeave={() => setHover(null)} />
          <Arc r={RINGS.exams} from={0} to={examsFrac * t} color={actColor('exam')} dim={dimOf('exams')}
               label={`做题 ${exams} / ${goals.exams}`} onEnter={() => setHover('exams')} onLeave={() => setHover(null)} />

          <Satellite r={RINGS.time} frac={shownTime} color={segs.length ? actColor(segs.findLast((s) => s.from < shownTime)?.key || segs[0].key) : 'var(--accent)'} dim={hover && hover !== 'time'} />
          <Satellite r={RINGS.words} frac={wordsFrac * t} color={actColor('words')} dim={hover && hover !== 'words'} />
          <Satellite r={RINGS.exams} frac={examsFrac * t} color={actColor('exam')} dim={hover && hover !== 'exams'} />

          <text x={C0} y={C0 - 24} className="vt-center-k" textAnchor="middle">{center.k}</text>
          <text x={C0} y={C0 + 14} className="vt-center-v" textAnchor="middle">{center.v}</text>
          <text x={C0} y={C0 + 32} className="vt-center-u" textAnchor="middle">{center.u}</text>
        </svg>
      </div>

      <div className="vt-read">
        <div className="vt-read-h">
          <h3>今天</h3>
          <button className="vt-goal-btn" onClick={onEditGoals}>调整目标</button>
        </div>
        {rows.map((r) => (
          <div key={r.key} className={`vt-row${hover && hover !== r.key && !(r.key === 'time' && segs.some((s) => s.key === hover)) ? ' dim' : ''}`}
               tabIndex={0} onPointerEnter={() => setHover(r.key)} onPointerLeave={() => setHover(null)}
               onFocus={() => setHover(r.key)} onBlur={() => setHover(null)}>
            <i className={`vt-key k-${r.key}`} aria-hidden="true" />
            <span className="vt-row-k">{r.label}</span>
            <span className="vt-row-v">{r.value}</span>
            {r.done && <span className="vt-done">达成</span>}
          </div>
        ))}
        {segs.length > 0 && (
          <ul className="vt-split" aria-label="今天的学习时间分在哪">
            {segs.map((s) => (
              <li key={s.key} className={dimOf(s.key) ? 'dim' : ''}
                  onPointerEnter={() => setHover(s.key)} onPointerLeave={() => setHover(null)}>
                <i style={{ background: actColor(s.key) }} aria-hidden="true" />{s.label}<b>{fmtDur(s.sec, { short: true })}</b>
              </li>
            ))}
          </ul>
        )}
        <p className="vt-insight">{insight}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 学习时长：近 7 / 30 天柱状图 + 目标线 + 一句话结论
 * ------------------------------------------------------------------ */

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const dayOf = (iso) => new Date(`${iso}T00:00:00`);
const mmdd = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}`;

/** 顶部圆角、底部方角的柱子 */
const barPath = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
};

const RANGE_KEY = 'kb-vitals-range';

export function TimeTrend({ days, since, goalMinutes, activeDays }) {
  const [range, setRange] = useState(() => { try { return Number(localStorage.getItem(RANGE_KEY)) || 7; } catch { return 7; } });
  const box = useRef(null);
  const width = useWidth(box);
  const [hover, setHover] = useState(-1);
  // 换范围时清掉悬停：第 3 根柱子在 7 天和 30 天里不是同一天
  const pick = (n) => { setRange(n); setHover(-1); try { localStorage.setItem(RANGE_KEY, String(n)); } catch { /* 无痕 */ } };
  const [grown, setGrown] = useState(reduceMotion());

  const list = days.slice(-range);
  const today = days.at(-1)?.date;
  const goal = goalMinutes * 60;
  useEffect(() => {
    if (reduceMotion()) return undefined;
    setGrown(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(id);
  }, [range]);

  // 纵轴按小时取整；目标线一定落在图里
  const max = Math.max(goal, ...list.map((d) => d.total), 3600);
  const stepH = max > 4 * 3600 ? 2 : 1;
  const top = Math.ceil((max * 1.08) / (stepH * 3600)) * stepH * 3600;
  const H = 188;
  const padL = 34;
  const padB = 26;
  const plotH = H - padB - 10;
  const plotW = Math.max(0, width - padL - 8);
  const slot = list.length ? plotW / list.length : 0;
  const barW = Math.max(3, Math.min(24, slot * (range > 7 ? 0.6 : 0.46)));
  const y = (s) => 10 + plotH - (s / top) * plotH;
  const ticks = [];
  for (let s = 0; s <= top; s += stepH * 3600) ticks.push(s);

  // 一句话：近 7 天合计、日均、和前 7 天比；还没记满就只说记了几天
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);
  const sum = (a) => a.reduce((n, d) => n + d.total, 0);
  const tracked7 = last7.filter((d) => !since || d.date >= since);
  const prevTracked = since && prev7.length && prev7[0].date >= since;
  const best = [...last7].sort((a, b) => b.total - a.total)[0];
  let story = '';
  if (!since) story = '学习时间从今天开始记录。';
  else if (!sum(last7)) story = '最近 7 天还没有记录到学习时间。';
  else {
    story = `近 7 天学了 ${fmtDur(sum(last7))}，平均每天 ${fmtDur(sum(last7) / Math.max(1, tracked7.length))}`;
    if (prevTracked) {
      const d = sum(last7) - sum(prev7);
      story += Math.abs(d) >= 60 ? `，比前 7 天${d > 0 ? '多' : '少'} ${fmtDur(Math.abs(d))}` : '，和前 7 天差不多';
    }
    if (best?.total) story += `。${best.date === today ? '今天' : `周${WEEKDAY[dayOf(best.date).getDay()]}`}学得最久。`;
    else story += '。';
  }

  const tip = hover >= 0 ? list[hover] : null;
  const notTracked = (d) => !since || d.date < since;

  return (
    <div className="vt-trend">
      <div className="vt-trend-h">
        <h3>学习时间</h3>
        <div className="seg" role="group" aria-label="时间范围">
          {[7, 30].map((n) => <button key={n} className={range === n ? 'on' : ''} aria-pressed={range === n} onClick={() => pick(n)}>{n} 天</button>)}
        </div>
      </div>
      <p className="vt-story">{story}</p>

      <div className="vt-plot" ref={box} onPointerLeave={() => setHover(-1)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`近 ${range} 天每天的学习时间，目标每天 ${goalMinutes} 分钟`}>
            {ticks.map((s) => (
              <g key={s}>
                <line x1={padL} x2={width - 8} y1={y(s)} y2={y(s)} className="vt-grid" />
                <text x={padL - 8} y={y(s) + 3.5} className="vt-axis" textAnchor="end">{s ? `${s / 3600}h` : '0'}</text>
              </g>
            ))}
            {list.map((d, i) => {
              const x = padL + i * slot + (slot - barW) / 2;
              const h = Math.max(0, y(0) - y(d.total));
              const isToday = d.date === today;
              const label = range === 7 ? `周${WEEKDAY[dayOf(d.date).getDay()]}` : (i % 5 === (list.length - 1) % 5 ? mmdd(d.date) : '');
              return (
                <g key={d.date}>
                  {h > 0 && (
                    <path d={barPath(x, y(d.total), barW, h, 4)}
                          className={`vt-bar${isToday ? ' today' : ''}${hover === i ? ' hot' : ''}`}
                          style={{ transform: `scaleY(${grown ? 1 : 0})`, transitionDelay: `${i * (range > 7 ? 12 : 40)}ms` }} />
                  )}
                  {!h && notTracked(d) && <line x1={x} x2={x + barW} y1={y(0) - 1} y2={y(0) - 1} className="vt-none" />}
                  {label && <text x={x + barW / 2} y={H - 8} className={`vt-axis${isToday ? ' now' : ''}`} textAnchor="middle">{isToday ? '今天' : label}</text>}
                  {/* 命中区是整根柱子的槽位，比柱子大得多 */}
                  <rect x={padL + i * slot} y={0} width={slot} height={H - padB} fill="transparent"
                        tabIndex={0} role="img" aria-label={`${d.date} ${notTracked(d) && !d.total ? '没记录' : fmtDur(d.total)}`}
                        onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(-1)} />
                </g>
              );
            })}
            {/* 目标线：实线发丝，右端标字 */}
            <line x1={padL} x2={width - 8} y1={y(goal)} y2={y(goal)} className="vt-goal" />
            <text x={width - 10} y={y(goal) - 6} className="vt-goal-t" textAnchor="end">目标 {fmtDur(goal)}</text>
          </svg>
        )}
        {tip && (
          <div className="vt-tip" style={{ left: Math.min(Math.max(padL + hover * slot + slot / 2, 90), width - 90) }}>
            <b>{notTracked(tip) && !tip.total ? '没记录' : fmtDur(tip.total)}</b>
            <span className="vt-tip-d">{mmdd(tip.date)} 周{WEEKDAY[dayOf(tip.date).getDay()]}</span>
            {ACTS.filter((a) => tip.byKind?.[a.key]).map((a) => (
              <span key={a.key} className="vt-tip-r"><i style={{ background: actColor(a.key) }} />{a.label}<em>{fmtDur(tip.byKind[a.key], { short: true })}</em></span>
            ))}
          </div>
        )}
      </div>

      {/* 坚持：最近 14 天哪天学过（日历上有痕迹的都算，和「坚持天数」同一口径） */}
      <div className="vt-streak">
        <span className="vt-streak-k">最近 14 天学了 {activeDays.filter((d) => d.on).length} 天</span>
        <span className="vt-dots">
          {activeDays.map((d) => <i key={d.date} className={`${d.on ? 'on' : ''}${d.date === today ? ' now' : ''}`} title={`${mmdd(d.date)}${d.on ? ' 学过' : ' 没学'}`} />)}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 调整目标
 * ------------------------------------------------------------------ */

export function GoalEditor({ goals, onSave, onClose }) {
  const [v, setV] = useState(goals);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', off, true);
    window.addEventListener('keydown', key);
    ref.current?.querySelector('input')?.focus();
    return () => { window.removeEventListener('mousedown', off, true); window.removeEventListener('keydown', key); };
  }, [onClose]);
  const field = (k, label, unit, step) => (
    <label className="vt-goal-f">
      <span>{label}</span>
      <input type="number" min={1} step={step} value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
      <em>{unit}</em>
    </label>
  );
  return (
    <div className="vt-goal-pop" ref={ref} role="dialog" aria-label="每日目标">
      {field('minutes', '学习时间', '分钟', 10)}
      {field('words', '背单词', '个', 5)}
      {field('exams', '做题', '道', 1)}
      <div className="vt-goal-acts">
        <button className="btn sm ghost" onClick={onClose}>取消</button>
        <button className="btn sm primary" disabled={busy}
                onClick={async () => { setBusy(true); try { await onSave(v); onClose(); } finally { setBusy(false); } }}>保存目标</button>
      </div>
    </div>
  );
}
