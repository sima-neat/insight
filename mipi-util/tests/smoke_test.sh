#!/bin/bash
# On-device smoke test for sima-mipi-util.
#
# Run this on the Modalix board (or any devkit runner) after installing the
# package. It exercises the live HTTP API the way the reviewers asked: generic
# installation + API access, no MIPI camera strictly required (camera-dependent
# checks degrade to warnings).
#
# Usage:
#   tests/smoke_test.sh                      # hits http://127.0.0.1:5000, token from /etc
#   BASE=http://192.168.1.20:5000 tests/smoke_test.sh
#   TOKEN=xxxx tests/smoke_test.sh
#   tests/smoke_test.sh --deb ./sima-mipi-util_1.0.0_all.deb   # offline package checks only
#
# Logging (opt-in; the terminal output is unchanged):
#   tests/smoke_test.sh --log                 # -> ./sima-mipi-util-smoke-<timestamp>.log
#   tests/smoke_test.sh --log-file /path.log  # explicit path
#   LOG_FILE=/path.log tests/smoke_test.sh    # same, via environment
# The log is plain text (no ANSI colors), carries a context header (host, OS,
# package, target), and prefixes every PASS/FAIL/WARN with a timestamp. Works
# in --deb mode too.
#
set -u

BASE="${BASE:-http://127.0.0.1:5000}"
TOKEN="${TOKEN:-}"
PASS=0; FAIL=0; WARN=0

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

ok()   { green   "  PASS: $1"; PASS=$((PASS+1)); _log "PASS: $1"; }
bad()  { red     "  FAIL: $1"; FAIL=$((FAIL+1)); _log "FAIL: $1"; }
warn() { yellow  "  WARN: $1"; WARN=$((WARN+1)); _log "WARN: $1"; }

# HTTP status for a request. Args: METHOD PATH [json-body]
code() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" --max-time 8)
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  [ -n "$TOKEN" ] && args+=(-H "X-Auth-Token: $TOKEN")
  curl "${args[@]}" "$BASE$path" 2>/dev/null
}
# Same but never sends the token (for the unauthenticated-write check).
code_notoken() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" --max-time 8)
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$BASE$path" 2>/dev/null
}

# ── Logging (opt-in; timestamps every result line) ───────────────────────────
# Pull --log/--log-file out of the arguments, leaving any remaining args (e.g.
# `--deb <file>`) untouched. LOG_FILE may also be set via the environment.
LOG_FILE="${LOG_FILE:-}"
_want_log=0
[ -n "$LOG_FILE" ] && _want_log=1
_rest=()
while [ $# -gt 0 ]; do
  case "$1" in
    --log)        _want_log=1; shift ;;
    --log-file)   _want_log=1; LOG_FILE="${2:?--log-file needs a path}"; shift 2 ;;
    --log-file=*) _want_log=1; LOG_FILE="${1#--log-file=}"; shift ;;
    *)            _rest+=("$1"); shift ;;
  esac
done
if [ "${#_rest[@]}" -gt 0 ]; then set -- "${_rest[@]}"; else set --; fi
if [ "$_want_log" = "1" ] && [ -z "$LOG_FILE" ]; then
  LOG_FILE="./sima-mipi-util-smoke-$(date +%Y%m%d-%H%M%S).log"
fi

_ts()  { date '+%Y-%m-%d %H:%M:%S'; }
_log() { [ -n "$LOG_FILE" ] && printf '%s  %s\n' "$(_ts)" "$1" >> "$LOG_FILE"; return 0; }

if [ -n "$LOG_FILE" ]; then
  if ! : > "$LOG_FILE" 2>/dev/null; then
    echo "ERROR: cannot write log file: $LOG_FILE" >&2; exit 2
  fi
  {
    echo "==================================================================="
    echo " sima-mipi-util on-device smoke test"
    echo " started : $(_ts)"
    echo " host    : $(hostname 2>/dev/null) ($(uname -m 2>/dev/null))"
    [ -r /etc/os-release ] && echo " os      : $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-}")"
    command -v dpkg-query >/dev/null 2>&1 && \
      echo " package : $(dpkg-query -W -f='${Package} ${Version}' sima-mipi-util 2>/dev/null)"
    echo " target  : $BASE"
    echo "==================================================================="
  } >> "$LOG_FILE"
  echo "   (logging to $LOG_FILE)"
