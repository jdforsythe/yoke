import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const YOKE_PORT = parseInt(process.env['YOKE_PORT'] ?? '3456', 10);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sw: resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: ({ name }) =>
          name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${YOKE_PORT}`,
        changeOrigin: false,
      },
      '/stream': {
        target: `ws://127.0.0.1:${YOKE_PORT}`,
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
