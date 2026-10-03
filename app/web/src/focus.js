import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * 番茄钟：专注 N 分钟 → 休息几分钟 → 等你点「再来一个」。
 *
 * 状态存在 localStorage，换页、刷新、关掉窗口再打开都接得上（按 endsAt 这个绝对时刻算，不靠定时器累加）。
 * 专注的时间算学习时间：studyClock 每秒来这里取「上次取到现在专注了几秒」——
 * 专注期间不看窗口在不在前台、人动没动，开着番茄钟就当在学，很可能正趴在纸上做题。
 *
 * 到点时响两声、弹一条系统通知；用一次性的 setTimeout 对准 endsAt，
 * 窗口最小化时 Chromium 节流的是反复触发的定时器，一次性的照样准时。
 */

const KEY = 'kb-focus';
const PREF_KEY = 'kb-focus-pref';
const DAY_KEY = 'kb-focus-day';
const STALE = 2 * 3600_000;   // 结束两小时以上的旧状态，重开时直接丢掉

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* 无痕 */ } };
const localDate = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* state: null | {
 *   phase: 'focus' | 'break' | 'over',
 *   minutes, breakMin,           这一轮的专注 / 休息长度
 *   endsAt,                      这一段结束的时刻（暂停时无效）
 *   paused, left,                暂停时还剩多少毫秒
 *   credited,                    专注时间已经算进学习时间到哪一刻
 *   label, to,                   在学什么、点悬浮钟回到哪
 * } */
let state = read(KEY, null);
let owed = 0;                     // 已经从专注里结出来、还没被 studyClock 取走的毫秒
const subs = new Set();
const emit = () => { write(KEY, state); subs.forEach((f) => f()); };

/** 专注时间往前结到 now（不超过这一段的终点） */
function accrue(now) {
  const s = state;
  if (!s || s.phase !== 'focus' || s.paused) return;
  const until = Math.min(now, s.endsAt);
  if (until > s.credited) {
    owed += until - s.credited;
    s.credited = until;
    write(KEY, s);
  }
}

export const prefs = () => ({ minutes: 25, breakMin: 5, ...read(PREF_KEY, {}) });
export const setPrefs = (p) => { write(PREF_KEY, { ...prefs(), ...p }); subs.forEach((f) => f()); };

/** 今天完成了几个番茄、专注了多久（本机记） */
export function focusToday() {
  const d = read(DAY_KEY, null);
  return d?.date === localDate() ? d : { date: localDate(), rounds: 0, minutes: 0 };
}
function bumpToday(minutes, at) {
  const date = localDate(at);
  const d = read(DAY_KEY, null);
  const cur = d?.date === date ? d : { date, rounds: 0, minutes: 0 };
  write(DAY_KEY, { date, rounds: cur.rounds + 1, minutes: cur.minutes + minutes });
}

/* ── 到点：响两声 + 系统通知 ── */
function chime(up) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = up ? [659.25, 987.77] : [987.77, 659.25];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.24;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1.5);
    });
    setTimeout(() => ctx.close(), 2200);
  } catch { /* 没有声卡也不影响计时 */ }
}
function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* 通知不可用就只响铃 */ }
}

/* ── 阶段推进 ── */
let timer = 0;
function schedule() {
  clearTimeout(timer);
  const s = state;
  if (!s || s.paused || s.phase === 'over') return;
  timer = setTimeout(check, Math.max(0, s.endsAt - Date.now()) + 60);
}

function check() {
  const now = Date.now();
  let changed = false;
  for (let guard = 0; guard < 3; guard++) {
    const s = state;
    if (!s || s.paused) break;
    // 刚到点才响：重开窗口时补算的旧阶段不吵人
    const live = now - (s.endsAt || 0) < 90_000;
    if (s.phase === 'focus' && now >= s.endsAt) {
      accrue(now);
      bumpToday(s.minutes, s.endsAt);
      state = { ...s, phase: 'break', endsAt: s.endsAt + s.breakMin * 60_000, credited: null };
      if (live) { chime(false); notify('专注完成', `${s.minutes} 分钟。休息 ${s.breakMin} 分钟吧`); }
      changed = true;
    } else if (s.phase === 'break' && now >= s.endsAt) {
      state = { ...s, phase: 'over', endsAt: s.endsAt };
      if (live) { chime(true); notify('休息结束', '再来一个番茄？'); }
      changed = true;
    } else break;
  }
  if (state?.phase === 'over' && now - state.endsAt > STALE) { state = null; changed = true; }
  if (changed) emit();
  schedule();
}

/* ── 操作 ── */
export function startFocus({ minutes, label = '', to = '' } = {}) {
  accrue(Date.now());
  const p = prefs();
  const m = Number(minutes) || p.minutes;
  const now = Date.now();
  state = { phase: 'focus', minutes: m, breakMin: p.breakMin, endsAt: now + m * 60_000, paused: false, left: 0, credited: now, label, to };
  if (minutes) setPrefs({ minutes: m });
  emit();
  schedule();
  // 第一次点开始时顺手要通知权限（Electron 里默认就有）
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* 无 */ }
}

export function pauseFocus() {
  const s = state;
  if (!s || s.paused || s.phase === 'over') return;
  const now = Date.now();
  accrue(now);
  state = { ...s, paused: true, left: Math.max(0, s.endsAt - now) };
  emit();
  schedule();
}

export function resumeFocus() {
  const s = state;
  if (!s || !s.paused) return;
  const now = Date.now();
  state = { ...s, paused: false, endsAt: now + s.left, left: 0, credited: s.phase === 'focus' ? now : s.credited };
  emit();
  schedule();
}

/** 结束：专注到一半也把已经专注的时间算上，只是不记成一个完整的番茄 */
export function stopFocus() {
  accrue(Date.now());
  state = null;
  emit();
  schedule();
}

export const skipBreak = () => { if (state?.phase === 'break') { state = { ...state, phase: 'over', paused: false }; emit(); schedule(); } };

/** studyClock 每秒来取：上次取到现在专注了几秒 */
export function takeFocusCredit() {
  accrue(Date.now());
  const sec = owed / 1000;
  owed = 0;
  return sec;
}
export const focusRunning = () => !!state && state.phase === 'focus' && !state.paused;

/** 还剩多少毫秒、这一段一共多长 */
export function remaining(s, now = Date.now()) {
  if (!s) return { left: 0, total: 1 };
  const total = (s.phase === 'break' ? s.breakMin : s.minutes) * 60_000;
  const left = s.phase === 'over' ? 0 : s.paused ? s.left : Math.max(0, s.endsAt - now);
  return { left, total };
}
export const mmss = (ms) => {
  const t = Math.ceil(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => state;
export const useFocus = () => useSyncExternalStore(subscribe, snapshot);
/** 偏好和今日统计变了也要刷新：订阅同一个通道，拿一个递增的版本号 */
let prefVer = 0;
subs.add(() => { prefVer += 1; });
export const usePrefsVersion = () => useSyncExternalStore(subscribe, () => prefVer);

/** 计时中每半秒重画一次（半秒才不会偶尔跳过一秒） */
export function useTicker(on) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

// 启动时：丢掉太旧的状态，补算关窗期间走完的阶段，排上下一次到点
if (state && state.phase !== 'over' && !state.paused && Date.now() - state.endsAt > STALE + (state.breakMin || 5) * 60_000) state = null;
check();
