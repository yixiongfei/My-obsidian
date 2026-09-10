import { index } from './vault.js';
import { readLog, todayStr, daysBetween, bucketNotes, intervalAfter } from './review.js';

/* ------------------------------------------------------------------ *
 * 全局搜索
 * ------------------------------------------------------------------ */

/** 子序列模糊匹配：连续命中给更高分，用于命令面板式搜索 */
function fuzzy(needle, hay) {
  const n = needle.toLowerCase(), h = hay.toLowerCase();
  if (!n) return 0;
  const direct = h.indexOf(n);
  if (direct !== -1) return 1000 - direct * 2 + (direct === 0 ? 200 : 0);
  let i = 0, score = 0, streak = 0;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) { i++; streak++; score += 10 + streak * 4; }
    else streak = 0;
  }
  return i === n.length ? score : 0;
}

function snippet(plain, q, len = 90) {
  const at = plain.toLowerCase().indexOf(q.toLowerCase());
  if (at === -1) return plain.slice(0, len).trim();
  const start = Math.max(0, at - Math.floor(len / 3));
  return `${start > 0 ? '…' : ''}${plain.slice(start, start + len).trim()}…`;
}

export function search(q, limit = 30) {
  const query = String(q || '').trim();
  if (!query) return [];
  const results = [];

  for (const note of index.notes.values()) {
    const titleScore = fuzzy(query, note.title) * 3;
    const pathScore = fuzzy(query, note.id) * 1.5;
    const tagScore = Math.max(0, ...note.tags.map((t) => fuzzy(query, t))) * 2;
    const headScore = Math.max(0, ...note.outline.map((h) => fuzzy(query, h.text)), 0) * 1.2;

    const plain = note.plain.replace(/\s+/g, ' ');
    const bodyHits = plain.toLowerCase().split(query.toLowerCase()).length - 1;
    const bodyScore = bodyHits ? 400 + Math.min(bodyHits, 10) * 20 : 0;

    const score = titleScore + pathScore + tagScore + headScore + bodyScore;
    if (score <= 0) continue;

    const matchedHeading = note.outline.find((h) => h.text.toLowerCase().includes(query.toLowerCase()));
    results.push({
      ...index.meta(note),
      score,
      snippet: bodyHits ? snippet(plain, query) : (matchedHeading?.text || plain.slice(0, 80).trim()),
      hits: bodyHits,
      matchedHeading: matchedHeading?.text || null,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 知识图谱
 * ------------------------------------------------------------------ */

/** 一级标签（学科），决定图谱配色分组 */
const TOP_TAGS = ['高等数学', '线性代数', '概率论', '数据结构', '操作系统', '计算机网络', '计算机组成原理', '英语', '语法', '词汇', '个人'];

function groupOf(note) {
  for (const t of TOP_TAGS) if (note.tags.includes(t)) return t;
  const seg = note.folder.split('/').filter(Boolean);
  return seg[seg.length - 1] || seg[0] || '未分类';
}

export function graph() {
  const nodes = [];
  const links = [];
  const degree = new Map();

  for (const note of index.notes.values()) {
    nodes.push({
      id: note.id,
      title: note.title,
      group: groupOf(note),
      tags: note.tags,
      words: note.words,
      reviewCount: note.reviewCount,
      nextReview: note.nextReview,
      empty: note.words === 0,
    });
    degree.set(note.id, 0);
  }

  const seen = new Set();
  for (const note of index.notes.values()) {
    for (const target of note.linkTargets) {
      const to = index.resolve(target);
      if (!to || to === note.id || !index.notes.has(to)) continue;
      const key = `${note.id}→${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: note.id, target: to });
      degree.set(note.id, degree.get(note.id) + 1);
      degree.set(to, degree.get(to) + 1);
    }
  }

  for (const n of nodes) n.degree = degree.get(n.id) || 0;
  return { nodes, links, groups: [...new Set(nodes.map((n) => n.group))].sort() };
}

/* ------------------------------------------------------------------ *
 * 复习仪表盘
 * ------------------------------------------------------------------ */

export async function dashboard(examDate) {
  const today = todayStr();
  const log = await readLog();
  const buckets = bucketNotes(today);
  const notes = index.allMeta();

  // 近 26 周的复习热力图
  const counts = new Map();
  for (const e of log) counts.set(e.date, (counts.get(e.date) || 0) + 1);
  const heatmap = [];
  const weeks = 26;
  const cursor = new Date();
  cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7) - (weeks - 1) * 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = todayStr(cursor);
    heatmap.push({ date: d, count: counts.get(d) || 0, future: d > today });
    cursor.setDate(cursor.getDate() + 1);
  }

  // 按学科统计掌握度：平均复习次数 / 最大间隔档位
  const byTag = new Map();
  for (const n of notes) {
    for (const t of n.tags) {
      if (!byTag.has(t)) byTag.set(t, { tag: t, notes: 0, reviews: 0, due: 0, empty: 0 });
      const b = byTag.get(t);
      b.notes++;
      b.reviews += n.reviewCount;
      if (n.empty) b.empty++;
      if (n.nextReview && daysBetween(today, n.nextReview) <= 0) b.due++;
    }
  }
  const subjects = [...byTag.values()]
    .map((b) => ({
      ...b,
      // 掌握度 = 平均复习次数占满档(5次)的比例
      mastery: Math.min(1, b.notes ? b.reviews / (b.notes * 5) : 0),
    }))
    .sort((a, b) => b.notes - a.notes);

  // 连续复习天数
  let streak = 0;
  const cur = new Date();
  for (;;) {
    const d = todayStr(cur);
    if (counts.get(d)) { streak++; cur.setDate(cur.getDate() - 1); continue; }
    if (d === today) { cur.setDate(cur.getDate() - 1); continue; } // 今天还没复习不算断
    break;
  }

  return {
    today,
    daysToExam: examDate ? daysBetween(today, examDate) : null,
    examDate: examDate || null,
    counts: {
      notes: notes.length,
      words: notes.reduce((s, n) => s + n.words, 0),
      reviews: log.length,
      due: buckets.due.length,
      upcoming: buckets.upcoming.length,
      unscheduled: buckets.unscheduled.length,
      empty: notes.filter((n) => n.empty).length,
      todayDone: counts.get(today) || 0,
    },
    streak,
    due: buckets.due.slice(0, 50),
    upcoming: buckets.upcoming.slice(0, 20),
    unscheduled: buckets.unscheduled.slice(0, 20),
    heatmap,
    subjects,
    recent: log.slice(-12).reverse().map((e) => ({ ...e, title: index.get(e.note_path)?.title || e.note_path })),
    intervals: [0, 1, 2, 3, 4, 5].map((c) => ({ after: c, days: intervalAfter(c) })),
  };
}
