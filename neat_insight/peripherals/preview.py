"""Explicit, temporary camera preview: capture on the board, play in Insight's existing viewer.

The board encodes H.264 in hardware and sends RTP to a reserved viewer channel, which vf already
serves over WebRTC. Capture starts only on request and never as part of discovery.

The board-side worker owns cleanup: Insight refreshes a heartbeat file while a viewer is watching
and the worker kills the pipeline once that file goes stale, so the camera is released even if
Insight restarts, the browser never fires unload, or the SSH connection dies.
"""
import ipaddress
import json
import logging
import shlex
import ssl
import subprocess
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

from neat_insight.board import BoardError
from neat_insight import port_map

VIDEO_CHANNELS = 80
DEFAULT_VIDEO_UDP_PORT = 9000
DEFAULT_VIDEO_UI_PORT = 8081
HEARTBEAT_INTERVAL_MS = 5000
SESSION_TTL_SEC = 45.0  # a briefly backgrounded tab should not kill the preview; the board still frees the camera
START_TIMEOUT_SEC = 25.0
VIDEO_ARRIVAL_TIMEOUT_SEC = 8.0
BITRATE_KBPS = 6000
WORKER_DIR = "/tmp/insight-preview"
# Written to the board per session. $1 session id, $2 heartbeat ttl, $3.. pipeline.
WORKER_SCRIPT = """#!/bin/sh
set -e
sid="$1"; ttl="$2"; shift 2
dir="{worker_dir}/$sid"
mkdir -p "$dir"
# Nothing else prunes these: a saved failure log whose session is long gone is litter.
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
# A pipeline that fails in its first seconds is gone before Insight can read the log, and its last
# words are the only explanation of why. Keep them outside the directory in that case only; a
# pipeline that ran and then stopped normally has nothing to explain.
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


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _unsupported(message: str, hint: str) -> BoardError:
    return BoardError("invalid_request", message, hint=hint)


def _port_map_entry(name: str):
    return port_map.find_exposed_entry(port_map.read_exposed_ports(), name)


def _neat_port_entry(name: str):
    """The SDK publishes its port map through `neat --json` when no port-map file is present."""
    try:
        result = subprocess.run(["neat", "--json"], capture_output=True, timeout=20, check=False)
        data = json.loads(result.stdout.decode("utf-8", errors="replace"))
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    for entry in data.get("exposedPorts", []):
        if isinstance(entry, dict) and entry.get("name") == name:
            return entry
    return None


def port_map_video_range():
    """(host port of channel 0, channel count) published for senders outside this machine."""
    entry = _port_map_entry("videoUDP") or _neat_port_entry("videoUDP")
    start = port_map.valid_port((entry or {}).get("hostPortStart"))
    if start is None:
        return None
    end = port_map.valid_port(entry.get("hostPortEnd")) or start
    if end < start:
        return None
    return start, max(1, (end - start) + 1)


def video_ui_port() -> int:
    port = (_port_map_entry("videoUI") or _neat_port_entry("videoUI") or {}).get("hostPortStart")
    return port_map.valid_port(port) or DEFAULT_VIDEO_UI_PORT


def _ingest_stats(port: int = DEFAULT_VIDEO_UI_PORT) -> Optional[list]:
    """vf's per-channel ingest counters, or None when vf does not answer."""
    # vf's own route, not Insight's /api proxy: vf answers unknown paths with the viewer page.
    url = f"https://127.0.0.1:{port}/ingest/stats?all=1"
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


def active_channels(port: int = DEFAULT_VIDEO_UI_PORT) -> Optional[set]:
    """Channels vf currently receives RTP on, so a preview never lands on a live application stream.

    None means vf did not answer: the caller must not read that as "every channel is free".
    """
    channels = _ingest_stats(port)
    if channels is None:
        return None
    return {entry.get("channel") for entry in channels if entry.get("active")}


def _channel_packets(channel: int) -> Optional[int]:
    """RTP packets vf has counted on a channel, or None when it cannot be read."""
    stats = _ingest_stats()
    if stats is None:
        return None
    for entry in stats:
        if entry.get("channel") == channel:
            rtp = entry.get("rtp")
            value = rtp.get("packets_received") if isinstance(rtp, dict) else None
            return value if isinstance(value, int) else None
    return None


