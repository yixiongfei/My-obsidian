/**
 * 发音。先走服务端 /api/tts（你的 Worker 合成的神经网络音色，服务端有缓存），
 * 拿不到就退回浏览器自带的 Web Speech，挑一个美式女声。
 *
 * 服务端一次最多合成 600 字符，浏览器自带的语音读太长也会中途卡死，
 * 所以长文（阅读里的短文）按句子切成几段，一段读完接下一段，下一段提前加载好。
 */

const DEFAULT_VOICE = 'en-US-JennyNeural';
const CHUNK = 400;

let audio = null;
let gen = 0; // 每次新朗读 / 停止都加一，旧队列看到代号变了就不再往下读

function stop() {
  gen += 1;
  if (audio) { try { audio.pause(); } catch { /* 忽略 */ } audio = null; }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function pickSystemVoice() {
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
  return en.find((v) => /en-US/i.test(v.lang) && /Jenny|Aria|Zira|Samantha|Ava|Allison|female/i.test(v.name))
    || en.find((v) => /en-US/i.test(v.lang))
    || en[0] || null;
}

/** 系统语音：每段一个 utterance，speechSynthesis 自己会排队按顺序读 */
function speakSystem(parts, rate) {
  if (!('speechSynthesis' in window)) return;
  const v = pickSystemVoice();
  for (const p of parts) {
    const u = new SpeechSynthesisUtterance(p);
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-US';
    u.rate = rate;
    window.speechSynthesis.speak(u);
  }
}

/** 按句子切成不超过 CHUNK 字符的段；单句太长再按逗号、最后按空格切 */
function chunks(text) {
  if (text.length <= CHUNK) return [text];
  const out = [];
  let cur = '';
  const push = (piece) => {
    if (cur && (cur.length + 1 + piece.length) > CHUNK) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${piece}` : piece;
  };
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    if (sentence.length <= CHUNK) { push(sentence); continue; }
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      if (clause.length <= CHUNK) { push(clause); continue; }
      for (const word of clause.split(' ')) push(word);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * @param text  要读的英文
 * @param rate  语速倍率，默认 1
 */
let last = { text: '', at: 0 };

export function speak(text, { rate = 1, voice = DEFAULT_VOICE } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  // 同一段文字 300ms 内的重复调用（点击 + 键盘、两个处理器都触发）只读一次
  const now = Date.now();
  if (t === last.text && now - last.at < 300) return;
  last = { text: t, at: now };
  stop();
  const my = gen;
  const parts = chunks(t);
  const urlOf = (p) => `/api/tts?text=${encodeURIComponent(p)}&voice=${encodeURIComponent(voice)}&speed=${rate}`;
  const load = (i) => {
    const a = new Audio(urlOf(parts[i]));
    a.preload = 'auto';
    return a;
  };

  const play = (i, a) => {
    if (my !== gen || i >= parts.length) return;
    audio = a;
    const next = i + 1 < parts.length ? load(i + 1) : null; // 边读边把下一段取回来，段间不留空白
    const fail = () => { if (my === gen) { audio = null; speakSystem(parts.slice(i), rate); } };
    a.onended = () => play(i + 1, next);
    a.onerror = fail;
    a.play().catch(fail);
  };
  play(0, load(0));
}

export const canSpeak = typeof window !== 'undefined' && (typeof Audio !== 'undefined' || 'speechSynthesis' in window);
export { stop as stopSpeaking };
