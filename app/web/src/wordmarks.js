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
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'MARK', 'SUP', 'SUB']);

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
export function useWordMarks(rootRef, enabled, source) {
  const [marks, setMarks] = useState([]);
  const [toast, setToast] = useState(null);
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

  const flash = useCallback((text, kind) => {
    setToast({ text, kind, at: Date.now() });
    setTimeout(() => setToast((t) => (t && Date.now() - t.at >= 1400 ? null : t)), 1500);
  }, []);

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

  return { marks, toast, onDoubleClick };
}
