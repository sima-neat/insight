import contextlib
import io
import json
import logging
import time
from pathlib import Path

from flask import Blueprint, current_app, request, send_file

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.manager import board_summary
from neat_insight.peripherals import mictest
from neat_insight.peripherals.cameras import ScanCache, empty_snapshot
from neat_insight.peripherals.client import PeripheralClient

peripherals_bp = Blueprint("peripherals", __name__)

CHECK_PATH = Path(__file__).with_name("board_check.py")
CHECK_TIMEOUT_SEC = 45.0

scans = ScanCache()


@peripherals_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _run_check(session, payload: dict):
    try:
        # This probe is best-effort, so its failure must not mark the selected board disconnected.
        result = session.raw_transport.exec(
            ["python3", "-", json.dumps(payload)], timeout=CHECK_TIMEOUT_SEC, stdin=CHECK_PATH.read_bytes()
        )
        session.require_current()
        if result.exit_code != 0:
            stderr = result.stderr.decode("utf-8", errors="replace").strip()[-2000:]
            logging.warning(
                "The peripheral camera check exited %s on %s: %s", result.exit_code, session.target.label, stderr
            )
        check = json.loads(result.stdout.decode("utf-8", errors="replace")) if result.exit_code == 0 else None
    except ValueError:
        check = None
    except BoardError as exc:
        session.require_current()
        if exc.code == "stale_snapshot":
            raise
        logging.warning("The peripheral check failed on %s: %s", session.target.label, exc)
        check = None
    return check if isinstance(check, dict) else None


# API: return the last peripheral scan of the selected board.
@peripherals_bp.get("/api/peripherals")
def get_peripherals():
    """Return the cached snapshot for the current board generation, or an empty one before any Refresh."""
    session = get_board_manager().session()
    snapshot = scans.snapshot(session.generation) or empty_snapshot(board_summary(session), session.generation)
    session.require_current()
    return snapshot


# API: rescan the selected board for cameras and microphones.
@peripherals_bp.post("/api/peripherals/refresh")
def refresh_peripherals():
    """Ask SiMa Sentinel to rescan, then return a new snapshot, or the result of a refresh in flight."""
    requested = time.monotonic()
    # The camera preview stops on the board first and keeps new previews off it until the scan ends;
    # a refresh queued behind it still shares the scan in flight when it arrived.
    guard = current_app.extensions.get("neat_refresh_guard") or contextlib.nullcontext
    with guard():
        session = get_board_manager().session()
        with scans.refresh_lock(session.generation):
            in_flight = scans.completed_since(session.generation, requested)
            if in_flight:
                session.require_current()
                return in_flight
            board = board_summary(session, session.identity())
            started = time.monotonic()
            catalog = PeripheralClient(session).refresh()
            scan_ms = int((time.monotonic() - started) * 1000)
            session.require_current()
            snapshot = scans.record(session.generation, board, catalog, scan_ms)
            session.require_current()
            return snapshot


# API: start recording from one microphone; the page polls for the level.
@peripherals_bp.post("/api/peripherals/microphones/test")
def start_microphone_test():
    """Re-read Sentinel's catalog, then record from a scanned microphone until stopped or `seconds` (1-30, default 30); 202."""
    mic_id, seconds = mictest.parse_request(request.get_json(silent=True))
    session = get_board_manager().session()
    snapshot, scanned = scans.scan(session.generation)
    if snapshot is None:
        raise BoardError(
            "stale_snapshot",
            "There is no scan for the selected board; it was never scanned or has changed since the scan.",
            hint="Click Refresh, then test again.",
        )
    mictest.find_microphone(snapshot, mic_id)
    mictest.refuse_if_running(session.generation)
    bound = mictest.bind_microphone(PeripheralClient(session).catalog(), scanned, mic_id)
    node = [bound["node"]] if isinstance(bound["node"], str) and bound["node"].startswith("/dev/") else []
    mictest.refuse_if_held(_run_check(session, {"microphones": {mic_id: node}}), mic_id)
    session.require_current()
    test = mictest.start(session, mic_id, bound, seconds)
    try:
        # A board change during the start leaves this test on the departed board: end it and say so.
        session.require_current()
    except BoardError:
        mictest.discard(test["token"])
        raise
    return {"test": test}, 202


# API: end the microphone test's recording now; the page then plays what was recorded.
@peripherals_bp.post("/api/peripherals/microphones/test/stop")
def stop_microphone_test():
    """Stop the recording on the selected board; its result arrives through GET as usual."""
    return {"test": mictest.stop(get_board_manager().session().generation)}


# API: the microphone test on the selected board: its live level, then its result.
@peripherals_bp.get("/api/peripherals/microphones/test")
def get_microphone_test():
    """Return the latest microphone test for the selected board, or null; never contacts the board."""
    return {"test": mictest.current(get_board_manager().session().generation)}


# API: the finished test recording as a WAV file.
@peripherals_bp.get("/api/peripherals/microphones/test/<token>.wav")
def get_microphone_test_audio(token):
    """Serve the latest finished recording of the selected board; 404 once another test or board replaced it."""
    wav = mictest.audio(token, get_board_manager().session().generation)
    if wav is None:
        raise BoardError("not_found", "This recording is gone; a newer test replaced it.", hint="Test again.")
    # Range-aware: Safari's audio element asks for byte ranges and does not play a reply that ignores them.
    return send_file(io.BytesIO(wav), mimetype="audio/wav", conditional=True, max_age=0)
