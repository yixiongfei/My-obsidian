/**
 * 箭头的锚点 —— 「指向题目中的具体位置」里的那个「位置」怎么记。
 *
 * 记屏幕坐标是最省事的做法，也是错的：窗口一宽、目录树一收、图片晚加载一帧，
 * 正文就重排了，箭头会指到空白处去。所以锚点必须挂在**内容**上，不是挂在像素上。
 *
 * 两种锚：
 *   text —— 落点在文字上。存「元素路径 + 该元素第几个文本节点 + 第几个字」，
 *           渲染时用 Range 量出那个字的矩形。正文怎么重排，箭头还钉在那个字上。
 *   box  —— 落点在公式、图片、表格这类整体上。存「元素路径 + 框内百分比」。
 *
 * 两种都带一份绝对坐标和一小段原文兜底：笔记被改动到路径对不上时，先按原文找回来，
 * 再找不到才退回绝对坐标——宁可指偏，也不能让箭头凭空消失。
 */

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 元素在 root 下的位置：一串子节点序号，'2.0.1' */
export function pathOf(el, root) {
  if (!el || !root || el === root || !root.contains(el)) return null;
  const parts = [];
  let n = el;
  while (n && n !== root) {
    const p = n.parentElement;
    if (!p) return null;
    parts.unshift(Array.prototype.indexOf.call(p.children, n));
    n = p;
  }
  return parts.join('.');
}

export function elOf(sel, root) {
  if (!root || sel === '' || sel == null) return null;
  let n = root;
  for (const part of String(sel).split('.')) {
    n = n.children?.[Number(part)];
    if (!n) return null;
  }
  return n;
}

/** 路径失效时按原文找回来：取包含这段话的最深元素 */
function findByText(root, txt) {
  const t = norm(txt);
  if (!root || t.length < 2) return null;
  let best = null;
  for (const el of root.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, td, th, div, span')) {
    if (!norm(el.textContent).includes(t)) continue;
    if (!best || best.contains(el)) best = el;
  }
  return best;
}

function caretAt(x, y) {
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

const charRect = (node, off) => {
  const len = node.data.length;
  if (!len) return null;
  const s = Math.min(Math.max(0, off), len - 1);
  const r = document.createRange();
  r.setStart(node, s);
  r.setEnd(node, s + 1);
  const box = r.getBoundingClientRect();
  return box.width || box.height ? box : null;
};

/**
 * 把一次落点（鼠标松开的位置）变成锚点。
 * prose 为空、或落在正文之外，就退化成一个只有绝对坐标的松锚。
 */
export function anchorAt(cx, cy, prose, hostRect) {
  const loose = { kind: 'box', sel: '', node: 0, off: 0, fx: 0.5, fy: 0.5, txt: '', x: cx - hostRect.left, y: cy - hostRect.top };
  if (!prose) return loose;

  const hit = document.elementFromPoint(cx, cy);
  if (!hit || !prose.contains(hit)) return loose;

  // 公式整体当一个锚，不往 KaTeX 那堆 span 里钻——那棵树会随字号重排
  const katexRoot = hit.closest('.katex, .katex-display, .md-figure, table, img');
  if (katexRoot && prose.contains(katexRoot)) return boxAnchor(katexRoot, cx, cy, prose, hostRect, loose);

  const caret = caretAt(cx, cy);
  if (caret?.node?.nodeType === 3 && prose.contains(caret.node.parentElement)) {
    const rect = charRect(caret.node, caret.offset);
    // caretRangeFromPoint 会把「最近的」字给你，哪怕点在半页之外；离得太远就不算落在字上
    if (rect && Math.abs((rect.top + rect.bottom) / 2 - cy) < rect.height + 8) {
      const parent = caret.node.parentElement;
      const sel = pathOf(parent, prose);
      if (sel !== null) {
        return {
          kind: 'text',
          sel,
          node: Array.prototype.indexOf.call(parent.childNodes, caret.node),
          off: Math.min(caret.offset, caret.node.data.length - 1),
          fx: 0.5, fy: 0.5,
          txt: norm(caret.node.data).slice(0, 24),
          x: cx - hostRect.left, y: cy - hostRect.top,
        };
      }
    }
  }

  const block = hit.closest('p, li, blockquote, h1, h2, h3, h4, td, th, pre, .callout') || hit;
  return boxAnchor(block, cx, cy, prose, hostRect, loose);
}

function boxAnchor(el, cx, cy, prose, hostRect, loose) {
  const sel = pathOf(el, prose);
  if (sel === null) return loose;
  const r = el.getBoundingClientRect();
  return {
    kind: 'box',
    sel,
    node: 0, off: 0,
    fx: r.width ? Math.min(1, Math.max(0, (cx - r.left) / r.width)) : 0.5,
    fy: r.height ? Math.min(1, Math.max(0, (cy - r.top) / r.height)) : 0.5,
    txt: norm(el.textContent).slice(0, 24),
    x: cx - hostRect.left, y: cy - hostRect.top,
  };
}

/** 锚点 → 当前布局下的落点（相对 host 左上角） */
export function pointOf(a, prose, hostRect) {
  const fallback = { x: a.x, y: a.y, loose: true };
  if (!prose || !a) return fallback;

  const toHost = (rect) => ({
    x: rect.left + rect.width / 2 - hostRect.left,
    y: rect.top + rect.height / 2 - hostRect.top,
  });

  if (a.kind === 'text') {
    const parent = elOf(a.sel, prose);
    const node = parent?.childNodes?.[a.node];
    if (node?.nodeType === 3) {
      // 段落被改过的话，第 a.node 个文本节点可能已经是别的话了——用存下来的原文对一眼
      const ok = !a.txt || norm(node.data).startsWith(a.txt.slice(0, 6));
      const rect = ok ? charRect(node, a.off) : null;
      if (rect) return toHost(rect);
    }
    const el = parent || findByText(prose, a.txt);
    return el ? boxPoint(el, a, hostRect) : fallback;
  }

  const el = elOf(a.sel, prose) || findByText(prose, a.txt);
  return el ? boxPoint(el, a, hostRect) : fallback;
}

function boxPoint(el, a, hostRect) {
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return { x: a.x, y: a.y, loose: true };
  return {
    x: r.left + (a.fx ?? 0.5) * r.width - hostRect.left,
    y: r.top + (a.fy ?? 0.5) * r.height - hostRect.top,
  };
}
