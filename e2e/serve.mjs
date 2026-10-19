// Starts one built copy of the app for the browser tests, on a database of its own (dropped and made again each time).
//
//   node e2e/serve.mjs service|connect
//
// `service`: a team service account (the fake platform's team). `connect`: people connect their own platform account.
// Both sign in with the development accounts (the fictional people of e2e/platform/world.mjs).
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { PEOPLE } from './platform/world.mjs';

const mode = process.argv[2];
if (mode !== 'service' && mode !== 'connect') throw new Error('usage: serve.mjs service|connect');

const adminUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://pai:pai-local-only@127.0.0.1:55433/pai',
);
const name = `pai_e2e_${mode}`;
const admin = postgres(adminUrl.href, { max: 1, onnotice: () => undefined });
await admin.unsafe(`drop database if exists ${name} with (force)`);
await admin.unsafe(`create database ${name}`);
await admin.end({ timeout: 2 });
const databaseUrl = new URL(adminUrl.href);
databaseUrl.pathname = `/${name}`;

const port = mode === 'service' ? 5291 : 5292;
Object.assign(process.env, {
  HOST: '127.0.0.1',
  PORT: String(port),
  APP_URL: `http://localhost:${port}`,
  DATABASE_URL: databaseUrl.href,
  SESSION_SECRET: 'e2e-only-secret-e2e-only-secret-e2e-only',
  STATIC_DIR: fileURLToPath(new URL('../dist', import.meta.url)),
  DEV_AUTH: 'true',
  DEV_ACCOUNTS: JSON.stringify(PEOPLE.map(({ id, name, email }) => ({ id, name, email }))),
  INITIAL_ADMIN_EMAIL: 'morgan.lee@example.com',
  PLATFORM_URL: 'http://localhost:8299',
  PLATFORM_AUTH: mode,
  ...(mode === 'service'
    ? { PLATFORM_SERVICE_KEY: 'pdp_sa_e2e', PLATFORM_TEAM: 'example-corp' }
    : { PLATFORM_SERVICE_KEY: '', PLATFORM_TEAM: '' }),
});
await import(pathToFileURL(new URL('../dist-server/main.js', import.meta.url).pathname).href);
