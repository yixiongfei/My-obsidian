import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  focusToday, mmss, pauseFocus, prefs, remaining, resumeFocus, setPrefs,
  skipBreak, startFocus, stopFocus, useFocus, usePrefsVersion, useTicker,
} from '../focus.js';

/**
 * 番茄钟的两张脸：
 *   FocusCard   仪表盘上的大钟——拖钟面定时长、开始、暂停、结束
 *   FocusFloat  其他页面角落里的小钟，跟着换页走，可以拖到任何位置
 *
 * 钟面是一只 60 分钟的计时钟：从 12 点顺时针铺开的扇面 = 还剩几分钟，
 * 时间走着走着，扇面边缘就逆时针退回 12 点。专注是主色、休息是绿色、暂停变灰。
 * 没开始的时候扇面边缘有个把手：按住拖一圈就是在拧计时器，松手那一刻的分钟数就是这一轮的长度。
 */

const TAU = Math.PI * 2;
const MIN_MIN = 1;
const MAX_MIN = 60;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t) => 1 - (1 - t) ** 3;

/** 扇面跳变（换阶段、松手、键盘调）时补一段缓动；拖动中、计时中的细小变化直接跟手 */
function useTween(target, instant) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    const from = cur.current;
    if (instant || reduceMotion() || Math.abs(target - from) < 0.004) {
      cur.current = target;
      setV(target);
      return undefined;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 460);
      cur.current = from + (target - from) * easeOut(p);
      setV(cur.current);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, instant]);
  return v;
}

/**
 * 钟面。frac = 扇面占整圈的比例（剩余分钟 / 60）。
 * 给了 onAdjust 就能拧：按住钟面拖动，按角度换算成 1–60 分钟（过 12 点不翻转）；键盘方向键 ±1、PageUp/Down ±5。
 */
export function FocusDial({ size, frac, tone = 'focus', mini = false, minutes, onAdjust, onAdjustEnd }) {
  const c = size / 2;
  const rim = c - (mini ? 2 : 4);
  const face = rim - (mini ? 3 : 14);
  const f = Math.max(0, Math.min(1, frac));
  const at = (r, p) => [c + r * Math.sin(p * TAU), c - r * Math.cos(p * TAU)];
  const [ex, ey] = at(face, f);
  const svg = useRef(null);
  const last = useRef(minutes);
  const [dragging, setDragging] = useState(false);
  const adjustable = !!onAdjust;

  const minutesAt = (e, wrapGuard) => {
    const r = svg.current.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    let a = Math.atan2(x, -y) / TAU;
    if (a < 0) a += 1;
    let m = Math.round(a * 60);
    const prev = last.current;
    // 拧过 12 点不翻面：从大往 0 拧就停在 60，从小往 59 拧就停在 1
    if (wrapGuard && prev >= 45 && m <= 15) m = MAX_MIN;
    else if (wrapGuard && prev <= 15 && m >= 45) m = MIN_MIN;
    if (m === 0) m = prev > 30 ? MAX_MIN : MIN_MIN;
    m = Math.max(MIN_MIN, Math.min(MAX_MIN, m));
    last.current = m;
    return m;
  };
  const onDown = (e) => {
    if (!adjustable || e.button !== 0) return;
    e.preventDefault();
    last.current = minutes;
    try { svg.current.setPointerCapture(e.pointerId); } catch { /* 无 */ }
    setDragging(true);
    onAdjust(minutesAt(e, false), true);
  };
  const onMove = (e) => { if (dragging) onAdjust(minutesAt(e, true), true); };
  const onUp = () => { if (!dragging) return; setDragging(false); onAdjustEnd?.(); };
  const onKey = (e) => {
    if (!adjustable) return;
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (!step) return;
    e.preventDefault();
    onAdjust(Math.max(MIN_MIN, Math.min(MAX_MIN, minutes + step)), false);
    onAdjustEnd?.();
  };

  const wedge = f >= 0.9995
    ? <circle cx={c} cy={c} r={face} className="fd-wedge" />
    : f > 0.0005 && <path d={`M${c},${c} L${c},${c - face} A${face},${face} 0 ${f > 0.5 ? 1 : 0} 1 ${ex},${ey} Z`} className="fd-wedge" />;
  const ticks = [];
  for (let i = 0; i < 60; i += mini ? 5 : 1) {
    const major = i % 5 === 0;
    const [x1, y1] = at(rim, i / 60);
    const [x2, y2] = at(rim - (mini ? 2.5 : major ? 9 : 5), i / 60);
    ticks.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? 'fd-tick major' : 'fd-tick'} />);
  }
  const [hx, hy] = at(face + (mini ? 0 : 2), f);
  return (
    <svg ref={svg} className={`fd fd-${tone}${adjustable ? ' adjustable' : ''}${dragging ? ' dragging' : ''}`}
         width={size} height={size} viewBox={`0 0 ${size} ${size}`}
         {...(adjustable
           ? { role: 'slider', tabIndex: 0, 'aria-label': '专注时长', 'aria-valuemin': MIN_MIN, 'aria-valuemax': MAX_MIN, 'aria-valuenow': minutes, 'aria-valuetext': `${minutes} 分钟`,
               onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onKeyDown: onKey }
           : { 'aria-hidden': true })}>
      <circle cx={c} cy={c} r={rim} className="fd-face" />
      {ticks}
      {wedge}
      {!mini && [0, 15, 30, 45].map((m) => {
        const [x, y] = at(face - 13, m / 60);
        return <text key={m} x={x} y={y + 4} className="fd-num" textAnchor="middle">{m}</text>;
      })}
      {f > 0.0005 && <line x1={c} y1={c} x2={hx} y2={hy} className="fd-hand" />}
      <circle cx={c} cy={c} r={mini ? 2.5 : 5} className="fd-knob" />
      {adjustable && <circle cx={ex} cy={ey} r={dragging ? 10 : 8} className="fd-grip" />}
    </svg>
  );
}

