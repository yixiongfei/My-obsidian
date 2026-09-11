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
  mindmap: () => j('/api/mindmap'),
  search: (q) => j(`/api/search?q=${encodeURIComponent(q)}`),
  dashboard: () => j('/api/dashboard'),
  queue: () => j('/api/review/queue'),
  review: (payload) => j('/api/review', body('POST', payload)),

  // 英语词汇 Anki
  cards: () => j('/api/review/cards'),
  rateWord: (id, rating) => j('/api/vocabulary/review', body('POST', { id, rating })),
  // 发完就走，不等磁盘：失败也不该挡住用户翻下一张卡
  syncVocabMarkdown: () => fetch('/api/vocabulary/sync-markdown', body('POST', {})).catch(() => {}),
  vocabOverview: () => j('/api/vocabulary/overview'),
  year: (y) => j(`/api/schedule/year/${y}`),
  month: (m) => j(`/api/schedule/month/${m}`),
  day: (d) => j(`/api/schedule/day/${d}`),
  addEvent: (payload) => j('/api/schedule/event', body('POST', payload)),
  patchEvent: (id, payload) => j(`/api/schedule/event/${id}`, body('PATCH', payload)),
  deleteEvent: (id) => j(`/api/schedule/event/${id}`, { method: 'DELETE' }),
};

export const vaultUrl = (id) => '/vault/' + id.split('/').map(encodeURIComponent).join('/');
