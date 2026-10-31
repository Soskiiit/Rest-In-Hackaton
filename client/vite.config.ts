/// <reference types="vitest" />
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0', // Exposes client to LAN for team laptop multiplayer
    port: 5173,
    strictPort: true,
    cors: true,
    proxy: { '/ai': { target: 'http://127.0.0.1:8000', rewrite: (path) => path.replace(/^\/ai/, '') } }
  },
  preview: {
    proxy: { '/ai': { target: 'http://127.0.0.1:8000', rewrite: (path) => path.replace(/^\/ai/, '') } },
    host: '0.0.0.0',
    port: 5173,
    strictPort: true
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts']
  }
});