fi

# ── Offline package validation mode ─────────────────────────────────────────
if [ "${1:-}" = "--deb" ]; then
  DEB="${2:?usage: smoke_test.sh --deb <file.deb>}"
  echo "== Package validation: $DEB =="
  if dpkg-deb --info "$DEB" >/dev/null 2>&1; then ok "dpkg-deb --info parses"; else bad "dpkg-deb --info failed"; fi
  contents="$(dpkg-deb --contents "$DEB" 2>/dev/null)"
  for want in usr/share/sima-mipi-util/camera_api.py usr/bin/sima-mipi-util lib/systemd/system/sima-mipi-util.service; do
    if echo "$contents" | grep -q "$want"; then ok "contains $want"; else bad "missing $want"; fi
  done
  _log "SUMMARY: $PASS passed, $FAIL failed, $WARN warnings"
  echo "== $PASS passed, $FAIL failed, $WARN warnings =="
  [ "$FAIL" -eq 0 ]
  exit $?
fi

echo "== Target: $BASE =="

# Try to read the install-provisioned token if none was supplied.
if [ -z "$TOKEN" ] && [ -r /etc/sima-mipi-util/token ]; then
  TOKEN="$(cat /etc/sima-mipi-util/token)"
  echo "   (using token from /etc/sima-mipi-util/token)"
fi
[ -z "$TOKEN" ] && warn "no token available — write-with-token checks will be skipped"

# ── Service state ────────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet sima-mipi-util.service; then ok "service is active"
  else bad "service is not active (journalctl -u sima-mipi-util.service -e)"; fi
else
  warn "systemctl not present; skipping service-state check"
fi

# ── Correct build owns port 5000 (catches a stale old service shadowing it) ──
case "$BASE" in
  *127.0.0.1*|*localhost*)
    if command -v ss >/dev/null 2>&1; then
      spid="$(ss -ltnpH 'sport = :5000' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)"
      scmd="$(tr '\0' ' ' < "/proc/${spid}/cmdline" 2>/dev/null)"
      case "$scmd" in
        *sima-mipi-util*) ok "port 5000 served by sima-mipi-util" ;;
        "")               warn "could not identify the process on :5000" ;;
        *)                bad "port 5000 served by an UNEXPECTED build: ${scmd} (stale old service?)" ;;
      esac
    fi ;;
esac

# ── Reads are open (no token) ────────────────────────────────────────────────
for p in /api/health /api/status /api/cameras; do
  c="$(code_notoken GET "$p")"
  if [ "$c" = "200" ]; then ok "GET $p -> 200 (open)"; else bad "GET $p -> $c (expected 200)"; fi
done

# ── CORS is not a wildcard ───────────────────────────────────────────────────
acao="$(curl -s -D - -o /dev/null --max-time 8 "$BASE/api/status" 2>/dev/null \
        | awk 'BEGIN{IGNORECASE=1} /^access-control-allow-origin:/{print $2}' | tr -d '\r')"
if [ "$acao" = "*" ]; then bad "CORS Access-Control-Allow-Origin is wildcard (*)"
else ok "CORS not wildcard (${acao:-absent})"; fi

# ── Writes require the token ─────────────────────────────────────────────────
noauth="$(code_notoken POST /api/set '{"control":"sdev_digital_gain","value":300}')"
if [ "$noauth" = "401" ]; then ok "POST /api/set without token -> 401"; else bad "POST /api/set without token -> $noauth (expected 401)"; fi

# A wrong token must also be rejected (proves it validates, not just presence).
wrongauth="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -X POST \
  -H 'Content-Type: application/json' -H 'X-Auth-Token: definitely-not-the-token' \
  -d '{"control":"sdev_digital_gain","value":300}' "$BASE/api/set" 2>/dev/null)"
if [ "$wrongauth" = "401" ]; then ok "POST /api/set with WRONG token -> 401"; else bad "POST /api/set wrong token -> $wrongauth (expected 401)"; fi

