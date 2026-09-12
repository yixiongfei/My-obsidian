import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * 思维导图：以 tags.yaml 的受控词表为骨架的正交折线树。
 * 画的是「学科 → 分支 → 考点 → 笔记」的从属关系，不是 wiki 链接的关系图。
 *
 * 数学与 408 的分支下面是真题标签名当锚点的考点列，笔记归在考点下；
 * 一个分支几十个考点，所以学科和分支都能折叠，折叠状态记在本机。
 * 英语、词表之外的分支没有考点清单，笔记直接挂分支。
 */

const ROW = 30;    // 笔记行高
const PROW = 26;   // 考点行高，比笔记紧一点
const X = { root: 38, g: 208, b: 400, p: 630, n: 880 };
const PORT = { root: 152, g: 344, b: 590, p: 840 };
const FOLD_KEY = 'kb-mind-fold';

const elbow = (x1, y1, x2, y2, mid) => {
  const m = mid ?? (x1 + x2) / 2;
  return `M ${x1} ${y1} H ${m} V ${y2} H ${x2}`;
};

const avg = (ys) => ys.reduce((s, v) => s + v, 0) / ys.length;
// 粗略的文字宽度：中文 13px、英文数字 7px（12.5px 字号）
const textW = (s, size = 12.5) => [...String(s)].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? size * 1.04 : size * 0.56), 0);

/** 折叠状态：显式折起 / 显式展开两张表，其余按默认（有考点但一个都没学的分支默认折起；
 *  展开的分支默认只列已学考点，未学的收在「还有 N 个未学考点」一行里） */
function loadFold() {
  try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || 'null'); if (v && Array.isArray(v.shut) && Array.isArray(v.open)) return { shut: new Set(v.shut), open: new Set(v.open) }; } catch { /* 无 */ }
  return { shut: new Set(), open: new Set() };
}
const defaultFolded = (b) => !!b.points && !b.stat.learned && !b.notes.length;

