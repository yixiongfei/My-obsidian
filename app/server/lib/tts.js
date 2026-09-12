import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { KB_DIR } from '../config.js';

/**
 * 词卡发音：走你自己那个 Cloudflare Worker（AIchat 仓库里的 tts-voice-magic），
 * 神经网络音色，比系统 Web Speech 好听得多。
 *
 * 这是整站唯一会出网的地方，而且只在你把「发音」开关打开之后才会发请求；
 * 合成结果按 (音色, 语速, 文本) 缓存在 .kb/tts/，同一个词第二次是本地文件、离线也能放。
 * Worker 不通时接口回 502，前端自动退回系统语音（美式女声）。
 */

const TTS_URL = process.env.TTS_URL || 'https://tts-voice-magic.yixiongfei1785.workers.dev/v1/audio/speech';
const TTS_KEY = process.env.TTS_API_KEY || '';
const CACHE_DIR = path.join(KB_DIR, 'tts');
const DEFAULT_VOICE = 'en-US-JennyNeural';
const VOICES = new Set(['en-US-JennyNeural', 'en-US-AriaNeural', 'en-US-GuyNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural']);

const keyOf = (text, voice, speed) => crypto.createHash('sha1').update(`${voice}|${speed}|${text}`).digest('hex');

/** 同一段文字并发请求只合成一次 */
const inflight = new Map();

export async function synth(rawText, rawVoice, rawSpeed) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!text) throw Object.assign(new Error('没有要读的文字'), { status: 400 });
  const voice = VOICES.has(rawVoice) ? rawVoice : DEFAULT_VOICE;
  const speed = Math.min(1.5, Math.max(0.6, Number(rawSpeed) || 1));
  const file = path.join(CACHE_DIR, `${keyOf(text, voice, speed)}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return { file, cached: true };

  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const headers = { 'Content-Type': 'application/json' };
    if (TTS_KEY) headers.Authorization = `Bearer ${TTS_KEY}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(TTS_URL, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ input: text, voice, speed, format: 'mp3' }),
      });
      if (!res.ok) throw Object.assign(new Error(`TTS 服务返回 ${res.status}`), { status: 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw Object.assign(new Error('TTS 服务返回了空音频'), { status: 502 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, file);
      return { file, cached: false };
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('TTS 服务超时'), { status: 504 });
      if (!err.status) err.status = 502;
      throw err;
    } finally {
      clearTimeout(timer);
      inflight.delete(file);
    }
  })();
  inflight.set(file, job);
  return job;
}

export { DEFAULT_VOICE, VOICES };
