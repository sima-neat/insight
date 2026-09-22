#!/usr/bin/env bash
# Folder-navigation end-to-end suite for issue #113.
#
# Default: start a throwaway neat-insight on :19900 with a temporary HOME (so the developer's
# real media library and slot assignments are untouched), seed a nested test tree, run the
# Playwright suite, and stop the service. Requires a neat-insight with built vf/mediamtx
# binaries on PATH or in NEAT_INSIGHT_CMD, plus ffmpeg, mkcert and Chromium for Playwright.
#
# Against a running instance (for example the SDK dev deploy on :9900):
#   INSIGHT_BASE_URL=https://127.0.0.1:9900 INSIGHT_MEDIA_ROOT=$HOME/workspace/.insight-media \
#     scripts/test-folder-navigation.sh
# INSIGHT_MEDIA_ROOT must be the media root as seen from this machine.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == http://* || "${1:-}" == https://* ]]; then
  echo "error: pass the target as INSIGHT_BASE_URL=$1 (plus INSIGHT_MEDIA_ROOT=...), not as an argument; remaining arguments go to Playwright" >&2
  exit 1
fi

for tool in ffmpeg node npx curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH" >&2
    exit 1
  fi
done

PORT="${INSIGHT_PORT:-19900}"
APP_PID=""
TMP_HOME=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" || true
    wait "$APP_PID" || true
  fi
  if [[ -n "$TMP_HOME" ]]; then
    rm -rf "$TMP_HOME"
  fi
}
trap cleanup EXIT

if [[ -z "${INSIGHT_BASE_URL:-}" ]]; then
  CMD="${NEAT_INSIGHT_CMD:-neat-insight}"
  if ! command -v "$CMD" >/dev/null 2>&1; then
    echo "error: $CMD not found; install a built neat-insight or set INSIGHT_BASE_URL" >&2
    exit 1
  fi
  TMP_HOME="$(mktemp -d)"
  export INSIGHT_BASE_URL="https://127.0.0.1:${PORT}"
  export INSIGHT_MEDIA_ROOT="${TMP_HOME}/.simaai/neat-insight/media"
  LOG="${INSIGHT_LOG:-${PWD}/folder-navigation-insight.log}"
  echo "== Starting ${CMD} on :${PORT} with HOME=${TMP_HOME} (log: ${LOG})"
  # Reuse the CA mkcert already installed for this user; a fresh HOME would otherwise create and
  # try to install a new one, which needs sudo and fails on laptops, containers and the SDK.
  CAROOT_DIR="$(mkcert -CAROOT 2>/dev/null || true)"
  HOME="$TMP_HOME" CAROOT="${CAROOT_DIR:-$TMP_HOME/.local/share/mkcert}" NEAT_METRICS_ZMQ_ENDPOINT="${NEAT_METRICS_ZMQ_ENDPOINT:-tcp://127.0.0.1:55580}" \
    "$CMD" --port "$PORT" > "$LOG" 2>&1 &
  APP_PID=$!
  for attempt in $(seq 1 90); do
    if curl -ksf "${INSIGHT_BASE_URL}/api/health" >/dev/null; then break; fi
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      echo "neat-insight exited before becoming ready" >&2
      cat "$LOG" >&2
      exit 1
    fi
    sleep 1
    if [[ "$attempt" == 90 ]]; then
      echo "neat-insight did not become healthy within 90 seconds" >&2
      cat "$LOG" >&2
      exit 1
    fi
  done
  mkdir -p "$INSIGHT_MEDIA_ROOT"
fi

if [[ -z "${INSIGHT_MEDIA_ROOT:-}" ]]; then
  echo "error: INSIGHT_MEDIA_ROOT must be set when INSIGHT_BASE_URL is given" >&2
  exit 1
fi

echo "== Base URL:   ${INSIGHT_BASE_URL}"
echo "== Media root: ${INSIGHT_MEDIA_ROOT}"
echo "== Frontend: npm run test:e2e"
npm --prefix frontend run test:e2e -- "$@"