/** 把接口返回的分组算成一棵带坐标的树 */
function layout(data, currentId, isFolded) {
  const paths = [];
  const leaves = [];    // 笔记
  const points = [];    // 考点
  const toggles = [];   // 可折叠的学科 / 分支标签
  const texts = [];
  let y = 30;
  let maxX = X.p + 300;

  const groupYs = [];
  for (const g of data.groups) {
    const gKey = `g:${g.name}`;
    const gFolded = isFolded(gKey, false);
    const gLabel = { key: gKey, name: g.name, outside: g.outside, folded: gFolded };

    if (gFolded) {
      const gy = y;
      const sub = g.stat ? `${g.count} 篇 · 考点 ${g.stat.learned} / ${g.stat.total}${g.stat.due ? ` · ${g.stat.due} 待复习` : ''}` : `${g.count} 篇 · ${g.branches.length} 个分支`;
      toggles.push({ ...gLabel, x: X.g, y: gy, size: 15, sub });
      groupYs.push(gy);
      y += ROW + 20;
      continue;
    }

    const branchYs = [];
    for (const b of g.branches) {
      const isDirect = b.name === null;
      const label = b.name || b.label || '—';
      const bKey = `b:${g.name}/${label}`;
      const foldable = !!b.points || b.notes.length > 3;
      const bFolded = foldable && isFolded(bKey, defaultFolded(b));
      const childYs = [];
      let by;

      if (bFolded) {
        by = y;
        y += ROW;
      } else {
        // 考点列：已学的每个一行；未学的收成一行，点开才全列出来（一科几十个，全摊开看不过来）
        const uKey = `u:${bKey}`;
        const showNew = b.points ? !isFolded(uKey, true) : false;
        const learnedPts = (b.points || []).filter((p) => p.status !== 'new');
        const newPts = (b.points || []).filter((p) => p.status === 'new');
        const shown = showNew ? [...learnedPts, ...newPts] : learnedPts;
        for (const p of shown) {
          let py;
          if (p.notes.length) {
            const ys = [];
            for (const n of p.notes) {
              leaves.push({ ...n, x: X.n, y, current: n.id === currentId });
              ys.push(y);
              y += ROW;
            }
            py = avg(ys);
            for (const ly of ys) paths.push({ d: elbow(PORT.p, py, X.n - 10, ly) });
            maxX = Math.max(maxX, X.n + 300);
          } else {
            py = y;
            y += PROW;
          }
          points.push({ ...p, group: b.group, x: X.p, y: py });
          childYs.push(py);
        }
        if (newPts.length) {
          toggles.push({
            key: uKey, def: true, x: X.p + 18, y, size: 12, weight: 400, fill: 'var(--dim)', plain: true,
            name: showNew ? `收起 ${newPts.length} 个未学考点` : `还有 ${newPts.length} 个未学考点`,
            folded: !showNew,
          });
          childYs.push(y);
          y += PROW;
        }
        // 直接挂在分支上的笔记（没有考点清单的分支，或对不上任何考点的）
        for (const n of b.notes) {
          leaves.push({ ...n, x: X.p, y, current: n.id === currentId });
          childYs.push(y);
          y += ROW;
        }
        if (childYs.length) {
          by = avg(childYs);
          for (const cy of childYs) paths.push({ d: elbow(PORT.b, by, X.p - 10, cy) });
        } else {
          by = y;
          paths.push({ d: `M ${PORT.b} ${by} H ${X.p + 26}`, dashed: true });
          texts.push({ x: X.p + 36, y: by + 4, size: 11.5, fill: 'var(--dim)', text: '待填充' });
          y += ROW;
        }
      }

      const n = b.notes.length + (b.points || []).reduce((s, p) => s + p.notes.length, 0);
      const sub = b.stat
        ? `${b.stat.learned} / ${b.stat.total} 考点${b.stat.today ? ` · 今日 ${b.stat.today}` : ''}${b.stat.due ? ` · ${b.stat.due} 待复习` : ''}`
        : `${n} 篇`;
      toggles.push({
        key: bKey, name: label, x: X.b, y: by, size: 13, sub,
        folded: bFolded, foldable, direct: isDirect,
        weight: n ? 500 : 400,
        fill: isDirect ? 'var(--text-2)' : n ? 'var(--text)' : 'var(--dim)',
      });
      if (isDirect) texts.push({ dot: true, x: X.b - 13, y: by });

      branchYs.push(by);
      y += 12;
    }

    const gy = branchYs.length ? avg(branchYs) : y;
    if (!branchYs.length) y += ROW;
    toggles.push({ ...gLabel, x: X.g, y: gy, size: 15, sub: g.stat ? `${g.count} 篇 · 考点 ${g.stat.learned} / ${g.stat.total}` : `${g.count} 篇` });
    for (const by of branchYs) paths.push({ d: elbow(PORT.g, gy, X.b - 10, by) });
    groupYs.push(gy);
    y += 20;
  }

  const ry = groupYs.length ? avg(groupYs) : 30;
  texts.push({ x: X.root + 22, y: ry + 4, size: 15, weight: 600, fill: 'var(--text)', text: data.root.name });
  texts.push({ x: X.root + 22, y: ry + 21, size: 10, ls: 1.4, fill: 'var(--dim)', text: `${data.root.count} 篇` });
  for (const gy of groupYs) paths.push({ d: elbow(PORT.root, ry, X.g - 10, gy) });

  return { paths, leaves, points, toggles, texts, rootY: ry, height: y, width: maxX };
}

function Marker({ x, y, status }) {
  if (status === 'due') return <rect x={x} y={y - 4} width="8" height="8" fill="var(--due)" />;
  if (status === 'today') return <rect x={x} y={y - 4} width="8" height="8" fill="var(--accent)" />;
  if (status === 'empty') return <line x1={x} y1={y} x2={x + 8} y2={y} stroke="var(--line-2)" strokeWidth="1" />;
  return (
    <rect x={x + 0.5} y={y - 3.5} width="7" height="7" fill="none" strokeWidth="1"
          stroke={status === 'sched' || status === 'learned' ? 'var(--text-2)' : 'var(--line-2)'} />
  );
}

