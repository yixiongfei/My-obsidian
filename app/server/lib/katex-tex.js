import katex from 'katex';
import { parse } from 'node-html-parser';

/**
 * KaTeX 渲染后的 HTML → TeX 源码。
 *
 * 为什么需要它：题源只给了 KaTeX 渲染后的 HTML，没有 TeX。错题本把那段 HTML 原样嵌进
 * Markdown，在本站看着没问题（页面本来就带 KaTeX 样式），但在 Obsidian 里是一堆
 * 没有样式的 span——上下标靠绝对定位摞在一起，整个公式糊成一团。
 *
 * 所以得把 TeX 倒推回来。倒推本身是有风险的：**错题本里一个写错的公式比一个难看的公式糟得多**。
 * 所以这里不赌，每次倒推都验一遍：
 *
 *     原始 HTML  ──倒推──▸  TeX  ──KaTeX 重新渲染──▸  新 HTML
 *                              ↑                        │
 *                              └──── 结构签名逐字比对 ◂──┘
 *
 * 签名带上 class 和 style（只把 `-.5em` / `-0.5em` 这类压缩写法归一），
 * 一致才算数——同一个 KaTeX 版本下，渲染是确定的，签名一致就意味着两个公式一模一样。
 * 对不上就返回 null，调用方退回老办法嵌 HTML。宁可少转一个，不能转错一个。
 */

/* KaTeX 输出的是 Unicode 字形，倒回 TeX 时要换成命令：
   MathJax（Obsidian 用的那个）对裸 Unicode 的支持没有 KaTeX 宽，写成命令两边都稳 */
const SYM = new Map(Object.entries({
  '−': '-', '∗': '*', '⋅': '\\cdot ', '×': '\\times ', '÷': '\\div ', '±': '\\pm ', '∓': '\\mp ',
  '≠': '\\neq ', '≤': '\\le ', '≥': '\\ge ', '≈': '\\approx ', '≡': '\\equiv ', '∼': '\\sim ',
  '→': '\\to ', '←': '\\leftarrow ', '⇒': '\\Rightarrow ', '⇔': '\\Leftrightarrow ', '↦': '\\mapsto ',
  '∞': '\\infty ', '∂': '\\partial ', '∇': '\\nabla ', '′': '\\prime ', '∘': '\\circ ',
  '∫': '\\int ', '∬': '\\iint ', '∭': '\\iiint ', '∮': '\\oint ',
  '∑': '\\sum ', '∏': '\\prod ', '⋃': '\\bigcup ', '⋂': '\\bigcap ',
  '∈': '\\in ', '∉': '\\notin ', '⊂': '\\subset ', '⊆': '\\subseteq ', '⊃': '\\supset ',
  '∪': '\\cup ', '∩': '\\cap ', '∅': '\\varnothing ', '∀': '\\forall ', '∃': '\\exists ',
  '⋯': '\\cdots ', '⋮': '\\vdots ', '⋱': '\\ddots ', '…': '\\ldots ', '⟶': '\\longrightarrow ',
  '∣': '|', '∥': '\\parallel ', '⊥': '\\perp ', '∠': '\\angle ', '△': '\\triangle ', '□': '\\square ',
  '⟨': '\\langle ', '⟩': '\\rangle ', '⌊': '\\lfloor ', '⌋': '\\rfloor ', '⌈': '\\lceil ', '⌉': '\\rceil ',
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\varepsilon ', 'ϵ': '\\epsilon ',
  'ζ': '\\zeta ', 'η': '\\eta ', 'θ': '\\theta ', 'ϑ': '\\vartheta ', 'ι': '\\iota ', 'κ': '\\kappa ',
  'λ': '\\lambda ', 'μ': '\\mu ', 'ν': '\\nu ', 'ξ': '\\xi ', 'π': '\\pi ', 'ϖ': '\\varpi ',
  'ρ': '\\rho ', 'ϱ': '\\varrho ', 'σ': '\\sigma ', 'ς': '\\varsigma ', 'τ': '\\tau ',
  'υ': '\\upsilon ', 'φ': '\\varphi ', 'ϕ': '\\phi ', 'χ': '\\chi ', 'ψ': '\\psi ', 'ω': '\\omega ',
  'Γ': '\\Gamma ', 'Δ': '\\Delta ', 'Θ': '\\Theta ', 'Λ': '\\Lambda ', 'Ξ': '\\Xi ', 'Π': '\\Pi ',
  'Σ': '\\Sigma ', 'Υ': '\\Upsilon ', 'Φ': '\\Phi ', 'Ψ': '\\Psi ', 'Ω': '\\Omega ',
  '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}',
}));

