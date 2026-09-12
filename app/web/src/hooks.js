import { useCallback, useEffect, useRef, useState } from 'react';

/** vault 变更版本号：Obsidian 里保存文件 → SSE 推送 → 相关视图自动重取 */
export function useVaultVersion() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type) setVersion((v) => v + 1);
      } catch { /* 忽略心跳等非 JSON 帧 */ }
    };
    return () => es.close();
  }, []);
  return version;
}

/** 带 loading / error / 重取的数据获取；deps 变化时自动重取 */
export function useApi(fetcher, deps = [], { skip = false } = {}) {
  const [state, setState] = useState({ data: null, loading: !skip, error: null });
  const seq = useRef(0);

  const run = useCallback(() => {
    if (skip) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(fetcher())
      .then((data) => { if (id === seq.current) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (id === seq.current) setState({ data: null, loading: false, error: error.message }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, skip]);

  useEffect(run, [run]);
  return { ...state, reload: run };
}

/** 全局快捷键 */
export function useHotkey(combo, handler) {
  useEffect(() => {
    const fn = (e) => {
      const parts = combo.toLowerCase().split('+');
      const key = parts.pop();
      if (parts.includes('mod') && !(e.metaKey || e.ctrlKey)) return;
      if (parts.includes('shift') && !e.shiftKey) return;
      if (e.key.toLowerCase() !== key) return;
      handler(e);
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [combo, handler]);
}

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('kb-theme') || 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('kb-theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), setTheme];
}
