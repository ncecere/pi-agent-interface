import { existsSync } from 'node:fs';

/**
 * The chat server's settings, from the environment (and `.env.local` in
 * development). Read once at start; anything missing or unsafe stops the
 * server with every problem listed, rather than failing on first use.
 */
export interface Config {
  /** Where people reach this app, e.g. https://chat.example.com. Its origin is the only one allowed to write. */
  appUrl: URL;
  /** The address to listen on: loopback for development, 0.0.0.0 in a container. */
  host: string;
  port: number;
  /** pi-durable-platform's address. */
  platformUrl: URL;
  /** The platform team whose service account this app uses, by slug. */
  platformTeam: string;
  /** The team service account's key (role editor), `pdp_sa_…`. Never sent to browsers. */
  platformServiceKey: string;
  /** Platform template every person's assistant is created from; empty for the platform's default. */
  agentTemplate: string;
  /** What the app calls a person's assistant. */
  agentName: string;
  /**
   * The model every assistant runs on, by name or id, from those published to
   * the team. Empty: the platform decides (the agent's template, then its default).
   */
  agentModel: string;
  /** 32+ characters; encrypts session cookies. Changing it signs everyone out. */
  sessionSecret: string;
  sessionTtlSeconds: number;
  /** Single sign-on; all three or none. */
  oidc: { issuer: URL; clientId: string; clientSecret: string; scopes: string } | null;
  /** Fixed development accounts with no password. Only with a loopback APP_URL. */
  devAuth: boolean;
  /** Serve the built web app from here (production). */
  staticDir: string | null;
  /** The chat app's own Postgres: people, roles, settings, preferences. */
  databaseUrl: string;
  /** Becomes an administrator on signing in while there is no administrator (the bootstrap). */
  initialAdminEmail: string | null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopback(url: URL): boolean {
  return LOOPBACK.has(url.hostname);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const url = (name: string, fallback?: string): URL => {
    const value = env[name]?.trim() || fallback;
    if (!value) {
      problems.push(`${name} is required`);
      return new URL('http://invalid');
    }
    try {
      return new URL(value);
    } catch {
      problems.push(`${name} is not a URL`);
      return new URL('http://invalid');
    }
  };
  const required = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (!value) problems.push(`${name} is required`);
    return value;
  };

  const appUrl = url('APP_URL', 'http://localhost:5177');
  const devAuth = env.DEV_AUTH === 'true';
  if (devAuth && !isLoopback(appUrl)) problems.push('DEV_AUTH requires a loopback APP_URL');

  const sessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');

  const issuer = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  let oidc: Config['oidc'] = null;
  if (issuer || clientId || clientSecret) {
    if (!issuer || !clientId || !clientSecret)
      problems.push('OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET go together');
    else
      oidc = {
        issuer: url('OIDC_ISSUER'),
        clientId,
        clientSecret,
        scopes: env.OIDC_SCOPES?.trim() || 'openid profile email',
      };
  }
  if (!oidc && !devAuth) problems.push('Configure OIDC_* for sign-in (or DEV_AUTH=true locally)');

  if (oidc && oidc.issuer.protocol !== 'https:' && !isLoopback(oidc.issuer))
    problems.push('OIDC_ISSUER must use https');

  const platformUrl = url('PLATFORM_URL');
  if (platformUrl.protocol !== 'https:' && !isLoopback(platformUrl))
    problems.push('PLATFORM_URL must use https (the service key travels with every request)');
  if (appUrl.protocol !== 'https:' && !isLoopback(appUrl))
    problems.push('APP_URL must use https outside local development');

  const ttlHours = Number(env.SESSION_TTL_HOURS ?? 168);
  const config: Config = {
    appUrl,
    host: env.HOST?.trim() || '127.0.0.1',
    port: Number(env.PORT ?? 5178),
    platformUrl,
    platformTeam: required('PLATFORM_TEAM'),
    platformServiceKey: required('PLATFORM_SERVICE_KEY'),
    agentTemplate: env.AGENT_TEMPLATE?.trim() ?? '',
    agentName: env.AGENT_NAME?.trim() || 'Assistant',
    agentModel: env.AGENT_MODEL?.trim() ?? '',
    sessionSecret,
    sessionTtlSeconds: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 : 168 * 3600,
    oidc,
    devAuth,
    staticDir: env.STATIC_DIR?.trim() || null,
    databaseUrl: required('DATABASE_URL'),
    initialAdminEmail: env.INITIAL_ADMIN_EMAIL?.trim() || null,
  };
  if (problems.length) throw new Error(`Configuration:\n  - ${problems.join('\n  - ')}`);
  return config;
}

/** `.env.local` then `.env`, when present (development). Real environment variables win. */
export function loadEnvFiles() {
  for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
}
