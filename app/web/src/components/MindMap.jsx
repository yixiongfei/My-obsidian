import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 思维导图：以 tags.yaml 的受控词表为骨架的正交折线树。
 * 画的是「学科 → 分支 → 笔记」的从属关系，不是 wiki 链接的关系图。
 */

const ROW = 30;
const X = { root: 38, g: 208, b: 400, n: 630 };
const PORT = { root: 152, g: 344, b: 590 };

const elbow = (x1, y1, x2, y2, mid) => {
  const m = mid ?? (x1 + x2) / 2;
  return `M ${x1} ${y1} H ${m} V ${y2} H ${x2}`;
};

/** 把接口返回的分组算成一棵带坐标的树 */
function layout(data, currentId) {
  const paths = [];
  const leaves = [];
  const texts = [];
  let y = 30;

  const groupYs = [];
  for (const g of data.groups) {
    const branchYs = [];
    for (const b of g.branches) {
      const isDirect = b.name === null;
      const label = b.name || b.label || '—';
      let by;

      if (b.notes.length) {
        const ys = [];
        for (const n of b.notes) {
          leaves.push({ ...n, y, current: n.id === currentId });
          ys.push(y);
          y += ROW;
        }
        by = ys.reduce((s, v) => s + v, 0) / ys.length;
        for (const ly of ys) {
          paths.push({ d: elbow(PORT.b, by, X.n - 10, ly), hot: false });
        }
      } else {
        by = y;
        paths.push({ d: `M ${PORT.b} ${by} H ${X.n + 26}`, dashed: true });
        texts.push({ x: X.n + 36, y: by + 4, size: 11.5, fill: 'var(--dim)', text: '待填充' });
        y += ROW;
      }

      texts.push({
        x: X.b, y: by + 4, size: 13, weight: b.notes.length ? 500 : 400,
        fill: isDirect ? 'var(--text-2)' : b.notes.length ? 'var(--text)' : 'var(--dim)',
        text: label,
      });
      texts.push({
        x: X.b, y: by + 19, size: 10, ls: 1.4,
        fill: 'var(--dim)',
        text: `${b.notes.length} 篇`,
      });
      if (isDirect) texts.push({ dot: true, x: X.b - 13, y: by });

      branchYs.push(by);
      y += 12;
    }

    const gy = branchYs.reduce((s, v) => s + v, 0) / branchYs.length;
    texts.push({ x: X.g, y: gy + 4, size: 15, weight: 600, fill: g.outside ? 'var(--dim)' : 'var(--text)', text: g.name });
    texts.push({ x: X.g, y: gy + 21, size: 10, ls: 1.4, fill: 'var(--dim)', text: `${g.count} 篇` });
    for (const by of branchYs) paths.push({ d: elbow(PORT.g, gy, X.b - 10, by) });
    groupYs.push(gy);
    y += 20;
  }

  const ry = groupYs.reduce((s, v) => s + v, 0) / groupYs.length;
  texts.push({ x: X.root + 22, y: ry + 4, size: 15, weight: 600, fill: 'var(--text)', text: data.root.name });
  texts.push({ x: X.root + 22, y: ry + 21, size: 10, ls: 1.4, fill: 'var(--dim)', text: `${data.root.count} 篇` });
  for (const gy of groupYs) paths.push({ d: elbow(PORT.root, ry, X.g - 10, gy) });

  return { paths, leaves, texts, rootY: ry, height: y, width: 1060 };
}

function Marker({ x, y, status }) {
  if (status === 'due') return <rect x={x} y={y - 4} width="8" height="8" fill="var(--accent)" />;
  if (status === 'empty') return <line x1={x} y1={y} x2={x + 8} y2={y} stroke="var(--line-2)" strokeWidth="1" />;
  return (
    <rect x={x + 0.5} y={y - 3.5} width="7" height="7" fill="none" strokeWidth="1"
          stroke={status === 'sched' ? 'var(--text-2)' : 'var(--line-2)'} />
  );
}

export default function MindMap({ data, currentId }) {
  const navigate = useNavigate();
  const wrapRef = useRef(null);
  const [t, setT] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef(null);

  const tree = useMemo(() => layout(data, currentId), [data, currentId]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pad = 48;
    const k = Math.min(1, (el.clientWidth - pad * 2) / tree.width, (el.clientHeight - pad * 2) / tree.height);
    setT({ k, x: (el.clientWidth - tree.width * k) / 2, y: (el.clientHeight - tree.height * k) / 2 });
  }, [tree]);

  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [fit]);

  const onWheel = (e) => {
    e.preventDefault();
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    setT((p) => {
      const k = Math.min(2.5, Math.max(0.25, p.k * (e.deltaY < 0 ? 1.12 : 0.893)));
      return { k, x: mx - (mx - p.x) * (k / p.k), y: my - (my - p.y) * (k / p.k) };
    });
  };

  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, moved: 0 }; };
  const onMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY, moved: drag.current.moved + Math.abs(dx) + Math.abs(dy) };
    setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  };
  const onUp = () => { drag.current = null; };

  return (
    <div className="mind-canvas" ref={wrapRef}
         onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove}
         onMouseUp={onUp} onMouseLeave={onUp}>
      <svg width="100%" height="100%" style={{ fontFamily: 'var(--font)' }}>
        <g transform={`translate(${t.x} ${t.y}) scale(${t.k})`}>
          {tree.paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" strokeWidth="1"
                  stroke={p.hot ? 'var(--accent)' : 'var(--line-2)'}
                  strokeDasharray={p.dashed ? '2 5' : undefined} />
          ))}

          {tree.texts.map((tx, i) => (tx.dot
            ? <circle key={i} cx={tx.x} cy={tx.y} r="2.5" fill="var(--accent)" />
            : <text key={i} x={tx.x} y={tx.y} fontSize={tx.size} fontWeight={tx.weight || 400}
                    letterSpacing={tx.ls} fill={tx.fill}>{tx.text}</text>
          ))}

          <circle cx={X.root + 6} cy={tree.rootY} r="5" fill="var(--accent)" />

          {tree.leaves.map((n) => (
            <g key={n.id} className="mind-node" onClick={() => navigate(`/note/${encodeURIComponent(n.id)}`)}>
              <rect className="mind-hit" x={X.n - 4} y={n.y - 13} width="420" height="26" fill="transparent" />
              <Marker x={X.n} y={n.y} status={n.status} />
              <text x={X.n + 18} y={n.y + 4} fontSize="12.5" fontWeight={n.current ? 600 : 400}
                    fill={n.current ? 'var(--accent)' : n.status === 'new' || n.status === 'empty' ? 'var(--dim)' : 'var(--text)'}>
                {n.title}
              </text>
              {n.current && (
                <line x1={X.n + 18} y1={n.y + 11} x2={X.n + 18 + n.title.length * 13} y2={n.y + 11}
                      stroke="var(--accent)" strokeWidth="1" />
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
