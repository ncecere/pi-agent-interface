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
| `AGENT_MODEL` | The model every assistant runs on, by name or id, from those published to the team. New assistants are created on it and existing ones moved to it (from their next start). Only a model currently published to the team is ever set, since an agent on an unpublished model would not start. Empty: the platform decides. |
| `DATABASE_URL` | The chat app's own Postgres (people, roles, settings, preferences). Migrated on start. Conversations stay on the platform. |
| `INITIAL_ADMIN_EMAIL` | Becomes an administrator on signing in while there is no administrator. After that, admins promote others. |
| `SESSION_SECRET` | 32+ characters (`openssl rand -base64 48`). Encrypts sessions; changing it signs everyone out. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Single sign-on. All three. |
| `DEV_AUTH` | `true` enables the development accounts tim, bob and sally. Refused unless `APP_URL` is loopback. |
| `HOST`, `PORT` | Where to listen (default `127.0.0.1:5178`; the container uses `0.0.0.0:8080`). |
| `SESSION_TTL_HOURS` | Default 168. |

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

## How it works

- `server/`: Hono on Node. Sign-in (`/auth/login` and `/auth/callback` for OIDC, `/auth/dev`), and `/api/*`, which
  relays each person's own agent routes to the platform (threads, messages, stop, SSE events).
- `src/hooks/use-agent-thread.ts`: follows a conversation's SSE stream (each `view` event is the whole
  conversation), sends with `requestId` idempotency, queues messages while the agent works, and stops.
- `src/lib/chat-view.ts`: turns the platform's `ChatView` into AI SDK `UIMessage`s so Open Chat Interface's
  renderers draw it. Unchanged messages keep their identity, so only the reply being written re-renders, and a
  message keeps its identity from "sent" to "in the transcript", so nothing re-mounts as the reply arrives.
- `src/lib/inbox.ts`, `src/hooks/use-inbox.ts`: the inbox's rules (pure, tested) and its store. The platform
  records only a title and when a message was last sent, so the app notices replies finishing itself: from the open
  conversation's stream, and by polling conversations that were still working when you left them.
- `src/components/agent/avatar/`: the animated avatars.

See [CHANGELOG.md](CHANGELOG.md) for what is and is not in this release, and [NOTICE.md](NOTICE.md) for where the
code and ideas come from.
