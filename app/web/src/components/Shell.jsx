import { NavLink, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/',         label: '仪表盘', end: true },
  { to: '/notes',    label: '笔记' },
  { to: '/review',   label: '复习', badgeKey: 'due' },
  { to: '/schedule', label: '日程' },
];

export default function Shell({ children, meta, badges = {}, theme, onToggleTheme, onSearch }) {
  const { pathname } = useLocation();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-text">
            <div className="brand-name">知识库</div>
            <div className="brand-sub">KNOWLEDGE BASE</div>
          </div>
        </div>

        {NAV.map((item, i) => {
          const active = item.end ? pathname === item.to : pathname.startsWith(item.to);
          const badge = badges[item.badgeKey];
          return (
            <NavLink key={item.to} to={item.to} className={`nav-item${active ? ' active' : ''}`}>
              <span className="ord">{String(i + 1).padStart(2, '0')}</span>
              <span>{item.label}</span>
              {badge > 0 && <span className="badge">{badge}</span>}
            </NavLink>
          );
        })}

        <div className="rail-foot">
          <button className="rail-btn" onClick={onSearch}>
            <span>搜索</span>
            <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <button className="rail-btn" onClick={onToggleTheme}>
            <span>{theme === 'dark' ? '浅色' : '深色'}</span>
            <kbd>{theme === 'dark' ? 'LIGHT' : 'DARK'}</kbd>
          </button>
          {meta && <div className="rail-btn" style={{ pointerEvents: 'none' }}><span>笔记</span><kbd>{meta.notes}</kbd></div>}
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
