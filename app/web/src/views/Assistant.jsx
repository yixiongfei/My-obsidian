import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MarkdownIt from 'markdown-it';
import katexPlugin from '@vscode/markdown-it-katex';
import katex from 'katex';
import { api, vaultUrl } from '../api.js';
import { useApi } from '../hooks.js';
import { assistant } from '../assistantStore.js';

/**
 * 学习助手：本机 Claude Code 驱动。读得到笔记和学习数据，改笔记要一条条经你同意。
 * 对话状态在 assistantStore 里，切走页面回答照样继续。
 */

// 解析不了的公式按原样显示 TeX 源码（淡色），不用 KaTeX 默认的红字报错
const quietKatex = {
  renderToString(src, opts) {
    try { return katex.renderToString(src, { ...opts, throwOnError: true }); }
    catch { return `<code class="tex-raw">${md.utils.escapeHtml(src)}</code>`; }
  },
};

// html: false —— 模型输出里的 HTML 一律当文本，不进 DOM
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(katexPlugin.default || katexPlugin, { katex: quietKatex });

/**
 * 正在输出的那段，末尾没收尾的公式先扣下：`$$` 块只来了开头、行内 `$` 只来了前半个时，
 * 半截 TeX 要么原样露出来、要么解析失败，等收尾了再一次渲染出来。
 */
function settledText(text) {
  if ((text.split('$$').length - 1) % 2) return text.slice(0, text.lastIndexOf('$$'));
  let open = -1;
  for (let i = text.lastIndexOf('\n') + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== '$') continue;
    if (text[i + 1] === '$') { i++; continue; }
    open = open < 0 ? i : -1;
  }
  return open < 0 ? text : text.slice(0, open);
}

export const WEEKLY_PROMPT = '用我最近 7 天一直没掌握的单词写一篇生词阅读，加进阅读卡片，然后告诉我用了哪些词。';

const SUGGESTIONS = [
  { t: '生词阅读', p: WEEKLY_PROMPT },
  { t: '本周学习总结', p: '总结一下我最近 7 天的学习：每天做了什么、哪里断了、下周最该补什么。' },
  { t: '薄弱考点', p: '我最薄弱的考点是哪些？结合错题本给我一个按优先级排的补法。' },
  { t: '整理笔记', p: '找找我关于「不定积分」的笔记，读一遍，告诉我哪里写得不清楚、缺了什么。先别改。' },
];

