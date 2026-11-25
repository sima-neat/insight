#!/usr/bin/env bash
# Feeds a Viewer channel in the Neat SDK container with a test stream for the Viewer: an H.264 or,
# with --codec jpeg, an RTP/JPEG test pattern (640x480 at 15 fps by default; --size and --rate
# change them) on UDP 9000+N and object-detection metadata
# matched to its frames on UDP 9100+N. The work happens in the container, in the package's
# neat_insight/tools/metadata_test.py (the neat-insight-metadata-test command), which says how the
# metadata is matched and which options it takes after the channel.
#
# Usage, from the laptop:
#   scripts/test-feed.sh <channel> [<option>...]               runs until Ctrl-C
#   scripts/test-feed.sh stop [<channel>]                       stops that channel's feed, or all
#
# The container is the first running sima-neat-sdk* one, as for scripts/deploy-sdk-dev.sh;
# INSIGHT_SDK_CONTAINER=<name> picks another. It needs ffmpeg and python3, which the SDK image has.
set -euo pipefail

SENDER=metadata_test.py
SENDER_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../neat_insight/tools" && pwd)
# The sender runs from a copy at a fixed path, so `stop` can tell it from any other process.
REMOTE_DIR=/tmp/neat-insight-test-feed
REMOTE_SENDER=$REMOTE_DIR/$SENDER

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/test-feed.sh <channel> [<option>...]               runs until Ctrl-C
  scripts/test-feed.sh stop [<channel>]                       stops that channel's feed, or all
Options: --types <type>,...  --metadata-delay-ms <ms>  --codec h264|jpeg  --size <W>x<H>  --rate <N>
         (neat_insight/tools/metadata_test.py --help)
EOF
  exit "${1:-2}"
}

die() {
  echo "test-feed: $*" >&2
  exit 1
}

# The channel number in $1 without leading zeros, which `stop` matches literally.
channel_number() {
  if ! [[ "$1" =~ ^[0-9]+$ ]] || ((10#$1 >= 80)); then die "channel must be 0-79: $1"; fi
  echo $((10#$1))
}

# The anchored command line of the feed on channel $1, or of every feed without one. Anchored,
# because an unanchored pattern also matches the shell that runs pgrep or pkill.
feed_pattern() {
  local pattern="^python3 ${REMOTE_SENDER//./\\.}"
  [[ -n "${1:-}" ]] && pattern+=" $1( |\$)"
  echo "$pattern"
}

# Stops the feed on channel $1, or every feed, and returns once it is gone: a feed started next must
# not overlap it, and a caller timing the stream's end needs it ended.
stop_feeds() {
  local pattern status=0
  pattern=$(feed_pattern "${1:-}")
  # SIGTERM lets the sender stop its ffmpeg. pkill exits 1 when nothing matched.
  docker exec "$CONTAINER" pkill -TERM -f "$pattern" || status=$?
  ((status <= 1)) || die "could not stop the feed (pkill exited $status)"
  if ((status == 1)); then
    echo "test-feed: no feed was running${1:+ on channel $1}" >&2
    return
  fi
  for _ in {1..50}; do
    docker exec "$CONTAINER" pgrep -f "$pattern" >/dev/null || return 0
    sleep 0.1
  done
  die "the feed did not stop within 5 s"
}

# The arguments first: help and mistakes get their answer without a container.
case "${1:-}" in
  -h | --help) usage 0 ;;
  '') usage ;;
  stop)
    [[ $# -le 2 ]] || usage
    action=stop
    channel=
    if [[ -n "${2:-}" ]]; then channel=$(channel_number "$2"); fi
    ;;
  *)
    action=start
    channel=$(channel_number "$1")
    ;;
esac
shift # what follows the channel goes to the sender

CONTAINER=${INSIGHT_SDK_CONTAINER:-$(docker ps --format '{{.Names}}' | grep -m1 'sima-neat-sdk' || true)}
[[ -n "$CONTAINER" ]] || die "SDK container not running (set INSIGHT_SDK_CONTAINER to pick one)"

if [[ "$action" == stop ]]; then
  stop_feeds "$channel"
  exit
fi

# Two senders on one port would interleave two streams into garbage.
if docker exec "$CONTAINER" pgrep -f "$(feed_pattern "$channel")" >/dev/null; then
  die "a feed already runs on channel $channel (scripts/test-feed.sh stop $channel)"
fi
docker exec "$CONTAINER" mkdir -p "$REMOTE_DIR"
docker cp --quiet "$SENDER_DIR/$SENDER" "$CONTAINER:$REMOTE_SENDER"
# docker exec passes no signal into the container, so Ctrl-C stops the sender the way `stop` does.
# The client runs in the background because bash runs a trap only once its foreground command has
# ended, and with the sender gone the client ends too.
trap 'stop_feeds "$channel"; wait' INT TERM HUP
docker exec "$CONTAINER" python3 "$REMOTE_SENDER" "$channel" "$@" &
wait $! || exit $?