export default function MindMap({ data, currentId }) {
  const navigate = useNavigate();
  const wrapRef = useRef(null);
  /* 视图（缩放 / 平移）记在本机：每次进这一页都缩到最小很烦。
     没有记录、或双击画布时才重新适配窗口 */
  const [t, setT] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem('kb-mind-view') || 'null'); if (v && v.k > 0) return v; } catch { /* 无 */ }
    return null;
  });
  const touched = useRef(t !== null);
  const drag = useRef(null);
  const [fold, setFold] = useState(loadFold);

  useEffect(() => { if (t && touched.current) localStorage.setItem('kb-mind-view', JSON.stringify(t)); }, [t]);
  useEffect(() => { localStorage.setItem(FOLD_KEY, JSON.stringify({ shut: [...fold.shut], open: [...fold.open] })); }, [fold]);

  const isFolded = useCallback((key, def) => (fold.shut.has(key) ? true : fold.open.has(key) ? false : def), [fold]);
  const toggle = useCallback((key, def) => {
    setFold((f) => {
      const shut = new Set(f.shut), open = new Set(f.open);
      const now = shut.has(key) ? true : open.has(key) ? false : def;
      shut.delete(key); open.delete(key);
      if (now) open.add(key); else shut.add(key);
      return { shut, open };
    });
  }, []);

  const tree = useMemo(() => layout(data, currentId, isFolded), [data, currentId, isFolded]);
  const defOf = useMemo(() => {
    const m = new Map();
    for (const g of data.groups) {
      m.set(`g:${g.name}`, false);
      for (const b of g.branches) {
        const k = `b:${g.name}/${b.name || b.label || '—'}`;
        m.set(k, defaultFolded(b));
        m.set(`u:${k}`, true);
      }
    }
    return m;
  }, [data]);

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const pad = 48;
    const k = Math.min(1, (el.clientWidth - pad * 2) / tree.width, (el.clientHeight - pad * 2) / tree.height);
    setT({ k, x: (el.clientWidth - tree.width * k) / 2, y: (el.clientHeight - tree.height * k) / 2 });
  }, [tree]);

  useEffect(() => {
    if (!touched.current) fit();
    const ro = new ResizeObserver(() => { if (!touched.current) fit(); });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [fit]);

  const refit = () => { touched.current = false; localStorage.removeItem('kb-mind-view'); fit(); };

  /* React 把 onWheel 挂成 passive，里面 preventDefault 会被浏览器拒绝并报错；
     自己挂一个非 passive 的，滚轮才能只缩放画布、不滚动页面 */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      touched.current = true;
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      setT((p) => {
        if (!p) return p;
        const k = Math.min(2.5, Math.max(0.25, p.k * (e.deltaY < 0 ? 1.12 : 0.893)));
        return { k, x: mx - (mx - p.x) * (k / p.k), y: my - (my - p.y) * (k / p.k) };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, moved: 0 }; };
  const onMove = (e) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY, moved: drag.current.moved + Math.abs(dx) + Math.abs(dy) };
    if (dx || dy) touched.current = true;
    setT((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  };
  // 拖过画布再松手不算点击，否则拖动时经过的标签会被误折叠
  const moved = useRef(0);
  const onUp = () => { moved.current = drag.current?.moved || 0; drag.current = null; };
  const clicked = (fn) => (e) => { e.stopPropagation(); if (moved.current > 4) return; fn(); };

  const openPoint = (p) => {
    if (p.notes.length) navigate(`/note/${encodeURIComponent(p.notes[0].id)}`);
    else if (p.group) navigate(`/resources/tags/${p.group}?tag=${encodeURIComponent(p.name)}`);
  };

  return (
    <div className="mind-canvas" ref={wrapRef}
         onMouseDown={onDown} onMouseMove={onMove}
         onMouseUp={onUp} onMouseLeave={onUp} onDoubleClick={refit}>
      <svg width="100%" height="100%" style={{ fontFamily: 'var(--font)' }}>
        <g transform={t ? `translate(${t.x} ${t.y}) scale(${t.k})` : undefined} style={{ opacity: t ? 1 : 0 }}>
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

          {/* 学科 / 分支标签：能折叠的带一个小三角 */}
          {tree.toggles.map((tg) => {
            const foldable = tg.foldable !== false;
            const w = textW(tg.name, tg.size) + 20;
            return (
              <g key={tg.key} className={foldable ? 'mind-node' : undefined}
                 onClick={foldable ? clicked(() => toggle(tg.key, defOf.get(tg.key) ?? false)) : undefined}
                 onDoubleClick={(e) => e.stopPropagation()}>
                {foldable && <rect className="mind-hit" x={tg.x - 16} y={tg.y - (tg.plain ? 11 : 14)} width={w + 16} height={tg.plain ? 22 : 36} fill="transparent" />}
                {foldable && (
                  <path d={tg.folded ? `M ${tg.x - 11} ${tg.y - 4} l 5 4 l -5 4 z` : `M ${tg.x - 13} ${tg.y - 2} l 8 0 l -4 5 z`}
                        fill={tg.folded ? 'var(--dim)' : 'var(--line-2)'} />
                )}
                <text x={tg.x} y={tg.y + 4} fontSize={tg.size} fontWeight={tg.weight ?? 600}
                      fill={tg.fill || (tg.outside ? 'var(--dim)' : 'var(--text)')}>{tg.name}</text>
                {tg.sub && <text x={tg.x} y={tg.y + (tg.size >= 15 ? 21 : 19)} fontSize="10" letterSpacing="1.4" fill="var(--dim)">{tg.sub}</text>}
              </g>
            );
          })}

          {/* 考点：有笔记的点进笔记，没笔记的去看这个考点的真题 */}
          {tree.points.map((p) => {
            const learned = p.status !== 'new';
            const w = textW(p.name);
            return (
              <g key={`${p.group}/${p.name}`} className="mind-node" onClick={clicked(() => openPoint(p))} onDoubleClick={(e) => e.stopPropagation()}>
                <rect className="mind-hit" x={p.x - 4} y={p.y - 12} width={w + 80} height="24" fill="transparent" />
                <Marker x={p.x} y={p.y} status={p.status} />
                <text x={p.x + 18} y={p.y + 4} fontSize="12.5" fontWeight={learned ? 500 : 400}
                      fill={p.status === 'today' ? 'var(--accent)' : learned ? 'var(--text)' : 'var(--dim)'}>{p.name}</text>
                <text x={p.x + 18 + w + 8} y={p.y + 4} fontSize="10" letterSpacing="1" fill="var(--dim)">{p.items} 题</text>
              </g>
            );
          })}

          {tree.leaves.map((n) => (
            <g key={n.id} className="mind-node" onClick={clicked(() => navigate(`/note/${encodeURIComponent(n.id)}`))} onDoubleClick={(e) => e.stopPropagation()}>
              <rect className="mind-hit" x={n.x - 4} y={n.y - 13} width="300" height="26" fill="transparent" />
              <Marker x={n.x} y={n.y} status={n.status} />
              <text x={n.x + 18} y={n.y + 4} fontSize="12.5" fontWeight={n.current ? 600 : 400}
                    fill={n.current ? 'var(--accent)' : n.status === 'new' || n.status === 'empty' ? 'var(--dim)' : 'var(--text)'}>
                {n.title}
              </text>
              {n.current && (
                <line x1={n.x + 18} y1={n.y + 11} x2={n.x + 18 + textW(n.title)} y2={n.y + 11}
                      stroke="var(--accent)" strokeWidth="1" />
              )}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
