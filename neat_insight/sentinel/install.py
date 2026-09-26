"""Detect Sentinel on the selected board and install it when it is missing.

`sima-cli neat install sentinel` runs on the board (it has no `--ip`) and its installer
needs sudo. The installer always restarts the daemon, which would break a trace in
flight, so a healthy install is never reinstalled.
"""
from datetime import datetime, timedelta, timezone

from neat_insight.sentinel.errors import SentinelError
from neat_insight.sentinel.socket_client import SOCKET_PATH

SERVICE = "simaai-sentinel"
STATUS_TIMEOUT_SEC = 20.0
# The installer downloads and unpacks a Vulcan artifact; on a slow link that is minutes.
INSTALL_TIMEOUT_SEC = 900.0
LOG_LIMIT = 4000
FALLBACK_CLI = "$HOME/.sima-cli/.venv/bin/sima-cli"
MANUAL_COMMAND = "sudo env SIMA_INSTALL_CONTEXT=1 SIMA_CLI_CHECK_FOR_UPDATE=0 sima-cli neat install sentinel"

# `sima-cli` is often absent from a non-login PATH, so the user's own copy is checked too.
_STATUS_SCRIPT = """
systemctl is-active {service} 2>/dev/null || true
echo @@
test -S {socket} && echo yes || echo no
echo @@
systemctl cat {service}.service >/dev/null 2>&1 && echo yes || echo no
echo @@
command -v sima-cli 2>/dev/null || {{ [ -x "{fallback}" ] && printf '%s\\n' "{fallback}"; }} || true
echo @@
# Seconds the service has been running, from two monotonic clocks: the board's wall clock can be
# wrong right after a boot, before time sync, so a start timestamp read from it could be too.
since=$(systemctl show {service} -p ActiveEnterTimestampMonotonic --value 2>/dev/null)
[ "${{since:-0}}" -gt 0 ] 2>/dev/null && awk -v since="$since" '{{ printf "%d\\n", $1 - since / 1000000 }}' /proc/uptime || true
""".format(
    service=SERVICE, socket=SOCKET_PATH, fallback=FALLBACK_CLI
)

# Not a format string: it is passed as an argument, so its braces reach sh as written.
_INSTALL_SCRIPT = """
set -e
sudo -n true 2>/dev/null || { echo 'sudo: a password is required' >&2; exit 77; }
dir=$(mktemp -d /tmp/sentinel-install.XXXXXX)
# The installer runs as root and leaves root-owned trees in $dir that this user cannot
# remove, so the directory goes with the same passwordless sudo the install runs under.
cleanup() { sudo -n rm -rf -- "$dir"; }
trap cleanup EXIT
# dash skips the EXIT trap when a signal ends the shell; exiting from each one runs it.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
sudo -n env SIMA_INSTALL_CONTEXT=1 SIMA_CLI_CHECK_FOR_UPDATE=0 "$SIMA_CLI" neat install sentinel -d "$dir"
"""


def _tail(*chunks) -> str:
    text = "\n".join(chunk.decode("utf-8", errors="replace").strip() for chunk in chunks if chunk)
    return text.strip()[-LOG_LIMIT:]


def status(session) -> dict:
    """Report whether Sentinel is installed, running and reachable on the board."""
    result = session.transport.exec(["sh", "-c", _STATUS_SCRIPT], timeout=STATUS_TIMEOUT_SEC)
    parts = (result.stdout.decode("utf-8", errors="replace").split("@@") + [""] * 5)[:5]
    service, socket_present, unit_present, sima_cli, running = (part.strip() for part in parts)
    installed = unit_present == "yes" or socket_present == "yes"
    started_at = None
    if service == "active" and running.isdigit():
        # On Insight's clock: the page shows it relative to the viewer's own time.
        started_at = (datetime.now(timezone.utc) - timedelta(seconds=int(running))).isoformat(timespec="seconds")
    return {
        "installed": installed,
        "healthy": service == "active" and socket_present == "yes",
        "service": service or "unknown",
        "socket": socket_present == "yes",
        "socket_path": SOCKET_PATH,
        "sima_cli": sima_cli.splitlines()[0].strip() if sima_cli else None,
        "started_at": started_at,
    }


def describe(state: dict) -> dict:
    """Why Sentinel cannot be used, in the board error shape, or ``None`` when it can."""
    if state["healthy"]:
        return None
    if not state["installed"]:
        return {
            "error": "Sentinel is not installed on this board.",
            "code": "sentinel_missing",
            "hint": "Install it from this page, or run `{}` on the board.".format(MANUAL_COMMAND),
        }
    return {
        "error": "The {} service is installed but {}.".format(SERVICE, state["service"] or "not running"),
        "code": "sentinel_stopped",
        "hint": "Start it on the board with `sudo systemctl start {}`.".format(SERVICE),
    }


def install(session) -> dict:
    """Install Sentinel on the board with sima-cli; refuses to reinstall a healthy daemon."""
    state = status(session)
    if state["healthy"]:
        raise SentinelError(
            "already_installed",
            "Sentinel is already installed and running on this board.",
            hint="Reinstalling restarts the daemon and would end a trace in flight. Reinstall from a shell on "
            "the board if you really need to.",
        )
    if not state["sima_cli"]:
        raise SentinelError(
            "sentinel_failed",
            "`sima-cli` was not found on the board, so Sentinel cannot be installed from here.",
            hint="Install sima-cli on the board, then retry, or install Sentinel there with `{}`.".format(
                MANUAL_COMMAND
            ),
            tool="sima-cli",
        )
    result = session.transport.exec(install_command(state["sima_cli"]), timeout=INSTALL_TIMEOUT_SEC)
    log = _tail(result.stdout, result.stderr)
    if result.exit_code == 77:
        raise SentinelError(
            "sentinel_denied",
            "Installing Sentinel needs sudo on the board, and this user cannot use sudo without a password.",
            hint="Run `{}` in a shell on the board, then reload this page.".format(MANUAL_COMMAND),
            detail=log,
        )
    if result.exit_code != 0:
        raise SentinelError(
            "sentinel_failed",
            "`sima-cli neat install sentinel` failed on the board (exit {}).".format(result.exit_code),
            hint="The installer's output is in detail; run it in a shell on the board to see the full log.",
            detail=log,
        )
    state = status(session)
    if not state["healthy"]:
        raise SentinelError(
            "sentinel_failed",
            "The installer finished but the {} service is {}.".format(SERVICE, state["service"]),
            hint="Check `systemctl status {}` on the board.".format(SERVICE),
            detail=log,
        )
    return {"status": state, "log": log}


def install_command(sima_cli: str) -> list:
    """The board command that installs Sentinel with the `sima-cli` found at ``sima_cli``."""
    return ["sh", "-c", "SIMA_CLI={}\n{}".format(_quote(sima_cli), _INSTALL_SCRIPT)]


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"
