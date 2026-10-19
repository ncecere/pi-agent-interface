# Roadmap

What is not built yet, in the order it is likely to be done. Each item is a GitHub issue with the proposed implementation and what “done” means; the milestones group them. Dates are not promised.

This list is complete as of v0.4.0: if something you need is missing from the app and not here, open an issue.

## Built so far

Agent-only chat with live tool steps, a work inbox with shortcuts and snoozing, reply details (time, model, tokens, step durations), sign-in through your identity provider, connecting each person's own platform account (Connect) or a team service account, provided and personal agents, optional features, an administrator area, and a PostgreSQL store. Since v0.4.0 it is also ready to share: access and administrators by identity-provider group, rotating the session secret without signing anyone out, Prometheus metrics, a rehearsed database restore, and browser and accessibility tests in CI. See the [changelog](CHANGELOG.md) for each release.

## v0.5 Usage and history

Whole-instance usage when people connect their own accounts, and conversation lists that stay fast when they are long.

- [#7](https://github.com/ncecere/pi-agent-interface/issues/7) **Admin → Usage in Connect mode**. With Connect, each person's agents run in their own workspace, so a service key cannot report on them.
- [#8](https://github.com/ncecere/pi-agent-interface/issues/8) **Page and search the conversation list**. The sidebar and Settings → Conversations load a person's whole thread list.
- [#9](https://github.com/ncecere/pi-agent-interface/issues/9) **Search the text of messages** *(needs the platform)*. Search matches conversation titles only.

## Later (needs the platform)

Each of these needs the Pi Durable platform to offer something first. The issue says what to ask for; the interface follows once it exists.

- [#10](https://github.com/ncecere/pi-agent-interface/issues/10) **Attach files and images to a message**. The composer sends text only.
- [#11](https://github.com/ncecere/pi-agent-interface/issues/11) **Steer a reply that is running**. A message sent while an agent is busy is queued as a follow-up and read after the reply finishes.
- [#12](https://github.com/ncecere/pi-agent-interface/issues/12) **Approve tool calls before they run**. Tool steps are shown after the fact.
- [#13](https://github.com/ncecere/pi-agent-interface/issues/13) **Edit a message and branch a conversation**. Messages can be copied and retried, not edited, and a conversation cannot fork.

## Not planned

- A second chat mode that talks to a model directly. This app is for Pi Durable agents only.
- Running the agents. The platform does that; this app is the way people talk to them.
