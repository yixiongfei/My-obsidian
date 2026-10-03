import { listEvents, timeOf } from './schedule.js';
import { todayStr } from './review.js';
import { getMeta, setMeta } from './db.js';

/**
 * 日程提醒：今天排了时间段的日程，到开始时间（和提前几分钟）弹一条系统通知。
 *
 * 这里只负责「什么时候该提醒什么」。怎么弹由宿主决定：桌面版在主进程里注册一个
 * 回调，用 Windows 原生通知；网页版走 SSE，由前端用浏览器通知。
 * 每条只提醒一次（记在内存里）；程序是开着以后才算——错过的不补。
 */

const listeners = new Set();
export const onReminder = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const fired = new Set();
let timer = null;

export const prefs = () => ({
  enabled: getMeta('reminders:on') !== '0',
  lead: Math.max(0, Math.min(60, Number(getMeta('reminders:lead') ?? 5) || 0)),
});
export function setPrefs({ enabled, lead } = {}) {
  if (enabled != null) setMeta('reminders:on', enabled ? '1' : '0');
  if (lead != null) setMeta('reminders:lead', String(Math.max(0, Math.min(60, Number(lead) || 0))));
  return prefs();
}

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function tick(emit) {
  const { enabled, lead } = prefs();
  if (!enabled) return;
  const today = todayStr();
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const e of listEvents(today, today)) {
    if (e.done) continue;
    const t = timeOf(e.note);
    if (!t) continue;
    const start = minutes(t.start);
    const stages = lead > 0 ? [['soon', start - lead], ['start', start]] : [['start', start]];
    for (const [stage, at] of stages) {
      const key = `${e.id}:${today}:${t.start}:${stage}`;
      // 两分钟的窗口：tick 间隔 30 秒，电脑刚睡醒也不至于漏掉
      if (fired.has(key) || nowMin < at || nowMin > at + 2) continue;
      fired.add(key);
      const url = (String(e.note).match(/https?:\/\/\S+/) || [])[0] || '';
      emit({
        id: e.id,
        date: today,
        stage,
        title: stage === 'soon' ? `${lead} 分钟后：${e.title}` : `开始：${e.title}`,
        body: `${t.start}–${t.end}${url.includes('bilibili') ? ' · 点开这条提醒去日程里打开视频' : ''}`,
        url,
      });
    }
  }
}

export function startReminders(broadcast) {
  if (timer) return;
  const emit = (r) => {
    broadcast?.({ type: 'reminder', reminder: r });
    for (const fn of listeners) { try { fn(r); } catch (err) { console.warn('[提醒] 回调出错', err.message); } }
  };
  const run = () => { try { tick(emit); } catch (err) { console.warn('[提醒]', err.message); } };
  run();
  timer = setInterval(run, 30_000);
  timer.unref?.();
}
