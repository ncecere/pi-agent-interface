import { createHash } from 'node:crypto';
import type { Config } from './config.ts';
import { Sealer, secretsOf, token } from './session.ts';
import type { PlatformConnection, Store } from './store.ts';

/**
 * OAuth Connect: each person connects this app to their own account on the
 * platform once, and the server then calls the platform with *their* token,
 * so their agents live in their personal workspace and the platform decides
 * what they may use. The platform is an OAuth 2.1 authorization server
 * (authorization code with PKCE S256, public clients, rotating refresh
 * tokens).
 *
 * - **Who this app is:** on an https APP_URL, a Client ID Metadata Document
 *   at `<APP_URL>/oauth/client-metadata.json`, whose URL is the client_id.
 *   On a loopback http APP_URL (development), a client registered once with
 *   Dynamic Client Registration, kept in the `connect.client` setting and
 *   registered again if the platform has forgotten it (after 30 days unused).
 * - **Tokens** are kept in the database encrypted with a key derived from
 *   SESSION_SECRET. Access tokens last an hour; the refresh token rotates on
 *   every use, so refreshes run one at a time per person (a database lock),
 *   and a request that finds the token already refreshed uses the new one.
 * - A refresh the platform refuses (the person disconnected the app, or an
 *   administrator revoked it) forgets the connection: the person is asked to
 *   connect again.
 */

/** The person has no working connection: connect (again). */
export class NotConnected extends Error {
  constructor(message = 'Connect your agents to continue.') {
    super(message);
    this.name = 'NotConnected';
  }
}

/** The platform refused the connection (the person declined, or a misconfiguration). */
export class ConnectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

interface Endpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
}

