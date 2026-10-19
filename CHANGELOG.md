# Changelog

## Unreleased

- **Search inside messages** (new optional feature "Search message text", off by default). The platform can't search messages, so the app keeps its own searchable copy of the text of conversations people open in it, in its database (migration 4; PostgreSQL full-text search, matching the start of words), and the sidebar's search shows "In messages" results with the matching words marked. Each person searches only their own; a copy is deleted with the conversation (when deleted here); turning the feature off deletes every copy and is recorded in the audit log. It covers only conversations opened through this app. This is the one place the app keeps conversation text, which is why it is off until an administrator turns it on.
- **Usage with Connect** (new optional feature "Usage of connected people", off by default): Admin → Usage reads each connected person's own personal-workspace report with their own connection (a few at a time, kept a minute) and lists, apart, the people who have not connected and those the platform would not report on, so they are never counted as zero. It covers only the agents in people's personal workspaces. The team-wide Usage stays for the service-account mode.
- **Long conversation lists.** The sidebar draws 40 conversations of each shelf and adds 40 with each "Show more", always keeping the open one in its list; a search still looks through all of them (and opens the Settled and Archived shelves that hold a match). Settings → Conversations pages its lists the same way and has a search box once they are long. With 2,000 conversations, measured on one machine: the sidebar went from about 2,000 rows and 103,000 page elements to 40 rows and 2,200, and the first row from about 5 s to 0.1 s. The platform's list has no paging, so the whole list still comes from it; the app now gzips its JSON and scripts (they went out uncompressed), and keeps only the newest 100 conversations per agent in the browser's copy.
- The Kubernetes base passes an optional `SESSION_SECRET_PREVIOUS` key of the `pi-agent-interface-runtime` Secret to the app, so a rotation there is just adding the key. (In 0.4.0 the base didn't, and an overlay had to add it.)

## 0.4.0

Released 2026-10-19. Safe to share, and to run for other people: access by identity-provider group, rotating the
session secret, metrics, a rehearsed restore, and browser and accessibility tests. No database migration and no step to upgrade from 0.3.1; the new options are all
off unless you set them, and the one change you will see without doing anything is slightly adjusted colours.

- **Sign-in by group.** `OIDC_ALLOWED_GROUPS` limits who can sign in to members of the listed groups of your identity
  provider, and `OIDC_ADMIN_GROUPS` makes its groups decide who is an administrator, checked on every sign-in. Someone
  who loses the group is signed out of the sessions they have and can't sign in again. `OIDC_GROUPS_CLAIM` says where
  the provider lists groups (a name, or a dotted path). With admin groups set, Admin → People shows "Set by sign-in
  group" and doesn't offer role changes; the audit log records the change as made through a group. The last active
  administrator is never demoted this way.
- **Rotating `SESSION_SECRET`.** Put the old secret in `SESSION_SECRET_PREVIOUS` and the new one in `SESSION_SECRET`:
  sessions keep working (and are sealed again with the new secret as they are used), and on start the app seals every
  stored platform connection with the new secret, so nobody signs in or connects again. The log says when the old secret
  can be dropped.
- **Prometheus metrics** (optional, `METRICS_ENABLED=true`): requests by route and status with latency, calls to the platform by outcome, platform-token refreshes, sign-ins by outcome, open streams, database reachability, and the usual process figures, on a port of their own (`METRICS_PORT`, default 9464) so exposing the app doesn't expose them. `deploy/kubernetes/components/metrics` adds a Service, ServiceMonitor, NetworkPolicy and eight example alerts (checked with promtool).
- **Restore rehearsed and documented.** The README now says what the database holds, what a restore needs (keep `SESSION_SECRET`) and does, and how to rehearse one on CloudNativePG. Rehearsed on the reference deployment on 2026-10-19: latest state and a point in time, each in about a minute, every table matching, tokens still opening.
- **Browser tests in CI** (`pnpm e2e`): sign-in, chat with a streamed reply, the inbox (including the status-over-actions layout fixed in 0.3.1, on desktop and touch), administration access and the Connect flow, against a fake platform. Not part of the shipped image.
- **Accessibility audit.** Automated checks (axe) now run in CI on the main pages in both themes and every accent. Fixed what they found: the Failed and Working statuses and the muted text on the open conversation's row were too faint to read (the light theme's red and blue are darker, the dark theme's muted text a little lighter); the Default model selector in Admin → Agents had no name for screen readers; the user-menu button on a phone didn't start its name with the initials it shows; and the emerald accent's dark-theme buttons (white on 3.3:1) are now darker. Keyboard focus and reduced motion are tested too. What isn't checked is listed in the README.

## 0.3.1

Released 2026-10-18. Two inbox glitches found while capturing the screenshots.

- **On a touch screen**, where a row's "…" button is always shown, it was drawn over the row's status ("Done",
  "Failed", "Woke", "Working 6m") and its pin. The status now keeps clear of the button.
- **With a row's menu open**, a row's status was drawn under its actions. The status now steps aside while the menu
  is open or a delete is being confirmed, as it already did on hover and focus.

## 0.3.0

Released 2026-10-18. What the platform now records shows with each message, and the app waits for its database.

- **When, which model, how many tokens.** Hover a message to see when it was sent. Under a finished reply you also
  see the model that wrote it and the tokens it used (summed over its steps), with the split (in, out, read from
  cache) in the tooltip. The platform records these from its next release on; against an older platform nothing
  extra is shown.
- **Tool steps show how long they ran** ("56 ms", "2.3 s"), from the platform's start and end times for the call.
- **A reply cut off at the model's length limit says so**, so a half-finished answer isn't mistaken for a finished one.
- **The app waits for its database on start** (up to three minutes) instead of exiting and being restarted until the
  database answers, as happened on a first deployment. Only "not reachable yet" errors are waited out: a wrong
  password or a missing database still fails at once, with the database's own message.
- Admin → Agents says, in Connect mode, that the models and templates it lists are the ones the administrator's own
  workspace offers.

## 0.2.1

Released 2026-10-18. Fixes found while writing the documentation.

- **Settings → My agents**: a team's agents no longer appear under "Provided for you"; they have their own "From
  your teams" section.
- **Settings → Account**: the agent platform card no longer shows a connection date (the time it held was the last
  token renewal, not when you connected).
- **`DEV_ACCOUNTS`**: with `DEV_AUTH=true`, choose the development accounts offered instead of tim, bob and sally.
  Development only; ignored while `DEV_AUTH` is off.
- The 0.2.0 release notes said the database "gains two migrations". 0.1.0 had no database: 0.2.0 adds it
  (`DATABASE_URL`, three migrations). The 0.2.0 notes are corrected.

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
