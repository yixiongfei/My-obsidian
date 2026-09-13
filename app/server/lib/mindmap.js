import fsp from 'node:fs/promises';
import yaml from 'js-yaml';
import { TAGS_FILE } from '../config.js';
import { allNotes } from './query.js';
import { todayStr, daysBetween } from './review.js';
import { subjectsOf, groupKeyOf, subjectMatches, matchNotes, learnedDates, pointStatus, wrongIndex, wrongOf } from './points.js';

/**
 * 思维导图：以 tags.yaml 的受控词表为骨架，而不是目录结构。
 *
 * 这样做的好处是——词表里写了但还没有笔记的考点（比如 408 的四门）会
 * 先占好位置，一眼看出哪里是空的；反过来，只打了大类标签、没打分支标签
 * 的笔记会落在「未归类到分支」，等于顺手查出打标签的漏网。
 *
 * 数学与 408 的分支下再挂一层**考点**（真题标签名）做锚点：笔记是学某个
 * 考点时写的感悟，归到对应考点下面；一个考点有没有笔记、笔记到没到期，
 * 就是这个考点学没学、要不要复习。
 */

const statusOf = (n, today) => {
  if (n.empty) return 'empty';
  if (!n.nextReview) return 'new';
  return daysBetween(today, n.nextReview) <= 0 ? 'due' : 'sched';
};

