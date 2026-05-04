import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const YOKE_PORT = parseInt(process.env['YOKE_PORT'] ?? '7777', 10);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // The graph route lazy-loads elkjs (~1.5 MB) on demand; raise the
    // warning ceiling so its async chunk doesn't trip the default 500 kB.
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sw: resolve(__dirname, 'src/sw.ts'),
      },
      output: {
        entryFileNames: ({ name }) =>
          name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('react-router')) return 'router';
          if (id.includes('@tanstack')) return 'tanstack';
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/scheduler/')
          )
            return 'react';
        },
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
