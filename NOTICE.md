# Notices

Pi Agent Interface is released under the [MIT License](LICENSE).

## Open Chat Interface

The web app is derived from [Open Chat Interface](https://github.com/ncecere/open-chat-interface) v0.13.1
(MIT): its layout, components, styles and Markdown and tool-step rendering. This repository's history starts with
an unmodified import of that version, so every change since is a diff against it
(`git diff 0679b3d HEAD -- .`). The copyright line in `LICENSE` is Open Chat Interface's and is kept.

The logo is this project's own: "Face" (the app's Face avatar on a near-black tile), drawn for this app. Its source,
exports and usage rules are in the private `pai-assets` repository; the files used here are in `public/` and
`src/components/brand/face-mark.tsx`. Open Chat Interface's "Turns" mark is not used.

## pi-d-ui

The Face avatar (`src/components/agent/avatar/face.css`) is ported from pi-d-ui's animated agent face.

## t3code

The inbox (pinned, working, snoozed, settled and archived), its rows, status icons, hover actions and the idea of
settling a conversation follow the design of [t3code](https://github.com/pingdotgg/t3code)'s thread sidebar, as
described in its documentation and visible in its interface. No t3code code is used here.
