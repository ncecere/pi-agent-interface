import { existsSync } from 'node:fs';
import { FEATURE_IDS, isFeatureId } from './features.ts';
import { type GroupRules, groupRules } from './groups.ts';

/** A development account: signs in with no password (DEV_AUTH, loopback only). */
export interface DevAccount {
  id: string;
  name: string;
  email: string;
}

/** The development accounts when DEV_ACCOUNTS is not set. */
export const DEFAULT_DEV_ACCOUNTS: readonly DevAccount[] = [
  { id: 'tim', name: 'Tim', email: 'tim@example.test' },
  { id: 'bob', name: 'Bob', email: 'bob@example.test' },
  { id: 'sally', name: 'Sally', email: 'sally@example.test' },
];

/**
 * DEV_ACCOUNTS: a JSON array of `{id, name, email}`. Problems are appended to
 * `problems`; an unusable value yields the default accounts.
 */
export function parseDevAccounts(text: string, problems: string[]): readonly DevAccount[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    problems.push('DEV_ACCOUNTS is not valid JSON (an array of {id, name, email})');
    return DEFAULT_DEV_ACCOUNTS;
  }
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(
      'DEV_ACCOUNTS must be a JSON array of {id, name, email}, with at least one account',
    );
    return DEFAULT_DEV_ACCOUNTS;
  }
  const accounts: DevAccount[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const email = typeof entry.email === 'string' ? entry.email.trim() : '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id))
      problems.push(
        `DEV_ACCOUNTS[${index}]: id is 1 to 64 letters, digits, dots, dashes or underscores`,
      );
    else if (seen.has(id)) problems.push(`DEV_ACCOUNTS[${index}]: the id "${id}" is used twice`);
    if (!name) problems.push(`DEV_ACCOUNTS[${index}]: name is required`);
    if (!email) problems.push(`DEV_ACCOUNTS[${index}]: email is required`);
    seen.add(id);
    accounts.push({ id, name, email });
  });
  return accounts;
}

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
  /**
   * How the app reaches people's agents (server/connect.ts):
   * - `connect`: each person connects their own platform account once (OAuth
   *   Connect); their agents live in their personal workspace and the app
   *   calls the platform with their token.
   * - `service`: one team service account gives each person agents in that
   *   team (for a platform without Connect).
   * Optional in the config file: `connect` unless a service key is set.
   */
  platformAuth?: 'connect' | 'service';
  /**
   * Connect mode: must the platform account a person connects have the same
   * email as their account here? `require` (the default) refuses a mismatch,
   * which would put their agents in someone else's workspace; `off` for
   * deployments whose two sides use different identity providers.
   */
  connectEmailMatch?: 'require' | 'off';
  /** Service mode: the platform team whose service account this app uses, by slug. */
  platformTeam: string;
  /** Service mode: the team service account's key (role editor), `pdp_sa_…`. Never sent to browsers. */
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
  /**
   * Secrets this app used before (SESSION_SECRET_PREVIOUS), still accepted for opening
   * sessions and stored platform tokens while a rotation completes. New values are always sealed with `sessionSecret`.
   */
  sessionSecretPrevious?: string[];
  sessionTtlSeconds: number;
  /** Single sign-on; all three or none. */
  oidc: { issuer: URL; clientId: string; clientSecret: string; scopes: string } | null;
  /** Who may sign in and who is an administrator, by the provider's groups; null when groups play no part. */
  oidcGroups?: GroupRules | null;
  /** Fixed development accounts with no password. Only with a loopback APP_URL. */
  devAuth: boolean;
  /** The accounts DEV_AUTH offers (DEV_ACCOUNTS); only read while `devAuth` is on. Default: tim, bob and sally. */
  devAccounts?: readonly DevAccount[];
  /** Serve the built web app from here (production). */
  staticDir: string | null;
  /** The chat app's own Postgres: people, roles, settings, preferences. */
  databaseUrl: string;
  /** Becomes an administrator on signing in while there is no administrator (the bootstrap). */
  initialAdminEmail: string | null;
  /** Optional features this deployment turns off for good (features.ts); administrators cannot turn them on. */
  disabledFeatures?: string[];
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

  const sessionSecretPrevious = (env.SESSION_SECRET_PREVIOUS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== sessionSecret);
  if (sessionSecretPrevious.some((value) => value.length < 32))
    problems.push('SESSION_SECRET_PREVIOUS: every secret must be at least 32 characters');

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
  const oidcGroups = groupRules(env);
  if (oidcGroups && !oidc)
    problems.push('OIDC_ALLOWED_GROUPS and OIDC_ADMIN_GROUPS need single sign-on (OIDC_*)');
  if (!oidc && !devAuth) problems.push('Configure OIDC_* for sign-in (or DEV_AUTH=true locally)');

  if (oidc && oidc.issuer.protocol !== 'https:' && !isLoopback(oidc.issuer))
    problems.push('OIDC_ISSUER must use https');

  const platformUrl = url('PLATFORM_URL');
  const authSetting = env.PLATFORM_AUTH?.trim();
  if (authSetting && authSetting !== 'connect' && authSetting !== 'service')
    problems.push('PLATFORM_AUTH is connect or service');
  const platformAuth: 'connect' | 'service' =
    authSetting === 'service' || authSetting === 'connect'
      ? authSetting
      : env.PLATFORM_SERVICE_KEY?.trim()
        ? 'service'
        : 'connect';
  const matchSetting = env.CONNECT_EMAIL_MATCH?.trim();
  if (matchSetting && matchSetting !== 'require' && matchSetting !== 'off')
    problems.push('CONNECT_EMAIL_MATCH is require or off');
  const serviceOnly = (name: string) =>
    platformAuth === 'service' ? required(name) : (env[name]?.trim() ?? '');
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
    platformAuth,
    connectEmailMatch: matchSetting === 'off' ? 'off' : 'require',
    platformTeam: serviceOnly('PLATFORM_TEAM'),
    platformServiceKey: serviceOnly('PLATFORM_SERVICE_KEY'),
    agentTemplate: env.AGENT_TEMPLATE?.trim() ?? '',
    agentName: env.AGENT_NAME?.trim() || 'Assistant',
    agentModel: env.AGENT_MODEL?.trim() ?? '',
    sessionSecret,
    sessionSecretPrevious: [...new Set(sessionSecretPrevious)],
    sessionTtlSeconds: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 : 168 * 3600,
    oidc,
    oidcGroups,
    devAuth,
    ...(devAuth && env.DEV_ACCOUNTS?.trim()
      ? { devAccounts: parseDevAccounts(env.DEV_ACCOUNTS, problems) }
      : {}),
    staticDir: env.STATIC_DIR?.trim() || null,
    databaseUrl: required('DATABASE_URL'),
    initialAdminEmail: env.INITIAL_ADMIN_EMAIL?.trim() || null,
    disabledFeatures: (env.DISABLED_FEATURES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  };
  for (const name of config.disabledFeatures ?? [])
    if (!isFeatureId(name))
      problems.push(
        `DISABLED_FEATURES: there is no feature "${name}" (known: ${FEATURE_IDS.join(', ')})`,
      );
  if (problems.length) throw new Error(`Configuration:\n  - ${problems.join('\n  - ')}`);
  return config;
}

/** `.env.local` then `.env`, when present (development). Real environment variables win. */
export function loadEnvFiles() {
  for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
}