/** KaTeX 把这些函数名渲染成 .mop 里的普通文本，倒回去要还原成命令 */
const OPS = new Set(['lim', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'ln', 'log', 'lg', 'exp', 'max', 'min', 'sup', 'inf', 'det', 'dim',
  'deg', 'gcd', 'ker', 'arg', 'Pr', 'limsup', 'liminf', 'mod']);

/** 字体类 → 命令。丢了它 \mathbb{R} 会退化成普通的 R，校验也会（正确地）拦下来 */
const FONT = new Map(Object.entries({
  mathbb: 'mathbb', mathbf: 'mathbf', mathrm: 'mathrm', mathcal: 'mathcal', mathscr: 'mathscr',
  mathfrak: 'mathfrak', mathsf: 'mathsf', mathtt: 'mathtt', mathit: 'mathit', boldsymbol: 'boldsymbol',
  mathnormal: '', textbf: 'textbf', textit: 'textit', textrm: '',
}));

/** 变音符号：KaTeX 把它画成 .accent + 一个符号字形 */
const ACCENT = new Map(Object.entries({
  '^': 'hat', 'ˆ': 'hat', '‾': 'bar', 'ˉ': 'bar', '¯': 'bar', '~': 'tilde', '˜': 'tilde',
  '˙': 'dot', '¨': 'ddot', '˘': 'breve', 'ˇ': 'check', '´': 'acute', '`': 'grave',
  '→': 'vec', '⃗': 'vec',
}));

const cls = (n) => (n.getAttribute?.('class') || '').split(/\s+/).filter(Boolean);
const has = (n, c) => cls(n).includes(c);
const topOf = (n) => {
  const m = /top:\s*(-?[\d.]+)em/.exec(n.getAttribute?.('style') || '');
  return m ? parseFloat(m[1]) : null;
};
/** 布局脚手架，不带任何数学含义 */
const SKIP = ['strut', 'pstrut', 'vlist-s', 'nulldelimiter', 'mspace', 'frac-line', 'hide-tail', 'svg-align'];

const mapText = (t) => [...t.replace(/​/g, '')].map((c) => SYM.get(c) ?? c).join('');

/** 一段文本要不要包进 \text{}：中文、多字母的正体词都得包 */
const needsText = (t) => /[一-鿿]/.test(t) || /^[A-Za-z]{2,}$/.test(t);

/**
 * 加不加花括号，是原作者的书写习惯，不是数学差别——但 KaTeX 渲染出来**不一样**：
 * `e^{x}` 比 `e^x` 多一层 <span class="mord"> 包裹。光靠猜会漏掉一半公式，
 * 所以两种写法都试一遍，谁能通过校验就用谁（见 reclaimTex）。
 */
let braceScripts = true;

const atom = (t) => /^\\?[A-Za-z0-9]$/.test(t) || /^\\[A-Za-z]+$/.test(t);
/** 上下标的参数：跟着当前模式走 */
const arg = (s) => {
  const t = s.trim();
  return !braceScripts && atom(t) ? t : `{${t}}`;
};
/** 底数：单个记号从不加括号，加了就会多出一层包裹 */
const base = (s) => {
  const t = s.trim();
  return atom(t) ? t : t;
};

