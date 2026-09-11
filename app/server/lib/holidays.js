/**
 * 日本の祝日 —— 纯算法推算，不联网、不打表，任何年份都能算。
 *
 * 三层规则，顺序不能反：
 *   1. 本体（固定日 / ハッピーマンデー / 春分・秋分）
 *   2. 振替休日：本体落在周日，顺延到之后第一个非祝日
 *   3. 国民の休日：被两个祝日夹住的平日（シルバーウィーク 就是这么来的）
 *
 * 春分・秋分用的是 1980–2099 年适用的近似式，误差不会跨天。
 */

const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(y, m - 1, d).getDay();

/** 某月第 n 个星期一 */
function nthMonday(year, month, n) {
  const first = dow(year, month, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

const vernal = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnal = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

/** 本体祝日（现行法，2023 年以降） */
function base(year) {
  const out = new Map();
  const put = (m, d, name) => out.set(key(year, m, d), name);

  put(1, 1, '元日');
  put(1, nthMonday(year, 1, 2), '成人の日');
  put(2, 11, '建国記念の日');
  put(2, 23, '天皇誕生日');
  put(3, vernal(year), '春分の日');
  put(4, 29, '昭和の日');
  put(5, 3, '憲法記念日');
  put(5, 4, 'みどりの日');
  put(5, 5, 'こどもの日');
  put(7, nthMonday(year, 7, 3), '海の日');
  put(8, 11, '山の日');
  put(9, nthMonday(year, 9, 3), '敬老の日');
  put(9, autumnal(year), '秋分の日');
  put(10, nthMonday(year, 10, 2), 'スポーツの日');
  put(11, 3, '文化の日');
  put(11, 23, '勤労感謝の日');

  return out;
}

const shift = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return key(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};

const cache = new Map();

/** @returns {Map<string, string>} 'YYYY-MM-DD' → 祝日名 */
export function holidaysOf(year) {
  if (cache.has(year)) return cache.get(year);

  const map = base(year);

  // 振替休日：本体落在周日，顺延到之后第一个不是祝日的日子
  for (const date of [...map.keys()].sort()) {
    const [y, m, d] = date.split('-').map(Number);
    if (dow(y, m, d) !== 0) continue;
    let next = shift(date, 1);
    while (map.has(next)) next = shift(next, 1);
    map.set(next, '振替休日');
  }

  // 国民の休日：前后都是祝日的平日
  for (const date of [...map.keys()].sort()) {
    const between = shift(date, 1);
    if (map.has(between)) continue;
    const [y, m, d] = between.split('-').map(Number);
    if (dow(y, m, d) === 0) continue;
    if (map.has(shift(between, 1))) map.set(between, '国民の休日');
  }

  cache.set(year, map);
  return map;
}

/** 取某月的祝日，键是「日」 */
export function holidaysInMonth(year, month) {
  const all = holidaysOf(year);
  const out = new Map();
  for (const [date, name] of all) {
    const [y, m, d] = date.split('-').map(Number);
    if (y === year && m === month) out.set(d, name);
  }
  return out;
}

export const holidayOn = (dateStr) => {
  const y = Number(dateStr.slice(0, 4));
  return holidaysOf(y).get(dateStr) || null;
};
