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

   In Connect mode, Admin → Usage is not available (people's agents aren't in a team the administrators see);
   Settings → Usage shows each person their own.
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
| `SESSION_SECRET` | 32+ characters (`openssl rand -base64 48`). Encrypts sessions; changing it signs everyone out. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Single sign-on. All three. |
| `DEV_AUTH` | `true` enables the development accounts tim, bob and sally. Refused unless `APP_URL` is loopback. |
| `DEV_ACCOUNTS` | With `DEV_AUTH=true`: the development accounts to offer instead of tim, bob and sally, as a JSON array of `{"id", "name", "email"}` (ids unique: letters, digits, dots, dashes, underscores). Ignored while `DEV_AUTH` is off. |
| `HOST`, `PORT` | Where to listen (default `127.0.0.1:5178`; the container uses `0.0.0.0:8080`). |
| `SESSION_TTL_HOURS` | Default 168. |
| `DISABLED_FEATURES` | Optional features to turn off for good, comma-separated (e.g. `usage`). See below. |

The server refuses to start, naming every problem, if the configuration is incomplete or unsafe: a platform or
provider that is not https (outside localhost), development accounts on a public address, a short session secret.

## Running it

**Docker.** Releases are published, signed, as a multi-architecture image (pin the digest from the GitHub Release,
and verify its cosign signature):

```sh
docker run -d -p 8080:8080 --env-file .env ghcr.io/ncecere/pi-agent-interface:v0.3.1
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

`/avatars` (development only) is a review page for the avatar styles.

**Locked out?** Make someone an administrator from the server: `pnpm admin:promote <email>` (in a container,
`node dist-server/cli.js promote <email>`). They must have signed in once.

## Settings, and where each kind lives

| Kind | Where | Who changes it | Examples |
|---|---|---|---|
| **Deployment** | Environment variables (above) | Whoever runs the server; a restart applies it | Platform URL and key, sign-in, `AGENT_MODEL` as a fallback |
| **Instance settings** | The app's database; Admin → Agents, Branding | Administrators, at once, in the audit log | Default model, provided agents, the name and logo |
| **Optional features** | The app's database; Admin → Features | Administrators, at once, in the audit log | `usage` (Admin → Usage), `myUsage` (Settings → Usage) |
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
