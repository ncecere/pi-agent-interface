# Pi Agent Interface

A chat app for [Pi Durable](https://github.com/ncecere/pi-durable-platform) agents. People sign in, talk to their
agents, and work across conversations from one inbox: what is working, what has a new reply, what is snoozed, done
or put away. Administrators decide which agents everyone gets, which models and templates people may use, and how the
app looks.

**Website** <https://pai.bitop.dev> · **Documentation** <https://docs.pai.bitop.dev> ·
**Image** `ghcr.io/ncecere/pi-agent-interface` · [Releases](https://github.com/ncecere/pi-agent-interface/releases)

People sign in to **this app** (single sign-on). To reach their agents, the app's server uses the agent platform in one
of two ways (`PLATFORM_AUTH`):

```
Connect (default)                                       Service account
─────────────────                                       ───────────────
person ──sign in──▶ chat server ──person's own token──▶ platform      person ──sign in──▶ chat server ──service key──▶ platform
        └─ connects their platform account once            │                   └─ one team service account           │
                                                           ├─ their personal workspace: their agents                  └─ a team: agent u:<person> each
                                                           └─ their teams' agents
```

- **Connect.** Each person connects their own platform account once, after signing in. Their agents live in their
  personal workspace on the platform, beside the agents of the teams they belong to, and the server calls the platform
  with their token (kept encrypted; the browser never sees it). The platform decides what they may use.
- **Service account.** For a platform without Connect: one team service account gives each person agents in that team
  (`PUT /v1/teams/{team}/agents/by-key/u:<person>`). The service key reaches every person's agent, so the server
  checks on every request that the agent is the signed-in person's own (`server/platform.ts`, tested in
  `tests/server/app.test.ts`).
- **Conversations** live on the platform. The app's own Postgres holds who has signed in, their role (admin or
  user), settings and preferences, the connection tokens, and which agent is each person's copy of a provided agent.
  Sessions are AES-GCM encrypted cookies.

## What you need

1. **A pi-durable-platform.** The app reaches people's agents in one of two ways (`PLATFORM_AUTH`):
   - **`connect`** (the default without a service key; needs a platform with OAuth Connect, which it advertises as
     `connect` in `GET /v1/auth/config`): each person connects their own platform account once, after signing in
     here. Their agents live in **their personal workspace** on the platform, beside their teams' agents, and the
     server calls the platform with their token. Nothing to set up on the platform except that personal
     workspaces are on; the app identifies itself with a Client ID Metadata Document at
     `<APP_URL>/oauth/client-metadata.json` (an administrator of the platform may mark it trusted, so people skip
     the approval screen). On a local `http://localhost` APP_URL it registers itself instead.
   - **`service`** (a platform without Connect): a team (default slug `pi-agent-interface`) with a **service
     account** of role **editor**, and its key (`pdp_sa_…`) → `PLATFORM_SERVICE_KEY`, `PLATFORM_TEAM`. The app
     gives each person agents in that team. Also needs a **model published to the team**, named in `AGENT_MODEL`;
     without one every agent answers from the platform's default.

   In Connect mode, the team-wide Admin → Usage is not available (people's agents aren't in a team the administrators see);
   turn on the feature "Usage of connected people" (off by default) and it reads each connected person's own report instead,
   listing who has not connected. Settings → Usage shows each person their own.
2. **An OpenID Connect provider** (authentik, Keycloak, Entra…): a confidential client whose redirect URI is
   `<APP_URL>/auth/callback`, with the `openid profile email` scopes → `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`. The provider must be reached over https.

## Configuration

Environment variables (a `.env.local` or `.env` file is read too; real variables win). `.env.example` has them all.

