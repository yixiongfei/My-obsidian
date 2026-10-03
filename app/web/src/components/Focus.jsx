import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FOCUS_CHOICES, focusToday, mmss, pauseFocus, prefs, remaining, resumeFocus, setPrefs,
  skipBreak, startFocus, stopFocus, useFocus, usePrefsVersion, useTicker,
} from '../focus.js';

/**
 * 番茄钟的两张脸：
 *   FocusCard   仪表盘上的大钟——挑时长、开始、暂停、结束
 *   FocusFloat  其他页面角落里的小钟，跟着换页走，可以拖到任何位置
 *
 * 钟面是一只 60 分钟的计时钟：从 12 点顺时针铺开的扇面 = 还剩几分钟，
 * 时间走着走着，扇面边缘就逆时针退回 12 点。专注是主色、休息是绿色、暂停变灰。
 */

const TAU = Math.PI * 2;

/** 钟面。frac = 扇面占整圈的比例（剩余分钟 / 60） */
export function FocusDial({ size, frac, tone = 'focus', mini = false }) {
  const c = size / 2;
  const rim = c - (mini ? 2 : 4);
  const face = rim - (mini ? 3 : 14);
  const f = Math.max(0, Math.min(1, frac));
  const at = (r, p) => [c + r * Math.sin(p * TAU), c - r * Math.cos(p * TAU)];
  const [ex, ey] = at(face, f);
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
    <svg className={`fd fd-${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={c} cy={c} r={rim} className="fd-face" />
      {ticks}
      {wedge}
      {f > 0.0005 && <line x1={c} y1={c} x2={hx} y2={hy} className="fd-hand" />}
      <circle cx={c} cy={c} r={mini ? 2.5 : 5} className="fd-knob" />
    </svg>
  );
}

/** 这一刻钟面该怎么画、读数写什么 */
function view(s, now, idleMinutes) {
  if (!s) return { tone: 'idle', frac: idleMinutes / 60, time: mmss(idleMinutes * 60_000), status: '选好时长，点开始' };
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
  const v = view(s, now, p.minutes);
  const day = focusToday();

  return (
    <div className="fc">
      <div className="vt-read-h">
        <h3>专注</h3>
        <span className="fc-meta">{day.rounds ? `今天 ${day.rounds} 个番茄 · ${day.minutes} 分钟` : '今天还没开始番茄'}</span>
      </div>
      <div className="fc-body">
        <FocusDial size={188} frac={v.frac} tone={v.tone} />
        <div className="fc-side">
          <div className={`fc-time fig${v.tone === 'idle' ? ' idle' : ''}`} role="timer" aria-live="off">{v.time}</div>
          <div className="fc-status">{v.status}</div>
          {!s && (
            <div className="seg fc-len" role="group" aria-label="专注时长">
              {FOCUS_CHOICES.map((m) => (
                <button key={m} className={p.minutes === m ? 'on' : ''} aria-pressed={p.minutes === m} onClick={() => setPrefs({ minutes: m })}>{m} 分</button>
              ))}
            </div>
          )}
          <div className="fc-acts">
            {!s && <button className="btn primary" onClick={() => startFocus({ minutes: p.minutes })}>开始专注</button>}
            {s?.phase === 'focus' && !s.paused && <button className="btn" onClick={pauseFocus}>暂停</button>}
            {s?.paused && <button className="btn primary" onClick={resumeFocus}>继续</button>}
            {s?.phase === 'break' && !s.paused && <button className="btn" onClick={skipBreak}>跳过休息</button>}
            {s?.phase === 'over' && <button className="btn primary" onClick={() => startFocus({ minutes: s.minutes, label: s.label, to: s.to })}>再来一个 {s.minutes} 分钟</button>}
            {s && <button className="btn ghost" onClick={stopFocus}>{s.phase === 'over' ? '不了' : '结束'}</button>}
          </div>
        </div>
      </div>
      <p className="fc-note">专注的时间算进今天的学习时间。换页、最小化窗口都接着计时，到点会响铃提醒；其他页面角落里有一只小钟。</p>
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