class PreviewManager:
    """One preview at a time per Insight, tied to the selected board's generation."""

    def __init__(self):
        self._lock = threading.Lock()
        self._condition = threading.Condition(self._lock)
        self._session: Optional[dict] = None
        self._owner = None  # the board session that started the preview, so a stop reaches it
        self._starting = False
        self._starting_camera: Optional[str] = None
        self._heartbeats = 0
        self._scan_active = False

    # ---- public API -------------------------------------------------------

    def current(self, generation: Optional[int] = None) -> Optional[dict]:
        with self._lock:
            session = self._session
            if session is None:
                return None
            if generation is not None and session["generation"] != generation:
                return None
            if _now() > datetime.fromisoformat(session["expires_at"]):
                return None
            return dict(session)

    def start(self, session_ctx, item: dict, mode: dict, request_host: str) -> dict:
        self.stop_stale()
        # Starting takes seconds of board work. Claim the slot before doing any of it, or a second
        # request slips through the gap and opens the same camera twice.
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
                    camera_id=self._starting_camera or "",
                )
            if self._session is not None and self._session["generation"] == session_ctx.generation:
                raise BoardError(
                    "preview_active",
                    f"A preview of {self._session['camera_id']} is already running.",
                    hint="Stop that preview before starting another one.",
                    camera_id=self._session["camera_id"],
                )
            self._starting = True
            self._starting_camera = item["id"]
        try:
            return self._start_locked(session_ctx, item, mode, request_host)
        finally:
            with self._lock:
                self._starting = False
                self._starting_camera = None
                self._condition.notify_all()

    def _start_locked(self, session_ctx, item: dict, mode: dict, request_host: str) -> dict:
        self._stop_current(session_ctx)
        _require_previewable(item, mode)
        channel = self._reserve_channel(session_ctx)
        baseline = _channel_packets(channel)
        target_host, target_port = self._insight_endpoint(session_ctx, channel)
        session_id = uuid.uuid4().hex
        pipeline = _pipeline(item, mode, target_host, target_port)
        self._start_worker(session_ctx, session_id, pipeline)
        session = {
            "id": session_id,
            "camera_id": item["id"],
            "mode": mode,
            "channel": channel,
            "viewer_url": _viewer_url(request_host, channel),
            "generation": session_ctx.generation,
            "started_at": _iso(_now()),
            "expires_at": _iso(_now() + timedelta(seconds=SESSION_TTL_SEC)),
            "heartbeat_interval_ms": HEARTBEAT_INTERVAL_MS,
            "state": "live",
        }
        with self._lock:
            self._session = session
            self._owner = session_ctx
        self._await_video(session_ctx, session, baseline)
        return dict(session)

    def _await_video(self, session_ctx, session: dict, baseline: Optional[int] = None) -> None:
        deadline = time.monotonic() + VIDEO_ARRIVAL_TIMEOUT_SEC
        channel = session["channel"]
        while time.monotonic() < deadline:
            if channel in (active_channels() or ()):
                packets = _channel_packets(channel)
                # "Active" alone could be someone else's stream that started on this channel in the
                # meantime; a rising packet count on a channel that was idle is our own video.
                if baseline is None or packets is None or packets > baseline:
                    return
            time.sleep(1.0)
        self._stop_current(session_ctx, session["id"])
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
                self._session = None
                self._owner = None
                raise _unknown_session()
            session = dict(session)
            self._heartbeats += 1
        directory = f"{WORKER_DIR}/{session_id}"
        # The heartbeat must prove the worker is still there. Reporting a live preview because a
        # touch on a deleted directory did not raise would leave the UI showing a dead stream.
        beat = f"[ -d {directory} ] && touch {directory}/heartbeat && echo alive || true"
        try:
            result = session_ctx.transport.exec(["sh", "-c", beat], timeout=10)
            if b"alive" not in result.stdout:
                with self._lock:
                    if self._session is not None and self._session["id"] == session_id:
                        self._session = None
                        self._owner = None
                raise _unknown_session()
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
        """Stop capture and exclude preview starts for the full discovery probe."""
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
        """Release the old board's camera before its transport is closed or replaced."""
        # Once the heartbeat lease has expired, the board-side worker owns camera release even if
        # its polling loop needs another moment. Forget local ownership before touching the old
        # transport, which may be unreachable precisely because that board is being replaced.
        with self.scan_guard(session_ctx, discard_expired=True):
            pass

    def stop_stale(self) -> None:
        with self._lock:
            session = self._session
            if session and not self._heartbeats and _now() > datetime.fromisoformat(session["expires_at"]):
                # The board worker frees the camera on its own; drop the reservation here.
                self._session = None
                self._owner = None

    # ---- internals --------------------------------------------------------

    def _stop_current(self, session_ctx, session_id: Optional[str] = None) -> None:
        """Stop the running preview, on the board that is actually running it.

        `session_id` makes the stop specific: a caller that asked to stop one session must never
        tear down a newer one that replaced it while the request was in flight.
        """
        with self._lock:
            session = self._session
            if session is None:
                return
            if session_id is not None and session["id"] != session_id:
                return
            # The session belongs to the board it was started on. After a board switch the caller's
            # transport points somewhere else, and killing there would leave the real camera busy.
            owner = self._owner or session_ctx
        directory = f"{WORKER_DIR}/{session['id']}"
        script = (
            f"pid=$(cat {directory}/pipeline.pid 2>/dev/null); "
            f'if [ -n "$pid" ]; then kill $pid 2>/dev/null; sleep 1; kill -9 $pid 2>/dev/null; fi; '
            f"rm -rf {directory} {WORKER_DIR}/{session['id']}.log"
        )
        owner.transport.exec(["sh", "-c", script], timeout=20)
        with self._lock:
            if self._session is not None and self._session["id"] == session["id"]:
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
        # The board tells us the address it reaches Insight on, which survives NAT and port mapping.
        client = result.stdout.decode("utf-8", errors="replace").split()
        if client and not _is_ip(client[0]):
            # $SSH_CLIENT is board-controlled input that ends up in the pipeline's udpsink host.
            raise BoardError(
                "command_failed",
                f"The board reported an address Insight cannot use: {client[0][:60]}",
                hint="Preview needs the board to send video back to Insight; check the SSH connection.",
            )
        if not client:
            raise BoardError(
                "command_failed",
                "The board could not report the address Insight connects from.",
                hint="Preview needs the board to send video back to Insight; check the SSH connection.",
            )
        return client[0], base + channel

    def _start_worker(self, session_ctx, session_id: str, pipeline: list) -> None:
        directory = f"{WORKER_DIR}/{session_id}"
        script = f"{directory}/worker.sh"
        setup = f"mkdir -p {directory} && cat > {script} && chmod +x {script}"
        session_ctx.transport.exec(["sh", "-c", setup], timeout=15, stdin=WORKER_SCRIPT.encode())
        launch = f"setsid nohup {script} {session_id} {int(SESSION_TTL_SEC)} {' '.join(shlex.quote(part) for part in pipeline)} > {directory}/worker.log 2>&1 < /dev/null &"
        session_ctx.transport.exec(["sh", "-c", launch], timeout=START_TIMEOUT_SEC)
        # A pipeline that dies at once takes its directory with it, so fall back to the tail the
        # worker saved beside it; without that the failure would be reported with no reason at all.
        check = (f"sleep 3; cat {directory}/pipeline.pid 2>/dev/null; "
                 f"tail -c 800 {directory}/pipeline.log 2>/dev/null || "
                 f"tail -c 800 {WORKER_DIR}/{session_id}.log 2>/dev/null")
        result = session_ctx.transport.exec(["sh", "-c", check], timeout=START_TIMEOUT_SEC)
        output = result.stdout.decode("utf-8", errors="replace")
        if not output.strip().split("\n")[0].strip().isdigit():
            self._stop_pipeline_dir(session_ctx, session_id)
            raise BoardError(
                "command_failed",
                "The preview pipeline did not start on the board.",
                hint="Check that the camera is free and that the board's encoder accepts this mode.",
                detail=output[-1000:],
            )

    def _stop_pipeline_dir(self, session_ctx, session_id: str) -> None:
        # The failure log the worker saved beside the directory has been read by now; leaving it
        # would litter the board until a later preview happens to prune it.
        remove = f"rm -rf {WORKER_DIR}/{session_id} {WORKER_DIR}/{session_id}.log"
        try:
            session_ctx.transport.exec(["sh", "-c", remove], timeout=10)
        except BoardError:
            pass