const MODELS = [['', '默认模型'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']];
const EFFORTS = [
  ['medium', '快速回答', '看图、讲题回得快，日常够用'],
  ['high', '深入思考', '难题、证明题想得更久更细，回得慢'],
];

const TOOL_LABEL = {
  mcp__kb__study_overview: () => '查看学习概况',
  mcp__kb__weak_words: (i) => `找出最近 ${i.days || 7} 天没掌握的单词`,
  mcp__kb__weak_points: () => '查看薄弱考点和错题本',
  mcp__kb__search_notes: (i) => `搜索笔记「${i.query}」`,
  mcp__kb__list_readings: () => '查看阅读卡片',
  mcp__kb__create_reading: (i) => `生成阅读《${i.title}》`,
  mcp__kb__list_schedule: (i) => `查看日程 ${String(i.from || '').slice(5)} ~ ${String(i.to || '').slice(5)}`,
  mcp__kb__change_schedule: (i) => `修改日程：${i.summary || ''}`,
  mcp__kb__lookup_words: (i) => `查单词 ${String(i.terms || '').slice(0, 40)}`,
  mcp__kb__add_words: (i) => `加进单词表 ${i.words || ''}`,
  mcp__kb__edit_word: (i) => `修改单词 ${i.term}`,
  mcp__kb__set_word_status: (i) => `调整单词状态 ${String(i.terms || '').slice(0, 40)}`,
  mcp__kb__add_sentences: (i) => `加进长难句 ${i.items || ''}`,
  mcp__kb__edit_reading: (i) => `修改阅读卡片 #${i.id}`,
  mcp__kb__delete_readings: () => '删除阅读卡片',
  mcp__kb__exam_history: (i) => `查看最近 ${i.days || 14} 天做过的题`,
  mcp__kb__get_question: (i) => `看原题 ${i.exam}${i.n ? ` 第 ${i.n} 题` : ''}`,
  mcp__kb__add_to_wrong_book: (i) => `加进错题本 ${i.exam}${i.n ? ` 第 ${i.n} 题` : ''}`,
  Read: (i) => `读取 ${i.file}`,
  Glob: (i) => `查找文件 ${i.pattern}`,
  Grep: (i) => `搜索内容 ${i.pattern}`,
  Edit: (i) => `修改 ${i.file}`,
  MultiEdit: (i) => `修改 ${i.file}`,
  Write: (i) => `写入 ${i.file}`,
};
const toolLabel = (p) => (TOOL_LABEL[p.name] || (() => p.name.replace(/^mcp__\w+__/, '')))(p.input || {});

function Markdown({ text, live }) {
  const html = useMemo(() => md.render(live ? settledText(text || '') : text || ''), [text, live]);
  return <div className="as-md prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

/* 改过数据的工具，做完给一个跳过去看的链接 */
const GO = {
  mcp__kb__create_reading: ['去阅读', '/review/reading'],
  mcp__kb__add_sentences: ['去阅读', '/review/reading/list'],
  mcp__kb__edit_reading: ['去阅读', '/review/reading/list'],
  mcp__kb__delete_readings: ['去阅读', '/review/reading/list'],
  mcp__kb__add_words: ['去单词表', '/review/words'],
  mcp__kb__edit_word: ['去单词表', '/review/words'],
  mcp__kb__set_word_status: ['去单词表', '/review/words'],
  mcp__kb__change_schedule: ['去日历', '/schedule'],
};

function ToolChip({ part, onOpen }) {
  const file = part.input?.file;
  const openable = file && /\.md$/i.test(file) && part.name === 'Read';
  return (
    <div className={`as-tool s-${part.status}`}>
      <i className="as-tool-dot" />
      {openable
        ? <button className="as-tool-t link" onClick={() => onOpen(file)}>{toolLabel(part)}</button>
        : <span className="as-tool-t">{toolLabel(part)}</span>}
      {part.status === 'done' && GO[part.name] && (
        <button className="as-tool-go" onClick={() => onOpen(null, GO[part.name][1])}>{GO[part.name][0]} →</button>
      )}
    </div>
  );
}

const OP = { add: '新增', update: '调整', delete: '删除' };
const slot = (e) => (e ? `${e.date.slice(5).replace('-', '/')}${e.time ? ` ${e.time.start}–${e.time.end}` : ''}` : '');

/** 日程改动：一行一条，改前 → 改后；只改了时间 / 日期的那一侧高亮 */
function ScheduleRows({ input }) {
  return (
    <div className="as-sched">
      {input.summary && <div className="as-sched-sum">{input.summary}</div>}
      {input.rows.map((r, i) => (
        <div className={`as-sched-row op-${r.op}`} key={i}>
          <span className="as-sched-op">{OP[r.op]}</span>
          <span className="as-sched-title">{(r.after || r.before).title}</span>
          <span className="as-sched-when">
            {r.op === 'update' && slot(r.before) !== slot(r.after)
              ? <><s>{slot(r.before)}</s><i>→</i><b>{slot(r.after)}</b></>
              : r.op === 'delete' ? <s>{slot(r.before)}</s> : <b>{slot(r.after || r.before)}</b>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 通用改动：一行一条，改前（划掉）→ 改后；内容长的上下排 */
function ChangeRows({ input }) {
  return (
    <div className="as-sched as-chg">
      {input.summary && <div className="as-sched-sum">{input.summary}</div>}
      {input.rows.map((r, i) => (
        <div className={`as-chg-row${r.op === '删除' ? ' del' : ''}`} key={i}>
          <div className="as-chg-h"><span className="as-sched-op">{r.op}</span><span className="as-chg-title">{r.title}</span></div>
          {r.before && <pre className="as-chg-before">{r.before}</pre>}
          {r.after && <pre className="as-chg-after">{r.after}</pre>}
        </div>
      ))}
    </div>
  );
}

function Permission({ part }) {
  const { tool, input, exists, decided } = part;
  const pending = decided == null;
  const verb = tool === 'schedule' ? `调整日程（${input.rows?.length || 0} 条）`
    : tool === 'changes' ? `${input.rows?.every((r) => r.op === '删除') ? '删除' : input.rows?.every((r) => r.op === '新增') ? '新增' : '修改'}（${input.rows?.length || 0} 处）`
      : tool === 'Write' ? (exists ? '覆盖整篇' : '新建') : '修改';
  return (
    <div className={`as-perm${pending ? ' pending' : ''}`}>
      <div className="as-perm-h">
        <span className="lbl">想要{verb}</span>
        {input.file && <span className="as-perm-file">{input.file}</span>}
      </div>
      {tool === 'schedule' && <ScheduleRows input={input} />}
      {tool === 'changes' && <ChangeRows input={input} />}
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

const MODEL_NAME = Object.fromEntries(MODELS);
const FOLD_KEY = 'kb-assistant-folded';

/** 点外面 / Esc 关掉的小弹出菜单 */
export function Menu({ onClose, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const off = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', off, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', off, true); window.removeEventListener('keydown', key); };
  }, [onClose]);
  return <div className={`as-menu ${className}`} ref={ref}>{children}</div>;
}

const Dots = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
);
const Chevron = ({ open }) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
       style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);
const Folder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
);

/** 一行对话：点开、拖到项目上、⋯ 菜单里挪项目 / 删除 */
function ConvRow({ c, s }) {
  const [menu, setMenu] = useState(false);
  const busy = s.running && c.id === s.convId;
  return (
    <div className={`as-conv${c.id === s.convId ? ' on' : ''}${menu ? ' menu-open' : ''}`}
         draggable={!s.running}
         onDragStart={(e) => { e.dataTransfer.setData('text/kb-conv', c.id); e.dataTransfer.effectAllowed = 'move'; }}>
      <button className="as-conv-t" disabled={s.running} onClick={() => assistant.open(c.id)} title={c.title}>
        <span className="as-conv-name">{c.title || '新对话'}</span>
        <span className="as-conv-d">{when(c.updatedAt)}</span>
      </button>
      <button className="as-ico as-conv-more" aria-label="更多" onClick={() => setMenu((m) => !m)}><Dots /></button>
      {menu && (
        <Menu onClose={() => setMenu(false)}>
          {s.projects.length > 0 && <div className="as-menu-cap">移到项目</div>}
          {s.projects.filter((p) => p.id !== c.projectId).map((p) => (
            <button key={p.id} onClick={() => { setMenu(false); assistant.moveConversation(c.id, p.id); }}><Folder />{p.name}</button>
          ))}
          {c.projectId && <button onClick={() => { setMenu(false); assistant.moveConversation(c.id, null); }}>移出项目</button>}
          <div className="as-menu-sep" />
          <button className="danger" disabled={busy}
                  onClick={() => { setMenu(false); if (window.confirm(`删除「${c.title || '新对话'}」？`)) assistant.remove(c.id); }}>删除对话</button>
        </Menu>
      )}
    </div>
  );
}

function ProjectRow({ p, convs, s, folded, onFold }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  const [name, setName] = useState(p.name);
  const active = s.projectId === p.id && !s.convId;
  const commit = () => { setRenaming(false); if (name.trim() && name.trim() !== p.name) assistant.renameProject(p.id, name); else setName(p.name); };
  return (
    <div className={`as-proj${over ? ' over' : ''}`}
         onDragOver={(e) => { if (e.dataTransfer.types.includes('text/kb-conv')) { e.preventDefault(); setOver(true); } }}
         onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
         onDrop={(e) => { setOver(false); const id = e.dataTransfer.getData('text/kb-conv'); if (id) assistant.moveConversation(id, p.id); }}>
      <div className={`as-proj-h${active ? ' on' : ''}${menu ? ' menu-open' : ''}`}>
        <button className="as-proj-fold" onClick={onFold} aria-label={folded ? '展开' : '收起'}><Chevron open={!folded} /></button>
        {renaming ? (
          <input className="as-proj-input" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                 onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setName(p.name); setRenaming(false); } }} />
        ) : (
          <button className="as-proj-name" onClick={onFold}><Folder /><span>{p.name}</span><em>{convs.length || ''}</em></button>
        )}
        <button className="as-ico" title="在这个项目里新建对话" aria-label="在这个项目里新建对话" disabled={s.running}
                onClick={() => { assistant.newChat(p.id); if (folded) onFold(); }}>＋</button>
        <button className="as-ico" aria-label="项目菜单" onClick={() => setMenu((m) => !m)}><Dots /></button>
        {menu && (
          <Menu onClose={() => setMenu(false)}>
            <button onClick={() => { setMenu(false); setRenaming(true); }}>重命名</button>
            <button className="danger" onClick={() => {
              setMenu(false);
              if (window.confirm(`删除项目「${p.name}」？里面的 ${convs.length} 段对话会保留，回到未分类。`)) assistant.removeProject(p.id);
            }}>删除项目</button>
          </Menu>
        )}
      </div>
      {!folded && (
        <div className="as-proj-body">
          {convs.map((c) => <ConvRow key={c.id} c={c} s={s} />)}
          {!convs.length && <div className="as-proj-empty">把对话拖到这里，或点 ＋ 新建</div>}
        </div>
      )}
    </div>
  );
}

function Sidebar({ s }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [folded, setFolded] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { return new Set(); } });
  const [overLoose, setOverLoose] = useState(false);
  const fold = (id) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...n])); } catch { /* 无痕 */ }
    return n;
  });
  const create = async () => {
    const n = name.trim();
    setAdding(false); setName('');
    if (n) await assistant.createProject(n);
  };
  const ids = new Set(s.projects.map((p) => p.id));
  const loose = s.list.filter((c) => !c.projectId || !ids.has(c.projectId));

  return (
    <aside className="as-side">
      <button className="as-new" disabled={s.running} onClick={() => assistant.newChat(null)}>
        <span className="as-new-plus">＋</span>新对话
      </button>

      <div className="as-side-scroll">
        <div className="as-sec">
          <span>项目</span>
          <button className="as-ico" title="新建项目" aria-label="新建项目" onClick={() => setAdding(true)}>＋</button>
        </div>
        {adding && (
          <div className="as-proj-new">
            <Folder />
            <input autoFocus value={name} placeholder="项目名，如「高数」" onChange={(e) => setName(e.target.value)}
                   onBlur={create} onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { setAdding(false); setName(''); } }} />
          </div>
        )}
        {s.projects.map((p) => (
          <ProjectRow key={p.id} p={p} s={s} folded={folded.has(p.id)} onFold={() => fold(p.id)}
                      convs={s.list.filter((c) => c.projectId === p.id)} />
        ))}
        {!s.projects.length && !adding && <div className="as-side-hint">用项目把对话归类，比如「高数」「英语」「复盘」</div>}

        <div className={`as-sec as-sec-loose${overLoose ? ' over' : ''}`}
             onDragOver={(e) => { if (e.dataTransfer.types.includes('text/kb-conv')) { e.preventDefault(); setOverLoose(true); } }}
             onDragLeave={() => setOverLoose(false)}
             onDrop={(e) => { setOverLoose(false); const id = e.dataTransfer.getData('text/kb-conv'); if (id) assistant.moveConversation(id, null); }}>
          <span>对话</span>
        </div>
        {loose.map((c) => <ConvRow key={c.id} c={c} s={s} />)}
      </div>
    </aside>
  );
}

