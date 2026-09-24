#!/usr/bin/env bash
# Folder-navigation end-to-end suite for issue #113.
#
# Default: start a throwaway neat-insight on :19900 with a temporary HOME (which isolates the
# developer's slot assignments and certificates, not the media library), run the Playwright suite
# (the suite's own fixture seeds and removes the nested test tree), and stop the service. The media
# root is whatever the service reports at startup. Requires a neat-insight with built vf/mediamtx
# binaries on PATH or in NEAT_INSIGHT_CMD, plus ffmpeg, ffprobe, mkcert and Chromium for Playwright.
#
# Against a running instance (for example the SDK dev deploy on :9900):
#   INSIGHT_BASE_URL=https://127.0.0.1:9900 INSIGHT_MEDIA_ROOT=$HOME/workspace/.insight-media \
#     scripts/test-folder-navigation.sh
# INSIGHT_MEDIA_ROOT must be the media root as seen from this machine. Inside the Neat SDK the
# media root is /workspace/.insight-media, so prefer this INSIGHT_BASE_URL mode against the
# instance already running there.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == http://* || "${1:-}" == https://* ]]; then
  echo "error: pass the target as INSIGHT_BASE_URL=$1 (plus INSIGHT_MEDIA_ROOT=...), not as an argument; remaining arguments go to Playwright" >&2
  exit 1
fi

for tool in ffmpeg ffprobe node npx curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH" >&2
    exit 1
  fi
done

PORT="${INSIGHT_PORT:-19900}"
APP_PID=""
TMP_HOME=""
EXTERNAL_BASE_URL="${INSIGHT_BASE_URL:-}"

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" || true
    for _ in $(seq 1 20); do
      kill -0 "$APP_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill -9 "$APP_PID" || true
    fi
    wait "$APP_PID" || true
  fi
  # On a shared instance the fixture may leave a tree behind if the run was interrupted; the
  # delete endpoint also stops and clears any slot that points into the folder.
  if [[ -n "$EXTERNAL_BASE_URL" && -n "${INSIGHT_MEDIA_ROOT:-}" && -d "${INSIGHT_MEDIA_ROOT:-}" ]]; then
    for leftover in "$INSIGHT_MEDIA_ROOT"/folder-nav-test-*; do
      [[ -d "$leftover" ]] || continue
      name="$(basename "$leftover")"
      if curl -ksf -X POST -H 'Content-Type: application/json' \
        -d "{\"path\": \"${name}\"}" "${EXTERNAL_BASE_URL}/api/delete-media" >/dev/null 2>&1; then
        echo "== Removed leftover test folder ${name}"
      fi
    done
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
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "error: mkcert is required to start a throwaway neat-insight; install it or set INSIGHT_BASE_URL" >&2
    exit 1
  fi
  # Refuse to attach to somebody else's instance: the service also needs the RTSP and HLS ports.
  for p in "$PORT" 8554 8081; do
    if curl -ksf "https://127.0.0.1:${p}/" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:${p}/" >/dev/null 2>&1 || (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${p} "); then
      echo "error: port ${p} is already in use; stop the other neat-insight (or mediamtx/vf) first, or run against it with INSIGHT_BASE_URL" >&2
      exit 1
    fi
  done
  TMP_HOME="$(mktemp -d)"
  export INSIGHT_BASE_URL="https://127.0.0.1:${PORT}"
  LOG="${INSIGHT_LOG:-${PWD}/folder-navigation-insight.log}"
  echo "== Starting ${CMD} on :${PORT} with HOME=${TMP_HOME} (log: ${LOG})"
  # Reuse the CA mkcert already installed for this user; a fresh HOME would otherwise create and
  # try to install a new one, which needs sudo and fails on laptops, containers and the SDK.
  CAROOT_DIR="$(mkcert -CAROOT 2>/dev/null || true)"
  HOME="$TMP_HOME" CAROOT="${CAROOT_DIR:-$TMP_HOME/.local/share/mkcert}" NEAT_METRICS_ZMQ_ENDPOINT="${NEAT_METRICS_ZMQ_ENDPOINT:-tcp://127.0.0.1:55580}" \
    "$CMD" --port "$PORT" > "$LOG" 2>&1 &
  APP_PID=$!
  for attempt in $(seq 1 90); do
    # Only accept a healthy answer while our own process is alive, so an orphan cannot stand in.
    if kill -0 "$APP_PID" 2>/dev/null && curl -ksf "${INSIGHT_BASE_URL}/api/health" >/dev/null; then break; fi
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
  # The service prints its media directory at startup; trust that instead of guessing a path.
  INSIGHT_MEDIA_ROOT="$(sed -n 's/^Insight media directory: //p' "$LOG" | tail -1)"
  if [[ -z "$INSIGHT_MEDIA_ROOT" ]]; then
    echo "error: could not read the media root from $LOG" >&2
    exit 1
  fi
  export INSIGHT_MEDIA_ROOT
fi

if [[ -z "${INSIGHT_MEDIA_ROOT:-}" ]]; then
  echo "error: INSIGHT_MEDIA_ROOT must be set when INSIGHT_BASE_URL is given" >&2
  exit 1
fi

[[ -w "$INSIGHT_MEDIA_ROOT" ]] || { echo "error: media root $INSIGHT_MEDIA_ROOT is not writable from this shell (on the SDK laptop the mount is root-owned; run the suite from inside the container or seed through docker exec)" >&2; exit 1; }

echo "== Base URL:   ${INSIGHT_BASE_URL}"
echo "== Media root: ${INSIGHT_MEDIA_ROOT}"
echo "== Frontend: npm run test:e2e"
npm --prefix frontend run test:e2e -- ${1+"$@"}
