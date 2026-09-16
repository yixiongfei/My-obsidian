import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:5174';
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * pdf.js 的 cMap 与标准字体镜像到 web/public/pdfjs/。
 *
 * 便利贴要把 PDF 的第一页渲染成封面图，中文真题 PDF 常引用 Adobe-GB1 这类预定义
 * CMap——缺了它们整页渲染出来是空白。这两份资源在 node_modules 里，打包后的
 * 桌面版没有 node_modules，所以必须先落进 public/ 才能跟着 dist-web 一起走。
 * 复制而不是加个 vite-plugin-static-copy：为这点事多一个构建期依赖不值。
 */
function pdfjsAssets() {
  const from = path.join(here, 'node_modules', 'pdfjs-dist');  // cmaps / standard_fonts 两套构建共用
  const to = path.join(here, 'web', 'public', 'pdfjs');
  const mirror = () => {
    for (const dir of ['cmaps', 'standard_fonts']) {
      const src = path.join(from, dir);
      const dst = path.join(to, dir);
      if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
  };
  return { name: 'kb-pdfjs-assets', buildStart: mirror, configureServer: mirror };
}

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/vault': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
