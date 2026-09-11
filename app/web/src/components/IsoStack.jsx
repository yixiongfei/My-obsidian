import { useMemo } from 'react';

/**
 * 首屏的等距立柱。不是装饰：
 *   一段 = 一个学科，实心程度 = 掌握度，
 *   外圈虚线 = 1/2/4/7/15/30 天的复习周期，轨道上的小方块 = 下一次复习。
 */

const COS30 = Math.cos(Math.PI / 6);
const P = (x, y, z) => [(x - z) * COS30, (x + z) * 0.5 - y];
const pts = (...ps) => ps.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

const S = 62;    // 立柱半边长
const H = 66;    // 每段高度
const W = 520;   // 视口宽
const VH = 560;  // 视口高
const OX = W / 2, OY = VH - 140;   // 世界原点在视口内的像素位置

function Block({ y0, y1, fill }) {
  const top   = [P(-S, y1, -S), P(S, y1, -S), P(S, y1, S), P(-S, y1, S)];
  const right = [P(S, y0, -S), P(S, y1, -S), P(S, y1, S), P(S, y0, S)];
  const front = [P(-S, y0, S), P(-S, y1, S), P(S, y1, S), P(S, y0, S)];
  const face = fill === 2
    ? ['var(--blue)', 'var(--iso-blue-r)', 'var(--iso-blue-f)']
    : fill === 1
      ? ['var(--iso-dim-t)', 'var(--iso-dim-r)', 'var(--iso-dim-f)']
      : ['none', 'none', 'none'];
  return (
    <g stroke="var(--iso-edge)" strokeWidth="1.1" strokeLinejoin="round" opacity={fill ? 0.95 : 0.42}>
      <polygon points={pts(...top)} fill={face[0]} />
      <polygon points={pts(...right)} fill={face[1]} />
      <polygon points={pts(...front)} fill={face[2]} />
    </g>
  );
}

export default function IsoStack({ subjects = [], nextReview, examDate, scale = 0.8 }) {
  // 自下而上：积累最少的在底，最多的在顶。篇数相同再比掌握度，
  // 避免刚开始全为 0 时顺序随机跳动。
  const stack = useMemo(
    () => [...subjects].slice(0, 4).sort((a, b) => a.notes - b.notes || a.mastery - b.mastery),
    [subjects],
  );
  if (!stack.length) return null;

  const grid = [];
  for (let i = -5; i <= 5; i++) {
    const [ax, ay] = P(i * 78, 0, -420); const [bx, by] = P(i * 78, 0, 420);
    const [cx, cy] = P(-420, 0, i * 78); const [dx, dy] = P(420, 0, i * 78);
    grid.push(<line key={`a${i}`} x1={ax} y1={ay} x2={bx} y2={by} />);
    grid.push(<line key={`b${i}`} x1={cx} y1={cy} x2={dx} y2={dy} />);
  }

  const topY = stack.length * H;
  const [tx, ty] = P(0, topY, 0);
  const [gx, gy] = P(0, topY + 150, 0);
  const R = 30;

  const ang = (24 * Math.PI) / 180;
  const [ox, oy] = P(250 * Math.cos(ang), 0, 250 * Math.sin(ang));
  const c = 17;

  return (
    <div className="iso-wrap" style={{ width: W, height: VH, transform: `scale(${scale})` }}>
      <svg viewBox={`${-OX} ${-OY} ${W} ${VH}`} width={W} height={VH} style={{ display: 'block', overflow: 'visible' }}>
        <g stroke="var(--iso-grid)" strokeWidth="1" strokeDasharray="3 6">{grid}</g>

        {[[250, '5 7', 1], [170, '3 8', 0.5]].map(([r, dash, op]) => (
          <ellipse key={r} cx="0" cy="0" rx={r * COS30} ry={r * 0.5}
                   fill="none" stroke="var(--line-2)" strokeWidth="1" strokeDasharray={dash} opacity={op} />
        ))}

        {stack.map((s, i) => (
          <Block key={s.name} y0={i * H} y1={(i + 1) * H}
                 fill={s.notes === 0 ? 0 : i === stack.length - 1 ? 2 : 1} />
        ))}

        <line x1={tx} y1={ty} x2={gx} y2={gy} stroke="var(--line-2)" strokeWidth="1" />
        <g stroke="var(--iso-edge)" fill="none" strokeWidth="1.1">
          <circle cx={gx} cy={gy} r={R} />
          <ellipse cx={gx} cy={gy} rx={R} ry={9} strokeWidth="1" opacity="0.5" />
          <ellipse cx={gx} cy={gy} rx={R} ry={R * 0.62} strokeWidth="1" opacity="0.5" />
          <ellipse cx={gx} cy={gy} rx={R * 0.42} ry={R} strokeWidth="1" opacity="0.5" />
        </g>

        <g transform={`translate(${ox.toFixed(1)} ${oy.toFixed(1)})`}
           stroke="var(--iso-edge)" strokeWidth="1.1" strokeLinejoin="round">
          <polygon points={pts(P(-c, c * 2, -c), P(c, c * 2, -c), P(c, c * 2, c), P(-c, c * 2, c))} fill="var(--bg-2)" />
          <polygon points={pts(P(c, 0, -c), P(c, c * 2, -c), P(c, c * 2, c), P(c, 0, c))} fill="var(--bg-1)" />
          <polygon points={pts(P(-c, 0, c), P(-c, c * 2, c), P(c, c * 2, c), P(c, 0, c))} fill="var(--bg-1)" />
          <circle cx="0" cy={-c * 2} r="2.6" fill="var(--blue)" stroke="none" />
        </g>
      </svg>

      {stack.map((s, i) => {
        const [, ly] = P(S, i * H + H / 2, 0);
        const on = i === stack.length - 1;
        return (
          <div key={s.name} className={`iso-label${on ? ' on' : ''}`} style={{ left: 340, top: OY + ly }}>
            <i />
            <span>
              <span className="n">{s.name}</span>
              <span className="s">
                {s.notes ? `${s.notes} 篇 · 掌握度 ${Math.round(s.mastery * 100)}%` : '尚未开始'}
              </span>
            </span>
          </div>
        );
      })}

      {examDate && (
        <div className="iso-note" style={{ left: OX + gx + 32, top: OY + gy - 6, transform: 'rotate(-30deg)', transformOrigin: 'left center' }}>
          初试 {examDate.replaceAll('-', '.')}
        </div>
      )}
      {nextReview && (
        <div className="iso-note" style={{ left: OX + ox + 42, top: OY + oy + 14 }}>
          下次复习 {nextReview.slice(5).replace('-', '.')}
        </div>
      )}
      <div className="iso-note" style={{ left: 8, top: OY + 150 }}>复习周期 1 · 2 · 4 · 7 · 15 · 30 天</div>
    </div>
  );
}
