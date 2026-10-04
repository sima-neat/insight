"""Run one temporary camera preview: a PyNeat graph on the board feeding a vf channel."""
import ipaddress
import json
import logging
import re
import shlex
import ssl
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

from neat_insight.board import BoardError

DEFAULT_VIDEO_UDP_PORT = 9000
DEFAULT_VIDEO_UI_PORT = 8081
HEARTBEAT_INTERVAL_MS = 5000
SESSION_TTL_SEC = 45.0
START_TIMEOUT_SEC = 25.0
VIDEO_ARRIVAL_TIMEOUT_SEC = 8.0
PROGRAM = Path(__file__).with_name("graph.py").read_bytes()
BOARD_CHECK = Path(__file__).parent.parent / "peripherals" / "board_check.py"
WORKER_DIR = "/tmp/insight-preview"
# Prints the address Insight connects from, then PyNeat's python when the per-user venv has PyNeat.
PREPARE_SCRIPT = (
    'echo "$SSH_CLIENT"; venv="${PYNEAT_VENV_DIR:-$HOME/pyneat}"; '
    'set -- "$venv"/lib/python3*/site-packages/pyneat-*.dist-info; '
    '[ -e "$1" ] && [ -x "$venv/bin/python" ] && echo "$venv/bin/python"; true'
)
_DEVICE_NODE = re.compile(r"/dev/[A-Za-z0-9_./-]+")
# What libcamera prints when another process holds the camera.
_CAMERA_BUSY = re.compile(r"Failed to acquire camera|Device or resource busy")
# The board-side worker stops the program once Insight stops touching the heartbeat file.
WORKER_SCRIPT = """#!/bin/sh
set -e
sid="$1"; ttl="$2"; shift 2
dir="{worker_dir}/$sid"
find "{worker_dir}" -maxdepth 1 -name '*.log' -mmin +60 -delete 2>/dev/null || true
started=$(date +%s)
beat="$dir/heartbeat"
touch "$beat"
"$@" > "$dir/pipeline.log" 2>&1 &
pipeline=$!
echo "$pipeline" > "$dir/pipeline.pid"
while :; do
    sleep 2
    kill -0 "$pipeline" 2>/dev/null || break
    now=$(date +%s)
    beat_at=$(stat -c %Y "$beat" 2>/dev/null || echo 0)
    if [ $((now - beat_at)) -gt "$ttl" ]; then
        kill "$pipeline" 2>/dev/null || true
        for i in 1 2 3 4 5 6 7 8; do kill -0 "$pipeline" 2>/dev/null || break; sleep 1; done
        kill -9 "$pipeline" 2>/dev/null || true
        break
    fi
done
if [ $(( $(date +%s) - started )) -lt 15 ]; then
    tail -c 800 "$dir/pipeline.log" > "{worker_dir}/$sid.log" 2>/dev/null || true
    [ -s "{worker_dir}/$sid.log" ] || rm -f "{worker_dir}/$sid.log"
fi
rm -rf "$dir"
""".format(worker_dir=WORKER_DIR)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _expired(session: dict) -> bool:
    return _now() > datetime.fromisoformat(session["expires_at"])


def _expiry() -> str:
    return (_now() + timedelta(seconds=SESSION_TTL_SEC)).isoformat(timespec="seconds")


def _valid_port(value) -> Optional[int]:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def _ingest_stats() -> Optional[list]:
    # vf's own route: vf answers unknown paths, such as Insight's /api proxy, with the viewer page.
    url = f"https://127.0.0.1:{DEFAULT_VIDEO_UI_PORT}/ingest/stats?all=1"
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(url, timeout=3, context=context) as response:
            return json.loads(response.read().decode("utf-8"))["channels"]
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown", never "all free"
        logging.warning("vf ingest stats unavailable at %s: %s", url, exc)
        return None


def _channel_rtp(channel: int) -> Optional[dict]:
    stats = _ingest_stats()
    if stats is None:
        return None
    entry = next((entry for entry in stats if entry.get("channel") == channel), {})
    rtp = entry.get("rtp")
    ssrc = rtp.get("ssrc") if isinstance(rtp, dict) else None
    return {"active": bool(entry.get("active")), "ssrc": ssrc if isinstance(ssrc, int) and ssrc else None}


def _channel_taken(channel: int) -> BoardError:
    return BoardError(
        "channel_taken",
        "An application started sending to this channel; the preview stopped so it would not corrupt that stream.",
        hint="Start the preview again; Insight will pick a channel nothing is sending to.",
        channel=channel,
    )


