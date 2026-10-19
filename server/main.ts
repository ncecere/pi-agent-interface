import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { loadConfig, loadEnvFiles } from './config.ts';
import { resealConnections } from './connect.ts';
import { Metrics } from './metrics.ts';
import { migrate, PgStore, waitForDatabase } from './store-pg.ts';

loadEnvFiles();
const config = loadConfig();
const store = PgStore.connect(config.databaseUrl);
await waitForDatabase(store.sql);
const applied = await migrate(store.sql);
if (applied.length) console.log(`[server] database migrated: ${applied.join(', ')}`);
if (config.sessionSecretPrevious?.length) {
  // A rotation in progress: bring every stored platform token under the current secret.
  const done = await resealConnections(config, store);
  console.log(
    `[server] SESSION_SECRET_PREVIOUS is set: ${done.resealed} platform connection(s) sealed again with the current secret` +
      (done.unreadable
        ? `; ${done.unreadable} could not be opened with any secret (those people connect again)`
        : '; the previous secret is no longer needed for them'),
  );
}
const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  }
).version;
const metrics = new Metrics(version);
const app = createApp(config, { store, metrics });

// Production: the built web app, with every other path answered by index.html
// (the router decides). In development Vite serves it and proxies here.
if (config.staticDir) {
  const root = resolve(config.staticDir);
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('*', serveStatic({ root }));
  app.get('*', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    return c.html(index);
  });
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    `[server] http://${config.host}:${info.port} for ${config.appUrl.origin} · platform ${config.platformUrl.origin} · team ${config.platformTeam}` +
      `${config.oidc ? ' · single sign-on' : ''}${config.devAuth ? ' · DEV_AUTH' : ''}`,
  );
});

// Metrics, on a port of their own (so exposing the app does not expose them).
const metricsServer = config.metrics
  ? createServer(async (request, response) => {
      if (request.method !== 'GET' || request.url?.split('?')[0] !== '/metrics') {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        .end(await metrics.render());
    })
  : null;
if (config.metrics && metricsServer)
  metricsServer.listen(config.metrics.port, config.metrics.host, () =>
    console.log(
      `[server] metrics on http://${config.metrics?.host}:${config.metrics?.port}/metrics`,
    ),
  );

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      metricsServer?.close();
      void store.close().finally(() => process.exit(0));
    }),
  );
