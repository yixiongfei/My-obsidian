/**
 * 学习助手的对话状态放在模块里而不是组件里：切到别的页面，回答照样在后台流，
 * 回来还是完整的。对话记录落本机（localStorage），会话 id 交给 Claude Code 续上下文。
 *
 * messages:
 *   { role: 'user', text }
 *   { role: 'assistant', parts: [ {type:'text', text} | {type:'tool', id, name, input, status} |
 *                                 {type:'permission', id, tool, input, exists, decided} ], cost, error }
 */

const KEY = 'kb-assistant';
const empty = () => ({ sessionId: null, model: '', messages: [], running: false, runId: null });

function load() {
  try {
    const s = { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    // 刷新前没跑完的一轮已经断了：把悬着的确认标成失效，别让按钮一直亮着
    if (s.running) {
      s.running = false;
      s.runId = null;
      const last = s.messages.at(-1);
      if (last?.role === 'assistant') {
        last.parts = last.parts.map((p) => (p.type === 'permission' && p.decided == null ? { ...p, decided: 'expired' } : p));
        last.error ||= '页面刷新，这一轮中断了';
      }
    }
    return s;
  } catch { return empty(); }
}

let state = load();
const subs = new Set();

function set(fn) {
  state = fn(state);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 满了就不存 */ }
  subs.forEach((f) => f());
}

/** 只改最后一条助手消息 */
const patchLast = (fn) => set((s) => {
  const messages = s.messages.slice();
  const i = messages.length - 1;
  if (messages[i]?.role !== 'assistant') return s;
  messages[i] = fn({ ...messages[i], parts: messages[i].parts.slice() });
  return { ...s, messages };
});

function apply(ev) {
  switch (ev.type) {
    case 'run': set((s) => ({ ...s, runId: ev.runId })); break;
    case 'session': set((s) => ({ ...s, sessionId: ev.sessionId })); break;
    case 'text_block': patchLast((m) => {
      const last = m.parts.at(-1);
      if (last?.type === 'text' && last.text) m.parts[m.parts.length - 1] = { ...last, text: `${last.text}\n\n` };
      return m;
    }); break;
    case 'text': patchLast((m) => {
      const last = m.parts.at(-1);
      if (last?.type === 'text') m.parts[m.parts.length - 1] = { ...last, text: last.text + ev.delta };
      else m.parts.push({ type: 'text', text: ev.delta });
      return m;
    }); break;
    case 'tool': patchLast((m) => { m.parts.push({ type: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }); return m; }); break;
    case 'tool_result': patchLast((m) => {
      m.parts = m.parts.map((p) => (p.type === 'tool' && p.id === ev.id ? { ...p, status: ev.error ? 'error' : 'done' } : p));
      return m;
    }); break;
    case 'permission': patchLast((m) => { m.parts.push({ type: 'permission', id: ev.id, tool: ev.tool, input: ev.input, exists: ev.exists, decided: null }); return m; }); break;
    case 'permission_done': patchLast((m) => {
      m.parts = m.parts.map((p) => (p.type === 'permission' && p.id === ev.id ? { ...p, decided: ev.allow } : p));
      return m;
    }); break;
    case 'result': patchLast((m) => ({ ...m, cost: ev.cost, error: ev.error || m.error })); break;
    case 'error': patchLast((m) => ({ ...m, error: ev.message })); break;
    default: break;
  }
}

async function send(prompt) {
  const text = String(prompt || '').trim();
  if (!text || state.running) return;
  set((s) => ({
    ...s,
    running: true,
    runId: null,
    messages: [...s.messages, { role: 'user', text }, { role: 'assistant', parts: [] }],
  }));
  try {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, sessionId: state.sessionId, model: state.model || undefined }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败 ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { apply(JSON.parse(line.slice(6))); } catch { /* 坏帧跳过 */ } }
      }
    }
  } catch (err) {
    patchLast((m) => ({ ...m, error: err.message || '连接断了' }));
  }
  set((s) => ({ ...s, running: false, runId: null }));
}

async function answer(id, allow, always = false) {
  if (!state.runId) return;
  patchLast((m) => {
    m.parts = m.parts.map((p) => (p.type === 'permission' && p.id === id ? { ...p, decided: allow ? 'sending' : false } : p));
    return m;
  });
  await fetch('/api/assistant/permission', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: state.runId, id, allow, always }),
  }).catch(() => {});
}

async function stop() {
  if (!state.runId) return;
  await fetch('/api/assistant/stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: state.runId }),
  }).catch(() => {});
}

export const assistant = {
  get: () => state,
  subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  send,
  answer,
  stop,
  setModel: (model) => set((s) => ({ ...s, model })),
  reset: () => { if (!state.running) set(() => ({ ...empty(), model: state.model })); },
};