/** 这一刻钟面该怎么画、读数写什么 */
function view(s, now, idleMinutes) {
  if (!s) return { tone: 'idle', frac: idleMinutes / 60, time: mmss(idleMinutes * 60_000), status: '拖动钟面定时长，点开始' };
  const { left } = remaining(s, now);
  const label = s.label ? ` · ${s.label}` : '';
  if (s.phase === 'over') return { tone: 'over', frac: 0, time: '00:00', status: '休息结束，再来一个？' };
  if (s.paused) return { tone: 'paused', frac: left / 3_600_000, time: mmss(left), status: `已暂停${label}` };
  if (s.phase === 'break') return { tone: 'break', frac: left / 3_600_000, time: mmss(left), status: '休息一下，站起来走走' };
  return { tone: 'focus', frac: left / 3_600_000, time: mmss(left), status: `专注中${label}` };
}

const Icon = {
  pause: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>,
  play: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>,
  stop: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>,
  close: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>,
};

/* ------------------------------------------------------------------ *
 * 仪表盘上的大钟
 * ------------------------------------------------------------------ */

export function FocusCard() {
  const s = useFocus();
  usePrefsVersion();
  const now = useTicker(!!s && !s.paused && s.phase !== 'over');
  const p = prefs();
  // 拖动中先只改这里，松手再存：拖一圈不至于写几十次 localStorage
  const [draft, setDraft] = useState(null);
  const draftRef = useRef(null);
  const [live, setLive] = useState(false);
  const minutes = draft ?? p.minutes;
  const v = view(s, now, minutes);
  const shown = useTween(v.frac, live);
  const day = focusToday();

  const adjust = (m, fromDrag) => { draftRef.current = m; setDraft(m); setLive(fromDrag); };
  const commit = () => {
    if (draftRef.current != null) setPrefs({ minutes: draftRef.current });
    draftRef.current = null;
    setDraft(null);
    setLive(false);
  };

  return (
    <div className="fc">
      <div className="vt-read-h">
        <h3>专注</h3>
        <span className="fc-meta">{day.rounds ? `今天 ${day.rounds} 个番茄 · ${day.minutes} 分钟` : '今天还没开始番茄'}</span>
      </div>
      <div className="fc-body">
        <FocusDial size={196} frac={shown} tone={v.tone} minutes={minutes}
                   onAdjust={s ? undefined : adjust} onAdjustEnd={s ? undefined : commit} />
        <div className="fc-side">
          <div className={`fc-time fig${v.tone === 'idle' ? ' idle' : ''}${live ? ' live' : ''}`} role="timer" aria-live="off">{v.time}</div>
          <div className="fc-status">{v.status}</div>
          <div className="fc-acts">
            {!s && <button className="btn primary" onClick={() => startFocus({ minutes })}>开始专注</button>}
            {s?.phase === 'focus' && !s.paused && <button className="btn" onClick={pauseFocus}>暂停</button>}
            {s?.paused && <button className="btn primary" onClick={resumeFocus}>继续</button>}
            {s?.phase === 'break' && !s.paused && <button className="btn" onClick={skipBreak}>跳过休息</button>}
            {s?.phase === 'over' && <button className="btn primary" onClick={() => startFocus({ minutes: s.minutes, label: s.label, to: s.to })}>再来一个 {s.minutes} 分钟</button>}
            {s && <button className="btn ghost" onClick={stopFocus}>{s.phase === 'over' ? '不了' : '结束'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 跟着换页走的小钟
 * ------------------------------------------------------------------ */

const POS_KEY = 'kb-focus-pos';
const readPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)); } catch { return null; } };