interface TokenReply {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface PendingConnect {
  state: string;
  verifier: string;
  personId: string;
  clientId: string;
  returnTo: string;
  expiresAt: number;
}

const ENDPOINTS_TTL_MS = 10 * 60_000;
/** Refresh a little before the access token runs out. */
const REFRESH_EARLY_MS = 2 * 60_000;
const PENDING_TTL_S = 10 * 60;
const SCOPE = 'agents';
const CLIENT_SETTING = 'connect.client';

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export class Connect {
  private endpointsCache: { at: number; value: Endpoints } | null = null;
  private readonly tokens: Sealer;
  private readonly pending: Sealer;

  constructor(
    private readonly config: Pick<
      Config,
      'appUrl' | 'platformUrl' | 'sessionSecret' | 'sessionSecretPrevious'
    >,
    private readonly store: Store,
    /** The app's name, for the platform's approval screen and Connected apps. */
    private readonly appName: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.tokens = new Sealer(secretsOf(config), 'platform-tokens');
    this.pending = new Sealer(secretsOf(config), 'connect-pending');
  }

  get redirectUri(): string {
    return new URL('/connect/callback', this.config.appUrl).toString();
  }

  /** On https the app identifies itself with a metadata document; on loopback http it registers. */
  get usesMetadataDocument(): boolean {
    return this.config.appUrl.protocol === 'https:';
  }

  get metadataUrl(): string {
    return new URL('/oauth/client-metadata.json', this.config.appUrl).toString();
  }

  /** The Client ID Metadata Document this app publishes. */
  async metadata() {
    return {
      client_id: this.metadataUrl,
      client_name: await this.appName(),
      client_uri: this.config.appUrl.origin,
      logo_uri: new URL('/icon-192.png', this.config.appUrl).toString(),
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    };
  }

  private platform(path: string): string {
    return new URL(path, this.config.platformUrl).toString();
  }

  /** The platform's OAuth endpoints, from `connect` in GET /v1/auth/config (cached ten minutes). */
  async endpoints(): Promise<Endpoints> {
    if (this.endpointsCache && Date.now() - this.endpointsCache.at < ENDPOINTS_TTL_MS)
      return this.endpointsCache.value;
    const response = await this.fetchImpl(this.platform('/v1/auth/config'), { redirect: 'manual' });
    if (!response.ok)
      throw new ConnectError('platform_unavailable', `The platform answered ${response.status}.`);
    const body = (await response.json()) as { data?: { connect?: Endpoints } };
    const connect = body.data?.connect;
    if (!connect?.authorizationEndpoint || !connect.tokenEndpoint)
      throw new ConnectError(
        'connect_unsupported',
        "The platform doesn't offer Connect (no `connect` in /v1/auth/config).",
      );
    this.endpointsCache = { at: Date.now(), value: connect };
    return connect;
  }

  /** This app's client_id: the metadata document's URL, or the registered client's id. */
  async clientId(): Promise<string> {
    if (this.usesMetadataDocument) return this.metadataUrl;
    const endpoints = await this.endpoints();
    const saved = (await this.store.setting(CLIENT_SETTING)) as {
      clientId?: string;
      redirectUri?: string;
      issuer?: string;
    } | null;
    if (
      saved?.clientId &&
      saved.redirectUri === this.redirectUri &&
      saved.issuer === endpoints.issuer
    )
      return saved.clientId;
    if (!endpoints.registrationEndpoint)
      throw new ConnectError(
        'registration_unsupported',
        'The platform has no client registration, and this app is not on https (it needs one or the other).',
      );
    const response = await this.fetchImpl(endpoints.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: await this.appName(),
        client_uri: this.config.appUrl.origin,
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        scope: SCOPE,
      }),
      redirect: 'manual',
    });
    const reply = (await response.json().catch(() => ({}))) as {
      client_id?: string;
      error_description?: string;
    };
    if (!response.ok || !reply.client_id)
      throw new ConnectError(
        'registration_failed',
        `The platform refused to register this app: ${reply.error_description ?? response.status}.`,
      );
    await this.store.setSetting(
      CLIENT_SETTING,
      { clientId: reply.client_id, redirectUri: this.redirectUri, issuer: endpoints.issuer },
      null,
    );
    return reply.client_id;
  }

  /** The platform forgot a registered client (unused for 30 days): register again next time. */
  private async forgetClient() {
    if (!this.usesMetadataDocument) await this.store.setSetting(CLIENT_SETTING, null, null);
  }

  /**
   * Where to send the person to connect, and the sealed state to keep in a
   * cookie until they come back.
   */
  async start(personId: string, returnTo: string): Promise<{ url: string; pending: string }> {
    const [endpoints, clientId] = await Promise.all([this.endpoints(), this.clientId()]);
    const verifier = b64url(Buffer.from(token(32)));
    const state = token(16);
    const url = new URL(endpoints.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: this.redirectUri,
      state,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
      scope: SCOPE,
    }).toString();
    const pending: PendingConnect = {
      state,
      verifier,
      personId,
      clientId,
      returnTo,
      expiresAt: Math.floor(Date.now() / 1000) + PENDING_TTL_S,
    };
    return { url: url.toString(), pending: this.pending.seal(pending) };
  }

  /** The person came back from the platform: check, exchange the code, keep the tokens. Returns where to go. */
  async finish(
    personId: string,
    query: Record<string, string | undefined>,
    sealed: string | undefined,
    /**
     * The person's email here, and whether the platform account must be the
     * same one. Two accounts of different people would put the person's
     * agents and conversations in someone else's workspace.
     */
    expected: { email: string; match: 'require' | 'off' } = { email: '', match: 'off' },
  ): Promise<string> {
    const pending = this.pending.open<PendingConnect>(sealed);
    if (
      !pending ||
      pending.personId !== personId ||
      pending.expiresAt < Date.now() / 1000 ||
      !query.state ||
      query.state !== pending.state
    )
      throw new ConnectError('invalid_state', 'That connection attempt expired. Try again.');
    const endpoints = await this.endpoints();
    if (query.iss && query.iss !== endpoints.issuer)
      throw new ConnectError('invalid_issuer', 'The answer came from another server.');
    if (query.error)
      throw new ConnectError(
        query.error,
        query.error === 'access_denied'
          ? 'You chose not to connect.'
          : (query.error_description ?? 'The platform refused the connection.'),
      );
    if (!query.code) throw new ConnectError('invalid_request', 'The platform sent no code.');
    const reply = await this.tokenRequest(endpoints, {
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    if ('error' in reply) {
      if (reply.error === 'invalid_client') await this.forgetClient();
      throw new ConnectError(reply.error, reply.description);
    }
    const me = await this.whoIs(reply.access_token);
    if (
      expected.match === 'require' &&
      expected.email &&
      me?.email &&
      me.email.toLowerCase() !== expected.email.toLowerCase()
    ) {
      await this.revokeRefresh(reply.refresh_token, pending.clientId);
      throw new ConnectError(
        'account_mismatch',
        `You connected ${me.email} on the agent platform, but you're signed in here as ${expected.email}. Sign out of ${this.config.platformUrl.host}, then connect again with the same account.`,
      );
    }
    await this.save(personId, reply, me);
    return pending.returnTo;
  }

  private async whoIs(accessToken: string) {
    const response = await this.fetchImpl(this.platform('/v1/me'), {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'manual',
    });
    if (!response.ok) return null;
    type Who = { id?: string; email?: string; displayName?: string };
    const body = (await response.json()) as { data?: Who & { user?: Who } };
    const user = body.data?.user ?? body.data;
    return user
      ? { id: user.id ?? null, email: user.email ?? null, name: user.displayName ?? null }
      : null;
  }

  private async save(
    personId: string,
    reply: TokenReply,
    me: { id: string | null; email: string | null; name: string | null } | null,
    previous?: PlatformConnection,
  ) {
    await this.store.saveConnection(personId, {
      accessToken: this.tokens.seal(reply.access_token),
      accessExpiresAt: new Date(Date.now() + Math.max(60, reply.expires_in || 3600) * 1000),
      refreshToken: this.tokens.seal(reply.refresh_token),
      platformUserId: me?.id ?? previous?.platformUserId ?? null,
      platformEmail: me?.email ?? previous?.platformEmail ?? null,
      platformName: me?.name ?? previous?.platformName ?? null,
      updatedAt: new Date(),
    });
  }

  private async tokenRequest(
    endpoints: Endpoints,
    form: Record<string, string>,
  ): Promise<TokenReply | { error: string; description: string }> {
    const response = await this.fetchImpl(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
    const body = (await response.json().catch(() => ({}))) as Partial<TokenReply> & {
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !body.access_token || !body.refresh_token)
      return {
        error: body.error ?? `http_${response.status}`,
        description: body.error_description ?? `The platform answered ${response.status}.`,
      };
    return body as TokenReply;
  }

  /** Who the person is on the platform, as last seen; null when not connected. */
  async account(personId: string) {
    const row = await this.store.connection(personId);
    return row
      ? { email: row.platformEmail, name: row.platformName, since: row.updatedAt.toISOString() }
      : null;
  }

  /**
   * A working access token for the person. `stale` is a token the platform
   * just refused: refresh unless someone already has.
   */
  async accessToken(personId: string, stale?: string): Promise<string> {
    const row = await this.store.connection(personId);
    if (!row) throw new NotConnected();
    const current = this.tokens.open<string>(row.accessToken);
    if (
      current &&
      current !== stale &&
      row.accessExpiresAt.getTime() - Date.now() > REFRESH_EARLY_MS
    )
      return current;
    return this.store.withConnectionLock(personId, async () => {
      // Read again inside the lock: another request (or replica) may have refreshed meanwhile.
      const locked = await this.store.connection(personId);
      if (!locked) throw new NotConnected();
      const now = this.tokens.open<string>(locked.accessToken);
      if (now && now !== stale && locked.accessExpiresAt.getTime() - Date.now() > REFRESH_EARLY_MS)
        return now;
      const refresh = this.tokens.open<string>(locked.refreshToken);
      if (!refresh) {
        await this.store.removeConnection(personId);
        throw new NotConnected();
      }
      const endpoints = await this.endpoints();
      const reply = await this.tokenRequest(endpoints, {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: await this.clientId(),
      });
      if ('error' in reply) {
        if (reply.error === 'invalid_grant' || reply.error === 'invalid_client') {
          if (reply.error === 'invalid_client') await this.forgetClient();
          await this.store.removeConnection(personId);
          throw new NotConnected('Your connection to the agent platform ended. Connect again.');
        }
        throw new ConnectError(reply.error, reply.description);
      }
      await this.save(personId, reply, null, locked);
      return reply.access_token;
    });
  }

  /**
   * A request to the platform as the person. A 401 refreshes once and tries
   * again; a second 401 means the connection is gone.
   */
  async fetchAs(personId: string, path: string, init: RequestInit = {}): Promise<Response> {
    const send = (accessToken: string) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (init.body !== undefined && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
      return this.fetchImpl(this.platform(path), { ...init, headers, redirect: 'manual' });
    };
    const first = await this.accessToken(personId);
    const response = await send(first);
    if (response.status !== 401) return response;
    await response.body?.cancel().catch(() => undefined);
    const second = await this.accessToken(personId, first);
    const retried = await send(second);
    if (retried.status === 401) {
      await retried.body?.cancel().catch(() => undefined);
      await this.store.removeConnection(personId);
      throw new NotConnected('Your connection to the agent platform ended. Connect again.');
    }
    return retried;
  }

  /** Disconnects: revokes the refresh token on the platform (best effort) and forgets the tokens. */
  async disconnect(personId: string) {
    const row = await this.store.connection(personId);
    if (!row) return;
    const refresh = this.tokens.open<string>(row.refreshToken);
    if (refresh) await this.revokeRefresh(refresh);
    await this.store.removeConnection(personId);
  }

  /** Revokes a refresh token on the platform (best effort: the person is disconnected here either way). */
  private async revokeRefresh(refresh: string, clientId?: string) {
    try {
      const endpoints = await this.endpoints();
      if (!endpoints.revocationEndpoint) return;
      await this.fetchImpl(endpoints.revocationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refresh,
          token_type_hint: 'refresh_token',
          client_id: clientId ?? (await this.clientId()),
        }).toString(),
        redirect: 'manual',
      });
    } catch (error) {
      console.warn('[connect] the refresh token could not be revoked', error);
    }
  }
}

/**
 * After a rotation of SESSION_SECRET: seals every stored platform token that
 * only a previous secret opens with the current one, so the previous secret can
 * be dropped without anyone having to connect again. Safe to run on every
 * start, and by two replicas at once.
 */
export async function resealConnections(
  config: Pick<Config, 'sessionSecret' | 'sessionSecretPrevious'>,
  store: Store,
): Promise<{ resealed: number; unreadable: number }> {
  const tokens = new Sealer(secretsOf(config), 'platform-tokens');
  let resealed = 0;
  let unreadable = 0;
  for (const personId of await store.connectionIds()) {
    await store.withConnectionLock(personId, async () => {
      const row = await store.connection(personId);
      if (!row) return;
      const access = tokens.open<string>(row.accessToken);
      const refresh = tokens.open<string>(row.refreshToken);
      if (access === null || refresh === null) {
        unreadable++;
        return;
      }
      if (!tokens.needsReseal(row.accessToken) && !tokens.needsReseal(row.refreshToken)) return;
      await store.saveConnection(personId, {
        ...row,
        accessToken: tokens.seal(access),
        refreshToken: tokens.seal(refresh),
      });
      resealed++;
    });
  }
  return { resealed, unreadable };
}
