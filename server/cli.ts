import { loadEnvFiles } from './config.ts';
import { migrate, PgStore } from './store-pg.ts';

/**
 * Lockout recovery, run on the server:
 *   pnpm admin:promote <email>             (development)
 *   node dist-server/cli.js promote <email> (a container)
 * Makes the person with that email an active administrator. They must have signed in once.
 */
loadEnvFiles();
const [command, email] = process.argv.slice(2);
if (command !== 'promote' || !email) {
  console.error('Usage: promote <email>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const store = PgStore.connect(url);
try {
  await migrate(store.sql);
  const person = await store.promote(email);
  if (!person) {
    console.error(
      `No one with the email ${email} has signed in yet. They must sign in once first.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`${person.name || person.email} is now an administrator.`);
  }
} finally {
  await store.close();
}