@lru_cache(maxsize=1)
def _neat_exposed_ports() -> list:
    """The SDK's published ports from `neat --json`, for setups without a port-map file."""
    try:
        result = subprocess.run(["neat", "--json"], capture_output=True, timeout=20, check=False)
        return list(json.loads(result.stdout.decode("utf-8", errors="replace")).get("exposedPorts", []))
    except (OSError, ValueError, AttributeError, TypeError, subprocess.SubprocessError):
        return []


def _camera_in_use(name: str, users: list, detail: str = "") -> BoardError:
    holders = ", ".join(f"{user['command']} (pid {user['pid']})" for user in users)
    return BoardError(
        "camera_in_use",
        f"{name} is already in use: " + (f"Open in {holders}." if holders else "libcamera could not acquire the camera; another process holds it."),
        hint="Stop the application using the camera, then start the preview.",
        users=users,
        **({"detail": detail} if detail else {}),
    )


def _unknown_session() -> BoardError:
    return BoardError("not_found", "That preview session is not running.", hint="Start the preview again.")


def _log_tail(session_id: str) -> str:
    directory = f"{WORKER_DIR}/{session_id}"
    return f"tail -c 800 {directory}/pipeline.log 2>/dev/null || tail -c 800 {WORKER_DIR}/{session_id}.log 2>/dev/null"


