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
  note: (id) => j(`/api/note?path=${encodeURIComponent(id)}`),
  mindmap: () => j('/api/mindmap'),
  search: (q) => j(`/api/search?q=${encodeURIComponent(q)}`),
  dashboard: () => j('/api/dashboard'),
  milestones: () => j('/api/milestones'),
  summarize: (path, on = true) => j('/api/note/summarize', body('POST', { path, on })),
  setMilestones: (patch) => j('/api/milestones', body('PUT', patch)),
  vocabPrefs: () => j('/api/vocabulary/prefs'),
  setVocabPrefs: (patch) => j('/api/vocabulary/prefs', body('PUT', patch)),
  review: (payload) => j('/api/review', body('POST', payload)),

  // 英语词汇 Anki
  cards: () => j('/api/review/cards'),
  assistantStatus: () => j('/api/assistant/status'),
  // 阅读卡片（句子 + 生词短文）
  sentences: () => j('/api/sentences'),
  allSentences: () => j('/api/sentences/all'),
  addSentence: (payload) => j('/api/sentences', body('POST', payload)),
  annotateSentence: (id, payload) => j(`/api/sentences/${id}/annotation`, body('PUT', payload)),
  rateSentence: (id, rating) => j(`/api/sentences/${id}/review`, body('POST', { rating })),
  removeSentence: (id) => j(`/api/sentences/${id}`, { method: 'DELETE' }),
  rateWord: (id, rating) => j('/api/vocabulary/review', body('POST', { id, rating })),
  // 发完就走，不等磁盘：失败也不该挡住用户翻下一张卡
  syncVocabMarkdown: () => fetch('/api/vocabulary/sync-markdown', body('POST', {})).catch(() => {}),
  // 标注词与单词列表
  vocabMarks: () => j('/api/vocabulary/marks'),
  markWord: (term, opts = {}) => j('/api/vocabulary/mark', body('POST', { term, ...opts })),
  words: (view, q = '') => j(`/api/vocabulary/words?view=${encodeURIComponent(view)}&q=${encodeURIComponent(q)}`),
  setWordImportant: (id, important) => j(`/api/vocabulary/words/${id}`, body('PATCH', { important })),
  word: (id) => j(`/api/vocabulary/words/${id}`),
  updateWord: (id, patch) => j(`/api/vocabulary/words/${id}`, body('PATCH', patch)),

  // 学习资源：历年真题。答案只在 submit 之后随响应下发
  exams: () => j('/api/exams'),
  exam: (id) => j(`/api/exams/${encodeURIComponent(id)}`),
  examTags: (group) => j(`/api/exams/tags/${encodeURIComponent(group)}`),
  saveExamDraft: (id, section, answers) => j(`/api/exams/${encodeURIComponent(id)}/${section}/answers`, body('PUT', { answers })),
  submitExam: (id, section, answers) => j(`/api/exams/${encodeURIComponent(id)}/${section}/submit`, body('POST', { answers })),
  resetExam: (id, section) => j(`/api/exams/${encodeURIComponent(id)}/${section}/reset`, body('POST', {})),
  // 荧光笔与错题本
  examMarks: (id) => j(`/api/exams/${encodeURIComponent(id)}/marks`),
  addExamMark: (id, payload) => j(`/api/exams/${encodeURIComponent(id)}/marks`, body('POST', payload)),
  removeExamMark: (mid) => j(`/api/exams/marks/${mid}`, { method: 'DELETE' }),
  recolorExamMark: (mid, color) => j(`/api/exams/marks/${mid}`, body('PATCH', { color })),
  syncExamMarks: () => fetch('/api/exams/marks/sync', body('POST', {})).catch(() => {}),
  readingAnnotations: (id, section) =>
    j(`/api/exams/${encodeURIComponent(id)}/${encodeURIComponent(section)}/reading-annotations`),
  saveReadingAnnotations: (id, section, data) =>
    j(`/api/exams/${encodeURIComponent(id)}/${encodeURIComponent(section)}/reading-annotations`, body('PUT', data)),
  exportQuestion: (id, section, n, drill = false) => j(`/api/exams/${encodeURIComponent(id)}/${section}/export`, body('POST', { n, drill })),
  // 专题训练：一个知识点的历年题，一题一交
  drill: (group, tag) => j(`/api/exams/drill/${encodeURIComponent(group)}?tag=${encodeURIComponent(tag)}`),
  drillAnswer: (exam, section, n, answer) => j('/api/exams/drill/answer', body('POST', { exam, section, n, answer })),
  drillReset: (exam, section, n) => j('/api/exams/drill/reset', body('POST', { exam, section, n })),
  // 便利贴：贴在笔记正文上的纸片
  stickies: (path) => j(`/api/stickies?path=${encodeURIComponent(path)}`),
  addSticky: (payload) => j('/api/stickies', body('POST', payload)),
  patchSticky: (id, patch) => j(`/api/stickies/${id}`, body('PATCH', patch)),
  removeSticky: (id) => j(`/api/stickies/${id}`, { method: 'DELETE' }),
  // 贴图走裸流，别让 JSON 体积限制和 base64 编码挡在截图和纸片之间
  uploadStickyMedia: (file) =>
    j(`/api/stickies/media?name=${encodeURIComponent(file.name || 'paste.png')}&mime=${encodeURIComponent(file.type || '')}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }),
  uploadAnswerImage: (file) =>
    j(`/api/answers/media?name=${encodeURIComponent(file.name || 'paste.png')}&mime=${encodeURIComponent(file.type || '')}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }),

  year: (y) => j(`/api/schedule/year/${y}`),
  month: (m) => j(`/api/schedule/month/${m}`),
  day: (d) => j(`/api/schedule/day/${d}`),
  addEvent: (payload) => j('/api/schedule/event', body('POST', payload)),
  patchEvent: (id, payload) => j(`/api/schedule/event/${id}`, body('PATCH', payload)),
  deleteEvent: (id) => j(`/api/schedule/event/${id}`, { method: 'DELETE' }),
};

export const vaultUrl = (id) => '/vault/' + id.split('/').map(encodeURIComponent).join('/');
