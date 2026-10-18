#!/usr/bin/env bash
# Creates the GitHub Release for $TAG: CHANGELOG.md's "## X.Y.Z" section, then
# the image digest and how to verify it. Called by image.yml's release job.
set -euo pipefail
: "${TAG:?}" "${DIGEST:?}"
base="${TAG%%-*}"
version="${base#v}"
notes=$(mktemp)
awk -v v="## ${version}" '$0==v {on=1; next} on && /^## / {exit} on' CHANGELOG.md > "${notes}"
[ -s "${notes}" ] || { echo "no '## ${version}' section in CHANGELOG.md" >&2; exit 1; }
image="ghcr.io/ncecere/pi-agent-interface"
cat >> "${notes}" <<NOTES

## Image

\`\`\`
${image}:${TAG}
${image}@${DIGEST}
\`\`\`

Verify the signature:

\`\`\`
cosign verify ${image}@${DIGEST} \\
  --certificate-identity https://github.com/ncecere/pi-agent-interface/.github/workflows/image.yml@refs/tags/${TAG} \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
\`\`\`
NOTES
flags=()
[[ "${TAG}" == *-* ]] && flags+=(--prerelease)
gh release create "${TAG}" --title "Pi Agent Interface ${TAG}" --notes-file "${notes}" --verify-tag "${flags[@]}"
