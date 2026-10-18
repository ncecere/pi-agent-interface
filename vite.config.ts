import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * In development the chat server (server/, `pnpm dev:server`) runs on
 * 127.0.0.1:5178 and this dev server proxies /api and /auth to it, so the
 * browser sees one origin (APP_URL, http://localhost:5177), as in production
 * where the chat server serves the built app itself.
 */
const server: ProxyOptions = {
  target: `http://127.0.0.1:${process.env.PORT ?? 5178}`,
  changeOrigin: false,
};
// The app's own server: its API, sign-in, and Connect (the platform's OAuth flow and this app's metadata document).
const proxy = {
  '/api': server,
  '/auth': server,
  '/connect/start': server,
  '/connect/callback': server,
  '/oauth': server,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5177, strictPort: true, proxy },
  preview: { port: 5177, proxy },
  build: {
    outDir: 'dist',
    sourcemap: true,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'initial-shared', tags: ['$initial'], minShareCount: 2 }],
        },
      },
    },
  },
});
