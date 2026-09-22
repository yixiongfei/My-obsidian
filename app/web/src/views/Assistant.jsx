import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { assistant } from '../assistantStore.js';

/**
 * 学习助手：本机 Claude Code 驱动。读得到笔记和学习数据，改笔记要一条条经你同意。
 * 对话状态在 assistantStore 里，切走页面回答照样继续。
 */

// html: false —— 模型输出里的 HTML 一律当文本，不进 DOM
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(katexPlugin.default || katexPlugin, { throwOnError: false });

export const WEEKLY_PROMPT = '用我最近 7 天一直没掌握的单词写一篇生词阅读，加进阅读卡片，然后告诉我用了哪些词。';

const SUGGESTIONS = [
  { t: '生词阅读', p: WEEKLY_PROMPT },
  { t: '本周学习总结', p: '总结一下我最近 7 天的学习：每天做了什么、哪里断了、下周最该补什么。' },
  { t: '薄弱考点', p: '我最薄弱的考点是哪些？结合错题本给我一个按优先级排的补法。' },
  { t: '整理笔记', p: '找找我关于「不定积分」的笔记，读一遍，告诉我哪里写得不清楚、缺了什么。先别改。' },
];

const MODELS = [['', '默认模型'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];

const TOOL_LABEL = {
  mcp__kb__study_overview: () => '查看学习概况',
  mcp__kb__weak_words: (i) => `找出最近 ${i.days || 7} 天没掌握的单词`,
  mcp__kb__weak_points: () => '查看薄弱考点和错题本',
  mcp__kb__search_notes: (i) => `搜索笔记「${i.query}」`,
  mcp__kb__list_readings: () => '查看阅读卡片',
  mcp__kb__create_reading: (i) => `生成阅读《${i.title}》`,
  Read: (i) => `读取 ${i.file}`,
  Glob: (i) => `查找文件 ${i.pattern}`,
  Grep: (i) => `搜索内容 ${i.pattern}`,
  Edit: (i) => `修改 ${i.file}`,
  MultiEdit: (i) => `修改 ${i.file}`,
  Write: (i) => `写入 ${i.file}`,
};
const toolLabel = (p) => (TOOL_LABEL[p.name] || (() => p.name.replace(/^mcp__\w+__/, '')))(p.input || {});

function Markdown({ text }) {
  const html = useMemo(() => md.render(text || ''), [text]);
  return <div className="as-md prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolChip({ part, onOpen }) {
  const file = part.input?.file;
  const openable = file && /\.md$/i.test(file) && part.name === 'Read';
  return (
    <div className={`as-tool s-${part.status}`}>
      <i className="as-tool-dot" />
      {openable
        ? <button className="as-tool-t link" onClick={() => onOpen(file)}>{toolLabel(part)}</button>
        : <span className="as-tool-t">{toolLabel(part)}</span>}
      {part.name === 'mcp__kb__create_reading' && part.status === 'done' && (
        <button className="as-tool-go" onClick={() => onOpen(null, '/review/reading')}>去阅读 →</button>
      )}
    </div>
  );
}

function Permission({ part }) {
  const { tool, input, exists, decided } = part;
  const pending = decided == null;
  const verb = tool === 'Write' ? (exists ? '覆盖整篇' : '新建') : '修改';
  return (
    <div className={`as-perm${pending ? ' pending' : ''}`}>
      <div className="as-perm-h">
        <span className="lbl">想要{verb}</span>
        <span className="as-perm-file">{input.file}</span>
      </div>
      {tool === 'Edit' && (
        <div className="as-diff">
          <pre className="del">{input.old}</pre>
          <pre className="add">{input.new}</pre>
          {input.all && <div className="dim as-perm-note">（全篇所有匹配处都会替换）</div>}
        </div>
      )}
      {tool === 'MultiEdit' && (input.edits || []).map((e, i) => (
        <div className="as-diff" key={i}><pre className="del">{e.old}</pre><pre className="add">{e.new}</pre></div>
      ))}
      {tool === 'Write' && <div className="as-diff"><pre className="add">{input.content}</pre></div>}
      <div className="as-perm-foot">
        {pending ? (
          <>
            <button className="btn primary" onClick={() => assistant.answer(part.id, true)}>允许</button>
            <button className="btn" onClick={() => assistant.answer(part.id, false)}>拒绝</button>
            <span className="spacer" />
            <button className="as-perm-always" onClick={() => assistant.answer(part.id, true, true)}>这次对话里的修改都允许</button>
          </>
        ) : (
          <span className={`as-perm-state ${decided === true ? 'ok' : ''}`}>
            {decided === true ? '已允许' : decided === 'sending' ? '处理中…' : decided === 'expired' ? '已失效' : '已拒绝'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function Assistant() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const s = useSyncExternalStore(assistant.subscribe, assistant.get);
  const { data: status } = useApi(() => api.assistantStatus(), []);
  const [draft, setDraft] = useState('');
  const logRef = useRef(null);
  const stick = useRef(true);

  // ?ask=weekly：从阅读页 / 仪表盘点「生成生词阅读」过来，自动发出去
  useEffect(() => {
    if (params.get('ask') !== 'weekly') return;
    setParams({}, { replace: true });
    if (!assistant.get().running) assistant.send(WEEKLY_PROMPT);
  }, [params, setParams]);

  // 新内容进来时贴底；用户往上翻了就不打扰
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.messages]);

  const submit = () => {
    if (!draft.trim() || s.running) return;
    assistant.send(draft);
    setDraft('');
    stick.current = true;
  };
  const open = (file, route) => navigate(route || `/note/${encodeURIComponent(file)}`);

  const noClaude = status && !status.claude;

  return (
    <div className="as-page">
      <div className="as-head">
        <div>
          <div className="as-title">学习助手</div>
          <div className="as-sub">本机 Claude Code · 读你的笔记和学习数据，改笔记前先问你</div>
        </div>
        <span className="spacer" />
        <select className="as-model" value={s.model} onChange={(e) => assistant.setModel(e.target.value)} disabled={s.running}>
          {MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className="btn" disabled={s.running || !s.messages.length} onClick={assistant.reset}>新对话</button>
      </div>

      <div className="as-log" ref={logRef}
           onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        <div className="as-log-in">
          {noClaude && (
            <div className="as-warn">没找到本机的 Claude Code。先安装 Claude Code，在终端里运行一次 <code>claude</code> 完成登录，再回来。</div>
          )}

          {!s.messages.length && (
            <div className="as-empty">
              <div className="as-empty-t">今天想从哪儿开始？</div>
              <div className="as-sugs">
                {SUGGESTIONS.map((x) => (
                  <button key={x.t} className="as-sug" onClick={() => assistant.send(x.p)} disabled={s.running}>
                    <b>{x.t}</b><span>{x.p}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {s.messages.map((m, i) => (m.role === 'user' ? (
            <div className="as-user" key={i}><div className="as-user-b">{m.text}</div></div>
          ) : (
            <div className="as-bot" key={i}>
              {m.parts.map((p, k) => (
                p.type === 'text' ? <Markdown key={k} text={p.text} />
                  : p.type === 'tool' ? <ToolChip key={k} part={p} onOpen={open} />
                    : <Permission key={k} part={p} />
              ))}
              {s.running && i === s.messages.length - 1 && <div className="as-typing"><i /><i /><i /></div>}
              {m.error && <div className="as-err">{m.error}</div>}
              {m.cost != null && !(s.running && i === s.messages.length - 1) && (
                <div className="as-cost" title="Claude Code 报的估算值；用订阅登录时不单独计费">估算 ${m.cost.toFixed(3)}</div>
              )}
            </div>
          )))}
        </div>
      </div>

      <div className="as-compose">
        <textarea rows={2} value={draft} placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        {s.running
          ? <button className="btn as-send" onClick={assistant.stop}>停止</button>
          : <button className="btn primary as-send" disabled={!draft.trim()} onClick={submit}>发送</button>}
      </div>
    </div>
  );
}
