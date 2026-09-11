/**
 * 发音。先走服务端 /api/tts（你的 Worker 合成的神经网络音色，服务端有缓存），
 * 拿不到就退回浏览器自带的 Web Speech，挑一个美式女声。
 */

const DEFAULT_VOICE = 'en-US-JennyNeural';

let audio = null;

function stop() {
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

function speakSystem(text, rate) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = pickSystemVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || 'en-US';
  u.rate = rate;
  window.speechSynthesis.speak(u);
}

/**
 * @param text  要读的英文
 * @param rate  语速倍率，默认 1
 */
export function speak(text, { rate = 1, voice = DEFAULT_VOICE } = {}) {
  const t = String(text || '').trim();
  if (!t) return;
  stop();
  const url = `/api/tts?text=${encodeURIComponent(t)}&voice=${encodeURIComponent(voice)}&speed=${rate}`;
  const a = new Audio(url);
  audio = a;
  a.onerror = () => { if (audio === a) { audio = null; speakSystem(t, rate); } };
  a.play().catch(() => { if (audio === a) { audio = null; speakSystem(t, rate); } });
}

export const canSpeak = typeof window !== 'undefined' && (typeof Audio !== 'undefined' || 'speechSynthesis' in window);
export { stop as stopSpeaking };
