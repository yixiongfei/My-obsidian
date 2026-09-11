import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import '@fontsource-variable/archivo';
import 'katex/dist/katex.min.css';
import './styles/base.css';
import './styles/markdown.css';
import './styles/views.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 提前打开 v7 行为，顺带消掉两条 future flag 警告——警告刷屏会盖住真报错 */}
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