export function FocusFloat({ pathname }) {
  const s = useFocus();
  const navigate = useNavigate();
  const now = useTicker(!!s && !s.paused && s.phase !== 'over');
  const ref = useRef(null);
  const [pos, setPos] = useState(readPos);
  const drag = useRef(null);
  const swallowClick = useRef(false);

  const clamp = (x, y) => {
    const el = ref.current;
    const w = el?.offsetWidth || 240;
    const h = el?.offsetHeight || 64;
    return { x: Math.round(Math.min(Math.max(8, x), window.innerWidth - w - 8)), y: Math.round(Math.min(Math.max(8, y), window.innerHeight - h - 8)) };
  };
  // 默认左下角（右下角是便利贴的取纸台）；窗口变小时拉回可见范围
  useLayoutEffect(() => {
    if (!s || pathname === '/dashboard') return undefined;
    const fit = () => setPos((p) => clamp(p?.x ?? 20, p?.y ?? window.innerHeight));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [!!s, pathname === '/dashboard']); // eslint-disable-line react-hooks/exhaustive-deps

  // 仪表盘上已经有大钟了
  if (!s || pathname === '/dashboard') return null;
  const v = view(s, now, s.minutes);

  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest('.ff-acts')) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pos?.x ?? 0, py: pos?.y ?? 0, moved: false, id: e.pointerId };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    // 过了 4px 才算拖：之前抓住指针的话，单击会被当成点在外框上，点不进里面的按钮
    if (!d.moved) {
      d.moved = true;
      try { ref.current?.setPointerCapture(d.id); } catch { /* 指针已经松开了 */ }
    }
    setPos(clamp(d.px + dx, d.py + dy));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    swallowClick.current = true;
    setPos((p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* 无痕 */ } return p; });
  };
  const go = () => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    navigate(s.to || '/dashboard');
  };

  return (
    <div ref={ref} className={`ff ff-${v.tone}${drag.current?.moved ? ' dragging' : ''}`}
         style={{ left: pos?.x ?? 20, top: pos?.y ?? 'auto', bottom: pos ? 'auto' : 20 }}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
         role="region" aria-label="番茄钟">
      <button className="ff-main" onClick={go} title={s.to ? '回到正在学的页面' : '打开仪表盘'}>
        <FocusDial size={44} frac={v.frac} tone={v.tone} mini />
        <span className="ff-read">
          <span className="ff-time fig">{s.phase === 'over' ? '休息结束' : v.time}</span>
          <span className="ff-label">{s.phase === 'over' ? '再来一个？' : v.status}</span>
        </span>
      </button>
      <div className="ff-acts">
        {s.phase === 'over'
          ? <button title={`再来一个 ${s.minutes} 分钟`} aria-label="再来一个" onClick={() => startFocus({ minutes: s.minutes, label: s.label, to: s.to })}>{Icon.play}</button>
          : s.paused
            ? <button title="继续" aria-label="继续" onClick={resumeFocus}>{Icon.play}</button>
            : s.phase === 'break'
              ? <button title="跳过休息" aria-label="跳过休息" onClick={skipBreak}>{Icon.play}</button>
              : <button title="暂停" aria-label="暂停" onClick={pauseFocus}>{Icon.pause}</button>}
        <button title={s.phase === 'over' ? '关掉' : '结束'} aria-label={s.phase === 'over' ? '关掉' : '结束'} onClick={stopFocus}>
          {s.phase === 'over' ? Icon.close : Icon.stop}
        </button>
      </div>
    </div>
  );
}
