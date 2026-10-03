import { getExam } from './exams.js';
import * as drill from './drill.js';
import { questionContext } from './assistant-ops.js';
import { askOnce } from './assistant.js';

/**
 * 专题训练里交给 AI 的两件事：
 *   grade      填空 / 解答题按考研口径打分、判对错，结论回填进 exam_drill
 *   summarize  给这道题的便利贴写两三行总结：做题关键、易错点、（做错了的话）错因
 *
 * 都走 askOnce：一次性、不带工具、按 schema 拿结构化结果，和助手对话互不干扰。
 * 题面、参考答案、作答（含手写图）都由 questionContext 拼——和侧栏助手看到的是同一份。
 */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function locate(examId, sectionId, n) {
  const exam = getExam(examId);
  const section = exam?.sections.find((s) => s.id === sectionId);
  if (!section) throw bad('题目不存在', 404);
  return { exam, section };
}

const GRADE_SYSTEM = [
  '你是考研数学 / 408 的阅卷老师，按考研阅卷的口径给一道题的作答打分。',
  '- 依据题目、参考答案与解析、学生作答（文字和手写图）。手写看不清的地方按最合理的理解，不因字迹扣分。',
  '- 解答题按步骤给分：思路正确、关键步骤到位就给相应的分；结论错但前面的步骤对，给过程分。',
  '- 填空题只看最终结果：和参考答案数学上等价就算对（写法不同不扣分），否则 0 分。',
  '- 只评这份作答，不替学生补没写的步骤。',
  '- verdict：right = 结论和关键步骤都对（不影响结论的小瑕疵可以扣一两分，仍算 right）；partial = 思路对但有错或没做完；wrong = 方法不对，或结果错且没有有效步骤，或空白。',
  '- brief：一句话结论，不超过 40 字。points：2–4 条，每条不超过 40 字，写得分点和失分点，失分点要指出具体是哪一步。',
  '- 用中文，公式写成 $…$。',
].join('\n');

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '得分，0 到满分之间，可以有 0.5' },
    verdict: { type: 'string', enum: ['right', 'partial', 'wrong'] },
    brief: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'verdict', 'brief', 'points'],
  additionalProperties: false,
};

/** AI 批改一道交过的填空 / 解答题 */
export async function grade(examId, sectionId, n, { model } = {}) {
  const { section } = locate(examId, sectionId, n);
  if (section.type === 'choice') throw bad('选择题已经自动判过了');
  const attempt = drill.attemptOf(examId, sectionId, n);
  if (!attempt) throw bad('先交了再批改', 409);
  if (!String(attempt.answer || '').trim()) throw bad('没有作答，没法批改');

  const total = drill.pointsOf(section) ?? (section.type === 'free' ? 10 : 5);
  const q = questionContext(examId, sectionId, n, '', { extras: false });
  const { data, cost } = await askOnce({
    system: GRADE_SYSTEM,
    text: `${q.text}\n\n这道题满分 ${total} 分。请批改上面「我的作答」。`,
    images: q.images,
    schema: GRADE_SCHEMA,
    model,
  });
  if (!data || typeof data.score !== 'number') throw bad('AI 没给出分数，再试一次', 502);

  const score = Math.max(0, Math.min(total, Math.round(data.score * 2) / 2));
  const verdict = ['right', 'partial', 'wrong'].includes(data.verdict) ? data.verdict : (score >= total ? 'right' : score > 0 ? 'partial' : 'wrong');
  return drill.saveGrade(examId, sectionId, n, {
    score,
    total,
    verdict,
    brief: String(data.brief || '').slice(0, 120),
    points: (Array.isArray(data.points) ? data.points : []).map((p) => String(p).slice(0, 120)).slice(0, 5),
    cost,
    at: new Date().toISOString(),
  });
}

const SUMMARY_SYSTEM = [
  '你在帮考研学生写一张做题后的便利贴，贴在这道题旁边，复习时扫一眼就能想起来。',
  '- key：这题的突破口——用到的定理、方法或关键一步，不超过 50 字。',
  '- pitfall：这类题最容易丢分的地方，不超过 50 字。',
  '- why：学生这次错在哪一步、为什么错，具体到步骤，不超过 60 字；做对了或还没作答就留空字符串。',
  '- 不复述题目，不客套，「我的便利贴」里已经写过的不要重复。用中文，公式写成 $…$。',
].join('\n');

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { key: { type: 'string' }, pitfall: { type: 'string' }, why: { type: 'string' } },
  required: ['key', 'pitfall', 'why'],
  additionalProperties: false,
};

/** 给便利贴写的两三行总结，返回便利贴格式的文字（**粗**、- 条目、$公式$） */
export async function summarize(examId, sectionId, n, { model } = {}) {
  const { section } = locate(examId, sectionId, n);
  const attempt = drill.attemptOf(examId, sectionId, n);
  const q = questionContext(examId, sectionId, n);
  // 选择题的对错 questionOf 里看得出来；填空 / 解答题没批改时说一声
  const verdict = section.type !== 'choice' && attempt && !attempt.ai ? '\n\n（这道题还没批改，对照参考答案自己判断对错）' : '';
  const { data } = await askOnce({
    system: SUMMARY_SYSTEM,
    text: `${q.text}${verdict}\n\n给这道题写便利贴总结。`,
    images: q.images,
    schema: SUMMARY_SCHEMA,
    model,
  });
  if (!data) throw bad('AI 没写出来，再试一次', 502);
  const line = (k, v) => (String(v || '').trim() ? `- **${k}**：${String(v).trim()}` : '');
  const text = [line('关键', data.key), line('易错', data.pitfall), line('错因', data.why)].filter(Boolean).join('\n');
  if (!text) throw bad('AI 没写出来，再试一次', 502);
  return { text };
}
