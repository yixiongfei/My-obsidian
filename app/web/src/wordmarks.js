import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * 真题阅读页的生词标注。
 *
 * 双击一个英文单词 → 记到词汇库（考研词表内的标在原词条上，画红线；词表外建自定义词，画蓝线）。
 * 画线的办法：题面是 innerHTML 灌进去的，React 管不到里面的文本节点，
 * 所以这里直接在 DOM 上把命中的词包成 <mark class="vmark">。
 * 交卷后解析、切换单元都会往文档里塞新节点，用 MutationObserver 盯着，新来的一并画。
 */

const WORD_RE = /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]/g;
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SUP', 'SUB']);

/** 与服务端 lemmaCandidates 同一套规则，前端用来把 criticized 对到 criticize 的标注上 */
export function lemmaCandidates(raw) {
  const w = String(raw || '').toLowerCase().replace(/’/g, "'");
  const out = [w];
  const add = (x) => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  if (/ies$/.test(w)) add(`${w.slice(0, -3)}y`);
  if (/ied$/.test(w)) add(`${w.slice(0, -3)}y`);
  if (/(sses|shes|ches|xes|zes)$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ing$/.test(w)) {
    const stem = w.slice(0, -3);
    add(stem); add(`${stem}e`);
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (/ed$/.test(w)) {
    const stem = w.slice(0, -2);
    add(stem); add(`${stem}e`); add(w.slice(0, -1));
    if (/([^aeiou])\1$/.test(stem)) add(stem.slice(0, -1));
  }
  if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return out;
}

const keyFor = (word, index) => lemmaCandidates(word).find((k) => index.has(k)) || null;

/** 把 root 下所有文本节点里命中的词包成 mark；index: term_key → { inList } */
function paint(root, index) {
  if (!index.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP.has(p.tagName) || p.closest('.vmark, .katex, .blank, button.opt .opt-k')) return NodeFilter.FILTER_REJECT;
      return /[A-Za-z]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);

  for (const node of targets) {
    const text = node.nodeValue;
    let last = 0;
    let frag = null;
    for (const m of text.matchAll(WORD_RE)) {
      const key = keyFor(m[0], index);
      if (!key) continue;
      frag = frag || document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = `vmark ${index.get(key).inList ? 'ky' : 'own'}`;
      mark.dataset.key = key;
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (!frag) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

/** 拆掉 root 下的标记（全部，或只拆某个词的），文本节点合并回去 */
function unpaint(root, key) {
  const sel = key ? `.vmark[data-key="${key}"]` : '.vmark';
  for (const m of root.querySelectorAll(sel)) {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
}

/** 双击选中的那个词（去掉标点），不是单个英文词就返回空 */
export function selectedWord() {
  const raw = String(window.getSelection?.()?.toString() || '').trim();
  const m = /^[A-Za-z][A-Za-z'’-]*$/.exec(raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''));
  return m ? m[0] : '';
}

/**
 * @param rootRef 卷面容器
 * @param enabled 只有英语卷开
 * @param source  记到标注来源里（卷子 id）
 */
export function useWordMarks(rootRef, enabled, source, notify) {
  const [marks, setMarks] = useState([]);
  const indexRef = useRef(new Map());
  const observing = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    api.vocabMarks().then(setMarks).catch(() => {});
  }, [enabled]);

  // 词表变了：全部重画
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) return undefined;
    indexRef.current = new Map(marks.map((m) => [m.termKey, m]));
    unpaint(root);
    paint(root, indexRef.current);

    const obs = new MutationObserver((records) => {
      if (observing.current) return;
      observing.current = true;
      try {
        for (const r of records) for (const n of r.addedNodes) {
          if (n.nodeType === 1 && !n.classList?.contains('vmark')) paint(n, indexRef.current);
        }
      } finally { observing.current = false; }
    });
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [marks, enabled, rootRef]);

  const flash = useCallback((text, kind) => notify?.(text, kind), [notify]);

  const onDoubleClick = useCallback(async (e) => {
    if (!enabled) return;
    if (e.target.closest('textarea, input, .paper-rail, .unit-foot')) return;
    const word = selectedWord();
    if (!word) return;
    const key = keyFor(word, indexRef.current);
    try {
      if (key) {
        await api.markWord(key, { on: false });
        setMarks((ms) => ms.filter((m) => m.termKey !== key));
        flash(`已取消标注 ${key}`, 'off');
      } else {
        const out = await api.markWord(word, { source });
        setMarks((ms) => [...ms.filter((m) => m.termKey !== out.word.termKey), out.word]);
        flash(out.word.inList ? `${out.word.term} · 考研词表` : `${out.word.term} · 词表外，已加为自定义词`, out.word.inList ? 'ky' : 'own');
      }
      window.getSelection?.()?.removeAllRanges();
    } catch (err) {
      flash(err.message, 'err');
    }
  }, [enabled, source, flash]);

  return { marks, onDoubleClick };
}

/* ══════════════════════════════════════════════════════════════
 * 荧光笔：选中一句 → 右键标记。存的是纯文本，回来时按文本在容器里重新找位置。
 * ══════════════════════════════════════════════════════════════ */

const squash = (t) => String(t || '').replace(/\s+/g, ' ');

/** 容器内所有文本节点，附带它们在拼接文本里的起点 */
function textIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      return p && !SKIP.has(p.tagName) && !p.closest('textarea, input, .paper-rail') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { nodes, text };
}

