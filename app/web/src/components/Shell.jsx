import { NavLink, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/',          label: '首页', end: true },
  { to: '/dashboard', label: '仪表盘' },
  { to: '/notes',     label: '笔记', match: ['/notes', '/note'] },
  // 这里进的是英语词汇 Anki，不再挂"待复习笔记数"的徽标——
  // 笔记的深度复习在笔记页里做，两条路径的计数混在一起会误导
  { to: '/review',    label: '复习' },
  { to: '/schedule',  label: '日历' },
  { to: '/resources', label: '资源' },
];

const Sparkle = (p) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M12 2c.5 4.6 2.9 7.4 8 8-5.1.6-7.5 3.4-8 8-.5-4.6-2.9-7.4-8-8 5.1-.6 7.5-3.4 8-8z" />
  </svg>
);

const Gear = (p) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

const Search = (p) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);

export default function Shell({ children, meta, badges = {}, theme, onToggleTheme, onSearch, onSettings, settingsOpen, settingsPanel }) {
  const { pathname } = useLocation();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Sparkle /></div>
          <div className="brand-text">
            <div className="brand-name">星图知识库</div>
            <div className="brand-sub">PERSONAL LEARNING SYSTEM</div>
          </div>
        </div>

        <nav className="topnav">
          {NAV.map((item) => {
            const active = item.end
              ? pathname === item.to
              : (item.match || [item.to]).some((m) => pathname.startsWith(m));
            const badge = badges[item.badgeKey];
            return (
              <NavLink key={item.to} to={item.to} className={active ? 'active' : undefined}>
                {item.label}
                {badge > 0 && <span className="badge">{badge}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="topbar-right">
          <button className={`icon-btn settings-btn${settingsOpen ? ' on' : ''}`} onClick={onSettings} title="设置" aria-expanded={settingsOpen}>
            <Gear />
          </button>
          <button className="icon-btn" onClick={onToggleTheme} title="切换日夜模式">
            {theme === 'dark' ? '白天' : '夜间'}
          </button>
          <button className="icon-btn" onClick={onSearch} title="搜索">
            <Search />
            <span className="kbd-hint">{isMac ? '⌘' : 'Ctrl'} K</span>
          </button>
        </div>
        {settingsPanel}
      </header>

      <main className="main">{children}</main>
    </div>
  );
}
