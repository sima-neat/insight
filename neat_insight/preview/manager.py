"""Run one temporary camera preview: a GStreamer pipeline on the board whose JPEG frames Insight relays."""
import json
import logging
import re
import threading
import time
import uuid
from contextlib import contextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from neat_insight.board import BoardError
from neat_insight.preview import gst, sensor

FIRST_FRAME_TIMEOUT_SEC = 10.0
# A stream nobody opened within this long after the start is stopped.
UNCLAIMED_TIMEOUT_SEC = 15.0
# A relay that receives nothing for this long ends, and the preview with it.
STALL_TIMEOUT_SEC = 10.0
START_TIMEOUT_SEC = 15.0
STOP_TIMEOUT_SEC = 15.0
PID_TIMEOUT_SEC = 2.0
# How long a pipeline that exited gets to finish writing its error, which arrives apart from stdout.
STDERR_WAIT_SEC = 2.0
STREAM_PATH = "/api/peripherals/cameras/preview/{}/stream"
BOARD_CHECK = Path(__file__).parent.parent / "peripherals" / "board_check.py"
GST_INSTALL_HINT = (
    "Install GStreamer on the board: `sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-base "
    "gstreamer1.0-plugins-good`, plus `gstreamer1.0-libcamera` for MIPI cameras."
)
_DEVICE_NODE = re.compile(r"/dev/[A-Za-z0-9_./-]+")
# What libcamera and v4l2src print when another process holds the camera.
_CAMERA_BUSY = re.compile(r"Failed to acquire camera|Device or resource busy|Device '[^']*' is busy")
# The line the board command writes to stderr before it becomes gst-launch-1.0 (see gst.board_command);
# a login shell may print other lines first.
_PID = re.compile(rb"^" + gst.PID_TAG.encode() + rb"([0-9]{1,10})$", re.M)
_PID_LINE = re.compile("^" + re.escape(gst.PID_TAG) + "[0-9]+\n?", re.M)
_NO_ELEMENT = re.compile(r'no element "(\w+)"')


