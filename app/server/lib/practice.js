import { getExam } from './exams.js';
import { notesOfPoints } from './points.js';
import { recordReview, todayStr, daysBetween } from './review.js';

/**
 * 做题也算复习：交了带考点标签的题，和这个考点对得上、今天到期的知识点笔记就记一次复习。
 *
 *   只动到期的，和写了还从没复习过的（做题就算第一次复习）——没到期的提前记一次，间隔被拉长，反而复习得更少；
 *   只动知识点笔记——错题本的复习是盖住解析重做那几道错题，做新题不算；
 *   这个考点下有题做错了记「有点吃力」（间隔缩短），否则记「完成一次复习」；
 *   今天已经复习过的不重复记。
 * 走的是和手动复习同一条 recordReview：frontmatter、review_log、SQLite 三处都有，日历和仪表盘照常计数。
 */

/** 整卷交一个单元：答了的题各自的标签和对错（填空 / 解答题判不了，记 null） */
export function hitsOfSection(section, answers = {}) {
  const has = (v) => String(v ?? '').trim() !== '';
  if (section.type === 'choice' || section.type === 'fill') {
    return (section.questions || [])
      .filter((q) => has(answers[q.n]))
      .map((q) => ({ tags: q.tags || [], correct: section.type === 'choice' ? answers[q.n] === q.answer : null }));
  }
  if (section.type === 'free') {
    const any = has(answers.text) || (section.numbers || []).some((n) => has(answers[n]));
    return any ? [{ tags: section.tags || [], correct: null }] : [];
  }
  return [];
}

/**
 * @param {string} examId
 * @param {{ tags: string[], correct: boolean | null }[]} hits  这次交的题
 * @param {string} label  记进复习日志的来源，如「数一 2026 第 20 题」
 * @returns {Promise<{ id: string, title: string, point: string }[]>}  记了复习的笔记
 */
export async function reviewByPractice(examId, hits, label) {
  const exam = getExam(examId);
  if (!exam || !hits.length) return [];
  const wrongTags = new Set(hits.filter((h) => h.correct === false).flatMap((h) => h.tags));
  const owners = notesOfPoints(exam.group, hits.flatMap((h) => h.tags));
  const today = todayStr();
  const out = [];
  for (const { note, point } of owners.values()) {
    // 到期了；或者写了还从没复习过（没有 next_review）——做题就当第一次复习，从此进复习循环
    const due = note.nextReview && daysBetween(today, note.nextReview) <= 0;
    const fresh = !note.nextReview && !note.lastReviewed;
    if (!note.reviewable || note.lastReviewed === today || !(due || fresh)) continue;
    try {
      await recordReview(note.id, {
        result: wrongTags.has(point) ? 'hard' : 'good',
        addedContent: `做题：${label}（${point}）`,
        source: '做题复习',
      });
      out.push({ id: note.id, title: note.title, point });
    } catch (err) {
      console.warn('[做题复习]', note.id, err.message);
    }
  }
  return out;
}