const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
);
const SendIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>
);
const FileIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
);

/**
 * 输入框：圆角卡片，文字多了往上长；左下 + 导入图片 / 文件，右下模型 + 发送。
 * 粘贴、拖进来的图和文件也走同一条路。
 */
export function Composer({ s, projectName, placeholder, onSend = assistant.send, top = null, focusSignal = 0 }) {
  const [draft, setDraft] = useState('');
  const [atts, setAtts] = useState([]);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const ta = useRef(null);
  const fileRef = useRef(null);

  // 跟着字数长高，到上限后在框里滚
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);
  useEffect(() => { if (focusSignal) ta.current?.focus(); }, [focusSignal]);

  const addFiles = async (list) => {
    const files = [...(list || [])].filter(Boolean);
    if (!files.length) return;
    setErr('');
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const out = await api.uploadAssistantFile(f);
        setAtts((a) => (a.some((x) => x.path === out.path) ? a : [...a, out].slice(0, 8)));
      } catch (e) { setErr(e.message); }
      setUploading((n) => n - 1);
    }
  };
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  };

  const ready = (draft.trim() || atts.length) && !uploading && !s.running;
  const submit = () => {
    if (!ready) return;
    onSend(draft, atts);
    setDraft('');
    setAtts([]);
  };

  return (
    <div className="as-compose-wrap">
      <div className={`as-composer${drag ? ' drag' : ''}`}
           onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
           onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
           onDrop={(e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
           onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); ta.current?.focus(); } }}>
        {top}
        {(atts.length > 0 || uploading > 0) && (
          <div className="as-atts">
            {atts.map((a) => (
              <span className={`as-att ${a.kind}`} key={a.path} title={a.name}>
                {a.kind === 'image' ? <img src={vaultUrl(a.path)} alt="" /> : <><FileIcon /><span className="as-att-name">{a.name}</span></>}
                <button aria-label="移除" onClick={() => setAtts((l) => l.filter((x) => x.path !== a.path))}>×</button>
              </span>
            ))}
            {uploading > 0 && <span className="as-att loading" />}
          </div>
        )}

        <textarea ref={ta} rows={1} value={draft}
                  placeholder={placeholder ?? (projectName ? `在「${projectName}」里提问` : undefined)}
                  onPaste={onPaste}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />

        <div className="as-bar">
          <button className="as-ico as-plus" title="导入图片或文件" aria-label="导入图片或文件" onClick={() => fileRef.current?.click()}><PlusIcon /></button>
          <input ref={fileRef} type="file" multiple hidden accept="image/*,.pdf,.md,.txt,.csv,.json,.tex"
                 onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          {err && <span className="as-bar-err">{err}</span>}
          <span className="spacer" />
          <div className="as-model-pick">
            <button className="as-model-btn" disabled={s.running} onClick={() => setModelMenu((m) => !m)}>
              {MODEL_NAME[s.model] || '默认模型'}{s.effort === 'high' && <span className="as-model-deep">深入</span>}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {modelMenu && (
              <Menu className="up" onClose={() => setModelMenu(false)}>
                {MODELS.map(([v, l]) => (
                  <button key={v} className={s.model === v ? 'on' : ''} onClick={() => { assistant.setModel(v); setModelMenu(false); }}>
                    {l}{s.model === v && <span className="as-menu-check">✓</span>}
                  </button>
                ))}
                <div className="as-menu-sep" />
                <div className="as-menu-cap">思考</div>
                {EFFORTS.map(([v, l, hint]) => (
                  <button key={v} className={s.effort === v ? 'on' : ''} title={hint} onClick={() => { assistant.setEffort(v); setModelMenu(false); }}>
                    {l}{s.effort === v && <span className="as-menu-check">✓</span>}
                  </button>
                ))}
              </Menu>
            )}
          </div>
          {s.running
            ? <button className="as-send stop" aria-label="停止" title="停止" onClick={assistant.stop}><StopIcon /></button>
            : <button className="as-send" aria-label="发送" title="发送（Enter）" disabled={!ready} onClick={submit}><SendIcon /></button>}
        </div>
      </div>
    </div>
  );
}