def _unknown_session() -> BoardError:
    return BoardError(
        "not_found",
        "That preview session is not running.",
        hint="Start the preview again; an older session cannot control a newer one.",
    )


def require_camera_free(item: dict) -> None:
    """Refuse a busy camera by name.

    This runs before Insight picks a mode: a busy camera reports no modes, and "no mode I can
    preview" would hide the real reason, which is that something else is holding the sensor.
    """
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
        # An unreported rate is refused here rather than by a caps negotiation failure on the board.
        listed = ", ".join(str(rate) for rate in sorted(rates))
        raise _unsupported(
            f"{mode['fps']} fps is not a rate this camera reported for {mode['width']}x{mode['height']}.",
            f"Pick one of: {listed}.",
        )


def _whole_fps(fps) -> int:
    """The rate as the whole number every pipeline element can take.

    neatencoder's enc-frame-rate and videorate's max-rate are integers, so a fractional rate such as
    29.97 cannot be given to all three of caps, videorate and the encoder consistently. Refuse it
    rather than configure the encoder for a rate its input does not have. Camera scans list whole
    rates only (`cameras.fps_choices`), so this guards the API, not a mode the UI offers.
    """
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or fps <= 0 or fps != int(fps):
        raise _unsupported(
            f"{fps} fps cannot be previewed: preview needs a whole-number frame rate.",
            "Pick one of the rates Insight lists for this size.",
        )
    return int(fps)


def _pipeline(item: dict, mode: dict, host: str, port: int) -> list:
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
        # libcamera picks a sensor mode and delivers its rate, which the modalix pipeline handler
        # says outright ("faster caps negotiate and snap to it"), so the caps above are a request,
        # not a promise. max-rate drops the surplus so the stream really runs at the chosen rate.
        # It only drops: a sensor slower than the request still passes through at its own rate.
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
        "config-interval=1",
        "mtu=1200",
        "!",
        "udpsink",
        f"host={host}",
        f"port={port}",
        "sync=false",
    ]


def _viewer_url(request_host: str, channel: int) -> str:
    # embed=1 asks the viewer for the bare video surface: no page controls, no channel banner, no
    # settings. There is one camera here and Insight chose its channel, so none of that can be acted on.
    query = f"mode=light&src={channel}&max_channels={VIDEO_CHANNELS}&embed=1"
    return port_map.format_browser_https_url(
        request_host,
        video_ui_port(),
        "/static/viewer.html",
        query,
    )