| Variable | Meaning |
|---|---|
| `APP_URL` | Where people open the app, e.g. `https://chat.example.com`. Its origin is the only one allowed to write. |
| `PLATFORM_URL` | The platform's address. https outside localhost. |
| `PLATFORM_AUTH` | `connect` or `service` (above). Default: `service` if `PLATFORM_SERVICE_KEY` is set, else `connect`. |
| `CONNECT_EMAIL_MATCH` | Connect mode: `require` (the default) refuses a platform account whose email differs from the person's account here, since it would put their agents in someone else's workspace; `off` where the two sides use different identity providers. |
| `PLATFORM_TEAM`, `PLATFORM_SERVICE_KEY` | Service mode only: the team and its service account's key. Never sent to browsers. |
| `AGENT_TEMPLATE`, `AGENT_NAME` | The platform template each person's assistant is made from, and what the app calls it. |
| `AGENT_MODEL` | The default model, by name or id, until an administrator picks one in Admin → Agents (which wins). Only a model currently published to the team is ever set, since an agent on an unpublished model would not start. Empty: the platform decides. |
| `DATABASE_URL` | The chat app's own Postgres (people, roles, settings, preferences). Migrated on start. Conversations stay on the platform. |
| `INITIAL_ADMIN_EMAIL` | Becomes an administrator on signing in while there is no administrator. After that, admins promote others. |
| `SESSION_SECRET` | 32+ characters (`openssl rand -base64 48`). Encrypts sessions and the stored platform tokens. To replace it without signing everyone out or making them connect again, see "Rotating `SESSION_SECRET`" below; changing it alone signs everyone out and disconnects them. |
| `SESSION_SECRET_PREVIOUS` | Secrets this deployment used before, comma-separated, still accepted for opening sessions and stored tokens during a rotation. Empty normally. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Single sign-on. All three. |
| `OIDC_ALLOWED_GROUPS` | Comma-separated group names. When set, only members of one of these (or of an admin group) can sign in; everyone else sees "isn't allowed" and, if they had signed in before, their sessions end. Empty: anyone your provider signs in. |
| `OIDC_ADMIN_GROUPS` | Comma-separated group names. When set, the provider decides who is an administrator, on every sign-in: members become administrators, others members. Admin → People then can't change roles. The last active administrator is never demoted this way (use `INITIAL_ADMIN_EMAIL`, or the recovery command, to get back in). |
| `OIDC_GROUPS_CLAIM` | Where the provider lists a person's groups: the claim's name (default `groups`), or a dotted path for a nested one (`realm_access.roles`). Looked for in the ID token, then at the userinfo endpoint. Names are matched exactly. The provider must release it: with authentik the default `profile` scope does; with others add the scope in `OIDC_SCOPES`. |
| `DEV_AUTH` | `true` enables the development accounts tim, bob and sally. Refused unless `APP_URL` is loopback. |
| `DEV_ACCOUNTS` | With `DEV_AUTH=true`: the development accounts to offer instead of tim, bob and sally, as a JSON array of `{"id", "name", "email"}` (ids unique: letters, digits, dots, dashes, underscores). Ignored while `DEV_AUTH` is off. |
| `METRICS_ENABLED` | `true` serves Prometheus metrics on a port of their own (below). Off by default. |
| `METRICS_PORT`, `METRICS_HOST` | Where the metrics listen: default `0.0.0.0:9464`. Never the app's own port, so exposing the app does not expose them; do not publish this port outside your cluster or monitoring network. |
| `HOST`, `PORT` | Where to listen (default `127.0.0.1:5178`; the container uses `0.0.0.0:8080`). |
| `SESSION_TTL_HOURS` | Default 168. |
| `DISABLED_FEATURES` | Optional features to turn off for good, comma-separated (e.g. `usage`). See below. |

The server refuses to start, naming every problem, if the configuration is incomplete or unsafe: a platform or
provider that is not https (outside localhost), development accounts on a public address, a short session secret.

### Backing up and restoring

The database holds who has signed in, their role, settings and preferences, each person's encrypted agent-platform tokens,
and which agent is their copy of a provided agent. **Conversations are on the agent platform, not here**, except the searchable copy of their text that the optional `messageSearch` feature keeps (off by default). Back it up like any
PostgreSQL database: a scheduled `pg_dump`, or continuous archiving (point-in-time recovery) if your operator offers it.

To restore: bring the database back, then start the app against it (it migrates on start; the schema version is in
`schema_migrations`). What a restore needs and does:

