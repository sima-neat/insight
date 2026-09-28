import ipaddress
import json
import logging
import secrets
import shlex
import ssl
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

from neat_insight.board import BoardError
from neat_insight import port_map

VIDEO_CHANNELS = 80
DEFAULT_VIDEO_UDP_PORT = 9000
DEFAULT_VIDEO_UI_PORT = 8081
HEARTBEAT_INTERVAL_MS = 5000
SESSION_TTL_SEC = 45.0
START_TIMEOUT_SEC = 25.0
VIDEO_ARRIVAL_TIMEOUT_SEC = 8.0
BITRATE_KBPS = 6000
WORKER_DIR = "/tmp/insight-preview"
# The board-side worker kills the pipeline once Insight stops touching the heartbeat file.
WORKER_SCRIPT = """#!/bin/sh
set -e
sid="$1"; ttl="$2"; shift 2
dir="{worker_dir}/$sid"
mkdir -p "$dir"
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
        sleep 1
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


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _unsupported(message: str, hint: str) -> BoardError:
    return BoardError("invalid_request", message, hint=hint)


@lru_cache(maxsize=1)
def _neat_exposed_ports() -> list:
    try:
        result = subprocess.run(["neat", "--json"], capture_output=True, timeout=20, check=False)
        return list(json.loads(result.stdout.decode("utf-8", errors="replace")).get("exposedPorts", []))
    except (OSError, ValueError, AttributeError, TypeError, subprocess.SubprocessError):
        return []


def _port_entry(name: str):
    return port_map.find_exposed_entry(port_map.read_exposed_ports(), name) or port_map.find_exposed_entry(
        _neat_exposed_ports(), name
    )


def port_map_video_range():
    entry = _port_entry("videoUDP")
    if entry is None:
        return None
    start = port_map.valid_port(entry["hostPortStart"])
    end = port_map.valid_port(entry.get("hostPortEnd")) or start
    return (start, end - start + 1) if end >= start else None


def video_ui_port() -> int:
    return port_map.valid_port((_port_entry("videoUI") or {}).get("hostPortStart")) or DEFAULT_VIDEO_UI_PORT


def _ingest_stats() -> Optional[list]:
    # vf's own route: vf answers unknown paths, such as Insight's /api proxy, with the viewer page.
    url = f"https://127.0.0.1:{DEFAULT_VIDEO_UI_PORT}/ingest/stats?all=1"
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(url, timeout=3, context=context) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return payload["channels"]
    except Exception as exc:  # noqa: BLE001 - any failure means "unknown", never "all free"
        logging.warning("vf ingest stats unavailable at %s: %s", url, exc)
        return None


def active_channels() -> Optional[set]:
    channels = _ingest_stats()
    if channels is None:
        return None
    return {entry.get("channel") for entry in channels if entry.get("active")}


def _channel_rtp(channel: int) -> Optional[dict]:
    stats = _ingest_stats()
    if stats is None:
        return None
    for entry in stats:
        if entry.get("channel") == channel:
            rtp = entry.get("rtp")
            ssrc = rtp.get("ssrc") if isinstance(rtp, dict) else None
            return {"active": bool(entry.get("active")), "ssrc": ssrc if isinstance(ssrc, int) and ssrc else None}
    return {"active": False, "ssrc": None}


def _pick_ssrc(avoid: Optional[int]) -> int:
    # Never 0 (vf omits it) nor 0xFFFFFFFF (rtph264pay's "random").
    while True:
        ssrc = secrets.randbelow(0xFFFFFFFE) + 1
        if ssrc != avoid:
            return ssrc


def _channel_taken(channel: int) -> BoardError:
    return BoardError(
        "channel_taken",
        "An application started sending to this channel; the preview stopped so it would not corrupt that stream.",
        hint="Start the preview again; Insight will pick a channel nothing is sending to.",
        channel=channel,
    )


class PreviewManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._session: Optional[dict] = None
        self._owner = None
        self._starting: Optional[str] = None
        self._heartbeats = 0
        self._scan_active = False

    def current(self, generation: Optional[int] = None) -> Optional[dict]:
        with self._lock:
            session = self._session
            if session is None or generation not in (None, session["generation"]):
                return None
            return None if _now() > datetime.fromisoformat(session["expires_at"]) else dict(session)

    def start(self, session_ctx, item: dict, mode: dict) -> dict:
        self.stop_stale()
        with self._lock:
            if self._scan_active:
                raise BoardError(
                    "preview_active",
                    "Camera discovery is already running.",
                    hint="Wait for Refresh to finish, then start the preview.",
                    camera_id=item["id"],
                )
            if self._starting:
                raise BoardError(
                    "preview_active",
                    "A preview is already starting.",
                    hint="Wait for it to appear, then stop it before starting another one.",
                    camera_id=self._starting,
                )
            if self._session is not None and self._session["generation"] == session_ctx.generation:
                raise BoardError(
                    "preview_active",
                    f"A preview of {self._session['camera_id']} is already running.",
                    hint="Stop that preview before starting another one.",
                    camera_id=self._session["camera_id"],
                )
            self._starting = item["id"]
        try:
            return self._start_locked(session_ctx, item, mode)
        finally:
            with self._lock:
                self._starting = None
                self._condition.notify_all()

    def _start_locked(self, session_ctx, item: dict, mode: dict) -> dict:
        self._stop_current(session_ctx)
        _require_previewable(item, mode)
        channel = self._reserve_channel(session_ctx)
        previous = (_channel_rtp(channel) or {}).get("ssrc")
        ssrc = _pick_ssrc(previous)
        target_host, target_port = self._insight_endpoint(session_ctx, channel)
        session_id = uuid.uuid4().hex
        pipeline = _pipeline(item, mode, target_host, target_port, ssrc)
        self._start_worker(session_ctx, session_id, pipeline)
        session = {
            "id": session_id,
            "camera_id": item["id"],
            "mode": mode,
            "channel": channel,
            "ssrc": ssrc,
            "generation": session_ctx.generation,
            "started_at": _iso(_now()),
            "expires_at": _iso(_now() + timedelta(seconds=SESSION_TTL_SEC)),
            "heartbeat_interval_ms": HEARTBEAT_INTERVAL_MS,
            "state": "live",
        }
        with self._lock:
            self._session = session
            self._owner = session_ctx
        self._await_video(session_ctx, session)
        return dict(session)

    def _await_video(self, session_ctx, session: dict) -> None:
        # A free channel is not reserved: only the preview's own SSRC proves its video arrived.
        deadline = time.monotonic() + VIDEO_ARRIVAL_TIMEOUT_SEC
        channel = session["channel"]
        foreign = False
        while time.monotonic() < deadline:
            rtp = _channel_rtp(channel)
            if rtp and rtp["active"] and rtp["ssrc"] is not None:
                if rtp["ssrc"] == session["ssrc"]:
                    return
                foreign = True
            time.sleep(1.0)
        self._stop_current(session_ctx, session["id"])
        if foreign:
            raise _channel_taken(channel)
        raise BoardError(
            "no_video",
            "The board started capturing, but no video reached Insight.",
            hint="The board must reach Insight's video port. Check that the mapped UDP port is open "
            "(a host firewall usually blocks it) or run Insight on the board.",
            channel=session["channel"],
        )

    def heartbeat(self, session_ctx, session_id: str) -> dict:
        with self._condition:
            while self._scan_active or self._heartbeats:
                self._condition.wait()
            session = self._session
            if session is None or session["id"] != session_id:
                raise _unknown_session()
            if _now() > datetime.fromisoformat(session["expires_at"]):
                self._forget(session_id)
                raise _unknown_session()
            session = dict(session)
            self._heartbeats += 1
        directory = f"{WORKER_DIR}/{session_id}"
        beat = f"[ -d {directory} ] && touch {directory}/heartbeat && echo alive || true"
        try:
            result = session_ctx.transport.exec(["sh", "-c", beat], timeout=10)
            if b"alive" not in result.stdout:
                with self._lock:
                    self._forget(session_id)
                raise _unknown_session()
            rtp = _channel_rtp(session["channel"])
            if rtp and rtp["ssrc"] not in (None, session["ssrc"]):
                try:
                    self._stop_current(session_ctx, session_id)
                except BoardError as exc:
                    logging.warning("Could not stop preview %s after its channel was taken: %s", session_id, exc)
                raise _channel_taken(session["channel"])
            session["expires_at"] = _iso(_now() + timedelta(seconds=SESSION_TTL_SEC))
            with self._lock:
                if self._session is not None and self._session["id"] == session_id:
                    self._session = session
            return dict(session)
        finally:
            with self._condition:
                self._heartbeats -= 1
                self._condition.notify_all()

    def stop(self, session_ctx, session_id: str) -> dict:
        with self._lock:
            session = self._session
            if session is None or session["id"] != session_id:
                raise _unknown_session()
        self._stop_current(session_ctx, session_id)
        session = dict(session)
        session["state"] = "stopped"
        return session

    @contextmanager
    def scan_guard(self, session_ctx, *, discard_expired: bool = False):
        with self._condition:
            while self._scan_active:
                self._condition.wait()
            self._scan_active = True
            while self._starting or self._heartbeats:
                self._condition.wait()
        try:
            if discard_expired:
                self.stop_stale()
            self._stop_current(session_ctx)
            yield
        finally:
            with self._condition:
                self._scan_active = False
                self._condition.notify_all()

    def stop_for_board_change(self, session_ctx) -> None:
        # An expired session is the board worker's to release; the old board may be unreachable.
        with self.scan_guard(session_ctx, discard_expired=True):
            pass

    def stop_stale(self) -> None:
        with self._lock:
            session = self._session
            if session and not self._heartbeats and _now() > datetime.fromisoformat(session["expires_at"]):
                self._forget(session["id"])

    def _stop_current(self, session_ctx, session_id: Optional[str] = None) -> None:
        with self._lock:
            session = self._session
            if session is None or session_id not in (None, session["id"]):
                return
            # Stop it on the board that started it, not the caller's current board.
            owner = self._owner or session_ctx
        directory = f"{WORKER_DIR}/{session['id']}"
        script = (
            f"pid=$(cat {directory}/pipeline.pid 2>/dev/null); "
            f'if [ -n "$pid" ]; then kill $pid 2>/dev/null; sleep 1; kill -9 $pid 2>/dev/null; fi; '
            f"rm -rf {directory} {WORKER_DIR}/{session['id']}.log"
        )
        owner.transport.exec(["sh", "-c", script], timeout=20)
        with self._lock:
            self._forget(session["id"])

    def _forget(self, session_id: str) -> None:
        if self._session is not None and self._session["id"] == session_id:
            self._session = None
            self._owner = None

    def _reserve_channel(self, session_ctx) -> int:
        if session_ctx.target.mode == "local":
            count = VIDEO_CHANNELS
        else:
            published = port_map_video_range()
            if published is None:
                raise BoardError(
                    "no_channel",
                    "Insight cannot tell which video ports are reachable from the board.",
                    hint="Preview needs the board to send video back to Insight. Check the SDK port map "
                    "(`neat --json`) or run Insight on the board.",
                )
            count = min(published[1], VIDEO_CHANNELS)
        busy = active_channels()
        if busy is None:
            raise BoardError(
                "viewer_unavailable",
                "Insight cannot reach the video viewer service.",
                hint="Preview sends video through the viewer. Check that vf is running, then try again.",
            )
        for channel in range(count - 1, -1, -1):
            if channel not in busy:
                return channel
        raise BoardError(
            "no_channel",
            "Every viewer channel Insight publishes is already receiving video.",
            hint="Stop a streaming source or an application stream, then start the preview again.",
        )

    def _insight_endpoint(self, session_ctx, channel: int):
        if session_ctx.target.mode == "local":
            return "127.0.0.1", DEFAULT_VIDEO_UDP_PORT + channel
        published = port_map_video_range()
        base = published[0] if published else DEFAULT_VIDEO_UDP_PORT
        result = session_ctx.transport.exec(["sh", "-c", "echo $SSH_CLIENT"], timeout=10)
        client = (result.stdout.decode("utf-8", errors="replace").split() or [""])[0]
        try:
            # $SSH_CLIENT is board-controlled and ends up in the udpsink host.
            ipaddress.ip_address(client)
        except ValueError:
            raise BoardError(
                "command_failed",
                f"The board reported an address Insight cannot use: {client[:60]}"
                if client
                else "The board could not report the address Insight connects from.",
                hint="Preview needs the board to send video back to Insight; check the SSH connection.",
            ) from None
        return client, base + channel

    def _start_worker(self, session_ctx, session_id: str, pipeline: list) -> None:
        directory = f"{WORKER_DIR}/{session_id}"
        script = f"{directory}/worker.sh"
        setup = f"mkdir -p {directory} && cat > {script} && chmod +x {script}"
        session_ctx.transport.exec(["sh", "-c", setup], timeout=15, stdin=WORKER_SCRIPT.encode())
        launch = f"setsid nohup {script} {session_id} {int(SESSION_TTL_SEC)} {' '.join(shlex.quote(part) for part in pipeline)} > {directory}/worker.log 2>&1 < /dev/null &"
        session_ctx.transport.exec(["sh", "-c", launch], timeout=START_TIMEOUT_SEC)
        check = (f"sleep 3; cat {directory}/pipeline.pid 2>/dev/null; "
                 f"tail -c 800 {directory}/pipeline.log 2>/dev/null || "
                 f"tail -c 800 {WORKER_DIR}/{session_id}.log 2>/dev/null")
        result = session_ctx.transport.exec(["sh", "-c", check], timeout=START_TIMEOUT_SEC)
        output = result.stdout.decode("utf-8", errors="replace")
        if not output.strip().split("\n")[0].strip().isdigit():
            try:
                session_ctx.transport.exec(["sh", "-c", f"rm -rf {directory} {WORKER_DIR}/{session_id}.log"], timeout=10)
            except BoardError:
                pass
            raise BoardError(
                "command_failed",
                "The preview pipeline did not start on the board.",
                hint="Check that the camera is free and that the board's encoder accepts this mode.",
                detail=output[-1000:],
            )


def _unknown_session() -> BoardError:
    return BoardError(
        "not_found",
        "That preview session is not running.",
        hint="Start the preview again; an older session cannot control a newer one.",
    )


def require_camera_free(item: dict) -> None:
    if item["availability"]["state"] == "in_use":
        holders = item["availability"].get("reason") or "another process is using it"
        raise BoardError(
            "camera_in_use",
            f"{item['name']} is already in use: {holders}",
            hint="Stop the application using the camera, then start the preview.",
        )


def _require_previewable(item: dict, mode: dict) -> None:
    if item["connection"] != "mipi":
        raise _unsupported(
            "Preview is available for MIPI cameras only in this release.",
            "USB cameras are discovered and can be exported, but preview is not implemented for them yet.",
        )
    require_camera_free(item)
    _whole_fps(mode["fps"])
    fmt = next((entry for entry in item["formats"] if entry["format"] == mode["format"]), None)
    if fmt is None or not fmt["exportable"]:
        raise _unsupported(
            f"{mode['format']} cannot be previewed on this camera.",
            "Pick a format Insight lists as usable with Core; preview uses the same encoder path.",
        )
    size = next(
        (s for s in fmt["sizes"] if (s["width"], s["height"]) == (mode["width"], mode["height"])),
        None,
    )
    if size is None:
        raise _unsupported(
            f"{mode['width']}x{mode['height']} is not a size this camera reported.",
            "Pick a resolution from the list; other sizes fail to configure (see core#883).",
        )
    rates = [entry["value"] for entry in size.get("fps") or [] if isinstance(entry.get("value"), (int, float))]
    if rates and mode["fps"] not in rates:
        listed = ", ".join(str(rate) for rate in sorted(rates))
        raise _unsupported(
            f"{mode['fps']} fps is not a rate this camera reported for {mode['width']}x{mode['height']}.",
            f"Pick one of: {listed}.",
        )


def _whole_fps(fps) -> int:
    # enc-frame-rate and max-rate take integers, so caps, videorate and encoder need one whole rate.
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or fps <= 0 or fps != int(fps):
        raise _unsupported(
            f"{fps} fps cannot be previewed: preview needs a whole-number frame rate.",
            "Pick one of the rates Insight lists for this size.",
        )
    return int(fps)


def _pipeline(item: dict, mode: dict, host: str, port: int, ssrc: int) -> list:
    fps = _whole_fps(mode["fps"])
    caps = f"video/x-raw,format={mode['format']},width={mode['width']},height={mode['height']},framerate={fps}/1"
    return [
        "gst-launch-1.0",
        "-q",
        "libcamerasrc",
        f"camera-name={item['device']['camera_name']}",
        "!",
        caps,
        "!",
        # libcamera delivers the sensor mode's rate; max-rate drops the surplus.
        "videorate",
        f"max-rate={fps}",
        "!",
        "neatencoder",
        "enc-type=h264",
        f"enc-fmt={mode['format']}",
        f"enc-width={mode['width']}",
        f"enc-height={mode['height']}",
        f"enc-bitrate={BITRATE_KBPS}",
        f"enc-frame-rate={fps}",
        "!",
        "h264parse",
        "config-interval=1",
        "!",
        "rtph264pay",
        "pt=96",
        f"ssrc={ssrc}",
        "config-interval=1",
        "mtu=1200",
        "!",
        "udpsink",
        f"host={host}",
        f"port={port}",
        "sync=false",
    ]


def viewer_url(host: str, channel: int) -> str:
    """`host` must come from `port_map.browser_host`."""
    query = f"mode=light&src={channel}&max_channels={VIDEO_CHANNELS}&embed=1"
    return port_map.format_browser_https_url(host, video_ui_port(), "/static/viewer.html", query)
