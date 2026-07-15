import { defineConfig } from 'vite';

// base: './' so the built dist/ can be opened locally (and embedded in the vault).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    minify: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5183,
    open: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
