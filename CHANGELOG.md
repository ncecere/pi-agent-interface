# Changelog

## Unreleased

- **The inbox looks and reads like t3code's**: three-line rows (agent, title, time), status in the corner with an
  icon (Working with a timer, Done, Failed, Woke), a pin on pinned rows, compact times (now, 5m, 3h, 2d), soft
  hover and active tints, and hover actions Pin, Snooze and Settle. "Done" now means a finished reply you have not
  seen; conversations you are finished with are **Settled**. Snoozing shows each wake time and offers "Custom…".
- **Inbox shortcuts**: ⌥↑/⌥↓ previous/next conversation, ⌥⇧↓ next that needs you, ⌥⇧S settle and move on,
  ⌥⇧P pin, ⌥⇧U mark unread (Alt on Windows and Linux; listed in Settings). Right-click a row for its menu.
- **Conversations open at their latest message** (they opened at the top after loading, and stopped following
  replies).
- **Tool steps**: an icon for the kind of tool (terminal, file, search, web, clock…), a spinner while it runs, red
  when it fails, and what it acted on ("get_time Asia/Tokyo"). While the agent works, its latest steps show under
  the header. Opened, a step shows a command as `$ command`, simple inputs as name and value, JSON output indented,
  and Copy.
- **Failed replies say why in plain words** ("The model is busy or over its limit right now…"), with the provider's
  raw error under Details.
- Live labels ("Thinking…", "get_time…") shimmer; reasoning in the steps is quieter than the answer; long messages
  you send fold after 12 lines; narrow no-break spaces some models write ("3 PM") no longer squash words together.
- **"No reply" note** under your message when the agent stopped without answering, with Try again.
- A turn the agent drops without replying (idle, your message last, 90s on) now shows **Failed** instead of
  Working for up to two hours.
- **Agents.** Admin → Agents sets the default model (instead of `AGENT_MODEL`, which remains the fallback), how
  many agents each person may make (default 5), whether people choose the model, and the templates allowed.
  **Provided agents**: administrators add agents everyone gets, each person their own private copy (the built-in
  assistant is the first). **My agents** (Settings): people make their own agents from the allowed templates,
  rename them, move them to another model, and delete them. The agent picker groups provided agents and your own.
- **The inbox follows you between devices**: pinned, snoozed, done, archived and read state is saved to your
  account. Each conversation's latest change wins, and removals (an unpin, say) carry over too.
- **The sidebar** is resizable (drag its edge, or use the arrow keys on it; double-click resets) and shows
  conversations as two-line cards with a coloured status and a live timer while the agent works, in the
  proportions of t3code's sidebar.
- Fixed: on a shared browser, the next person to sign in inherited the previous person's theme, accent and
  avatar style.
- Fixed: leaving a conversation while its agent was working showed the agent as done.
- **Admin dashboard** (`/admin`, administrators only, in Open Chat Interface's layout): Overview (people, activity,
  recent changes), People (search, make administrator or member, suspend or restore), Branding (name, logo,
  default accent and appearance, shown on every page and the sign-in page) and the Audit log.
- **Settings** (`/settings`, in Open Chat Interface's layout): Account (profile from sign-in, sign out, sign out
  everywhere), Customization (light/dark/system, accent, avatar style, Enter behaviour, code wrapping) and
  Conversations (archived and done, restore or delete, one by one or together). Appearance is saved to the
  person's account (`/api/me/prefs`), so it follows them between devices.
- The app has its own Postgres (`DATABASE_URL`), migrated on start: the people who have signed in, their role and
  an audit log. `INITIAL_ADMIN_EMAIL` makes the first administrator; `pnpm admin:promote <email>` recovers from a
  lockout. Administrators can promote and suspend people (`/api/admin/*`); a suspension, or "sign out
  everywhere", ends the person's sessions within seconds. There is always at least one active administrator.
- `AGENT_MODEL` chooses the model every assistant runs on, from those published to the team. New assistants are
  created on it; existing ones are moved to it, taking effect from their next start. A model that is not
  published (or is disabled) is never set, and a failed change is logged without keeping anyone from their
  assistant.

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