/** 一组兄弟节点 → TeX。上下标要接到前一个片段上，所以按片段数组来攒 */
function run(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const t = mapText(node.rawText);
      if (t.trim()) out.push(needsText(t.trim()) ? `\\text{${t.trim()}}` : t.trim());
      continue;
    }
    if (node.nodeType !== 1) continue;
    const c = cls(node);
    if (c.some((x) => SKIP.includes(x))) continue;

    if (c.includes('msupsub')) {
      const scripts = supsub(node);
      if (scripts === null) return null;
      const b = out.length ? out.pop() : '';
      out.push(base(b) + scripts);
      continue;
    }
    if (c.includes('mfrac')) {
      const f = frac(node);
      if (f === null) return null;
      out.push(f);
      continue;
    }
    if (c.includes('sqrt')) {
      const s = sqrt(node);
      if (s === null) return null;
      out.push(s);
      continue;
    }
    if (c.includes('mtable')) {
      const t = table(node);
      if (t === null) return null;
      out.push(t);
      continue;
    }
    if (c.includes('op-limits')) {
      const o = opLimits(node);
      if (o === null) return null;
      out.push(o);
      continue;
    }
    if (c.includes('delimsizing') || c.includes('delimcenter')) {
      const side = c.includes('mopen') ? 'open' : c.includes('mclose') ? 'close' : '';
      const d = delim(node, side);
      if (d === null) return null;
      if (d) out.push(d);
      continue;
    }
    if (c.includes('text') && !c.includes('mtight')) {
      const t = node.text.replace(/​/g, '').trim();
      if (t) { out.push(`\\text{${t}}`); continue; }
      continue;
    }
    if (c.includes('accent')) {
      const a = accent(node);
      if (a === null) return null;
      out.push(a);
      continue;
    }
    if (c.includes('accent')) {
      const a = accent(node);
      if (a === null) return null;
      out.push(a);
      continue;
    }
    if (c.includes('overline')) { const b = run(node.childNodes); if (b === null) return null; out.push(`\\overline{${b.trim()}}`); continue; }
    if (c.includes('underline')) { const b = run(node.childNodes); if (b === null) return null; out.push(`\\underline{${b.trim()}}`); continue; }

    const kids = node.childNodes.filter((k) => k.nodeType === 1);
    if (c.includes('mop') && !kids.length) {
      const t = node.text.replace(/​/g, '').trim();
      if (OPS.has(t)) { out.push(`\\${t}`); continue; }
      out.push(mapText(t));
      continue;
    }
    if (!kids.length) {
      const t = node.text.replace(/​/g, '').trim();
      if (!t) continue;
      const font = c.map((x) => FONT.get(x)).find((x) => x);
      if (font) { out.push(`\\${font}{${t}}`); continue; }
      // mathnormal 是数学斜体，哪怕连着几个字母也是几个变量，不能包成 \text
      if (c.includes('mathnormal')) { out.push(mapText(t)); continue; }
      out.push(needsText(t) ? `\\text{${t}}` : mapText(t));
      continue;
    }
    const inner = run(node.childNodes);
    if (inner === null) return null;
    if (inner.trim()) out.push(inner.trim());
  }
  /* 片段之间不补空格：TeX 里空格本就无意义，但写进笔记是要给人看、给人改的，
     `f(x)` 比 `f ( x )` 顺眼得多。命令名后面的空格由 SYM / OPS 自己带着 */
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** .msupsub → ^{…}_{…}。上下由 vlist 里各行的 top 决定：越负越高 */
function supsub(node) {
  const rows = [];
  for (const vr of node.querySelectorAll('.vlist-r')) {
    const vl = vr.childNodes.find((k) => k.nodeType === 1 && has(k, 'vlist'));
    if (!vl) continue;
    for (const row of vl.childNodes.filter((k) => k.nodeType === 1)) {
      const top = topOf(row);
      if (top === null) continue;
      const tex = run(row.childNodes);
      if (tex === null) return null;
      if (tex.trim()) rows.push({ top, tex: tex.trim() });
    }
  }
  if (!rows.length) return '';
  rows.sort((a, b) => a.top - b.top);
  if (rows.length === 1) {
    // 只有上标时不会在基线下留深度，所以没有 vlist-t2；有 t2 就是下标
    const isSub = has(node.querySelector('.vlist-t') || node, 'vlist-t2');
    return `${isSub ? '_' : '^'}${arg(rows[0].tex)}`;
  }
  if (rows.length === 2) return `^${arg(rows[0].tex)}_${arg(rows[1].tex)}`;
  return null;
}

