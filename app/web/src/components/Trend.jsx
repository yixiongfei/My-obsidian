import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * 每日进度：柱子 = 当天做了多少（笔记复习 / 新建 / 背词 / 做题 叠起来），
 * 曲线 = 7 天滑动平均，看趋势用。默认近一周，预设 7 / 14 / 30 / 90，滑杆可以拉到任意天数。
 * 纯 SVG。图的**高度是定死的**（SVG_H 像素，和左边热力图一样高），宽度跟着容器走：
 * 量出容器宽，反推 viewBox 该多宽，柱子正好铺满一行；天数多到塞不下时再按每天 12 单位加宽、整体缩小。
 */
const SVG_H = 96;

const PRESETS = [7, 14, 30, 90];
const KEY = 'kb-trend-days';
export const SERIES = [
  { key: 'reviews', label: '笔记复习', color: 'var(--accent-2)' },
  { key: 'words', label: '背词', color: 'var(--hue-3)' },
  { key: 'exams', label: '做题', color: 'var(--hue-2)' },
  { key: 'sentences', label: '阅读', color: 'var(--hue-5)' },
  { key: 'created', label: '新建', color: 'var(--hue-4)' },
];
// 背词一天几十个、笔记一天一两篇，硬叠在一起笔记那格看不见：背词按 1/5 折算成"单位量"。
// 热力图的深浅也用这套折算，两边才是同一个「今天学了多少」
export const WEIGHT = { reviews: 1, created: 1, exams: 0.5, sentences: 0.5, words: 0.2 };
export const tipOf = (r) => `${r.date}　笔记复习 ${r.reviews} · 新建 ${r.created} · 背词 ${r.words} · 做题 ${r.exams} · 阅读 ${r.sentences || 0}${r.points ? ` · 考点推进 ${r.points}` : ''}`;
export const unitsOf = (r) => SERIES.reduce((a, k) => a + (r[k.key] || 0) * WEIGHT[k.key], 0);

export default function Trend({ daily = [] }) {
  const [days, setDays] = useState(() => {
    const v = Number(localStorage.getItem(KEY));
    return v >= 7 && v <= 90 ? v : 7;
  });
  useEffect(() => { localStorage.setItem(KEY, String(days)); }, [days]);

  const box = useRef(null);
  const [cw, setCw] = useState(420);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setCw(Math.max(200, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => daily.slice(-days), [daily, days]);
  const weight = WEIGHT;
  const totalOf = unitsOf;
  const avg = useMemo(() => rows.map((_, i) => {
    const win = daily.slice(Math.max(0, daily.length - days + i - 6), daily.length - days + i + 1);
    return win.reduce((s, r) => s + totalOf(r), 0) / Math.max(1, win.length);
  }), [rows, daily, days]);

  const max = Math.max(1, ...rows.map(totalOf), ...avg);
  const H = 120, pad = { t: 8, b: 18, l: 6, r: 6 };
  // viewBox 的宽按「渲染成 SVG_H 高时正好铺满容器」反推；天数多了再按每天 12 单位拉宽（整体会缩小一点）
  const W = Math.max(Math.round((cw * H) / SVG_H), rows.length * 12 + 24);
  const ih = H - pad.t - pad.b;
  const bw = (W - pad.l - pad.r) / rows.length;
  const y = (v) => pad.t + ih - (v / max) * ih;
  const line = avg.map((v, i) => `${i === 0 ? 'M' : 'L'} ${(pad.l + (i + 0.5) * bw).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const tickEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 5 : 15;

  return (
    <div className="trend" ref={box}>
      <div className="trend-head">
        <span>每日进度</span>
        <span className="spacer" />
        <div className="seg">
          {PRESETS.map((p) => <button key={p} className={days === p ? 'on' : ''} onClick={() => setDays(p)}>{p} 天</button>)}
        </div>
        <input type="range" min="7" max="90" value={days} onChange={(e) => setDays(Number(e.target.value))} title={`${days} 天`} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ height: SVG_H }} preserveAspectRatio="xMinYMid meet" role="img" aria-label={`近 ${days} 天每日进度`}>
        {/* 基线 */}
        <line x1={pad.l} y1={y(0)} x2={W - pad.r} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
        {rows.map((r, i) => {
          let acc = 0;
          const x = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          const total = totalOf(r);
          return (
            <g key={r.date}>
              <title>{tipOf(r)}</title>
              {SERIES.map((s) => {
                const v = (r[s.key] || 0) * weight[s.key];
                if (!v) return null;
                const y0 = y(acc + v), h = y(acc) - y(acc + v);
                acc += v;
                return <rect key={s.key} x={x} y={y0} width={w} height={h} fill={s.color} rx="1.5" opacity="0.9" />;
              })}
              {!total && <rect x={x} y={y(0) - 1.5} width={w} height="1.5" fill="var(--line-2)" rx="0.75" />}
              {i % tickEvery === 0 && (
                <text x={x + w / 2} y={H - 4} fontSize="8.5" textAnchor="middle" fill="var(--dim)" letterSpacing="0.03em">
                  {r.date.slice(5).replace('-', '.')}
                </text>
              )}
            </g>
          );
        })}
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />
        {avg.map((v, i) => (i === avg.length - 1
          ? <circle key={i} cx={pad.l + (i + 0.5) * bw} cy={y(v)} r="2.6" fill="var(--accent)" />
          : null))}
      </svg>
      <div className="trend-legend">
        {SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
        <span><i style={{ background: 'var(--accent)', borderRadius: 99, height: 2, width: 12, verticalAlign: 2 }} />7 天均线</span>
      </div>
    </div>
  );
}