/** 新内容进来时贴底；用户往上翻了就不打扰 */
export function useChatScroll(s) {
  const logRef = useRef(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.messages]);
  useEffect(() => { if (s.running) stick.current = true; }, [s.running]);
  const onScroll = (e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; };
  return { logRef, onScroll };
}

/** 一段对话的消息流：助手页和做题页侧栏共用 */
export function Messages({ s, onOpen }) {
  const last = s.messages.length - 1;
  return s.messages.map((m, i) => (m.role === 'user' ? (
    <div className="as-user" key={i}>
      {m.ctx && <div className="as-user-ctx" title="这条消息附上了这道题">{m.ctx.label}</div>}
      {(m.images?.length > 0 || m.files?.length > 0) && (
        <div className="as-user-imgs">
          {m.images?.map((p) => <img key={p} src={vaultUrl(p)} alt="" onClick={() => window.open(vaultUrl(p), '_blank')} />)}
          {m.files?.map((f) => <span className="as-att file" key={f.path}><FileIcon /><span className="as-att-name">{f.name}</span></span>)}
        </div>
      )}
      {m.text && <div className="as-user-b">{m.text}</div>}
    </div>
  ) : (
    <div className="as-bot" key={i}>
      {m.parts.map((p, k) => (
        p.type === 'text' ? <Markdown key={k} text={p.text} live={s.running && i === last && k === m.parts.length - 1} />
          : p.type === 'tool' ? <ToolChip key={k} part={p} onOpen={onOpen} />
            : <Permission key={k} part={p} />
      ))}
      {s.running && i === last && <div className="as-typing"><i /><i /><i /></div>}
      {m.error && <div className="as-err">{m.error}</div>}
      {m.cost != null && !(s.running && i === last) && (
        <div className="as-cost" title="Claude Code 报的估算值；用订阅登录时不单独计费">估算 ${m.cost.toFixed(3)}</div>
      )}
    </div>
  )));
}