/* ------------------------------------------------------------------ *
 * 撑高的括号、矩阵、带上下限的大算符
 * ------------------------------------------------------------------ */

/**
 * 撑高的括号在 KaTeX 里是拿 SVG 路径拼出来的，一个字符都没有——没法从文本认出它是
 * 圆括号还是方括号。所以反过来：**用本地这版 KaTeX 把各种括号都渲一遍，记下路径指纹**，
 * 再拿指纹反查。指纹出自同一个渲染器，天然对得上，也不必硬编码任何路径常量。
 */
let DELIM = null;
function delimTable() {
  if (DELIM) return DELIM;
  DELIM = new Map();
  const pairs = [['(', ')'], ['[', ']'], ['\\{', '\\}'], ['|', '|'], ['\\|', '\\|'],
    ['\\lfloor', '\\rfloor'], ['\\lceil', '\\rceil'], ['\\langle', '\\rangle']];
  for (const [l, r] of pairs) {
    for (let rows = 2; rows <= 7; rows++) {
      const body = Array.from({ length: rows }, () => 'x').join('\\\\');
      let html;
      try { html = katex.renderToString(`\\left${l}\\begin{matrix}${body}\\end{matrix}\\right${r}`, { output: 'html', throwOnError: true }); }
      catch { continue; }
      const root = parse(html);
      for (const [selCls, side, tex] of [['mopen', 'open', `\\left${l}`], ['mclose', 'close', `\\right${r}`]]) {
        for (const el of root.querySelectorAll(`.${selCls}`)) {
          const k = delimKey(el);
          if (k) DELIM.set(`${side}|${k}`, tex);
        }
      }
    }
  }
  return DELIM;
}

/** 括号指纹：优先用 SVG 路径开头，没有路径就用可见文字 */
function delimKey(node) {
  const paths = node.querySelectorAll('path').map((p) => (p.getAttribute('d') || '').slice(0, 24));
  if (paths.length) return paths.join('|');
  const inner = node.querySelectorAll('.delimsizinginner').map((x) => x.text.replace(/​/g, '').trim()).join('');
  return inner || node.text.replace(/​/g, '').trim();
}

function delim(node, side) {
  const key = delimKey(node);
  if (!key) return '';
  const hit = side ? delimTable().get(`${side}|${key}`) : null;
  if (hit) return hit;
  // 不是撑高的括号，就是个普通字形
  const ch = mapText(key).trim();
  return ch || null;
}

/**
 * .mtable → \begin{…}…\end{…}
 * 列是竖着存的（每个 .col-align-* 是一整列），所以先按列取、再转置成行。
 * 具体用哪个环境（matrix / array / cases）猜不出来，交给 reclaimTex 逐个试。
 */
let tableEnv = 'matrix';
function table(node) {
  const cols = node.childNodes.filter((k) => k.nodeType === 1 && cls(k).some((x) => x.startsWith('col-align-')));
  if (!cols.length) return null;
  const aligns = cols.map((k) => (cls(k).find((x) => x.startsWith('col-align-')) || 'col-align-c').slice(-1));
  const grid = [];
  for (const col of cols) {
    const vl = col.querySelector('.vlist');
    if (!vl) return null;
    const cells = vl.childNodes
      .filter((r) => r.nodeType === 1 && topOf(r) !== null && r.childNodes.some((x) => x.nodeType === 1 && !has(x, 'pstrut')))
      .map((r) => ({ top: topOf(r), node: r }))
      .sort((a, b) => a.top - b.top);
    const texts = [];
    for (const cell of cells) {
      const t = run(cell.node.childNodes);
      if (t === null) return null;
      texts.push(t.trim());
    }
    grid.push(texts);
  }
  const rows = grid[0].length;
  if (!rows || grid.some((c) => c.length !== rows)) return null;
  const lines = [];
  for (let i = 0; i < rows; i++) lines.push(grid.map((c) => c[i]).join(' & '));
  const body = lines.join(' \\\\ ');
  if (tableEnv === 'array') return `\\begin{array}{${aligns.join('')}}${body}\\end{array}`;
  return `\\begin{${tableEnv}}${body}\\end{${tableEnv}}`;
}

