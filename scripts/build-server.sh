#!/bin/bash
# Build the Insight server (server/) with the frontend's build (frontend/dist) embedded.
# Usage: scripts/build-server.sh <goos> <goarch> <output> [version]
# Run from anywhere; needs Go on PATH. build.sh and deploy-sdk-dev.sh use it.
set -euo pipefail
[[ $# -ge 3 ]] || { echo "usage: $0 <goos> <goarch> <output> [version]" >&2; exit 2; }
GOOS_TARGET=$1 GOARCH_TARGET=$2 OUTPUT=$3 VERSION=${4:-dev}
REPO=$(cd "$(dirname "$0")/.." && pwd)
EMBED="$REPO/server/internal/spa/dist"

command -v go >/dev/null || { echo "Go is not on PATH (server/go.mod says which version)" >&2; exit 1; }
[[ -f "$EMBED/README.md" ]] || { echo "not an insight checkout: $REPO" >&2; exit 1; }

# Replace what an earlier build embedded; the folder's README stays.
find "$EMBED" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
if [[ -f "$REPO/frontend/dist/index.html" ]]; then
  cp -r "$REPO/frontend/dist/." "$EMBED/"
else
  echo "warning: frontend/dist has no build; this server has no web UI" >&2
fi

case "$OUTPUT" in /*) ;; *) OUTPUT="$PWD/$OUTPUT" ;; esac
(cd "$REPO/server" && GOOS="$GOOS_TARGET" GOARCH="$GOARCH_TARGET" CGO_ENABLED=0 \
  go build -trimpath -ldflags "-X main.version=$VERSION" -o "$OUTPUT" ./cmd/neat-insight)
echo "built $OUTPUT ($GOOS_TARGET/$GOARCH_TARGET, $VERSION)"
