import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { assistant } from '../assistantStore.js';
import { Composer, Menu, Messages, useChatScroll, when } from '../views/Assistant.jsx';

/**
 * 做题页右侧的学习助手：和「助手」页是同一段对话（assistantStore），边做题边问。
 *
 * context 是正在看的那道题（只用来显示）；发消息时再调 getContext() 取完整的一份（含没交的草稿），
 * 题面、作答、手写图由服务端拼进这条消息。题号签可以点掉，这一条就不附题。
 * 左边缘拖动改宽度（双击恢复默认），宽度和收起状态记在本机。
 */

const W_KEY = 'kb-dock-w';
const OPEN_KEY = 'kb-dock-open';
const DEF_W = 420;
const MIN_W = 320;
const maxW = () => Math.max(MIN_W, Math.min(820, Math.round(window.innerWidth * 0.55)));
const clampW = (w) => Math.max(MIN_W, Math.min(maxW(), Math.round(w)));

const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 无痕 */ } };

const Ico = ({ d, size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const I = {
  plus: <path d="M12 5v14M5 12h14" />,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  expand: <><path d="M14 4h6v6" /><path d="M20 4l-7 7" /><path d="M10 20H4v-6" /><path d="M4 20l7-7" /></>,
  close: <path d="M9 6l6 6-6 6" />,
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
};

export default function AssistantDock({ context, getContext, suggestions = [], openSignal = 0, focusSignal = 0 }) {
  const navigate = useNavigate();
  const s = useSyncExternalStore(assistant.subscribe, assistant.get);
  const { data: status } = useApi(() => api.assistantStatus(), []);
  const { logRef, onScroll } = useChatScroll(s);
  const [open, setOpen] = useState(() => load(OPEN_KEY, true));
  const [w, setW] = useState(() => clampW(load(W_KEY, DEF_W)));
  const [attach, setAttach] = useState(true);
  const [history, setHistory] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wRef = useRef(w);
  wRef.current = w;

  useEffect(() => { assistant.init(); }, []);
  useEffect(() => { save(OPEN_KEY, open); }, [open]);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  // 换题时把「附上这道题」重新打开——上一题点掉了，不代表这一题也不要
  useEffect(() => { setAttach(true); }, [context?.key]);
  // 窗口变窄时别让侧栏把卷面挤没了
  useEffect(() => {
    const fit = () => setW((x) => clampW(x));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const startDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const x0 = e.clientX;
    const w0 = wRef.current;
    grip.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev) => setW(clampW(w0 + (x0 - ev.clientX)));
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      setDragging(false);
      save(W_KEY, wRef.current);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };
  const nudge = (e) => {
    const step = e.key === 'ArrowLeft' ? 32 : e.key === 'ArrowRight' ? -32 : 0;
    if (!step) return;
    e.preventDefault();
    const next = clampW(wRef.current + step);
    setW(next);
    save(W_KEY, next);
  };

  const withCtx = attach && context;
  const send = (text, atts = []) => assistant.send(text, atts, withCtx ? getContext() : null);
  const openNote = (file, route) => navigate(route || `/note/${encodeURIComponent(file)}`);

  if (!open) {
    return (
      <button className="dock-tab" onClick={() => setOpen(true)} title="打开学习助手">
        <span className="dock-tab-mark">✦</span>
        <span className="dock-tab-t">学习助手</span>
        {s.running && <i className="dock-tab-live" />}
      </button>
    );
  }

  const chip = context && (withCtx ? (
    <div className="dock-ctx">
      <span className="dock-ctx-pill" title="发消息时附上这道题：题面、你的作答和手写图">
        <Ico d={I.doc} size={13} />
        <span className="dock-ctx-t">{context.label}</span>
        <button aria-label="这条不附题目" title="这条不附题目" onClick={() => setAttach(false)}>×</button>
      </span>
    </div>
  ) : (
    <div className="dock-ctx">
      <button className="dock-ctx-pill off" onClick={() => setAttach(true)} title="把这道题附上">
        <span className="dock-ctx-plus">＋</span>附上 {context.label}
      </button>
    </div>
  ));

  return (
    <aside className={`dock${dragging ? ' dragging' : ''}`} style={{ width: w }} aria-label="学习助手">
      <div className="dock-grip" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" tabIndex={0}
           title="拖动调整宽度，双击恢复默认"
           onPointerDown={startDrag} onKeyDown={nudge}
           onDoubleClick={() => { setW(clampW(DEF_W)); save(W_KEY, clampW(DEF_W)); }} />

      <header className="dock-head">
        <span className="dock-mark">✦</span>
        <div className="dock-title">
          <span className="dock-lbl">ASSISTANT</span>
          <b title={s.title || '学习助手'}>{s.title || '学习助手'}</b>
        </div>
        <span className="spacer" />
        <button className="dock-ico" title="新对话" aria-label="新对话" disabled={s.running} onClick={() => assistant.newChat(null)}><Ico d={I.plus} /></button>
        <div className="dock-menu-anchor">
          <button className="dock-ico" title="历史对话" aria-label="历史对话" disabled={s.running} onClick={() => setHistory((h) => !h)}><Ico d={I.history} /></button>
          {history && (
            <Menu className="dock-history" onClose={() => setHistory(false)}>
              <div className="as-menu-cap">最近的对话</div>
              {s.list.slice(0, 14).map((c) => (
                <button key={c.id} className={c.id === s.convId ? 'on' : ''} onClick={() => { setHistory(false); assistant.open(c.id); }}>
                  <span className="dock-history-t">{c.title || '新对话'}</span>
                  <span className="dock-history-d">{when(c.updatedAt)}</span>
                </button>
              ))}
              {!s.list.length && <div className="as-menu-cap">还没有对话</div>}
            </Menu>
          )}
        </div>
        <button className="dock-ico" title="在助手页打开" aria-label="在助手页打开" onClick={() => navigate('/assistant')}><Ico d={I.expand} size={14} /></button>
        <button className="dock-ico" title="收起" aria-label="收起" onClick={() => setOpen(false)}><Ico d={I.close} /></button>
      </header>

      <div className="dock-log" ref={logRef} onScroll={onScroll}>
        {status && !status.claude && (
          <div className="as-warn">没找到本机的 Claude Code。先安装 Claude Code，在终端里运行一次 <code>claude</code> 完成登录。</div>
        )}
        {!s.messages.length ? (
          <div className="dock-empty">
            <div className="dock-empty-t">边做边问</div>
            <p>我看得到你正在看的这道题和你写的作答。还没交的题，我先给思路，不直接说答案。</p>
            <div className="dock-sugs">
              {suggestions.map((x) => (
                <button key={x.t} className="dock-sug" disabled={s.running || !context} onClick={() => assistant.send(x.p, [], getContext())}>
                  <b>{x.t}</b><span>{x.d}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="dock-msgs"><Messages s={s} onOpen={openNote} /></div>
        )}
      </div>

      <Composer s={s} onSend={send} top={chip} focusSignal={focusSignal}
                placeholder={withCtx ? '问问这道题…' : '问点什么…'} />
    </aside>
  );
}
