const j = async (url, opts) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `请求失败 ${res.status}`);
  return data;
};

const body = (method, payload) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

export const api = {
  meta: () => j('/api/meta'),
  tree: () => j('/api/tree'),
  notes: () => j('/api/notes'),
  note: (id) => j(`/api/note?path=${encodeURIComponent(id)}`),
  tags: () => j('/api/tags'),
  search: (q) => j(`/api/search?q=${encodeURIComponent(q)}`),
  dashboard: () => j('/api/dashboard'),
  queue: () => j('/api/review/queue'),
  review: (payload) => j('/api/review', body('POST', payload)),
  year: (y) => j(`/api/schedule/year/${y}`),
  month: (m) => j(`/api/schedule/month/${m}`),
  day: (d) => j(`/api/schedule/day/${d}`),
  addEvent: (payload) => j('/api/schedule/event', body('POST', payload)),
  patchEvent: (id, payload) => j(`/api/schedule/event/${id}`, body('PATCH', payload)),
  deleteEvent: (id) => j(`/api/schedule/event/${id}`, { method: 'DELETE' }),
};

export const vaultUrl = (id) => '/vault/' + id.split('/').map(encodeURIComponent).join('/');
