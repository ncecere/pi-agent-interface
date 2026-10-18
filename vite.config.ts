import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * The platform's APP_URL (pi-durable-platform .env). Requests are proxied so
 * the browser sees one origin, as in production where the platform (or a
 * reverse proxy) serves this UI beside /v1 and /auth.
 */
const PLATFORM_URL = new URL(process.env.PLATFORM_URL ?? 'http://localhost:8098');
// Connect over IPv4: the platform listens on 127.0.0.1, and Node may resolve
// "localhost" to ::1 first.
const target = `${PLATFORM_URL.protocol}//${PLATFORM_URL.hostname === 'localhost' ? '127.0.0.1' : PLATFORM_URL.hostname}:${PLATFORM_URL.port}`;

/**
 * Development only. The platform accepts browser writes from its own origin
 * (APP_URL), and dev login only when addressed to APP_URL's host. This dev
 * server is a different origin, so it presents the request as the platform's
 * own; the session cookie and the X-CSRF-Token header still have to match.
 */
const platform: ProxyOptions = {
  target,
  changeOrigin: false,
  configure(proxy) {
    proxy.on('proxyReq', (request) => {
      request.setHeader('host', PLATFORM_URL.host);
      if (request.getHeader('origin')) request.setHeader('origin', PLATFORM_URL.origin);
    });
  },
};

const proxy = { '/v1': platform, '/auth': platform, '/healthz': platform };

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
