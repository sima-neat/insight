#!/usr/bin/env bash
# Runs the FPS-rendition test suite for issue #111: backend integration tests
# against real ffmpeg/ffprobe and the frontend FPS-control unit tests.
# Usage: scripts/test-fps-renditions.sh   (PYTHON=/path/to/python to override the interpreter)
set -euo pipefail

cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH (install FFmpeg)" >&2
    exit 1
  fi
done
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

export NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS=1
export NEAT_METRICS_ZMQ_ENDPOINT="${NEAT_METRICS_ZMQ_ENDPOINT:-tcp://127.0.0.1:55580}"

echo "== Backend: tests.test_fps_renditions"
"$PYTHON" -m unittest tests.test_fps_renditions -v

echo "== Frontend: npm run test:unit"
npm --prefix frontend run test:unit