/** .op-limits：上下限摞在算符上下（\sum \int 在行间公式里的样子）。行按 top 排，最上是上限 */
function opLimits(node) {
  const vl = node.querySelector('.vlist');
  if (!vl) return null;
  const rows = vl.childNodes.filter((k) => k.nodeType === 1 && topOf(k) !== null)
    .map((k) => ({ top: topOf(k), node: k }))
    .sort((a, b) => a.top - b.top);
  const parts = [];
  for (const r of rows) {
    const t = run(r.node.childNodes);
    if (t === null) return null;
    parts.push(t.trim());
  }
  const body = parts.filter(Boolean);
  if (body.length === 2) return `${body[1]}^{${body[0]}}`;          // 只有上限
  if (body.length === 3) return `${body[1]}_{${body[2]}}^{${body[0]}}`;
  if (body.length === 1) return body[0];
  return null;
}

/** .accent → \hat{} / \bar{} / \vec{}：符号在一层，被标的东西在 .accent-body 里 */
function accent(node) {
  // .accent-body 里是符号本身（帽子、横杠），被标的字母在同一个 vlist 的另一行
  const body = node.querySelector('.accent-body');
  const vl = node.querySelector('.vlist');
  if (!body || !vl) return null;
  const cmd = ACCENT.get(body.text.replace(/\u200B/g, '').trim());
  const baseRow = vl.childNodes.find((r) => r.nodeType === 1 && topOf(r) !== null && r !== body && !r.contains(body));
  const inner = baseRow ? run(baseRow.childNodes) : null;
  if (!cmd || inner === null || !inner.trim()) return null;
  return `\\${cmd}{${inner.trim()}}`;
}

/** .mfrac → \frac{}{}：横线以上是分子，以下是分母 */
function frac(node) {
  const vl = node.querySelector('.vlist');
  if (!vl) return null;
  const rows = vl.childNodes.filter((k) => k.nodeType === 1 && topOf(k) !== null)
    .map((k) => ({ top: topOf(k), node: k }))
    .sort((a, b) => a.top - b.top);
  const lineAt = rows.findIndex((r) => r.node.querySelector('.frac-line') || has(r.node, 'frac-line'));
  if (lineAt <= 0 || lineAt >= rows.length) return null;
  const num = run(rows.slice(0, lineAt).flatMap((r) => r.node.childNodes));
  const den = run(rows.slice(lineAt + 1).flatMap((r) => r.node.childNodes));
  if (num === null || den === null) return null;
  return `\\frac{${num.trim()}}{${den.trim()}}`;
}

