import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Loading, ErrorBox } from '../components/bits.jsx';

/** 分组配色只在蓝—白轴上取值，不引入第四种色相 */
const colorOf = (i, total) => {
  const t = total <= 1 ? 0 : i / (total - 1);
  return `hsl(217, ${Math.round(90 - t * 78)}%, ${Math.round(52 + t * 38)}%)`;
};

export default function Graph({ version }) {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const stateRef = useRef({ nodes: [], links: [], k: 1, tx: 0, ty: 0, hover: null, dragging: false });
  const [hover, setHover] = useState(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const { data, loading, error, reload } = useApi(() => api.graph(), [version]);

  const palette = useMemo(() => {
    const map = new Map();
    (data?.groups || []).forEach((g, i) => map.set(g, colorOf(i, data.groups.length)));
    return map;
  }, [data]);

  useEffect(() => {
    if (!data) return undefined;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const ctx = canvas.getContext('2d');
    const st = stateRef.current;

    const nodes = data.nodes.map((n) => ({ ...n }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = data.links
      .map((l) => ({ source: byId.get(l.source), target: byId.get(l.target) }))
      .filter((l) => l.source && l.target);
    st.nodes = nodes;
    st.links = links;
    st.k = 1; st.tx = 0; st.ty = 0;

    let w = 0, h = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      w = wrap.clientWidth; h = wrap.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sim.force('center', forceCenter(w / 2, h / 2));
      sim.alpha(0.4).restart();
    };

    const radius = (n) => 5 + Math.min(9, n.degree * 1.7) + Math.min(4, n.words / 900);

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).distance(110).strength(0.55))
      .force('charge', forceManyBody().strength(-380))
      .force('collide', forceCollide((n) => radius(n) + 16))
      .force('x', forceX().strength(0.045))
      .force('y', forceY().strength(0.045));

    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

    const draw = () => {
      const { k, tx, ty } = st;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(k, k);

      const hoverId = st.hover?.id;
      const near = new Set();
      if (hoverId) {
        near.add(hoverId);
        for (const l of links) {
          if (l.source.id === hoverId) near.add(l.target.id);
          if (l.target.id === hoverId) near.add(l.source.id);
        }
      }

      // 边
      for (const l of links) {
        const lit = hoverId && (l.source.id === hoverId || l.target.id === hoverId);
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.strokeStyle = lit ? css('--blue') : css('--line-2');
        ctx.globalAlpha = hoverId ? (lit ? 0.95 : 0.15) : 0.55;
        ctx.lineWidth = lit ? 1.6 : 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 节点
      for (const n of nodes) {
        const r = radius(n);
        const dim = hoverId && !near.has(n.id);
        const color = palette.get(n.group) || css('--blue');
        ctx.globalAlpha = dim ? 0.2 : 1;

        if (n.id === hoverId) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2);
          ctx.fillStyle = css('--blue-soft');
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.empty ? css('--bg-3') : color;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = n.empty ? css('--line-2') : css('--bg');
        ctx.stroke();

        if (k > 0.62 || n.id === hoverId || near.has(n.id)) {
          ctx.font = `${n.id === hoverId ? 600 : 500} ${11.5 / Math.max(k, 0.75)}px ${css('--font') || 'sans-serif'}`;
          ctx.fillStyle = dim ? css('--dim') : css('--text-2');
          ctx.textAlign = 'center';
          ctx.fillText(n.title, n.x, n.y + r + 13 / Math.max(k, 0.75));
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    };

    /** 收敛后把整张图缩放平移到视野中央，避免一上来挤在一角 */
    const fit = () => {
      if (!nodes.length || !w || !h) return;
      const pad = 90;
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const k = Math.min(3, Math.max(0.3, Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1))));
      st.k = k;
      st.tx = w / 2 - ((minX + maxX) / 2) * k;
      st.ty = h / 2 - ((minY + maxY) / 2) * k;
    };

    let fitted = false;
    sim.on('tick', () => {
      if (!fitted && sim.alpha() < 0.06) { fitted = true; fit(); }
      draw();
    });
    sim.on('end', () => { if (!fitted) { fitted = true; fit(); } draw(); });

    /* 交互：拖拽平移、滚轮缩放、悬停高亮、点击进入笔记 */
    const toWorld = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left - st.tx) / st.k, y: (e.clientY - rect.top - st.ty) / st.k };
    };
    const pick = (p) => nodes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) <= radius(n) + 6) || null;

    let last = null, moved = 0;
    const onDown = (e) => { last = { x: e.clientX, y: e.clientY }; moved = 0; st.dragging = true; };
    const onMove = (e) => {
      if (st.dragging && last) {
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        st.tx += dx; st.ty += dy;
        last = { x: e.clientX, y: e.clientY };
        draw();
        return;
      }
      const hit = pick(toWorld(e));
      if (hit?.id !== st.hover?.id) { st.hover = hit; setHover(hit); draw(); }
      if (hit) setPointer({ x: e.clientX, y: e.clientY });
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    };
    const onUp = (e) => {
      st.dragging = false; last = null;
      if (moved < 4) {
        const hit = pick(toWorld(e));
        if (hit) navigate(`/note/${encodeURIComponent(hit.id)}`);
      }
    };
    const onLeave = () => { st.dragging = false; last = null; st.hover = null; setHover(null); draw(); };
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const next = Math.min(3, Math.max(0.3, st.k * (e.deltaY < 0 ? 1.12 : 0.893)));
      st.tx = mx - (mx - st.tx) * (next / st.k);
      st.ty = my - (my - st.ty) * (next / st.k);
      st.k = next;
      draw();
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    return () => {
      sim.stop();
      ro.disconnect();
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [data, palette, navigate]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  return (
    <div className="graph-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} />

      <div className="graph-hud">
        <span className="chip num">{data?.nodes.length} 节点 · {data?.links.length} 条链接</span>
        <span className="chip">滚轮缩放 · 拖拽平移 · 点击进入</span>
      </div>

      <div className="graph-legend">
        {(data?.groups || []).map((g) => (
          <div className="lg" key={g}>
            <i style={{ background: palette.get(g) }} />
            {g}
          </div>
        ))}
      </div>

      {hover && (
        <div className="graph-tip" style={{ left: pointer.x + 16, top: pointer.y - 46 }}>
          <div style={{ color: 'var(--text)', fontWeight: 600 }}>{hover.title}</div>
          <div className="num" style={{ color: 'var(--dim)', fontSize: 11.5 }}>
            {hover.group} · {hover.degree} 条链接 · 复习 {hover.reviewCount} 次
          </div>
        </div>
      )}
    </div>
  );
}
