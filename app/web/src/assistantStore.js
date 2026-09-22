/**
 * 学习助手的对话状态放在模块里而不是组件里：切到别的页面，回答照样在后台流，回来还是完整的。
 *
 * 对话存在 SQLite（/api/assistant/conversations），本机只记「当前开着哪段」和选的模型。
 * 新对话不删旧的——旧的都在侧栏里，点一下就接着聊（Claude Code 的会话 id 一起存着，上下文接得上）。
 *
 * messages:
 *   { role: 'user', text }
 *   { role: 'assistant', parts: [ {type:'text', text} | {type:'tool', id, name, input, status} |
 *                                 {type:'permission', id, tool, input, exists, decided} ], cost, error }
 */

const KEY = 'kb-assistant';
const blank = () => ({ convId: null, title: '', sessionId: null, messages: [] });

let state = { ...blank(), model: '', running: false, runId: null, list: [], loaded: false };
const subs = new Set();

function set(fn) {
  state = fn(state);
  try { localStorage.setItem(KEY, JSON.stringify({ convId: state.convId, model: state.model })); } catch { /* 无痕 */ }
  subs.forEach((f) => f());
}

const json = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
};
const put = (id, body) => json(`/api/assistant/conversations/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function refreshList() {
  try { const list = await json('/api/assistant/conversations'); set((s) => ({ ...s, list })); } catch { /* 服务没起 */ }
}

/** 当前这段存回库里（整段覆盖） */
async function persist() {
  const s = state;
  if (!s.convId || !s.messages.length) return;
  try {
    await put(s.convId, { title: s.title, sessionId: s.sessionId, model: s.model, messages: s.messages });
    refreshList();
  } catch { /* 下一轮再存 */ }
}

/** 断在半路的一轮（刷新 / 关窗）：悬着的确认标成失效 */
const settle = (messages) => messages.map((m, i) => {
  if (m.role !== 'assistant' || i !== messages.length - 1) return m;
  const hanging = m.parts.some((p) => p.type === 'permission' && p.decided == null);
  if (!hanging && m.cost != null) return m;
  return {
    ...m,
    parts: m.parts.map((p) => (p.type === 'permission' && p.decided == null ? { ...p, decided: 'expired' } : p)),
    error: m.error || (m.cost == null && !m.parts.length ? '这一轮中断了' : m.error),
  };
});

async function init() {
  if (state.loaded) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* 坏了就当空 */ }
  set((s) => ({ ...s, loaded: true, model: saved.model || '' }));

  // 上一版把整段对话放在 localStorage 里：搬进库，别丢
  if (Array.isArray(saved.messages) && saved.messages.length && !saved.convId) {
    const id = crypto.randomUUID();
    const first = saved.messages.find((m) => m.role === 'user');
    await put(id, { title: (first?.text || '对话').slice(0, 30), sessionId: saved.sessionId, model: saved.model || '', messages: settle(saved.messages) }).catch(() => {});
    saved.convId = id;
  }
  await refreshList();
  if (saved.convId) await open(saved.convId);
}

async function open(id) {
  if (state.running) return;
  try {
    const c = await json(`/api/assistant/conversations/${id}`);
    set((s) => ({ ...s, convId: c.id, title: c.title, sessionId: c.sessionId, messages: settle(c.messages) }));
  } catch {
    set((s) => ({ ...s, ...blank() }));
  }
}

async function remove(id) {
  if (state.running && state.convId === id) return;
  await json(`/api/assistant/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
  if (state.convId === id) set((s) => ({ ...s, ...blank() }));
  refreshList();
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
  const fresh = !state.convId;
  set((s) => ({
    ...s,
    convId: s.convId || crypto.randomUUID(),
    title: s.title || text.replace(/\s+/g, ' ').slice(0, 30),
    running: true,
    runId: null,
    messages: [...s.messages, { role: 'user', text }, { role: 'assistant', parts: [] }],
  }));
  if (fresh) persist(); // 新对话马上进侧栏

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
  persist();
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
  init,
  send,
  answer,
  stop,
  open,
  remove,
  setModel: (model) => set((s) => ({ ...s, model })),
  /** 新对话：只是换一张白纸，旧的留在侧栏 */
  newChat: () => { if (!state.running) set((s) => ({ ...s, ...blank() })); },
};
