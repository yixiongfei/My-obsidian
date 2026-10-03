import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 仪表盘的「运动健康」那一块：今天的三道轨道环、每日进度柱状图、最近 14 天的坚持点。
 *
 * 轨道环是这一页唯一张扬的东西——星图的气质：三道同心轨道，进度头上一颗「卫星」，外圈一圈刻度。
 *   外圈  学习时间，按做什么分段上色（做题 / 笔记 / 助手 / 阅读 / 背单词 / 专注），一圈 = 当天目标
 *   中圈  背单词个数 / 目标
 *   内圈  做题道数 / 目标
 * 颜色跟着「做什么」走，全页一致。这六个色、以及每日进度里四段的叠放顺序，深浅两套都过了色盲校验
 * （dataviz 的 validate_palette，相邻对 CVD ΔE ≥ 8）。
 * 动效只有一次：进页面时三道环从 0 扫到当前进度、数字跟着数上去；柱子从底线长出来。减少动效时直接到位。
 */

/** 顺序就是色盲安全的机制：冷暖交替，蓝紫不相邻 */
export const ACTS = [
  { key: 'exam', label: '做题' },
  { key: 'notes', label: '笔记' },
  { key: 'assistant', label: '助手' },
  { key: 'reading', label: '阅读' },
  { key: 'words', label: '背单词' },
  // 番茄钟专注、但不在上面这些页面（在纸上做题、看书）
  { key: 'focus', label: '专注' },
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
    ? '今天还没开始。做题、背单词、看笔记的时间会自动记进来，开番茄钟专注也算。'
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
 * 每日进度：每天学了多少（做题 / 笔记 / 背单词 / 阅读叠成一根柱子）+ 7 天均线 + 一句话结论 + 最近 14 天坚持
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
const weekday = (iso) => `周${WEEKDAY[dayOf(iso).getDay()]}`;

/** 顶部圆角、底部方角的柱子 */
const barPath = (x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
};

/* 柱子从下往上叠的顺序 = 图例顺序。笔记 = 复习 + 新建。
   相邻两段的颜色都过了色盲校验（做题玫 / 笔记蓝 / 背单词青 / 阅读紫：蓝紫不挨着）。
   背单词一天几十个、笔记一天一两篇，硬叠在一起笔记那段看不见：按 w 折算成「学习量」再叠，
   日历的深浅、「坚持天数」也是这套折算 */
export const PROGRESS = [
  { key: 'exam', label: '做题', of: (r) => r?.exams || 0, w: 0.5, unit: '道' },
  { key: 'notes', label: '笔记', of: (r) => (r?.reviews || 0) + (r?.created || 0), w: 1, unit: '篇' },
  { key: 'words', label: '背单词', of: (r) => r?.words || 0, w: 0.2, unit: '个' },
  { key: 'reading', label: '阅读', of: (r) => r?.sentences || 0, w: 0.5, unit: '句' },
];
export const unitsOf = (r) => PROGRESS.reduce((a, s) => a + s.of(r) * s.w, 0);

const RANGES = [7, 14, 30, 90];
const RANGE_KEY = 'kb-trend-days';

export function DailyProgress({ daily = [], studyDays = [], activeDays = [], today }) {
  const [range, setRange] = useState(() => {
    try { const v = Number(localStorage.getItem(RANGE_KEY)); return RANGES.includes(v) ? v : 7; } catch { return 7; }
  });
  const box = useRef(null);
  const width = useWidth(box);
  const [hover, setHover] = useState(-1);
  // 换范围时清掉悬停：第 3 根柱子在 7 天和 30 天里不是同一天
  const pick = (n) => { setRange(n); setHover(-1); try { localStorage.setItem(RANGE_KEY, String(n)); } catch { /* 无痕 */ } };
  const [grown, setGrown] = useState(reduceMotion());
  useEffect(() => {
    if (reduceMotion()) return undefined;
    setGrown(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(id);
  }, [range]);

  const list = daily.slice(-range);
  const time = useMemo(() => new Map(studyDays.map((d) => [d.date, d.total])), [studyDays]);
  const totals = list.map(unitsOf);
  // 7 天均线：每根柱子往前看 7 天（含当天），范围左边界之外的日子也算进去
  const avg = list.map((_, i) => {
    const end = daily.length - list.length + i;
    const win = daily.slice(Math.max(0, end - 6), end + 1);
    return win.reduce((s, r) => s + unitsOf(r), 0) / Math.max(1, win.length);
  });

  const H = 176;
  const padX = 4;
  const padT = 12;
  const padB = 26;
  const plotH = H - padT - padB;
  const plotW = Math.max(0, width - padX * 2);
  const slot = list.length ? plotW / list.length : 0;
  const barW = Math.max(2, Math.min(24, slot * (range > 14 ? 0.62 : 0.5)));
  const top = Math.max(1, ...totals, ...avg) * 1.08;
  const y = (v) => padT + plotH - (v / top) * plotH;
  const gap = range > 30 ? 1 : 2;   // 段与段之间留一道底色缝
  const every = range === 7 ? 1 : range === 14 ? 2 : range === 30 ? 5 : 15;
  const cx = (i) => padX + i * slot + slot / 2;
  const avgPath = avg.map((v, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  // 一句话：这段时间各做了多少、哪天最用功
  const sum = (s) => list.reduce((a, r) => a + s.of(r), 0);
  const [nExam, nNotes, nWords, nRead] = PROGRESS.map(sum);
  const parts = [
    nWords && `背了 ${nWords} 个单词`,
    nExam && `做了 ${nExam} 道题`,
    nNotes && `笔记 ${nNotes} 篇`,
    nRead && `读了 ${nRead} 句`,
  ].filter(Boolean);
  const secs = list.reduce((a, r) => a + (time.get(r.date) || 0), 0);
  let story = `近 ${range} 天还没有学习记录。`;
  if (parts.length) {
    story = `近 ${range} 天${parts.join('，')}${secs >= 60 ? `，计时 ${fmtDur(secs)}` : ''}。`;
    const best = list[totals.indexOf(Math.max(...totals))];
    if (totals.filter((v) => v > 0).length > 1 && best) {
      story += `${best.date === today ? '今天' : range <= 7 ? weekday(best.date) : mmdd(best.date)}最用功。`;
    }
  }

  const tip = hover >= 0 ? list[hover] : null;

  return (
    <div className="vt-trend">
      <div className="vt-trend-h">
        <h3>每日进度</h3>
        <div className="seg" role="group" aria-label="时间范围">
          {RANGES.map((n) => <button key={n} className={range === n ? 'on' : ''} aria-pressed={range === n} onClick={() => pick(n)}>{n} 天</button>)}
        </div>
      </div>
      <p className="vt-story">{story}</p>

      <div className="vt-plot" ref={box} onPointerLeave={() => setHover(-1)}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`近 ${range} 天每日进度：${story}`}>
            <line x1={padX} x2={width - padX} y1={y(0) + 0.5} y2={y(0) + 0.5} className="vt-grid" />
            {list.map((r, i) => {
              const x = padX + i * slot + (slot - barW) / 2;
              const segs = [];
              let acc = 0;
              for (const s of PROGRESS) {
                const v = s.of(r) * s.w;
                if (v > 0) { segs.push({ s, from: acc, to: acc + v }); acc += v; }
              }
              const isToday = r.date === today;
              const label = i % every === (list.length - 1) % every ? (isToday ? '今天' : range === 7 ? weekday(r.date) : mmdd(r.date)) : '';
              return (
                <g key={r.date} className={`vt-col${hover >= 0 && hover !== i ? ' dim' : ''}`}>
                  <g className="vt-stack" style={{ transform: `scaleY(${grown ? 1 : 0})`, transitionDelay: `${i * (range > 14 ? 8 : 36)}ms` }}>
                    {segs.map((g, j) => {
                      const y0 = y(g.to);
                      const h = y(g.from) - (j ? gap : 0) - y0;
                      if (h < 0.5) return null;
                      return j === segs.length - 1
                        ? <path key={g.s.key} d={barPath(x, y0, barW, h, 4)} fill={actColor(g.s.key)} />
                        : <rect key={g.s.key} x={x} y={y0} width={barW} height={h} fill={actColor(g.s.key)} />;
                    })}
                  </g>
                  {!segs.length && <line x1={x} x2={x + barW} y1={y(0) - 1} y2={y(0) - 1} className="vt-none" />}
                  {label && <text x={cx(i)} y={H - 8} className={`vt-axis${isToday ? ' now' : ''}`} textAnchor="middle">{label}</text>}
                  {/* 命中区是整个槽位，比柱子大得多 */}
                  <rect x={padX + i * slot} y={0} width={slot} height={H - padB} fill="transparent"
                        tabIndex={0} role="img"
                        aria-label={`${r.date} ${PROGRESS.map((s) => `${s.label} ${s.of(r)}`).join('，')}`}
                        onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(-1)} />
                </g>
              );
            })}
            <path d={avgPath} className="vt-avg" />
            {avg.length > 0 && <circle cx={cx(avg.length - 1)} cy={y(avg.at(-1))} r={3} className="vt-avg-dot" />}
          </svg>
        )}
        {tip && (
          <div className="vt-tip" style={{ left: Math.min(Math.max(cx(hover), 80), width - 80) }}>
            <b>{tip.date === today ? '今天' : `${mmdd(tip.date)} ${weekday(tip.date)}`}</b>
            {PROGRESS.filter((s) => s.of(tip)).map((s) => (
              <span key={s.key} className="vt-tip-r">
                <i style={{ background: actColor(s.key) }} />{s.label}
                <em>{s.key === 'notes' && tip.created ? `复习 ${tip.reviews || 0} · 新建 ${tip.created}` : `${s.of(tip)} ${s.unit}`}</em>
              </span>
            ))}
            {tip.points > 0 && <span className="vt-tip-r"><i style={{ background: 'var(--line-2)' }} />考点推进<em>{tip.points} 个</em></span>}
            {time.get(tip.date) >= 60 && <span className="vt-tip-r"><i style={{ background: 'var(--text-2)' }} />计时<em>{fmtDur(time.get(tip.date), { short: true })}</em></span>}
            {!unitsOf(tip) && !tip.points && <span className="vt-tip-d">这天没有学习记录</span>}
          </div>
        )}
      </div>

      <ul className="vt-legend" aria-label="图例">
        {PROGRESS.map((s) => <li key={s.key}><i style={{ background: actColor(s.key) }} />{s.label}</li>)}
        <li><i className="line" />7 天均线</li>
      </ul>

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
