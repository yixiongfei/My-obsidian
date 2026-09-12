import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { START_PAGES, ZOOMS, desktop, resetUiState } from '../settings.js';

/**
 * 设置面板：顶栏「白天 / 夜间」左边那个齿轮。
 * 通用项（主题、启动页、缩放）网页版和桌面版都有；
 * 窗口模式、仓库路径、打开数据文件夹只在桌面版出现——网页版没有窗口可言。
 */

const WINDOW_MODES = [
  { key: 'window', label: '窗口', hint: '记住上次的大小和位置' },
  { key: 'maximized', label: '最大化', hint: '启动即铺满屏幕，保留标题栏' },
  { key: 'fullscreen', label: '全屏', hint: '无边框；F11 或菜单可退出' },
];

function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.key} className={value === o.key ? 'on' : ''} title={o.hint} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

export default function Settings({ open, onClose, theme, setTheme, settings, update, meta }) {
  const ref = useRef(null);
  const [info, setInfo] = useState(null);
  const [notice, setNotice] = useState('');
  const [ms, setMs] = useState(null);   // 里程碑：{初试, 复试, 上岸} → 通过日期或 null

  useEffect(() => {
    if (!open) return;
    if (desktop) desktop.getInfo().then(setInfo).catch(() => setInfo(null));
    api.milestones().then(setMs).catch(() => setMs(null));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.settings-btn')) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open, onClose]);

  useEffect(() => { if (!open) setNotice(''); }, [open]);

  if (!open) return null;

  const setWindowMode = async (mode) => {
    if (!desktop) return;
    const ok = await desktop.setWindowMode(mode);
    if (ok) setInfo((i) => ({ ...i, windowMode: mode }));
  };

  return (
    <div className="settings-pop" ref={ref} role="dialog" aria-label="设置">
      <div className="settings-head">
        <span className="lbl">SETTINGS</span>
        <span className="settings-title">设置</span>
        <span className="spacer" />
        <span className="dim" style={{ fontSize: 11 }}>{desktop ? `桌面版 ${info?.version || ''}` : '网页版'}</span>
      </div>

      <div className="settings-sec">
        <div className="settings-k">主题</div>
        <Seg value={theme} onChange={setTheme}
             options={[{ key: 'light', label: '白天' }, { key: 'dark', label: '夜间' }]} />
      </div>

      <div className="settings-sec">
        <div className="settings-k">界面缩放</div>
        <Seg value={settings.zoom} onChange={(z) => update({ zoom: z })}
             options={ZOOMS.map((z) => ({ key: z, label: `${z}%` }))} />
      </div>

      <div className="settings-sec">
        <div className="settings-k">启动时打开</div>
        <Seg value={settings.startPage} onChange={(p) => update({ startPage: p })}
             options={START_PAGES.map((p) => ({ key: p.to, label: p.label }))} />
      </div>

      {desktop && (
        <>
          <div className="settings-sec">
            <div className="settings-k">窗口</div>
            <Seg value={info?.windowMode || 'window'} onChange={setWindowMode} options={WINDOW_MODES} />
            <div className="settings-hint">{WINDOW_MODES.find((m) => m.key === (info?.windowMode || 'window'))?.hint}</div>
          </div>

          <div className="settings-sec">
            <div className="settings-k">仓库</div>
            <div className="settings-path" title={meta?.repo || ''}>{meta?.repo || info?.vaultRoot || '—'}</div>
            <div className="settings-hint">笔记读自 {meta?.vault ? meta.vault.replace(meta.repo || '', '') || '/' : '—'} · 数据在 .kb/</div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn sm" onClick={() => desktop.openPath(meta?.kb || '')}>打开数据文件夹</button>
              <button className="btn sm" onClick={() => desktop.openPath(meta?.vault || '')}>打开笔记文件夹</button>
              <button className="btn sm" onClick={() => desktop.pickVault()}>切换仓库…</button>
            </div>
          </div>
        </>
      )}

      <div className="settings-sec">
        <div className="settings-k">里程碑</div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          {['初试', '复试', '上岸'].map((k) => (
            <label key={k} className="settings-check">
              <input type="checkbox" checked={!!ms?.[k]} disabled={!ms}
                     onChange={async (e) => {
                       try { setMs(await api.setMilestones({ [k]: e.target.checked })); } catch (err) { setNotice(err.message); }
                     }} />
              <span>{k}{ms?.[k] ? <em>{ms[k].slice(5).replace('-', '.')}</em> : null}</span>
            </label>
          ))}
        </div>
        <div className="settings-hint">考完、过了就勾上</div>
      </div>

      <div className="settings-sec">
        <div className="settings-k">本机状态</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => { resetUiState(); setNotice('已清除导图 / 目录树 / 列表的记忆状态，刷新后生效'); }}>重置界面记忆</button>
          <button className="btn sm" onClick={() => window.location.reload()}>重新载入</button>
        </div>
        {notice && <div className="settings-hint" style={{ color: 'var(--accent)' }}>{notice}</div>}
      </div>
    </div>
  );
}
