import { useCallback, useState } from 'react';
import { Routes, Route, useLocation, Navigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';

import Shell from './components/Shell.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Home from './views/Home.jsx';
import Dashboard from './views/Dashboard.jsx';
import Notes from './views/Notes.jsx';
import Review from './views/Review.jsx';
import Schedule from './views/Schedule.jsx';

import { api } from './api.js';
import { useApi, useHotkey, useTheme, useVaultVersion } from './hooks.js';

// 换页过渡：淡入 + 极轻微的上浮。位移控制在 6px 以内，
// 再大就会和页内的逐块进场动画叠成"整页在晃"
const fade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
};

export default function App() {
  const version = useVaultVersion();
  const [theme, toggleTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  const { data: meta } = useApi(() => api.meta(), [version]);
  const { data: dash, reload: reloadDash } = useApi(() => api.dashboard(), [version]);

  useHotkey('mod+k', useCallback((e) => { e.preventDefault(); setPaletteOpen((o) => !o); }, []));

  return (
    <>
      <Shell
        meta={meta}
        badges={{ due: dash?.counts?.due || 0 }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSearch={() => setPaletteOpen(true)}
      >
        <AnimatePresence mode="wait">
          <motion.div key={routeKey(location.pathname)} className="view" {...fade}>
            <Routes location={location}>
              <Route path="/" element={<Home version={version} theme={theme} />} />
              <Route path="/dashboard" element={<Dashboard version={version} />} />
              <Route path="/notes" element={<Notes version={version} onReviewed={reloadDash} />} />
              <Route path="/note/:id" element={<Notes version={version} onReviewed={reloadDash} />} />
              <Route path="/review" element={<Review version={version} onReviewed={reloadDash} />} />
              {/* 旧链接兼容：/review/:id 曾经是"按篇复习某条笔记"，
                  现在 /review 是英语词汇 Anki，带 id 的一律送回笔记原文 */}
              <Route path="/review/:id" element={<LegacyReviewRedirect />} />
              <Route path="/schedule" element={<Schedule version={version} />} />
              <Route path="/schedule/:year" element={<Schedule version={version} />} />
              <Route path="/schedule/:year/:month" element={<Schedule version={version} />} />
              <Route path="/schedule/:year/:month/:day" element={<Schedule version={version} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </motion.div>
        </AnimatePresence>
      </Shell>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

/** 笔记之间、日程层级之间切换不做整页动画，交给视图内部的共享元素过渡 */
function routeKey(pathname) {
  if (pathname.startsWith('/note')) return 'notes';
  if (pathname.startsWith('/schedule')) return 'schedule';
  if (pathname.startsWith('/review')) return 'review';
  return pathname;
}

/** 把 /review/:id 换算回 /note/:id。id 在 URL 里是编码过的，要先解码再重新编码 */
function LegacyReviewRedirect() {
  const { id } = useParams();
  let decoded = id || '';
  try { decoded = decodeURIComponent(id || ''); } catch { /* 编码坏了就按原样走 */ }
  if (!decoded) return <Navigate to="/notes" replace />;
  return <Navigate to={`/note/${encodeURIComponent(decoded)}`} replace />;
}
