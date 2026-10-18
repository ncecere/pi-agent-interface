# Changelog

## Unreleased

Nothing yet.

## 0.2.0

Released 2026-10-18. People connect their own agent platform account, the app gains an administration area, settings,
agents people can make, and a live inbox in t3code's style, and it gets its own logo, site and documentation.

### Upgrading from 0.1.0
- **0.2.0 adds a database.** 0.1.0 kept nothing of its own. Set `DATABASE_URL` to a PostgreSQL database; the app
  creates its tables when it starts (three migrations: people, settings and preferences; people's agents; platform
  connections).
- **A deployment with `PLATFORM_SERVICE_KEY` set stays in service mode, as before.** Without a service key the app
  now defaults to Connect (`PLATFORM_AUTH=connect`). Set `PLATFORM_AUTH=service` to keep using a service account.
- `AGENT_MODEL` is now only the fallback default: Admin → Agents sets the default model and wins.
- The image no longer contains npm, corepack or yarn.
- New settings: `DATABASE_URL` (required), `INITIAL_ADMIN_EMAIL`, `PLATFORM_AUTH`, `CONNECT_EMAIL_MATCH`,
  `DISABLED_FEATURES`. See the README's configuration table.

### Connecting to the platform
- **OAuth Connect** (`PLATFORM_AUTH=connect`): after signing in, a person connects their own account on the agent
  platform once, and their agents live in their personal workspace beside their teams' agents. The server keeps
  their tokens encrypted (refreshes run one at a time per person), calls the platform with them, and asks them to
  connect again if the connection ends. Settings → Account shows the connection, with Disconnect.
- The app identifies itself with a Client ID Metadata Document at `/oauth/client-metadata.json` (on a local `http`
  address it registers itself instead).
- A platform account whose email differs from the person's is refused and its tokens revoked, unless
  `CONNECT_EMAIL_MATCH=off`.
- A conversation with a team's agent starts private to the person (the platform fixes visibility with the first
  message).
- Service mode is unchanged. Admin → Usage needs it, since people's agents in Connect mode are not in a team the
  administrators see.

### Agents
- **Admin → Agents**: the default model, how many agents each person may make (default 5), whether people choose the
  model, and the allowed templates.
- **Provided agents**: administrators add agents everyone gets, each person their own private copy (the built-in
  assistant is the first). In Connect mode a copy is made once per person in their workspace; one already there
  under its name is adopted, not duplicated.
- **My agents** (Settings): people make their own agents from the allowed templates, rename them, move them to
  another model, and delete them. The picker groups Provided, Yours and each team.

### Inbox
- **t3code's look**: three-line rows (agent, title, time), the status in the corner with an icon (Working with a
  timer, Done, Failed, Woke), a pin on pinned rows, compact times, soft hover and active tints, and hover actions
  Pin, Snooze and Settle. "Done" means a finished reply you have not seen; conversations you are finished with are
  **Settled**. Snoozing shows each wake time and offers "Custom…". Rename a conversation from its menu.
- **Live from the platform**: one event stream per person updates conversation lists as they change on any device,
  and the platform's own status drives Working, Done and Failed. Replies that finish while the app is closed show as
  Done when you come back. Polling only runs while the stream is down. Listing conversations no longer wakes agents.
- **Follows you between devices**: pinned, snoozed, settled, archived and read state is saved to your account.
- **Shortcuts**: ⌥↑/⌥↓ previous and next conversation, ⌥⇧↓ next that needs you, ⌥⇧S settle and move on, ⌥⇧P pin,
  ⌥⇧U mark unread (Alt on Windows and Linux; listed in Settings). Right-click a row for its menu.
- A resizable sidebar with a live timer while an agent works.

### Chat
- **Tool steps**: an icon for the kind of tool, a spinner while it runs, red when it fails, and what it acted on.
  While the agent works its latest steps show under the header. Opened, a step shows a command as `$ command`,
  inputs as name and value, JSON output indented, and Copy.
- **Failed replies say why in plain words**, with the provider's raw error under Details. A turn the agent drops
  without replying shows **Failed** and a "No reply" note with Try again.
- Conversations open at their latest message; long messages you send fold; live labels shimmer; narrow no-break
  spaces some models write no longer squash words together.

### Administration and settings
- **Admin** (`/admin`, in Open Chat Interface's layout): Overview, People (search, make administrator or member,
  suspend or restore), Agents, Branding (name, logo, default accent and appearance), Features, Usage and the Audit
  log. `INITIAL_ADMIN_EMAIL` makes the first administrator; `pnpm admin:promote <email>` recovers from a lockout.
  There is always at least one active administrator.
- **Settings** (`/settings`): Account, Customization (light/dark/system, accent, avatar style, Enter behaviour, code
  wrapping), My agents, Conversations and, when on, Usage. Appearance is saved to your account.
- **Optional features** (Admin → Features): parts of the app an instance can do without, enforced by the server and
  hidden in the browser when off; `DISABLED_FEATURES` turns one off for good. **Usage** (Admin → Usage, on by
  default) shows requests, tokens and an estimated cost per person; **Personal usage** (Settings → Usage, off by
  default) shows each person their own.

### Look and release
- A new logo, "Face", and the default name **Pi Agent Interface**.
- A Kubernetes base in `deploy/kubernetes/`, CI, and a release workflow that builds a signed multi-architecture image
  at `ghcr.io/ncecere/pi-agent-interface`.
- Fixed: on a shared browser the next person to sign in inherited the previous person's theme and avatar style.

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
