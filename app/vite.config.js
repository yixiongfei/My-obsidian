import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:5174';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
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