/** 在容器里按文本找一段（空白差异容忍），返回 Range；找不到返回 null */
export function findTextRange(root, wanted) {
  const target = squash(wanted).trim();
  if (!target) return null;
  const { nodes, text } = textIndex(root);
  // 把多余空白压掉的同时记住每个压缩后字符对应的原始下标
  const map = [];
  let compact = '';
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (prevSpace) continue; prevSpace = true; compact += ' '; map.push(i); continue; }
    prevSpace = false; compact += ch; map.push(i);
  }
  const at = compact.indexOf(target);
  if (at < 0) return null;
  const s = map[at]; const e = map[at + target.length - 1] + 1;
  const locate = (pos, end) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      if (pos >= start && (pos < start + node.nodeValue.length || (end && pos === start + node.nodeValue.length))) return [node, pos - start];
    }
    return null;
  };
  const a = locate(s, false); const b = locate(e, true);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]);
  return range;
}

/** 把一个 Range 覆盖到的文本逐节点包进 <mark>，跨标签也没关系 */
export function wrapRange(range, className, dataset = {}) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  const marks = [];
  for (const n of nodes) {
    let node = n;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.nodeValue.length;
    if (to <= from) continue;
    if (to < node.nodeValue.length) node.splitText(to);
    if (from > 0) node = node.splitText(from);
    const mark = document.createElement('mark');
    mark.className = className;
    for (const [k, v] of Object.entries(dataset)) mark.dataset[k] = v;
    node.parentNode.replaceChild(mark, node);
    mark.appendChild(node);
    marks.push(mark);
  }
  return marks;
}

/** 拆掉某个 id 的荧光笔标记 */
export function unwrapHighlight(root, id) {
  for (const m of root.querySelectorAll(`mark.hl[data-id="${id}"]`)) {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

/** 当前选区落在哪个单元 / 哪道题里 */
export function selectionTarget() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const el = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const unit = el?.closest('.unit-anchor');
  if (!unit) return null;
  const q = el.closest('[id^="q-"]')?.id.match(/-(\d+)$/)?.[1];
  const text = squash(sel.toString()).trim();
  if (text.length < 2) return null;
  return { range: range.cloneRange(), sectionId: unit.id.replace(/^unit-/, ''), q: q ? Number(q) : null, text };
}

/**
 * 荧光笔的状态与画线。marks 来自服务端，按 sectionId 找到单元容器再按文本定位。
 * 单元重挂载（重做）后 DOM 是新的，所以每次 sections 变化都补画一遍；已画过的（有同 id 的 mark）跳过。
 */
export function useHighlights(rootRef, examId, enabled, notify) {
  const [marks, setMarks] = useState([]);
  const [menu, setMenu] = useState(null); // { x, y, target } | { x, y, existing }

  useEffect(() => {
    if (!enabled) { setMarks([]); return; }
    api.examMarks(examId).then(setMarks).catch(() => {});
  }, [examId, enabled]);

  // 离开卷面时把攒着的句子写进 Markdown（服务端合并写，不等它）
  useEffect(() => () => { if (enabled) api.syncExamMarks(); }, [examId, enabled]);

  const paintAll = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const m of marks) {
      if (root.querySelector(`mark.hl[data-id="${m.id}"]`)) continue;
      const unit = root.querySelector(`#unit-${CSS.escape(m.sectionId)}`);
      if (!unit) continue;
      const range = findTextRange(unit, m.text);
      if (range) wrapRange(range, 'hl', { id: String(m.id) });
    }
  }, [marks, rootRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    const t = setTimeout(paintAll, 60);
    return () => clearTimeout(t);
  });

  const onContextMenu = useCallback((e) => {
    if (!enabled) return;
    const hit = e.target.closest?.('mark.hl');
    if (hit) { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, existing: Number(hit.dataset.id) }); return; }
    const target = selectionTarget();
    if (!target) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, [enabled]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const highlight = useCallback(async () => {
    const t = menu?.target;
    setMenu(null);
    if (!t) return;
    try {
      const saved = await api.addExamMark(examId, { section: t.sectionId, text: t.text, q: t.q });
      // 先按当时的选区画，不等重新定位；下次进来再按文本找
      try { wrapRange(t.range, 'hl', { id: String(saved.id) }); } catch { /* 选区已失效，靠 paintAll */ }
      window.getSelection?.()?.removeAllRanges();
      setMarks((ms) => (ms.some((m) => m.id === saved.id) ? ms : [...ms, saved]));
      notify?.('已标记，稍后合并写入 英语/语法/真题例句.md', 'hl');
    } catch (err) {
      notify?.(err.message, 'err');
    }
  }, [menu, examId, notify]);

  const unhighlight = useCallback(async () => {
    const id = menu?.existing;
    setMenu(null);
    if (!id) return;
    try {
      await api.removeExamMark(id);
      if (rootRef.current) unwrapHighlight(rootRef.current, id);
      setMarks((ms) => ms.filter((m) => m.id !== id));
      notify?.('已取消标记', 'off');
    } catch (err) {
      notify?.(err.message, 'err');
    }
  }, [menu, rootRef, notify]);

  const copySelection = useCallback(() => {
    const t = menu?.target;
    setMenu(null);
    if (t) navigator.clipboard?.writeText(t.text).catch(() => {});
  }, [menu]);

  return { marks, menu, onContextMenu, closeMenu, highlight, unhighlight, copySelection };
}
