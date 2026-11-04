#!/bin/bash
# Deploy the Insight working tree into the Neat SDK container's dev copy and (re)start it on :9900.
# Usage: deploy.sh [--no-frontend] [--restore]
#   --no-frontend  skip the frontend build (backend or docs-only change)
#   --restore      stop the dev build and start the stock insight-admin service again
set -euo pipefail
REPO=${INSIGHT_REPO:-$(git rev-parse --show-toplevel)}
DEV=$HOME/workspace/.insight-dev            # == /workspace/.insight-dev inside the container
C=${INSIGHT_SDK_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 'sima-neat-sdk' || true)}
[[ -n "$C" ]] || { echo "SDK container not running (set INSIGHT_SDK_CONTAINER to pick one)"; exit 1; }

stop_dev() {
  docker exec "$C" bash -c '
    for p in $(pgrep -f "^/workspace/.insight-dev/.venv/bin/python3 .*neat-insight"); do kill $p; done
    for i in $(seq 1 30); do pgrep -f "insight-dev/neat_insight/bin/(vf|mediamtx)" >/dev/null || break; sleep 0.5; done
    pgrep -fa "insight-dev/neat_insight/bin" | grep -v pgrep || true'
}

if [[ "${1:-}" == "--restore" ]]; then
  stop_dev; docker exec "$C" insight-admin restart | tail -1; sleep 3
  curl -sk https://127.0.0.1:9900/api/health; echo; exit 0
fi

[[ -f "$REPO/neat_insight/app.py" ]] || { echo "not an insight checkout: $REPO"; exit 1; }
if [[ "${1:-}" != "--no-frontend" ]]; then
  # Standalone commands, not `... && echo`: set -e ignores a failure on the left of && - a failed
  # build used to fall through and deploy the old dist.
  if [[ ! -d "$REPO/frontend/node_modules" ]]; then (cd "$REPO/frontend" && npm ci >/dev/null); fi
  (cd "$REPO/frontend" && npm run build >/dev/null)      # no npm in the container
  echo "frontend built"
fi
rsync -a --delete --exclude .venv --exclude node_modules --exclude .git --exclude .superpowers \
  --exclude 'neat_insight/bin' --exclude dev-insight.log --exclude DEPLOYED_COMMIT "$REPO/" "$DEV/"
cp "$REPO/webrtc/mediamtx.yml" "$DEV/neat_insight/bin/mediamtx.yml"     # build.sh does this; the launcher reads bin/
rsync -a --delete "$REPO/webrtc/static/" "$DEV/neat_insight/bin/static/"
git -C "$REPO" rev-parse HEAD > "$DEV/DEPLOYED_COMMIT"; git -C "$REPO" status --short >> "$DEV/DEPLOYED_COMMIT"

docker exec "$C" insight-admin stop >/dev/null 2>&1 || true                 # stock service shares :9900
stop_dev
docker exec -d "$C" bash -c 'cd /workspace/.insight-dev && exec .venv/bin/neat-insight --port 9900 >> dev-insight.log 2>&1'
for i in $(seq 1 30); do curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:9900/api/health | grep -q 200 && break; sleep 1; done
echo "health: $(curl -sk https://127.0.0.1:9900/api/health)"
echo "serving: $(docker exec "$C" bash -c 'pgrep -fa "neat-insight --port" | grep -o "/[^ ]*neat-insight" | head -1')  commit $(head -c 12 "$DEV/DEPLOYED_COMMIT")"
echo "note: mediamtx restarted, external publishers (webcam/test streams) must be started again"
