# Pi Agent Interface

A chat interface for [Pi Durable](https://github.com/ncecere/pi-durable-platform) agents, built from the
[Open Chat Interface](https://github.com/ncecere/open-chat-interface) web app (v0.13.1).

It is a frontend only. The **pi-durable-platform** is the only backend and the record of everything:
sign-in (OIDC or dev personas), agents, conversations and their transcripts. This app talks to the
platform's `/v1` API on the same origin and never to agent runtimes.

```
Browser ──/v1, /auth──▶ pi-durable-platform ──▶ agent runtimes
```

## Development

```sh
pnpm install
pnpm dev            # http://localhost:5177, proxies /v1 and /auth to the platform
```

Settings go in `.env.local` (git-ignored):

- `PLATFORM_URL`: the platform, e.g. `https://agents.bitop.dev` (default `http://localhost:8098`).
- `PLATFORM_SESSION`: for a remote platform with single sign-on, whose sign-in returns to its own domain.
  Sign in on the platform, copy the value of the `__Host-pdp_session` cookie, and restart `pnpm dev`.
  The dev proxy sends it with each request; the browser never sees it.

The proxy presents requests as the platform's own origin, because the platform accepts browser writes
only from its APP_URL. The sign-in page is `/sign-in`: `/auth/*` belongs to the platform.

```sh
pnpm gen:api        # regenerate src/api/schema.gen.ts from the platform's openapi.yaml
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## How a conversation works

- `src/hooks/use-agent-thread.ts`: follows `GET /v1/agents/{id}/threads/{threadId}/events` (each SSE
  `view` event is the whole conversation), sends with `requestId` idempotency, and stops.
  Messages sent while the agent is working queue behind the current reply.
- `src/lib/chat-view.ts`: turns the platform's `ChatView` into AI SDK `UIMessage`s so OCI's renderers
  (work block, tool steps, reasoning, Markdown) draw it. Unchanged messages keep their object identity,
  so only the reply being written re-renders.
- A new conversation's ID is made in the browser; its first message creates it on the platform.
