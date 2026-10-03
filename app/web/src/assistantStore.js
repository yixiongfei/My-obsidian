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
const blank = (projectId = null) => ({ convId: null, title: '', sessionId: null, projectId, messages: [] });

// effort：medium「快速回答」/ high「深入思考」。看图讲题时 high 要等很久，默认快速
let state = { ...blank(), model: '', effort: 'medium', running: false, runId: null, list: [], projects: [], loaded: false };
const subs = new Set();

function set(fn) {
  state = fn(state);
  try { localStorage.setItem(KEY, JSON.stringify({ convId: state.convId, model: state.model, effort: state.effort })); } catch { /* 无痕 */ }
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

async function refreshProjects() {
  try { const projects = await json('/api/assistant/projects'); set((s) => ({ ...s, projects })); } catch { /* 服务没起 */ }
}
const send2 = (url, method, body) => json(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function createProject(name) {
  const p = await send2('/api/assistant/projects', 'POST', { name });
  await refreshProjects();
  return p;
}
async function renameProject(id, name) { await send2(`/api/assistant/projects/${id}`, 'PATCH', { name }); refreshProjects(); }
async function removeProject(id) {
  await send2(`/api/assistant/projects/${id}`, 'DELETE');
  if (state.projectId === id) set((s) => ({ ...s, projectId: null }));
  await Promise.all([refreshProjects(), refreshList()]);
}
async function moveConversation(id, projectId) {
  await send2(`/api/assistant/conversations/${id}`, 'PATCH', { projectId });
  if (state.convId === id) set((s) => ({ ...s, projectId }));
  refreshList();
}

async function refreshList() {
  try { const list = await json('/api/assistant/conversations'); set((s) => ({ ...s, list })); } catch { /* 服务没起 */ }
}

/** 当前这段存回库里（整段覆盖） */
async function persist() {
  const s = state;
  if (!s.convId || !s.messages.length) return;
  try {
    await put(s.convId, { title: s.title, sessionId: s.sessionId, model: s.model, projectId: s.projectId, messages: s.messages });
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
  set((s) => ({ ...s, loaded: true, model: saved.model || '', effort: saved.effort === 'high' ? 'high' : 'medium' }));

  // 上一版把整段对话放在 localStorage 里：搬进库，别丢
  if (Array.isArray(saved.messages) && saved.messages.length && !saved.convId) {
    const id = crypto.randomUUID();
    const first = saved.messages.find((m) => m.role === 'user');
    await put(id, { title: (first?.text || '对话').slice(0, 30), sessionId: saved.sessionId, model: saved.model || '', messages: settle(saved.messages) }).catch(() => {});
    saved.convId = id;
  }
  await Promise.all([refreshList(), refreshProjects()]);
  if (saved.convId) await open(saved.convId);
}

async function open(id) {
  if (state.running) return;
  try {
    const c = await json(`/api/assistant/conversations/${id}`);
    set((s) => ({ ...s, convId: c.id, title: c.title, sessionId: c.sessionId, projectId: c.projectId || null, messages: settle(c.messages) }));
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

/**
 * attachments: [{ path, kind: 'image' | 'file', name }]
 * context（做题页侧栏）：{ exam, section, n, label, key, sig, draft } —— 正在做的那道题。
 *   key 认题，sig 认作答；和这段对话里上一次附的题一样就只发 brief，服务端不再重复整道题和手写图。
 */
async function send(prompt, attachments = [], context = null) {
  const text = String(prompt || '').trim();
  const images = attachments.filter((a) => a.kind === 'image').map((a) => a.path);
  const files = attachments.filter((a) => a.kind === 'file').map((a) => ({ path: a.path, name: a.name }));
  if ((!text && !attachments.length) || state.running) return;
  const fresh = !state.convId;
  const lastCtx = state.messages.findLast((m) => m.role === 'user' && m.ctx)?.ctx;
  const ctx = context && { key: context.key, label: context.label, sig: context.sig };
  const ctxBody = context && {
    exam: context.exam, section: context.section, n: context.n, label: context.label,
    ...(lastCtx?.key === ctx.key && lastCtx?.sig === ctx.sig ? { brief: true } : { draft: context.draft || '' }),
  };
  set((s) => ({
    ...s,
    convId: s.convId || crypto.randomUUID(),
    title: s.title || (text || files[0]?.name || '图片').replace(/\s+/g, ' ').slice(0, 30),
    running: true,
    runId: null,
    messages: [...s.messages, { role: 'user', text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(ctx ? { ctx } : {}) }, { role: 'assistant', parts: [] }],
  }));
  if (fresh) persist(); // 新对话马上进侧栏

  try {
    const res = await fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text, images, files: files.map((f) => f.path), sessionId: state.sessionId, model: state.model || undefined, effort: state.effort, context: ctxBody || undefined }),
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
  createProject,
  renameProject,
  removeProject,
  moveConversation,
  setModel: (model) => set((s) => ({ ...s, model })),
  setEffort: (effort) => set((s) => ({ ...s, effort: effort === 'high' ? 'high' : 'medium' })),
  /** 新对话：只是换一张白纸，旧的留在侧栏 */
  newChat: (projectId = null) => { if (!state.running) set((s) => ({ ...s, ...blank(projectId) })); },
};
