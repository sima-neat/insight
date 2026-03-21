#!/usr/bin/env bash
set -euo pipefail

# Multi-source traffic harness for viewer testing:
# - Video RTP to 9000.. (default 16 channels)
# - Metadata UDP JSON to 9100.. (default 16 channels)
#
# Example:
#   neat_insight/tools/multisrc-harness.sh start
#   neat_insight/tools/multisrc-harness.sh status
#   neat_insight/tools/multisrc-harness.sh stop

CMD="${1:-}"
shift || true

BASE_DIR="${BASE_DIR:-/tmp/insight-multisrc-test}"
VIDEO_DIR_DEFAULT="$HOME/multisrc/multisrc/videos-720p16"
VIDEO_DIR="$VIDEO_DIR_DEFAULT"
COUNT=16
VIDEO_START_PORT=9000
META_START_PORT=9100
META_TYPES="object-detection"
FOREGROUND=0

VIDEO_PID_FILE="$BASE_DIR/video_pids.txt"
META_PID_FILE="$BASE_DIR/metadata_pid.txt"
LOG_DIR="$BASE_DIR/logs"

usage() {
  cat <<EOF
Usage:
  $0 <start|stop|status|restart> [options]

Options:
  --video-dir <path>           Video source dir (default: $VIDEO_DIR_DEFAULT)
  --count <n>                  Number of channels (default: 16)
  --video-start-port <port>    Starting video RTP port (default: 9000)
  --meta-start-port <port>     Starting metadata UDP port (default: 9100)
  --meta-types <csv>           Metadata types for metadata-test.py (default: object-detection)
  --foreground                 Keep running in foreground until Ctrl+C

Examples:
  $0 start
  $0 start --foreground
  $0 start --count 16 --video-dir ~/multisrc/multisrc/videos-720p16
  $0 restart --meta-types object-detection,classification
  $0 status
  $0 stop
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --video-dir)
      VIDEO_DIR="$2"
      shift 2
      ;;
    --count)
      COUNT="$2"
      shift 2
      ;;
    --video-start-port)
      VIDEO_START_PORT="$2"
      shift 2
      ;;
    --meta-start-port)
      META_START_PORT="$2"
      shift 2
      ;;
    --meta-types)
      META_TYPES="$2"
      shift 2
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

kill_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi
  while read -r pid; do
    [[ -n "${pid:-}" ]] || continue
    kill "$pid" 2>/dev/null || true
  done < "$pid_file"
}

status() {
  local alive_v=0
  local total_v=0
  local meta_state="stopped"
  local meta_pid=""

  if [[ -f "$VIDEO_PID_FILE" ]]; then
    while read -r pid; do
      [[ -n "${pid:-}" ]] || continue
      total_v=$((total_v + 1))
      if kill -0 "$pid" 2>/dev/null; then
        alive_v=$((alive_v + 1))
      fi
    done < "$VIDEO_PID_FILE"
  fi

  if [[ -f "$META_PID_FILE" ]]; then
    meta_pid="$(cat "$META_PID_FILE" || true)"
    if [[ -n "${meta_pid:-}" ]] && kill -0 "$meta_pid" 2>/dev/null; then
      meta_state="running"
    fi
  fi

  echo "Harness base: $BASE_DIR"
  echo "Video senders: $alive_v/$total_v running"
  echo "Metadata sender: $meta_state${meta_pid:+ (pid=$meta_pid)}"
  echo "Logs: $LOG_DIR"
}

start() {
  require_cmd ffmpeg
  require_cmd python3

  mkdir -p "$LOG_DIR"
  : > "$VIDEO_PID_FILE"

  # Stop previous run if any
  kill_pid_file "$VIDEO_PID_FILE"
  kill_pid_file "$META_PID_FILE"
  : > "$VIDEO_PID_FILE"

  video_files=()
  while IFS= read -r file; do
    video_files+=("$file")
  done < <(find "$VIDEO_DIR" -maxdepth 1 -type f \( -name '*.mp4' -o -name '*.mov' -o -name '*.mkv' -o -name '*.avi' -o -name '*.webm' \) | sort)
  if [[ "${#video_files[@]}" -lt "$COUNT" ]]; then
    echo "Need at least $COUNT video files in $VIDEO_DIR, found ${#video_files[@]}" >&2
    exit 1
  fi

  echo "Starting $COUNT RTP video senders to 127.0.0.1:$VIDEO_START_PORT..$((VIDEO_START_PORT + COUNT - 1))"
  for ((i=0; i<COUNT; i++)); do
    local_port=$((VIDEO_START_PORT + i))
    file="${video_files[$i]}"
    log_file="$(printf "%s/video%02d.log" "$LOG_DIR" $((i+1)))"
    (
      while true; do
        ffmpeg -nostdin -hide_banner -loglevel warning -re -stream_loop -1 -i "$file" \
          -map 0:v:0 -an -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
          -profile:v baseline -level 3.1 -bf 0 -g 30 -keyint_min 30 -sc_threshold 0 \
          -x264-params "repeat-headers=1:aud=1:nal-hrd=none" \
          -f rtp -payload_type 96 "rtp://127.0.0.1:${local_port}?pkt_size=1200" \
          >> "$log_file" 2>&1 || true
        sleep 0.2
      done
    ) &
    echo $! >> "$VIDEO_PID_FILE"
  done

  echo "Starting metadata sender to 127.0.0.1:$META_START_PORT..$((META_START_PORT + COUNT - 1))"
  python3 neat_insight/tools/metadata-test.py \
    --start-port "$META_START_PORT" \
    --count "$COUNT" \
    --types "$META_TYPES" \
    > "$LOG_DIR/metadata.log" 2>&1 &
  echo $! > "$META_PID_FILE"

  sleep 1
  status

  if [[ "$FOREGROUND" -eq 1 ]]; then
    echo "Running in foreground mode. Press Ctrl+C to stop all harness processes."
    cleanup() {
      trap - INT TERM
      stop
      exit 0
    }
    trap cleanup INT TERM
    while true; do
      sleep 1
    done
  fi
}

stop() {
  kill_pid_file "$VIDEO_PID_FILE"
  kill_pid_file "$META_PID_FILE"
  echo "Stopped harness processes."
}

case "$CMD" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  status)
    status
    ;;
  restart)
    stop
    start
    ;;
  *)
    usage
    exit 1
    ;;
esac