def _kill_script(pid: int) -> str:
    """Stop the pipeline by PID: TERM, then KILL after a short grace. Only while that PID is still
    gst-launch-1.0, so a PID the system reused for another process is never signalled."""
    return (
        f'pid={pid}; alive() {{ [ "$(cat /proc/$pid/comm 2>/dev/null)" = gst-launch-1.0 ]; }}; '
        "alive || exit 0; kill $pid 2>/dev/null; i=0; "
        'while alive && [ "$i" -lt 10 ]; do sleep 0.2; i=$((i + 1)); done; '
        "alive && kill -9 $pid 2>/dev/null; exit 0"
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _camera_in_use(name: str, users: list, detail: str = "") -> BoardError:
    holders = ", ".join(f"{user['command']} (pid {user['pid']})" for user in users)
    return BoardError(
        "camera_in_use",
        f"{name} is already in use: " + (f"Open in {holders}." if holders else "the board reports the camera busy; another process holds it."),
        hint="Stop the application using the camera, then start the preview.",
        users=users,
        **({"detail": detail} if detail else {}),
    )


def _unknown_session() -> BoardError:
    return BoardError("not_found", "That preview session is not running.", hint="Start the preview again.")


def _stderr_detail(stream, wait: float = 0) -> str:
    """The pipeline's stderr without the PID line the shell writes; `wait` lets an exiting one finish it."""
    text = stream.stderr(wait).decode("utf-8", errors="replace")
    return _PID_LINE.sub("", text).strip()[-1000:]


class _Relay:
    """A stream's response body. Closing it stops the preview even when it was never iterated, which a
    generator's own cleanup does not cover."""

    def __init__(self, frames, stop):
        self._frames, self._stop = frames, stop

    def __iter__(self):
        return self._frames

    def close(self) -> None:
        self._frames.close()
        self._stop()


class PreviewManager:
    """At most one preview, owned by the board session that started it."""

    def __init__(self):
        self._lock = threading.Lock()
        # Held by a preview start for its whole request, and by board_change() and refresh() around a
        # target change or a scan, so no start can launch capture on a board in between.
        self.board_lock = threading.Lock()
        self._session: Optional[dict] = None
        self._run: Optional[dict] = None  # The running pipeline: owner, stream, parser, pid, pending frames.
        self._starting: Optional[str] = None

    def current(self, generation: int) -> Optional[dict]:
        with self._lock:
            session = self._session
            if session is None or session["generation"] != generation:
                return None
            return dict(session)

    def start(self, board_session, item: dict, mode: dict) -> dict:
        """Start one scanned camera's mode; `mode` is {format, width, height, fps, rate, source} (see api)."""
        with self._lock:
            session = self._session
        if session is not None and session["generation"] != board_session.generation:
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

    def _start(self, board_session, item: dict, mode: dict) -> dict:
        self._require_gstreamer(board_session)
        self._require_camera_free(board_session, item)
        arguments = gst.pipeline(item["connection"], mode["source"], mode["format"], mode["width"], mode["height"], mode["rate"])
        stream = board_session.transport.stream(gst.board_command(arguments), timeout=START_TIMEOUT_SEC)
        parser = gst.FrameParser()
        try:
            frames = self._first_frames(stream, parser, item["name"])
            pid = self._pid(stream)
            # libcamera starts a MIPI sensor at its own rate; once it runs, set the rate this mode asked for.
            # Best effort: when that fails the preview runs on at the sensor's rate, with a note saying so.
            sensor_rate, rate_note = (
                sensor.apply(board_session.raw_transport, item["device"].get("camera_name"), mode["rate"])
                if item["connection"] == "mipi" else (None, None)
            )
        except Exception:
            stream.close()
            self._kill(board_session, stream)
            raise
        session_id = uuid.uuid4().hex
        session = {
            "id": session_id,
            "camera_id": item["id"],
            "mode": {key: mode[key] for key in ("format", "width", "height", "fps")},
            "stream_url": STREAM_PATH.format(session_id),
            "generation": board_session.generation,
            "started_at": _now(),
            "state": "live",
            "sensor_rate": sensor_rate,
            "rate_note": rate_note,
        }
        timer = threading.Timer(UNCLAIMED_TIMEOUT_SEC, self._stop_unclaimed, args=(session_id,))
        timer.daemon = True
        with self._lock:
            self._session = session
            self._run = {"owner": board_session, "stream": stream, "parser": parser, "pid": pid,
                         "frames": frames, "claimed": False, "timer": timer}
        timer.start()
        return dict(session)

    @staticmethod
    def _require_gstreamer(board_session) -> None:
        result = board_session.transport.exec(["sh", "-c", "command -v gst-launch-1.0 || true"], timeout=10)
        if not result.stdout.strip():
            raise BoardError(
                "tool_missing",
                "Preview runs a GStreamer pipeline on the board, and gst-launch-1.0 is not installed there.",
                hint=GST_INSTALL_HINT,
                tool="gst-launch-1.0",
            )

    @staticmethod
    def _require_camera_free(board_session, item: dict) -> None:
        """Refuse a camera another process holds now; when that cannot be read, the start reports it."""
        device = item["device"]
        node = device.get("media_device") if item["connection"] == "mipi" else device.get("video_node")
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
            raise _camera_in_use(item["name"], users)

    @staticmethod
    def _first_frames(stream, parser, name: str) -> list:
        """Read until the pipeline writes its first complete frame; raise why it did not."""
        deadline = time.monotonic() + FIRST_FRAME_TIMEOUT_SEC
        chunk = None
        while time.monotonic() < deadline:
            try:
                chunk = stream.read(max(deadline - time.monotonic(), 0))
                if chunk:
                    frames = parser.feed(chunk)
                    if frames:
                        return frames
                    continue
            except gst.FrameError as exc:
                raise BoardError("command_failed", f"The board's preview output is not usable: {exc}") from None
            if chunk == b"":
                break  # The pipeline exited.
        ended = chunk == b""
        detail = _stderr_detail(stream, STDERR_WAIT_SEC if ended else 0)
        if _CAMERA_BUSY.search(detail):
            raise _camera_in_use(name, [], detail)
        missing = _NO_ELEMENT.search(detail)
        if missing:
            raise BoardError(
                "tool_missing",
                f"The board's GStreamer has no {missing[1]} element, which the preview pipeline needs.",
                hint=GST_INSTALL_HINT,
                tool=missing[1],
                detail=detail,
            )
        raise BoardError(
            "command_failed",
            "The preview pipeline stopped before it sent a frame." if ended
            else f"The camera sent no frame within {FIRST_FRAME_TIMEOUT_SEC:g} s.",
            hint="The board output below says why; check that the camera is connected and no other application holds it.",
            detail=detail,
        )

    @staticmethod
    def _pid(stream) -> int:
        """The pipeline's PID, which the shell writes to stderr before it becomes gst-launch-1.0."""
        deadline = time.monotonic() + PID_TIMEOUT_SEC
        while True:
            match = _PID.search(stream.stderr())
            if match:
                return int(match[1])
            if time.monotonic() >= deadline:
                raise BoardError("command_failed", "The board did not report the preview pipeline's process id.",
                                 detail=_stderr_detail(stream))
            time.sleep(0.05)

    @staticmethod
    def _kill(board_session, stream) -> None:
        """Best effort: kill a pipeline whose start failed, so a stalled one does not keep the camera."""
        match = _PID.search(stream.stderr())
        if match:
            with suppress(BoardError):
                board_session.raw_transport.exec(["sh", "-c", _kill_script(int(match[1]))], timeout=STOP_TIMEOUT_SEC)

    def relay(self, board_session, session_id: str):
        """Claim the session's stream and return a generator of response parts; the preview stops when it ends.

        One reader per session: a second one is refused."""
        with self._lock:
            session, run = self._session, self._run
            if session is None or session["id"] != session_id or session["generation"] != board_session.generation:
                raise _unknown_session()
            if run["claimed"]:
                raise BoardError("preview_active", "This preview is already shown in another tab or window.",
                                 hint="Close the other view, or stop the preview and start it again here.",
                                 camera_id=session["camera_id"])
            run["claimed"] = True
            run["timer"].cancel()
            frames, run["frames"] = run["frames"], []
        return _Relay(self._frames(session_id, run, frames), lambda: self._release(session_id))

    def _frames(self, session_id: str, run: dict, frames: list):
        try:
            for frame in frames:
                yield gst.part(frame)
            while True:
                chunk = run["stream"].read(STALL_TIMEOUT_SEC)
                if not chunk:
                    return  # The pipeline ended, stalled, or the preview was stopped.
                for frame in run["parser"].feed(chunk):
                    yield gst.part(frame)
        except (BoardError, gst.FrameError) as exc:
            logging.warning("Camera preview %s ended: %s", session_id, exc)
        finally:
            # Also when the browser disconnects: the pipeline must not outlive its only viewer.
            self._release(session_id)

    def _stop_unclaimed(self, session_id: str) -> None:
        with self._lock:
            run = self._run if self._session is not None and self._session["id"] == session_id else None
            if run is None or run["claimed"]:
                return
        logging.info("Stopping camera preview %s: no viewer opened its stream.", session_id)
        self._release(session_id)

    def stop(self, board_session, session_id: str) -> Optional[dict]:
        """Stop the session and return it, or None when it already ended: stopping twice is not an error,
        and an older session id never stops a newer session."""
        with self._lock:
            session = self._session
        if session is None or session["id"] != session_id:
            return None
        if session["generation"] == board_session.generation:
            self._stop_current(session_id)
        else:
            self._release(session_id)
        return {**session, "state": "stopped"}

    @contextmanager
    def board_change(self, changes):
        """Around a request that may change the selected board: when `changes()` says it will, stop the
        preview on its board before Insight closes that board's connection."""
        with self.board_lock:
            if changes():
                self.stop_for_board_change()
            yield

    @contextmanager
    def refresh(self, generation):
        """Around a refresh: stop the preview before the scan and keep new previews out until it ends.
        `generation` is a callable returning the selected board's generation."""
        with self.board_lock:
            self.stop_for_refresh(generation())
            yield

    def stop_for_board_change(self) -> None:
        """Stop the preview on its board before Insight closes that board's connection."""
        with self._lock:
            session = self._session
        if session is not None:
            self._release(session["id"])

    def stop_for_refresh(self, generation: int) -> None:
        """Stop the preview before a refresh scans its board; refuse the scan when it cannot be stopped.

        Forgetting it instead would let the scan record the camera as held by a preview nobody can stop."""
        with self._lock:
            session = self._session
        if session is None:
            return
        if session["generation"] != generation:
            self._release(session["id"])  # Another board's preview; the scan does not look at that board.
            return
        try:
            self._stop_current(session["id"])
        except BoardError as exc:
            raise BoardError(
                exc.code,
                f"Could not stop the camera preview before the scan: {exc.message}",
                hint="The preview is still running. Stop it, or click Refresh again once the board responds.",
            ) from exc

    def _release(self, session_id: str) -> None:
        try:
            self._stop_current(session_id)
        except BoardError as exc:
            # That board may be gone; its pipeline already lost its output and dies at its next write.
            logging.warning("Could not stop camera preview %s on its board: %s", session_id, exc)
            with self._lock:
                self._forget(session_id)

    def _stop_current(self, session_id: str) -> None:
        with self._lock:
            session, run = self._session, self._run
            if session is None or session["id"] != session_id:
                return
        run["timer"].cancel()
        run["stream"].close()
        # The board that started it, even when another board is selected now.
        run["owner"].raw_transport.exec(["sh", "-c", _kill_script(run["pid"])], timeout=STOP_TIMEOUT_SEC)
        with self._lock:
            self._forget(session_id)

    def _forget(self, session_id: str) -> None:
        if self._session is not None and self._session["id"] == session_id:
            self._session = self._run = None
