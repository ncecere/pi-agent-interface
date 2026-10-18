# Pi Agent Interface

A chat app for [Pi Durable](https://github.com/ncecere/pi-durable-platform) agents, built from the
[Open Chat Interface](https://github.com/ncecere/open-chat-interface) web app (v0.13.1).

Each person who signs in gets their own assistant. People sign in to **this app** (single sign-on, or
development accounts locally) and never to the agent platform: the app's server talks to
pi-durable-platform for them with one team service account.

```
tim / bob / sally ──sign in──▶ chat server (server/) ──service key──▶ pi-durable-platform
                                │                                     team: pi-agent-interface
                                └─ encrypted session cookie           ├─ agent u:<tim>
                                                                      ├─ agent u:<bob>
                                                                      └─ agent u:<sally>
```

- **Agents** are the platform's service-managed agents: `PUT /v1/teams/{team}/agents/by-key/u:<person>`
  creates a person's assistant the first time they open the app (from `AGENT_TEMPLATE`).
- **Conversations** live on the platform. The app keeps no database; sessions are AES-GCM encrypted cookies.
- **Isolation**: the service key reaches every person's agent, so the server checks on every request that
  the agent is the signed-in person's own (`server/platform.ts` `ownsAgent`, tested in
  `tests/server/app.test.ts`). The team's owners see the agents in the platform console, not their conversations.

## Development

```sh
cp .env.example .env.local   # then set PLATFORM_*, SESSION_SECRET, DEV_AUTH=true
pnpm install
pnpm dev                     # web on http://localhost:5177, server on 127.0.0.1:5178
```

The platform team needs a service account with role **editor** and a key (`PLATFORM_SERVICE_KEY`), and a
model published to the team, or every agent runs the platform's scripted demo model.

```sh
pnpm typecheck && pnpm test && pnpm lint
pnpm build && pnpm start     # production: one Node process serving dist/ and the API
pnpm gen:api                 # platform types from ../golang/pi-durable-platform/api/openapi.yaml
```

## Layout

- `server/`: Hono on Node. Sign-in (`/auth/login`, `/auth/callback` for OIDC; `/auth/dev`), and `/api/*`,
  which relays each person's own agent routes to the platform (threads, messages, stop, SSE events).
- `src/hooks/use-agent-thread.ts`: follows a conversation's SSE stream (each `view` event is the whole
  conversation), sends with `requestId` idempotency, queues messages while the agent works, stops.
- `src/lib/chat-view.ts`: turns the platform's `ChatView` into AI SDK `UIMessage`s so OCI's renderers (work
  block, tool steps, reasoning, Markdown) draw it; unchanged messages keep their identity, so only the reply
  being written re-renders.
