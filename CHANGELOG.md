# Changelog

## 0.1.0

First release. A chat app for [Pi Durable](https://github.com/ncecere/pi-durable-platform) agents, where every
person who signs in gets their own assistant, built from the Open Chat Interface web app.

### Chat
- Streaming conversations with an agent: reasoning, tool steps (what each tool acted on, its inputs and live
  output) and Markdown, with syntax highlighting, tables, math and diagrams.
- Messages sent while the agent is working queue behind the current reply; Stop works; sends are safe to retry.
- A conversation follows the platform's stream and reconnects on its own; a background tab lets an idle agent sleep.

### Inbox
- One list of every conversation, in the style of t3code's thread sidebar: **Pinned**, **Working** and **Inbox**,
  with **Snoozed**, **Done** and **Archived** shelves.
- A reply that finishes or fails while you are elsewhere shows as **New reply** / **Failed**, and the tab title
  counts them. Snoozes end early when the agent finishes; done conversations return on new activity.
- Replies still being written when you leave a conversation are followed, so they are noticed when they finish.
- Hover actions and a menu with everything (always shown on touch screens); Undo for every change but Delete.

### Agents
- Animated avatars (Face, Signal, Pixel) that show what the agent is doing: idle, thinking, working, waiting,
  needs you, done, error, asleep. Chosen per browser in the Appearance menu.

### Accounts and security
- People sign in to this app with single sign-on (OpenID Connect), never to the agent platform. A small server
  holds the platform team's service account key and relays each person's own agent routes only.
- Encrypted cookie sessions, CSRF token and Origin check on writes, ownership check on every agent request,
  a cap on open streams per person, strict Content-Security-Policy, HSTS over https.
- Development accounts (tim, bob, sally) when `DEV_AUTH=true`, loopback only.

### Deployment
- `docker build .`: one Node process serves the web app and the API, runs as a non-root user, health check on
  `/healthz`.

### Known limitations
- Inbox state is kept in the browser (per person, cleared on sign-out); it does not follow you between devices.
- "Working" and "New reply" are known only for conversations this browser has seen working. A reply that finishes
  while the app is closed is not flagged.
- One assistant per person. The server's key scheme allows more; the interface does not offer them yet.
- No attachments, tool approvals, message editing or branching, or search of message text.
- Single sign-on is tested against an in-process provider, not against a particular identity provider.
- No access control by identity-provider group yet.
- The icons and the sidebar mark are Open Chat Interface's, to be replaced.