class PreviewManager:
    """At most one preview, owned by the board session that started it."""

    def __init__(self, exposed_ports, channel_capacity, format_url):
        self._exposed_ports = exposed_ports
        self._channel_capacity = channel_capacity
        self._format_url = format_url
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._session: Optional[dict] = None
        self._owner = None
        self._starting: Optional[str] = None

    def _port_entry(self, name: str) -> Optional[dict]:
        def find(rows):
            return next((row for row in rows if isinstance(row, dict) and str(row.get("name") or "").split(".")[0] == name
                         and _valid_port(row.get("hostPortStart"))), None)
        return find(self._exposed_ports()) or find(_neat_exposed_ports())

    def _udp_range(self):
        entry = self._port_entry("videoUDP")
        if entry is None:
            return None
        start = _valid_port(entry["hostPortStart"])
        end = _valid_port(entry.get("hostPortEnd")) or start
        return (start, end - start + 1) if end >= start else None

    def viewer_url(self, host: str, channel: int) -> str:
        """`host` must already be validated; see `api.browser_host`."""
        port = _valid_port((self._port_entry("videoUI") or {}).get("hostPortStart")) or DEFAULT_VIDEO_UI_PORT
        query = f"mode=light&src={channel}&max_channels={self._channel_capacity()}&embed=1"
        return self._format_url(host, port, "/static/viewer.html", query)

    def current(self, generation: int) -> Optional[dict]:
        with self._lock:
            session = self._session
            if session is None or session["generation"] != generation or _expired(session):
                return None
            return dict(session)

    def start(self, board_session, item: dict, mode: dict) -> dict:
        """Start one scanned camera's mode; `mode` is {format, width, height, fps} with a whole fps."""
        with self._lock:
            session = self._session
        if session is not None and (_expired(session) or session["generation"] != board_session.generation):
            self._release(session["id"])
        with self._lock:
            running = self._starting or (self._session or {}).get("camera_id")
            if running:
                raise BoardError(
                    "preview_active",
                    f"A preview of {running} is already starting or running.",
                    hint="Stop that preview before starting another one.",
                    camera_id=running,
                )
            self._starting = item["id"]
        try:
            return self._start(board_session, item, mode)
        finally:
            with self._lock:
                self._starting = None
                self._idle.notify_all()

    def _start(self, board_session, item: dict, mode: dict) -> dict:
        target_host, port_base, python = self._prepare(board_session)
        self._require_camera_free(board_session, item)
        channel = self._reserve_channel(board_session)
        previous = (_channel_rtp(channel) or {}).get("ssrc")
        session_id = uuid.uuid4().hex
        args = [item["device"]["camera_name"], target_host, mode["width"], mode["height"], mode["fps"], port_base, channel]
        self._start_worker(board_session, session_id, [python, f"{WORKER_DIR}/{session_id}/preview.py", *map(str, args)])
        session = {
            "id": session_id,
            "camera_id": item["id"],
            "mode": dict(mode),
            "channel": channel,
            "ssrc": None,
            "generation": board_session.generation,
            "started_at": _now().isoformat(timespec="seconds"),
            "expires_at": _expiry(),
            "heartbeat_interval_ms": HEARTBEAT_INTERVAL_MS,
            "state": "live",
        }
        with self._lock:
            self._session, self._owner = session, board_session
        self._await_video(board_session, session, previous)
        return dict(session)

    def _prepare(self, board_session):
        result = board_session.transport.exec(["sh", "-c", PREPARE_SCRIPT], timeout=10)
        lines = result.stdout.decode("utf-8", errors="replace").splitlines() + ["", ""]
        client, python = (lines[0].split() or [""])[0], lines[1].strip()
        if not python:
            raise BoardError(
                "tool_missing",
                "Preview runs on PyNeat, which is not installed for this user on the board.",
                hint="On the board, run `sima-cli neat install core` (run `sima-cli login` first if it asks); "
                "it installs PyNeat in ~/pyneat.",
                tool="pyneat",
            )
        if board_session.target.mode == "local":
            return "127.0.0.1", DEFAULT_VIDEO_UDP_PORT, python
        try:
            # $SSH_CLIENT is board-controlled and ends up in the program's arguments.
            ipaddress.ip_address(client)
        except ValueError:
            raise BoardError(
                "command_failed",
                f"The board reported an address Insight cannot use: {client[:60]}",
                hint="Preview needs the board to send video back to Insight; check the SSH connection.",
            ) from None
        published = self._udp_range()
        return client, published[0] if published else DEFAULT_VIDEO_UDP_PORT, python

    def _require_camera_free(self, board_session, item: dict) -> None:
        """Refuse a camera another process holds now; when that cannot be read, the start reports it."""
        node = item["device"].get("media_device")
        if not isinstance(node, str) or not _DEVICE_NODE.fullmatch(node):
            return
        request = json.dumps({"cameras": {item["id"]: [node]}})
        try:
            result = board_session.transport.exec(["python3", "-", request], timeout=20, stdin=BOARD_CHECK.read_bytes())
            users = json.loads(result.stdout.decode("utf-8", errors="replace"))["users"][item["id"]]
        except (BoardError, ValueError, KeyError, TypeError) as exc:
            logging.warning("Could not check whether %s is in use: %s", item["id"], exc)
            return
        if isinstance(users, list) and users:
            raise _camera_in_use(item["device"]["camera_name"], users)

    def _await_video(self, board_session, session: dict, previous: Optional[int]) -> None:
        # Neat picks the SSRC: the first new one on the idle channel is the preview's, and any other is a second sender.
        deadline = time.monotonic() + VIDEO_ARRIVAL_TIMEOUT_SEC
        foreign = False
        while time.monotonic() < deadline:
            rtp = _channel_rtp(session["channel"])
            if rtp and rtp["active"] and rtp["ssrc"] is not None:
                if rtp["ssrc"] != previous:
                    with self._lock:
                        session["ssrc"] = rtp["ssrc"]
                    return
                foreign = True
            time.sleep(1.0)
        log = b""
        with suppress(BoardError):
            log = board_session.transport.exec(["sh", "-c", _log_tail(session["id"])], timeout=10).stdout
        self._stop_current(session["id"])
        if foreign:
            raise _channel_taken(session["channel"])
        raise BoardError(
            "no_video",
            "The board started capturing, but no video reached Insight.",
            hint="The board must reach Insight's video port. Check that the mapped UDP port is open "
            "(a host firewall usually blocks it) or run Insight on the board.",
            channel=session["channel"],
            detail=log.decode("utf-8", errors="replace")[-1000:],
        )

    def heartbeat(self, board_session, session_id: str) -> dict:
        with self._lock:
            session = self._session
            if session is None or session["id"] != session_id or session["generation"] != board_session.generation:
                raise _unknown_session()
            if _expired(session):
                self._forget(session_id)
                raise _unknown_session()
            session = dict(session)
        directory = f"{WORKER_DIR}/{session_id}"
        beat = f"[ -d {directory} ] && touch {directory}/heartbeat && echo alive || true"
        if b"alive" not in board_session.transport.exec(["sh", "-c", beat], timeout=10).stdout:
            with self._lock:
                self._forget(session_id)
            raise _unknown_session()
        rtp = _channel_rtp(session["channel"])
        if rtp and rtp["ssrc"] not in (None, session["ssrc"]):
            self._release(session_id)
            raise _channel_taken(session["channel"])
        session["expires_at"] = _expiry()
        with self._lock:
            # A stop that finished while this heartbeat ran wins.
            if self._session is not None and self._session["id"] == session_id:
                self._session = session
        return dict(session)

    def stop(self, board_session, session_id: str) -> dict:
        with self._lock:
            session = self._session
            if session is None or session["id"] != session_id:
                raise _unknown_session()
        if session["generation"] == board_session.generation:
            self._stop_current(session_id)
        else:
            self._release(session_id)
        return {**session, "state": "stopped"}

    def stop_for_board_change(self) -> None:
        """Stop the preview on its board before Insight closes that board's connection."""
        with self._idle:
            self._idle.wait_for(lambda: not self._starting, timeout=START_TIMEOUT_SEC * 2)
        with self._lock:
            session = self._session
        if session is not None:
            self._release(session["id"])

    def _release(self, session_id: str) -> None:
        try:
            self._stop_current(session_id)
        except BoardError as exc:
            # That board may be gone; its worker ends the program once heartbeats stop.
            logging.warning("Could not stop camera preview %s on its board: %s", session_id, exc)
            with self._lock:
                self._forget(session_id)

    def _stop_current(self, session_id: str) -> None:
        with self._lock:
            session, owner = self._session, self._owner
            if session is None or session["id"] != session_id:
                return
        directory = f"{WORKER_DIR}/{session_id}"
        script = (
            f"pid=$(cat {directory}/pipeline.pid 2>/dev/null); "
            f'if [ -n "$pid" ]; then kill $pid 2>/dev/null; for i in $(seq 16); do kill -0 $pid 2>/dev/null || break; '
            f"sleep 0.5; done; kill -9 $pid 2>/dev/null; fi; "
            f"rm -rf {directory} {WORKER_DIR}/{session_id}.log"
        )
        # The board that started it, even when another board is selected now.
        owner.raw_transport.exec(["sh", "-c", script], timeout=20)
        with self._lock:
            self._forget(session_id)

    def _forget(self, session_id: str) -> None:
        if self._session is not None and self._session["id"] == session_id:
            self._session = self._owner = None

    def _reserve_channel(self, board_session) -> int:
        count = self._channel_capacity()
        if board_session.target.mode != "local":
            published = self._udp_range()
            if published is None:
                raise BoardError(
                    "no_channel",
                    "Insight cannot tell which video ports are reachable from the board.",
                    hint="Preview needs the board to send video back to Insight. Check the SDK port map "
                    "or run Insight on the board.",
                )
            count = min(published[1], count)
        stats = _ingest_stats()
        if stats is None:
            raise BoardError(
                "viewer_unavailable",
                "Insight cannot reach the video viewer service.",
                hint="Preview sends video through the viewer. Check that vf is running, then try again.",
            )
        busy = {entry.get("channel") for entry in stats if entry.get("active")}
        channel = next((channel for channel in range(count - 1, -1, -1) if channel not in busy), None)
        if channel is None:
            raise BoardError(
                "no_channel",
                "Every viewer channel Insight publishes is already receiving video.",
                hint="Stop a streaming source or an application stream, then start the preview again.",
            )
        return channel

    def _start_worker(self, board_session, session_id: str, command: list) -> None:
        directory = f"{WORKER_DIR}/{session_id}"
        for name, content in (("worker.sh", WORKER_SCRIPT.encode()), ("preview.py", PROGRAM)):
            board_session.transport.exec(["sh", "-c", f"mkdir -p {directory} && cat > {directory}/{name}"], timeout=15, stdin=content)
        launch = f"setsid nohup sh {directory}/worker.sh {session_id} {int(SESSION_TTL_SEC)} {shlex.join(command)} > {directory}/worker.log 2>&1 < /dev/null &"
        board_session.transport.exec(["sh", "-c", launch], timeout=START_TIMEOUT_SEC)
        # The program prints "running" once PyNeat has built the graph.
        check = (f"for i in $(seq 40); do grep -qx running {directory}/pipeline.log 2>/dev/null && break; "
                 f"[ -d {directory} ] || break; sleep 0.5; done; cat {directory}/pipeline.pid 2>/dev/null; {_log_tail(session_id)}")
        output = board_session.transport.exec(["sh", "-c", check], timeout=START_TIMEOUT_SEC).stdout.decode("utf-8", errors="replace")
        if not output.strip().split("\n")[0].strip().isdigit():
            with suppress(BoardError):
                board_session.transport.exec(["sh", "-c", f"rm -rf {directory} {WORKER_DIR}/{session_id}.log"], timeout=10)
            if _CAMERA_BUSY.search(output):
                raise _camera_in_use(command[2], [], output[-1000:])  # command[2] is the camera_name
            raise BoardError(
                "command_failed",
                "The preview did not start on the board.",
                hint="Check that no other application holds the camera; detail has the Neat error.",
                detail=output[-1000:],
            )