export async function mindmap() {
  let vocab = {};
  let order = [];
  try {
    const raw = await fsp.readFile(TAGS_FILE, 'utf8');
    vocab = yaml.load(raw) || {};
    // JS 对象会把 "408" 这类纯数字键排到最前，所以顺序得从原文里取
    order = [...raw.matchAll(/^([^\s#][^:\n]*):\s*$/gm)].map((m) => m[1].trim());
  } catch { /* 词表可选 */ }

  const categories = [
    ...order.filter((k) => k in vocab),
    ...Object.keys(vocab).filter((k) => !order.includes(k)),
  ];

  const today = todayStr();
  const learnedAt = learnedDates();
  const notes = allNotes().map((n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags,
    reviewCount: n.reviewCount,
    nextReview: n.nextReview,
    reviewable: n.reviewable,
    words: n.words,
    empty: n.empty,
    kind: n.kind,
    status: statusOf(n, today),
    learnedAt: learnedAt.get(n.id) || null,
  }));
  const wrongs = wrongIndex(notes);

  const placed = new Set();
  const leaf = (n) => {
    placed.add(n.id);
    const { tags, reviewable, empty, ...rest } = n;
    return rest;
  };
  // 错题本 / 日志不参与"这一支有没有学过"的判断；错题本单独列一支，日志挂到分支上
  const isEvidence = (n) => n.kind === 'point';

  const groups = [];
  for (const category of categories) {
    const subs = Array.isArray(vocab[category]) ? vocab[category].map(String) : [];
    const subjects = subjectsOf(category);
    const groupKey = groupKeyOf(category);
    const branches = [];
    const gstat = { total: 0, learned: 0, due: 0, today: 0 };

    for (const sub of subs) {
      const hit = notes.filter((n) => !placed.has(n.id) && n.tags.includes(sub));
      const subject = subjects?.find((s) => subjectMatches(sub, s.name));
      if (!subject) {
        branches.push({ name: sub, notes: hit.map(leaf) });
        continue;
      }

      // 有考点清单的分支：知识点笔记归到考点下，对不上的留在分支上；错题本按题号挂到考点、只计数
      const map = matchNotes(hit.filter((n) => !n.empty && isEvidence(n)), subject.points);
      const stat = { total: 0, learned: 0, due: 0, today: 0, wrong: 0 };
      const points = subject.points.map((p) => {
        const own = hit.filter((n) => map.get(n.id) === p.name);
        const st = pointStatus(own, today, learnedAt);
        const wrong = wrongOf(p, wrongs);
        stat.total += 1; gstat.total += 1;
        if (st !== 'new') { stat.learned += 1; gstat.learned += 1; }
        if (st === 'due') { stat.due += 1; gstat.due += 1; }
        if (st === 'today') { stat.today += 1; gstat.today += 1; }
        if (wrong.count) stat.wrong += 1;
        return { name: p.name, items: p.items, status: st, notes: own.map(leaf), wrong: wrong.count, wrongNotes: wrong.notes };
      });
      const rest = hit.filter((n) => !placed.has(n.id) && n.kind !== 'wrong').map(leaf);
      branches.push({ name: sub, subject: subject.name, group: groupKey, points, stat, notes: rest });
    }

    /* 有考点清单的科目（数学 / 408）：错题本笔记直接挂到它对应的考点后面，不再单列一支。
       先按标题对（「泰勒公式 错题」→ 泰勒公式），对不上再看它里面的题号落在哪个考点，取最具体的那个 */
    if (subjects) {
      const allPoints = branches.flatMap((b) => b.points || []);
      const normTitle = (t) => String(t || '').replace(/\s*错题.*$/, '').replace(/[\s·:：、（）()\-]/g, '').toLowerCase();
      for (const n of notes) {
        if (placed.has(n.id) || n.kind !== 'wrong' || !(n.tags.includes(category) || n.id.startsWith(`${category}/`))) continue;
        const key = normTitle(n.title);
        let target = allPoints.find((p) => normTitle(p.name) === key);
        if (!target) {
          const cands = allPoints.filter((p) => p.wrongNotes.includes(n.id));
          if (cands.length) target = cands.reduce((a, b) => (b.items < a.items ? b : a));
        }
        if (target) target.notes.push(leaf(n));
      }
    }

    // 错题本：没挂到考点上的（英语没有考点清单，全部在这）单独一支，二轮查漏用，不算一轮的学习证据
    const wrongNotes = notes.filter((n) => !placed.has(n.id) && n.kind === 'wrong' && (n.tags.includes(category) || n.id.startsWith(`${category}/`)));
    if (wrongNotes.length) branches.push({ name: '错题本', kind: 'wrong', notes: wrongNotes.map(leaf) });

    // 打了大类标签、但没打任何分支标签的笔记
    const direct = notes.filter((n) => !placed.has(n.id) && n.tags.includes(category));
    if (direct.length) {
      branches.push({ name: null, label: '未归类到分支', notes: direct.map(leaf) });
    }

    const own = branches.flatMap((b) => [...b.notes, ...(b.points || []).flatMap((p) => p.notes)]);
    const reviews = own.reduce((s, n) => s + n.reviewCount, 0);
    groups.push({
      name: category,
      group: groupKey,
      branches,
      count: own.length,
      declared: subs.length,
      reviews,
      // 掌握度 = 平均复习次数占满档（5 次）的比例
      mastery: own.length ? Math.min(1, reviews / (own.length * 5)) : 0,
      ...(subjects ? { stat: gstat } : {}),
    });
  }

  // 词表之外的笔记（个人随笔、说明文档等），按各自的首个标签分组
  const rest = notes.filter((n) => !placed.has(n.id));
  if (rest.length) {
    const byTag = new Map();
    for (const n of rest) {
      const key = n.tags[0] || '未分类';
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key).push(leaf(n));
    }
    groups.push({
      name: '词表之外',
      branches: [...byTag.entries()].map(([name, list]) => ({ name, notes: list })),
      count: rest.length,
      declared: 0,
      reviews: rest.reduce((s, n) => s + n.reviewCount, 0),
      mastery: 0,
      outside: true,
    });
  }

  const allPoints = groups.flatMap((g) => g.branches.flatMap((b) => b.points || []));
  return {
    root: { name: '知识库', count: notes.length },
    groups,
    counts: {
      notes: notes.length,
      due: notes.filter((n) => n.status === 'due').length,
      empty: notes.filter((n) => n.status === 'empty').length,
      // 词表里写了、但一篇笔记都还没有的分支
      emptyBranches: groups.flatMap((g) => g.branches).filter((b) => b.name && !b.notes.length && !(b.points || []).some((p) => p.notes.length)).length,
      points: {
        total: allPoints.length,
        learned: allPoints.filter((p) => p.status !== 'new').length,
        due: allPoints.filter((p) => p.status === 'due').length,
        today: allPoints.filter((p) => p.status === 'today').length,
      },
    },
  };
}
