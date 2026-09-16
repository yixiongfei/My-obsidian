import katex from 'katex';

/**
 * 便利贴上的手打文字 → HTML。
 *
 * 只认四样东西，多一样都不认：
 *   $x^2$ / $$…$$   数学公式，交给 KaTeX，和正文用同一套字形
 *   **粗**          重点
 *   - / · 开头      条目
 *   > 开头          首行小标题（比如「我的思路」）
 *
 * 为什么不直接复用后端那套 markdown-it：那条链路在服务端，一敲键盘就发一次请求
 * 不现实；而便利贴上的东西本来也只有这几种形态，一百来行比多拉一个解析器划算。
 *
 * 转义顺序是这里唯一的坑：公式源码里 \le、x<1 的尖括号不能被转义，
 * 所以先把公式抠出来换成占位符，转义完再填回去。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** 占位符用私用区字符，正常笔记里不会出现，也不会被 HTML 转义碰到 */
const MARK = '';

function tex(src, display) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'html' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

/** 行内：抠公式 → 转义 → 粗体 → 填回公式 */
function inline(raw) {
  const math = [];
  let s = String(raw).replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (_m, block, span) => {
    math.push(tex(block ?? span, block != null));
    return `${MARK}${math.length - 1}${MARK}`;
  });
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^-])-&gt;/g, '$1→')
    .replace(/=&gt;/g, '⇒');
  return s.replace(new RegExp(`${MARK}(\\d+)${MARK}`, 'g'), (_m, i) => math[Number(i)]);
}

export function renderSticky(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }

    const bullet = /^[-*·•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();

    const head = /^(?:>|#{1,3})\s+(.*)$/.exec(line);
    if (head) { out.push(`<div class="sn-h">${inline(head[1])}</div>`); continue; }

    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

/** 纸片没写字时的占位提示 */
export const SN_PLACEHOLDER = '双击写点什么…';