export default function Assistant() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const s = useSyncExternalStore(assistant.subscribe, assistant.get);
  const { data: status } = useApi(() => api.assistantStatus(), []);
  const { logRef, onScroll } = useChatScroll(s);

  // ?ask=weekly：从阅读页点「生成生词阅读」过来——开一段新对话，自动发出去
  useEffect(() => {
    const ask = params.get('ask') === 'weekly';
    if (ask) setParams({}, { replace: true });
    assistant.init().then(() => {
      if (!ask || assistant.get().running) return;
      assistant.newChat();
      assistant.send(WEEKLY_PROMPT);
    });
  }, [params, setParams]);

  const open = (file, route) => navigate(route || `/note/${encodeURIComponent(file)}`);
  const noClaude = status && !status.claude;
  const project = s.projects.find((p) => p.id === s.projectId);

  return (
    <div className="as-wrap">
      <Sidebar s={s} />

      <div className="as-page">
        <div className="as-head">
          {project && <span className="as-head-proj"><Folder />{project.name}<i>/</i></span>}
          <div className="as-title">{s.title || '学习助手'}</div>
        </div>

        <div className="as-log" ref={logRef} onScroll={onScroll}>
          <div className="as-log-in">
            {noClaude && (
              <div className="as-warn">没找到本机的 Claude Code。先安装 Claude Code，在终端里运行一次 <code>claude</code> 完成登录，再回来。</div>
            )}

            {!s.messages.length && (
              <div className="as-empty">
                <div className="as-empty-t">{project ? `「${project.name}」` : '今天想从哪儿开始？'}</div>
                <div className="as-sugs">
                  {SUGGESTIONS.map((x) => (
                    <button key={x.t} className="as-sug" onClick={() => assistant.send(x.p)} disabled={s.running}>
                      <b>{x.t}</b><span>{x.p}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Messages s={s} onOpen={open} />
          </div>
        </div>

        <Composer s={s} projectName={project?.name} />
      </div>
    </div>
  );
}

/** 侧栏里的时间：今天显示时刻，今年显示月日，再早显示年 */
export function when(iso) {
  const d = new Date(iso);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return String(d.getFullYear());
}
