import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * Development against a pi-durable-platform, local or remote. The browser
 * sees one origin (this dev server), as in production where the platform or
 * a reverse proxy serves this UI beside /v1 and /auth.
 *
 * Settings (environment, or .env.local, which is git-ignored):
 *
 * - PLATFORM_URL: the platform's address (its APP_URL), default
 *   http://localhost:8098.
 * - PLATFORM_SESSION: for a remote platform with single sign-on. Its sign-in
 *   returns to the platform's own domain, so the session cookie never reaches
 *   localhost. Sign in on the platform, copy the value of its session cookie
 *   (`__Host-pdp_session` over https), and the proxy sends it with every
 *   request. It stays in this Node process; the browser never sees it.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const platformUrl = new URL(env.PLATFORM_URL ?? 'http://localhost:8098');
  const secure = platformUrl.protocol === 'https:';
  const session = env.PLATFORM_SESSION?.trim();
  const cookieName = secure ? '__Host-pdp_session' : 'pdp_session';
  // A local platform listens on 127.0.0.1, and Node may resolve "localhost" to ::1 first.
  const target =
    platformUrl.hostname === 'localhost'
      ? `${platformUrl.protocol}//127.0.0.1:${platformUrl.port}`
      : platformUrl.origin;

  /**
   * The platform accepts browser writes only from its own origin (APP_URL),
   * so requests are presented as coming from it. The session cookie and the
   * X-CSRF-Token header still have to match, as for any browser.
   */
  const platform: ProxyOptions = {
    target,
    changeOrigin: true,
    secure: true,
    configure(proxy) {
      proxy.on('proxyReq', (request) => {
        request.setHeader('host', platformUrl.host);
        if (request.getHeader('origin')) request.setHeader('origin', platformUrl.origin);
        if (session) request.setHeader('cookie', `${cookieName}=${session}`);
      });
      proxy.on('proxyRes', (response) => {
        // A __Host- cookie cannot be set on http://localhost; with an injected
        // session, signing out here must not try to clear it either.
        if (session || secure) delete response.headers['set-cookie'];
      });
    },
  };
  const proxy = { '/v1': platform, '/auth': platform, '/healthz': platform };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    define: {
      // Shown on the sign-in page in development, to explain remote sign-in.
      __DEV_PLATFORM__: JSON.stringify(
        mode === 'development'
          ? { url: platformUrl.origin, remote: secure, session: Boolean(session), cookieName }
          : null,
      ),
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
  };
});