if [ -n "$TOKEN" ]; then
  c="$(code POST /api/set '{"control":"sdev_digital_gain","value":300}')"
  if [ "$c" = "200" ]; then ok "POST /api/set with token -> 200"; else bad "POST /api/set with token -> $c (expected 200)"; fi

  c="$(code POST /api/set '{"control":"sdev_digital_gain","value":"nope"}')"
  if [ "$c" = "400" ]; then ok "POST /api/set bad int -> 400"; else bad "POST /api/set bad int -> $c (expected 400)"; fi
fi

# ── Set → read-back round-trip (proves the write actually lands on the ISP) ──
# Set a value, read it back via /api/controls, confirm it took (within a small
# tolerance for auto-algorithm drift), then restore the original.
if [ -n "$TOKEN" ] && command -v python3 >/dev/null 2>&1; then
  _ctrl_value() {  # $1=control -> current value from /api/controls
    curl -s --max-time 8 "$BASE/api/controls" 2>/dev/null \
      | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',{}).get('value',''))" 2>/dev/null
  }
  set_readback() {  # $1=control $2=test-value $3=tolerance(default 4)
    local ctrl="$1" val="$2" tol="${3:-4}" orig got sc diff
    orig="$(_ctrl_value "$ctrl")"
    sc="$(code POST /api/set "{\"control\":\"$ctrl\",\"value\":$val}")"
    if [ "$sc" != "200" ]; then bad "$ctrl set=$val -> HTTP $sc"; return; fi
    got="$(_ctrl_value "$ctrl")"
    if ! [ "$got" -eq "$got" ] 2>/dev/null; then bad "$ctrl read-back not numeric ('$got')"; return; fi
    diff=$(( got > val ? got - val : val - got ))
    if [ "$diff" -le "$tol" ]; then ok "$ctrl set→readback: set $val, read $got (±$tol)"
    else bad "$ctrl set→readback drift: set $val, read $got (> $tol)"; fi
    # restore the original value if we captured a numeric one
    if [ -n "$orig" ] && [ "$orig" -eq "$orig" ] 2>/dev/null; then
      code POST /api/set "{\"control\":\"$ctrl\",\"value\":$orig}" >/dev/null 2>&1
    fi
  }
  set_readback sdev_digital_gain          512 4
  set_readback system_saturation_target   140 6
  set_readback system_sinter_threshold_target 35 6
elif [ -n "$TOKEN" ]; then
  warn "python3 not present — skipping set/read-back checks"
fi

# ── System reboot must be refused ────────────────────────────────────────────
# SAFETY: only probe this when auth is actually enforced (the no-token write
# returned 401 above). If it did NOT, we're talking to an old/unexpected build
# whose /api/restart {"type":"system"} may still trigger a REAL device reboot —
# never send that to it.
if [ "$noauth" = "401" ]; then
  c="$(code POST /api/restart '{"type":"system"}')"
  if [ "$c" = "403" ]; then ok "POST /api/restart system -> 403 (disabled)"; else bad "POST /api/restart system -> $c (expected 403)"; fi
else
  warn "skipping system-reboot check: auth not enforced, so this is an old/unexpected build — refusing to risk a real device reboot"
fi

# ── Live stream produces frames ──────────────────────────────────────────────
# The core function. Real 1080p JPEG frames are tens/hundreds of KB; the
# no-camera fallback emits only a tiny blank JPEG every few seconds.
sf="$(mktemp)"
timeout 6 curl -s --max-time 6 "$BASE/api/stream" -o "$sf" 2>/dev/null || true
sz="$(stat -c%s "$sf" 2>/dev/null || echo 0)"
rm -f "$sf"
if [ "$sz" -gt 10000 ]; then ok "live stream produced frames (${sz} bytes)"
elif [ "$sz" -gt 0 ]; then warn "live stream returned only ${sz} bytes (blank frames — camera not producing?)"
else bad "live stream produced no data"; fi

_log "SUMMARY: $PASS passed, $FAIL failed, $WARN warnings"
echo "== $PASS passed, $FAIL failed, $WARN warnings =="
[ "$FAIL" -eq 0 ]