/** .sqrt → \sqrt{}（暂不还原 n 次根，交给校验拦下来） */
function sqrt(node) {
  const vl = node.querySelector('.vlist');
  if (!vl) return null;
  const body = vl.childNodes.filter((k) => k.nodeType === 1 && topOf(k) !== null && !k.querySelector('svg'))
    .flatMap((k) => k.childNodes);
  const inner = run(body);
  if (inner === null || !inner.trim()) return null;
  if (node.querySelector('.root')) return null;   // 有根指数，这儿不处理
  return `\\sqrt{${inner.trim()}}`;
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/**
 * 结构签名：元素树形状 + class + 文字。**几何一概不看。**
 *
 * 一开始把 style 也算进去，结果只认出两成——题源那版 KaTeX 的小数位数和现在不一样
 * （`margin-right:.03148em` vs `0.0315em`），高度、边距处处差一点点，把大量正确结果误杀了。
 * 而几何本来就是结构的函数：同一个渲染器、同一棵结构树，尺寸必然一样；不同版本之间
 * 尺寸会漂，结构不会。所以判同只看结构和文字。
 *
 * 区分力够不够：上标和下标的 class 本就不同（vlist-t / vlist-t2），分子分母靠元素顺序，
 * 括号大小靠 delimsizing 类——都不依赖数字。被放过的只有间距粗细（\\, 和 \;）这类
 * 纯排版差别，不影响这个公式念出来是什么。
 */
/* 题源的 HTML 里 > < & 是裸字符，KaTeX 现在输出的是 &gt; &lt; &amp;——
   同一个字形两种写法，不解码的话 `k>1` 这类比较式全都会被误判成不一致 */
const unent = (t) => t.replace(/&(gt|lt|amp|quot|#39|nbsp);/g,
  (_m, e) => ({ gt: '>', lt: '<', amp: '&', quot: '"', '#39': "'", nbsp: ' ' }[e]));

/** 纯粹的排版脚手架和间距，不承载数学含义，签名里一并略过 */
const NOISE = ['strut', 'pstrut', 'vlist-s', 'mspace', 'nulldelimiter'];
/** 只有一个孩子、自己不带任何类的包裹层：`{x}` 和 `x` 的差别只在这儿，是书写习惯不是数学 */
const transparent = (n) => {
  const c = cls(n);
  return (c.length === 0 || c.join(' ') === 'mord' || c.join(' ') === 'mord mtight')
    && n.childNodes.filter((k) => k.nodeType === 1).length === 1
    && !n.childNodes.some((k) => k.nodeType === 3 && k.rawText.trim());
};

function sig(node, out = []) {
  if (node.nodeType === 3) {
    const t = unent(node.rawText).replace(/​/g, '').trim();
    if (t) out.push(`t:${t}`);
    return out;
  }
  if (node.nodeType !== 1) return out;
  if (cls(node).some((x) => NOISE.includes(x))) return out;
  if (transparent(node)) { node.childNodes.forEach((k) => sig(k, out)); return out; }
  out.push(`<${node.rawTagName}.${cls(node).sort().join('.')}`);
  node.childNodes.forEach((k) => sig(k, out));
  out.push('>');
  return out;
}
const sigOf = (html) => {
  const root = parse(html);
  const el = root.querySelector('.katex') || root.firstChild;
  return el ? sig(el).join(' ') : '';
};

/**
 * KaTeX 的 HTML → 经过校验的 TeX。对不上就返回 null。
 * @param {string} html 一整个 <span class="katex">…</span>
 * @param {boolean} display 调用方认为它是不是块级公式（只作为起点，两种都会试）
 * @returns {{tex: string, display: boolean} | null}
 */
export function reclaimTex(html, display = false) {
  let want;
  try { want = sigOf(html); } catch { return null; }
  if (!want) return null;

  const root = (() => { try { return parse(html); } catch { return null; } })();
  const el = root && (root.querySelector('.katex-html') || root.querySelector('.katex') || root.firstChild);
  if (!el) return null;

  /* 有几处是原作者的书写习惯，渲染结果不同但数学一样：上下标加不加花括号、
     矩阵用哪个环境。猜不出来，就都试一遍，谁能复现原始渲染就用谁 */
  const envs = html.includes('mtable') ? ['matrix', 'array', 'cases', 'pmatrix', 'vmatrix', 'bmatrix'] : ['matrix'];
  const combos = [];
  for (const env of envs) for (const brace of [true, false]) combos.push({ env, brace });

  for (const { env, brace } of combos) {
    braceScripts = brace;
    tableEnv = env;
    let tex;
    try { tex = run(el.childNodes); } catch { continue; }
    if (!tex || !tex.trim()) continue;
    tex = tex.replace(/\s+/g, ' ').trim();
    /* 行内还是行间也一起试：\sum 的上下限在两种模式下摆法不同，
       而题源里偶尔会在行内写 \displaystyle */
    for (const mode of [display, !display]) {
      let again;
      try { again = katex.renderToString(tex, { output: 'html', displayMode: mode, throwOnError: true }); }
      catch { continue; }
      try { if (sigOf(again) === want) return { tex, display: mode }; } catch { /* 下一个 */ }
    }
  }
  return null;
}

/** 只给调试脚本用：拿到未经校验的倒推结果 */
export function __debugTex(html) {
  try {
    const root = parse(html);
    const el = root.querySelector('.katex-html') || root.querySelector('.katex') || root.firstChild;
    if (!el) return null;
    braceScripts = true; tableEnv = 'matrix';
    const t = run(el.childNodes);
    return t && t.trim() ? t.replace(/\s+/g, ' ').trim() : null;
  } catch { return null; }
}
