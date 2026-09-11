import { useId, useMemo } from 'react';

/**
 * 首页的轨道图。不是装饰：
 *   一个点 = tags.yaml 里的一个一级学科，
 *   点的大小 = 笔记篇数，实心程度 = 掌握度，
 *   两圈轨道 = 复习周期，还没有笔记的学科是空心的。
 */

const W = 560;
const H = 400;
const CX = W / 2;
const CY = H / 2;

/** 半径按序轮换，让点不落在同一圈上，看起来才像轨道而不是钟面 */
const RADII = [0.95, 0.68, 0.88, 0.74];
/** 从正上方偏左起算，按学科个数均分一圈——三科就是一个三角形，不会挤在一侧 */
const angleOf = (i, n) => -100 + (i * 360) / Math.max(n, 3);

export default function OrbitMap({ subjects = [], caption }) {
  const uid = useId().replace(/:/g, '');

  const dots = useMemo(() => {
    const max = Math.max(1, ...subjects.map((s) => s.notes));
    const picked = subjects.slice(0, 4);
    return picked.map((s, i) => {
      const rad = (angleOf(i, picked.length) * Math.PI) / 180;
      const r = RADII[i % RADII.length];
      return {
        ...s,
        x: CX + Math.cos(rad) * 205 * r,
        y: CY + Math.sin(rad) * 122 * r,
        // 篇数映射到半径，最小 5px 保证空学科也看得见
        rr: s.notes ? 9 + (s.notes / max) * 15 : 5,
      };
    });
  }, [subjects]);

  const lead = dots.reduce((a, b) => (b.notes > (a?.notes ?? -1) ? b : a), null);

  return (
    <div className="orbit">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
        <defs>
          {dots.map((d, i) => (
            <radialGradient key={i} id={`${uid}-g${i}`}>
              <stop offset="0%" stopColor={d.notes ? 'var(--accent)' : 'var(--line-2)'} stopOpacity="0.30" />
              <stop offset="100%" stopColor={d.notes ? 'var(--accent)' : 'var(--line-2)'} stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>

        {/* 两条轨道：一条主环、一条斜环，构成有机的闭合曲线 */}
        <g fill="none" stroke="var(--line-2)" strokeWidth="1" opacity="0.75">
          <ellipse cx={CX} cy={CY} rx="218" ry="132" transform={`rotate(-14 ${CX} ${CY})`} />
          <ellipse cx={CX} cy={CY} rx="176" ry="112" transform={`rotate(24 ${CX} ${CY})`} opacity="0.6" />
        </g>

        {/* 主导学科与其余学科之间的连线 */}
        {lead && dots.filter((d) => d !== lead && d.notes).map((d, i) => (
          <line key={i} x1={lead.x} y1={lead.y} x2={d.x} y2={d.y}
                stroke="var(--line-2)" strokeWidth="1" opacity="0.55" />
        ))}

        {dots.map((d, i) => (
          <g key={d.name}>
            <circle cx={d.x} cy={d.y} r={d.rr * 3.4} fill={`url(#${uid}-g${i})`} />
            <circle cx={d.x} cy={d.y} r={d.rr}
                    fill={d.notes ? 'var(--accent)' : 'none'}
                    stroke={d.notes ? 'none' : 'var(--line-2)'} strokeWidth="1" />
            <text x={d.x} y={d.y + d.rr + 17} textAnchor="middle"
                  fontSize="11" letterSpacing="0.06em"
                  fill={d.notes ? 'var(--text-2)' : 'var(--dim)'}>
              {d.name}
            </text>
          </g>
        ))}
      </svg>

      {caption && <div className="orbit-cap">{caption}</div>}
    </div>
  );
}
