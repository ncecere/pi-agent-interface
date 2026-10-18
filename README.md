# Pi Agent Interface

A chat app for [Pi Durable](https://github.com/ncecere/pi-durable-platform) agents. Every person who signs in gets
their own assistant, with an inbox for working across conversations: what is working, what has a new reply, what
is snoozed, done or put away.

People sign in to **this app** (single sign-on) and never to the agent platform. The app's server talks to
pi-durable-platform for them with one team service account.

```
tim / bob / sally ──sign in──▶ chat server (server/) ──service key──▶ pi-durable-platform
                                │                                     team: pi-agent-interface
                                └─ encrypted session cookie           ├─ agent u:<tim>
                                                                      ├─ agent u:<bob>
                                                                      └─ agent u:<sally>
```

- **Agents** are the platform's service-managed agents. `PUT /v1/teams/{team}/agents/by-key/u:<person>` creates a
  person's assistant the first time they open the app, from `AGENT_TEMPLATE`.
- **Conversations** live on the platform. The app's own Postgres holds who has signed in, their role (admin or
  user), settings and preferences; sessions are AES-GCM encrypted cookies.
- **Isolation.** The service key reaches every person's agent, so the server checks on every request that the
  agent is the signed-in person's own (`server/platform.ts`, tested in `tests/server/app.test.ts`). The team's
  owners see the agents in the platform console, not their conversations.

## What you need

1. **A pi-durable-platform** with a team (default slug `pi-agent-interface`), and in it:
   - a **service account** with role **editor**, and a key (`pdp_sa_…`) → `PLATFORM_SERVICE_KEY`;
   - a **model published to the team**, named in `AGENT_MODEL`. Without one every agent answers from the
     platform's default, which out of the box is a scripted demo model.
2. **An OpenID Connect provider** (authentik, Keycloak, Entra…): a confidential client whose redirect URI is
   `<APP_URL>/auth/callback`, with the `openid profile email` scopes → `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`. The provider must be reached over https.

## Configuration

Environment variables (a `.env.local` or `.env` file is read too; real variables win). `.env.example` has them all.

| Variable | Meaning |
|---|---|
| `APP_URL` | Where people open the app, e.g. `https://chat.example.com`. Its origin is the only one allowed to write. |
| `PLATFORM_URL`, `PLATFORM_TEAM`, `PLATFORM_SERVICE_KEY` | The platform, the team, and the service account key. Never sent to browsers. |
| `AGENT_TEMPLATE`, `AGENT_NAME` | The platform template each person's assistant is made from, and what the app calls it. |
| `AGENT_MODEL` | The default model, by name or id, until an administrator picks one in Admin → Agents (which wins). Only a model currently published to the team is ever set, since an agent on an unpublished model would not start. Empty: the platform decides. |
| `DATABASE_URL` | The chat app's own Postgres (people, roles, settings, preferences). Migrated on start. Conversations stay on the platform. |
| `INITIAL_ADMIN_EMAIL` | Becomes an administrator on signing in while there is no administrator. After that, admins promote others. |
| `SESSION_SECRET` | 32+ characters (`openssl rand -base64 48`). Encrypts sessions; changing it signs everyone out. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Single sign-on. All three. |
| `DEV_AUTH` | `true` enables the development accounts tim, bob and sally. Refused unless `APP_URL` is loopback. |
| `HOST`, `PORT` | Where to listen (default `127.0.0.1:5178`; the container uses `0.0.0.0:8080`). |
| `SESSION_TTL_HOURS` | Default 168. |
| `DISABLED_FEATURES` | Optional features to turn off for good, comma-separated (e.g. `usage`). See below. |

The server refuses to start, naming every problem, if the configuration is incomplete or unsafe: a platform or
provider that is not https (outside localhost), development accounts on a public address, a short session secret.

## Running it

**Docker**

```sh
docker build -t pi-agent-interface .
docker run -d -p 8080:8080 --env-file .env pi-agent-interface
```

One Node process serves the web app and the API, as the non-root `node` user, with a health check on `/healthz`.

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

Sign in as tim, bob or sally; each gets their own assistant on the platform.

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
- `server/events-hub.ts`, `src/hooks/use-platform-events.ts`: one connection to the platform's event stream for
  the whole server, each event passed only to the person whose agent it is (`GET /api/events`). Conversation lists
  update in place, from any device.
- `src/lib/inbox.ts`, `src/hooks/use-inbox.ts`: the inbox's rules (pure, tested) and its store. The platform says
  whether a conversation is busy and when its last reply finished or failed; what the person did with it (seen,
  pinned, snoozed, settled) is the app's, synced to their account. Polling only happens while the event stream is
  down.
- `src/components/agent/avatar/`: the animated avatars.

See [CHANGELOG.md](CHANGELOG.md) for what is and is not in this release, and [NOTICE.md](NOTICE.md) for where the
code and ideas come from.