- **Keep `SESSION_SECRET`** (and `SESSION_SECRET_PREVIOUS`, if a rotation was under way). The stored platform tokens are
  sealed with it; with another secret nobody's connection opens and everyone connects again, and everyone signs in again.
- **Everything in the database is restored as of the recovery point**: people, roles, audit log, saved inbox state, and
  connections. The platform rotates a refresh token every time it is used, so a person whose token was refreshed after the
  recovery point comes back with one the platform has already seen: it refuses it, the app forgets the connection, and the
  person connects again (counted as "ended" in the metrics). Recovering to the latest point avoids this.
- Browser-only state (an unsaved draft) is not in the database and is not restored.

On CloudNativePG with the Barman Cloud plugin, the restore is a new `Cluster` with `bootstrap.recovery` from the object store
(add `recoveryTarget.targetTime` for a point in time), without a `plugins:` entry so it does not write into the backups.
Rehearse it in a scratch namespace rather than beside the live cluster: a namespace with default-deny network policies
blocks a cluster it does not name, and a `Retain` storage class keeps the scratch volumes until you remove them. This was
rehearsed on 2026-10-19 on the reference deployment: the latest state and a point in time (five hours back) were each
restored in about a minute, every table matched the live database, the sealed tokens opened with the live `SESSION_SECRET`,
and the scratch volumes were removed afterwards.

### Metrics

With `METRICS_ENABLED=true` the app answers `GET /metrics` (Prometheus text format) on `METRICS_PORT`, separate from the
app's own port. Labels are route patterns and outcomes, never a person, an ID or a path.

| Metric | What |
| --- | --- |
| `pai_http_requests_total{method,route,status}`, `pai_http_request_duration_seconds{method,route}` | Requests and how long until the response begins (a stream goes on after that). |
| `pai_platform_requests_total{outcome}` | Calls to the agent platform: `ok`, `client_error`, `server_error`, `network_error`, `not_connected`. |
| `pai_connect_token_refreshes_total{outcome}` | Refreshes of people's platform tokens: `ok`, `ended` (the platform ended the connection), `error`. |
| `pai_sign_ins_total{outcome}` | `ok`, `suspended`, `not_allowed`, `failed`, `expired`. |
| `pai_open_streams{kind}` | Conversation streams and live-event streams open now. |
| `pai_database_up` | 1 when the database answered at the scrape. |
| `pai_build_info{version}`, `process_*`, `nodejs_*` | Version, CPU, memory, event-loop lag. |

On Kubernetes, `deploy/kubernetes/components/metrics` turns this on and adds a Service, a ServiceMonitor, a NetworkPolicy
for Prometheus and eight example alerts (the database down, server errors, platform errors, connections ending, failed
sign-ins, slow requests, event-loop lag).

### Rotating `SESSION_SECRET`

1. Generate a new secret. Set `SESSION_SECRET` to it and `SESSION_SECRET_PREVIOUS` to the old one, then restart.
2. People stay signed in: a session opened with the old secret is sealed again with the new one the next time it is used. On
   start the app also seals every stored platform connection with the new secret and logs how many (and how many could not
   be opened with any secret; those people connect again).
3. When the log line says the previous secret is no longer needed, and after the session lifetime has passed
   (`SESSION_TTL_HOURS`, 7 days by default) so that sessions of people who have not come back have ended anyway, remove
   `SESSION_SECRET_PREVIOUS`. Anyone whose session still carried the old secret signs in again; nothing else is lost.

Rotate the same way if the secret leaks, but then remove the previous one as soon as step 2 has run, since it is the leaked one.

## Running it

**Docker.** Releases are published, signed, as a multi-architecture image (pin the digest from the GitHub Release,
and verify its cosign signature):

```sh
docker run -d -p 8080:8080 --env-file .env ghcr.io/ncecere/pi-agent-interface:v0.5.1
# or build it:  docker build -t pi-agent-interface .
```

One Node process serves the web app and the API, as the non-root `node` user, with a health check on `/healthz`
and `/readyz`. It needs a PostgreSQL database (`DATABASE_URL`); `compose.yaml` starts one for development.

