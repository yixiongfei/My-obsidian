import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import { index } from './vault.js';
import { IMAGE_EXT } from '../config.js';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Obsidian callout：> [!question]- 标题  →  可折叠的 <details>
 * ------------------------------------------------------------------ */

const CALLOUT_ICON = {
  question: '?', success: '✓', failure: '✕', warning: '!', info: 'i',
  note: '✎', tip: '★', abstract: '≡', example: '»', quote: '”', danger: '⚡', bug: '•', todo: '☐',
};

const CALLOUT_RE = /^\[!(\w+)\]([-+]?)[ \t]*(.*)$/;

function calloutPlugin(md) {
  md.core.ruler.after('block', 'obsidian_callout', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') continue;
      const inline = tokens[i + 2];
      if (tokens[i + 1]?.type !== 'paragraph_open' || inline?.type !== 'inline') continue;

      const nl = inline.content.indexOf('\n');
      const firstLine = nl === -1 ? inline.content : inline.content.slice(0, nl);
      const m = firstLine.match(CALLOUT_RE);
      if (!m) continue;

      const [, rawType, fold, titleText] = m;
      const type = rawType.toLowerCase();
      const open = fold !== '-'; // `-` 默认折叠，`+` 或不写默认展开
      const icon = CALLOUT_ICON[type] || '•';

      // 找到配对的 blockquote_close
      let depth = 0, close = -1;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++;
        else if (tokens[j].type === 'blockquote_close') { depth--; if (depth === 0) { close = j; break; } }
      }
      if (close === -1) continue;

      const title = titleText.trim();
      const head = new state.Token('html_block', '', 0);
      head.content =
        `<details class="callout callout-${md.utils.escapeHtml(type)}"${open ? ' open' : ''}>` +
        `<summary class="callout-title">` +
        `<span class="callout-icon" aria-hidden="true">${icon}</span>` +
        `<span class="callout-title-text">`;
      const mid = new state.Token('html_block', '', 0);
      mid.content = `</span><span class="callout-chevron" aria-hidden="true"></span></summary><div class="callout-body">`;
      const tail = new state.Token('html_block', '', 0);
      tail.content = `</div></details>`;

      // 标题行本身作为 inline 渲染，保留其中的行内公式与加粗
      const titleTok = new state.Token('inline', '', 0);
      titleTok.content = title;
      titleTok.children = [];
      titleTok.level = 0;
      // 不在这里解析：core 的 inline 规则排在本规则之后，会统一解析所有 inline token

      // 正文：去掉首行后剩下的内容
      const rest = nl === -1 ? '' : inline.content.slice(nl + 1);
      const bodyTokens = tokens.slice(i + 4, close);
      const head3 = [];
      if (rest.trim()) {
        inline.content = rest;
        inline.children = [];
        head3.push(tokens[i + 1], inline, tokens[i + 3]);
      }

      tokens.splice(i, close - i + 1, head, titleTok, mid, ...head3, ...bodyTokens, tail);
      i += 2;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Obsidian wiki 链接与嵌入
 * ------------------------------------------------------------------ */

const vaultUrl = (id) => '/vault/' + id.split('/').map(encodeURIComponent).join('/');

const WIKILINK_RE = /(!?)\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/;
const WIKILINK_RE_G = new RegExp(WIKILINK_RE.source, 'g');

function wikilinkPlugin(md) {
  // 在 text 规则之后拆分行内文本中的 [[...]]
  md.core.ruler.push('obsidian_wikilink', (state) => {
    for (const blk of state.tokens) {
      if (blk.type !== 'inline') continue;
      const out = [];
      let changed = false;
      for (const tok of blk.children) {
        if (tok.type !== 'text' || !tok.content.includes('[[')) { out.push(tok); continue; }
        changed = true;
        let last = 0;
        WIKILINK_RE_G.lastIndex = 0;
        let m;
        while ((m = WIKILINK_RE_G.exec(tok.content))) {
          if (m.index > last) {
            const t = new state.Token('text', '', 0);
            t.content = tok.content.slice(last, m.index);
            out.push(t);
          }
          out.push(...renderWikilink(state, m));
          last = m.index + m[0].length;
        }
        if (last < tok.content.length) {
          const t = new state.Token('text', '', 0);
          t.content = tok.content.slice(last);
          out.push(t);
        }
      }
      if (changed) blk.children = out;
    }
  });
}

function renderWikilink(state, m) {
  const [, bang, rawTarget, anchor, alias] = m;
  const target = rawTarget.trim();
  const id = index.resolve(target);
  const label = (alias || anchor || target).trim();
  const tok = new state.Token('html_inline', '', 0);
  const esc = state.md.utils.escapeHtml;

  if (!id) {
    tok.content = `<span class="wikilink is-broken" title="未找到：${esc(target)}">${esc(label)}</span>`;
    return [tok];
  }

  const ext = path.extname(id).toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    if (bang) {
      const block = new state.Token('html_inline', '', 0);
      block.content =
        // 用 span 而不是 figure：嵌入通常独占一段，被 <p> 包住时 figure 会被浏览器拆开
        `<span class="md-figure"><img loading="lazy" src="${vaultUrl(id)}" alt="${esc(label)}"></span>`;
      return [block];
    }
    tok.content = `<a class="wikilink" href="${vaultUrl(id)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;
    return [tok];
  }

  if (ext === '.canvas') {
    tok.content = `<a class="wikilink is-canvas" href="#/schedule" title="路线图画布">${esc(label.replace(/\.canvas$/, ''))}</a>`;
    return [tok];
  }

  const note = index.get(id);
  const text = alias ? label : (note ? note.title : label);
  const hash = anchor ? `?h=${encodeURIComponent(anchor)}` : '';
  tok.content =
    `<a class="wikilink" href="#/note/${encodeURIComponent(id)}${hash}" data-note="${esc(id)}">${esc(text)}</a>`;
  return [tok];
}

/* ------------------------------------------------------------------ *
 * ==高亮==
 * ------------------------------------------------------------------ */
function highlightPlugin(md) {
  md.core.ruler.push('obsidian_highlight', (state) => {
    for (const blk of state.tokens) {
      if (blk.type !== 'inline') continue;
      for (const tok of blk.children) {
        if (tok.type === 'text' && tok.content.includes('==')) {
          const parts = tok.content.split(/==([^=]+)==/g);
          if (parts.length > 1) {
            tok.type = 'html_inline';
            tok.content = parts
              .map((p, i) => (i % 2 ? `<mark>${md.utils.escapeHtml(p)}</mark>` : md.utils.escapeHtml(p)))
              .join('');
          }
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

export const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: false,
})
  .use(katexPlugin.default || katexPlugin, { throwOnError: false, errorColor: '#ff5f6d' })
  .use(calloutPlugin)
  .use(wikilinkPlugin)
  .use(highlightPlugin);

// 外链一律新窗口打开
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  const href = tokens[i].attrGet('href') || '';
  if (/^https?:\/\//.test(href)) {
    tokens[i].attrSet('target', '_blank');
    tokens[i].attrSet('rel', 'noreferrer');
  }
  return defaultLinkOpen(tokens, i, opts, env, self);
};

// 表格外面包一层，窄屏可横向滚动
md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
md.renderer.rules.table_close = () => '</table></div>';

/** 给标题加锚点 id，供大纲跳转 */
export function render(body) {
  const tokens = md.parse(body, {});
  const seen = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = tokens[i + 1]?.content || '';
    const base = slug(text);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    tokens[i].attrSet('id', n === 1 ? base : `${base}-${n}`);
  }
  return md.renderer.render(tokens, md.options, {});
}

export function slug(text) {
  return String(text)
    .trim()
    .replace(/\$[^$]*\$/g, '')
    .replace(/[!?？！。，,.:：、`*_~[\]()#]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'h';
}
