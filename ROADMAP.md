# Roadmap

What is not built yet. Each item is a GitHub issue with the proposed implementation and what “done” means. Dates are not promised.

This list is complete as of v0.5.1: if something you need is missing from the app and not here, open an issue.

## Built so far

Agent-only chat with live tool steps, a work inbox with shortcuts and snoozing, reply details (time, model, tokens, step durations), sign-in through your identity provider (restrictable by group), connecting each person's own platform account (Connect) or a team service account, provided and personal agents, optional features (usage for the team, for connected people and for each person; search inside messages), an administrator area, and a PostgreSQL store. Ready to share since v0.4.0: rotating the session secret without signing anyone out, Prometheus metrics, a rehearsed database restore, browser and accessibility tests in CI. Since v0.5.0 long conversation lists stay fast. See the [changelog](CHANGELOG.md) for each release.

## Waiting on the Pi Durable platform

Each of these needs the platform to offer something first. The issue says what to ask for, and the questions are written up for the platform (`QUESTIONS_FROM_CHAT_3`); the interface follows once it exists.

- [#10](https://github.com/ncecere/pi-agent-interface/issues/10) **Attach files and images to a message**. The composer sends text only.
- [#11](https://github.com/ncecere/pi-agent-interface/issues/11) **Steer a reply that is running**. A message sent while an agent is busy is queued as a follow-up and read after the reply finishes.
- [#12](https://github.com/ncecere/pi-agent-interface/issues/12) **Approve tool calls before they run**. Tool steps are shown after the fact.
- [#13](https://github.com/ncecere/pi-agent-interface/issues/13) **Edit a message and branch a conversation**. Messages can be copied and retried, not edited, and a conversation cannot fork.

## Could be better, whenever the platform allows

- [#14](https://github.com/ncecere/pi-agent-interface/issues/14) **Paging and a title filter in the platform's thread list.** The app draws a page at a time and gzips its replies, but the whole list still comes from the platform on every refresh. Asked for in `QUESTIONS_FROM_CHAT_3`.
- [#15](https://github.com/ncecere/pi-agent-interface/issues/15) **Searching messages on the platform.** Message search uses the app's own copy of conversations opened in it; a platform search would cover everything. Asked for in `QUESTIONS_FROM_CHAT_3`.

## Not planned

- A second chat mode that talks to a model directly. This app is for Pi Durable agents only.
- Running the agents. The platform does that; this app is the way people talk to them.