**Kubernetes.** `deploy/kubernetes/` has a generic Kustomize base (two replicas, a PodDisruptionBudget, default-deny
NetworkPolicies); see [its README](deploy/kubernetes/README.md) for what an overlay adds.

**Behind a reverse proxy**, which should terminate TLS and then:
- not buffer or time out `/api/agents/*/threads/*/events`: it is a server-sent event stream that stays open
  (nginx: `proxy_buffering off; proxy_read_timeout 1h;`). The platform sends a keep-alive every 15 seconds;
- pass `Host` and `X-Forwarded-*` through, and keep `APP_URL` equal to the public address.

**Without Docker:** `pnpm install && pnpm build && pnpm start`.

## Status and roadmap

Pi Agent Interface is in use and versioned (see the [changelog](CHANGELOG.md)); expect minor releases to add things and to change settings only with a note. What is not built yet, and the plan for it, is in the [roadmap](ROADMAP.md), with an issue for each item.

## Development

```sh
cp .env.example .env.local   # set PLATFORM_*, SESSION_SECRET, DEV_AUTH=true
pnpm install
pnpm db:up                   # a Postgres for the app, on 127.0.0.1:55433 (compose.yaml)
pnpm dev                     # web on http://localhost:5177, server on 127.0.0.1:5178
```

Sign in as tim, bob or sally. With a service key in `.env.local` each gets their own assistant in the platform's
team; without one (or with `PLATFORM_AUTH=connect`) you connect a platform account first. On `http://localhost` the
app registers itself with the platform, and because the dev accounts' emails are not your platform account's, set
`CONNECT_EMAIL_MATCH=off` for local Connect.

```sh
pnpm typecheck && pnpm test && pnpm lint
pnpm gen:api                 # platform types from ../golang/pi-durable-platform/api/openapi.yaml
```

**Browser tests.** `pnpm build && pnpm e2e` drives the built app in a real browser (desktop and a phone-sized touch
screen) against a fake platform (`e2e/platform`: the fictional Example Corp, with its people, agents and conversations) in
both modes, service and Connect. It needs the development Postgres (`pnpm db:up`) or `TEST_DATABASE_URL`, makes a database
of its own for each app, and the first time `pnpm exec playwright install chromium`. CI runs it on every push. A test is
worth adding whenever something is found by looking at the screen.

`/avatars` (development only) is a review page for the avatar styles.

**Locked out?** Make someone an administrator from the server: `pnpm admin:promote <email>` (in a container,
`node dist-server/cli.js promote <email>`). They must have signed in once.

## Accessibility

