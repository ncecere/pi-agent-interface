# Notices

Pi Agent Interface is released under the [MIT License](LICENSE).

## Open Chat Interface

The web app is derived from [Open Chat Interface](https://github.com/ncecere/open-chat-interface) v0.13.1
(MIT): its layout, components, styles and Markdown and tool-step rendering. This repository's history starts with
an unmodified import of that version, so every change since is a diff against it
(`git diff 0679b3d HEAD -- .`). The copyright line in `LICENSE` is Open Chat Interface's and is kept.

The page icons and the "Turns" mark in the sidebar and sign-in page are Open Chat Interface's too, and are
placeholders for this app's own.

## pi-d-ui

The Face avatar (`src/components/agent/avatar/face.css`) is ported from pi-d-ui's animated agent face.

## t3code

The inbox (pinned, working, snoozed, done and archived) follows the design of [t3code](https://github.com/pingdotgg/t3code)'s
thread sidebar, as described in its documentation. No t3code code is used.
