import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { loadConfig, loadEnvFiles } from './config.ts';
import { migrate, PgStore, waitForDatabase } from './store-pg.ts';

loadEnvFiles();
const config = loadConfig();
const store = PgStore.connect(config.databaseUrl);
await waitForDatabase(store.sql);
const applied = await migrate(store.sql);
if (applied.length) console.log(`[server] database migrated: ${applied.join(', ')}`);
const app = createApp(config, { store });

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

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      void store.close().finally(() => process.exit(0));
    }),
  );