Checked on every push by the browser tests (`e2e/tests/a11y.spec.ts`): axe (WCAG 2.0/2.1 A and AA) finds nothing on the
sign-in page, the chat (home, a conversation, a row's menu, the command palette, while an agent works), Settings and every
Admin page, in the light and dark themes and with each of the four accents; every stop of the keyboard path shows where focus
is, and the first is a "Skip to main content" link; with reduced motion asked for, nothing on the page keeps animating.
A reply starting and finishing is announced to screen readers (a polite live region).

Not checked: a screen reader by hand (VoiceOver, NVDA), text scaled to 200 %, and high-contrast mode. Axe finds only a part
of the problems; if something fails for you, open an issue saying what you used.

## Settings, and where each kind lives

| Kind | Where | Who changes it | Examples |
|---|---|---|---|
| **Deployment** | Environment variables (above) | Whoever runs the server; a restart applies it | Platform URL and key, sign-in, `AGENT_MODEL` as a fallback |
| **Instance settings** | The app's database; Admin → Agents, Branding | Administrators, at once, in the audit log | Default model, provided agents, the name and logo |
| **Optional features** | The app's database; Admin → Features | Administrators, at once, in the audit log | `usage`, `connectedUsage` (Admin → Usage), `messageSearch` (sidebar search), `myUsage` (Settings → Usage) |
| **Personal preferences** | The person's account; Settings | Each person, for themselves, on every device | Theme, avatar style, the inbox (pinned, snoozed, read) |

**Optional features** are whole parts of the app an instance may do without. Each is declared once in
`server/features.ts` with a label, a description and its default. The server enforces it (its routes answer 404 while
it is off), and `/api/me` tells the browser which are on, so their screens and menu entries are hidden
(`useFeature()`). A deployment that cannot support one (a platform without the API it needs) lists it in
`DISABLED_FEATURES`; administrators then see it locked off. To add one: declare it in `features.ts`, guard its routes
with `feature(id)` in `server/app.ts`, and hide its screens with `useFeature(id)`.

Features today:

| Feature | Default | What it does |
|---|---|---|
| `usage` | on | Admin → Usage: requests, tokens and an estimated cost per person for the last 7, 30 or 90 days, from the platform's usage report (`GET /v1/teams/{team}/usage`). Agents that name no person here are summed as "Other agents". Cost appears once the platform has prices for the models. |
| `connectedUsage` | off | Connect only: Admin → Usage for the people who have connected their platform account. Each person's own report is read with their own connection, by agent and by day (`GET /v1/teams/{personal}/usage`), a few at a time and kept for a minute, so opening the page costs a few calls per person. It covers only agents in the person's personal workspace, not their teams'. People who have not connected, and people whose report the platform would not give, are listed apart ("Not in these figures"), never counted as zero. |
| `messageSearch` | off | The sidebar's search also looks inside messages. The app keeps its own searchable copy of the text of the conversations people open in it (what people and the agent said; not thinking or tool output; up to 200,000 characters each), one per person and conversation, in its database (table `message_index`, PostgreSQL full-text search, each word matched as the start of a word). Each person searches only their own; a copy goes when the conversation is deleted here; turning the feature off deletes every copy and says so in the audit log. It covers only conversations opened through this app, and a conversation deleted somewhere else leaves a copy nobody sees until the feature is turned off. This is the one place the app holds conversation text; the platform's own is the record. |
| `myUsage` | off | Settings → Usage: each person sees their own agents' requests, tokens and estimated cost, per agent and per day (`GET /api/me/usage`). Nobody sees anyone else's. |

## How it works

- `server/`: Hono on Node. Sign-in (`/auth/login` and `/auth/callback` for OIDC, `/auth/dev`), and `/api/*`, which
  relays each person's own agent routes to the platform (threads, messages, stop, SSE events).
- `src/hooks/use-agent-thread.ts`: follows a conversation's SSE stream (each `view` event is the whole
  conversation), sends with `requestId` idempotency, queues messages while the agent works, and stops.
- `src/lib/chat-view.ts`: turns the platform's `ChatView` into AI SDK `UIMessage`s so Open Chat Interface's
  renderers draw it. Unchanged messages keep their identity, so only the reply being written re-renders, and a
  message keeps its identity from "sent" to "in the transcript", so nothing re-mounts as the reply arrives.
- `server/connect.ts`, `server/connect-agents.ts`: Connect. The OAuth client (authorization code with PKCE; the app
  is identified by a Client ID Metadata Document, or registers itself on a local address), encrypted token storage
  with refreshes one at a time per person, and a person's agents in their personal workspace (provided agents made
  once per person, their own, their teams').
- `server/events-hub.ts`, `src/hooks/use-platform-events.ts`: one connection to the platform's event stream for
  the whole server, each event passed only to the person whose agent it is (`GET /api/events`). Conversation lists
  update in place, from any device.
- `src/lib/inbox.ts`, `src/hooks/use-inbox.ts`: the inbox's rules (pure, tested) and its store. The platform says
  whether a conversation is busy and when its last reply finished or failed; what the person did with it (seen,
  pinned, snoozed, settled) is the app's, synced to their account. Polling only happens while the event stream is
  down.
- `src/components/agent/avatar/`: the animated avatars.

See [CHANGELOG.md](CHANGELOG.md) for what is in each release, the [documentation](https://docs.pai.bitop.dev) for
using and running the app, and [NOTICE.md](NOTICE.md) for where the code and ideas come from. MIT licensed.
