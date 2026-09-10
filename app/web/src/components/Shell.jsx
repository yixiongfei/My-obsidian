import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Icon } from './Icons.jsx';

const NAV = [
  { to: '/', icon: 'dash', label: '仪表盘', end: true },
  { to: '/notes', icon: 'notes', label: '笔记' },
  { to: '/review', icon: 'review', label: '复习', badgeKey: 'due' },
  { to: '/schedule', icon: 'calendar', label: '日程' },
];

export default function Shell({ children, meta, badges = {}, theme, onToggleTheme, onSearch }) {
  const { pathname } = useLocation();
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark" />
          <div className="brand-text">
            <div className="brand-name">知识库</div>
            <div className="brand-sub num">{meta ? `${meta.notes} 篇` : '—'}</div>
          </div>
        </div>

        <div className="nav-group">导航</div>
        {NAV.map((item) => {
          const active = item.end ? pathname === item.to : pathname.startsWith(item.to);
          const Ico = Icon[item.icon];
          const badge = badges[item.badgeKey];
          return (
            <NavLink key={item.to} to={item.to} className={`nav-item${active ? ' active' : ''}`}>
              {active && <motion.span layoutId="nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              <Ico className="ic" />
              <span>{item.label}</span>
              {badge > 0 && <span className="badge num">{badge}</span>}
            </NavLink>
          );
        })}

        <div className="rail-foot">
          <button className="kbd-hint" onClick={onSearch}>
            <Icon.search width={15} height={15} />
            <span>搜索</span>
            <span className="spacer" />
            <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          <button className="nav-item" onClick={onToggleTheme}>
            {theme === 'dark' ? <Icon.sun className="ic" /> : <Icon.moon className="ic" />}
            <span>{theme === 'dark' ? '浅色' : '深色'}</span>
          </button>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
