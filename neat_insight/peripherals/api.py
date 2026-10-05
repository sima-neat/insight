import json
import logging
import time
from pathlib import Path

from flask import Blueprint, Response, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.manager import board_summary
from neat_insight.peripherals import export, mictest
from neat_insight.peripherals.cameras import ScanCache, camera_nodes, cameras_of, empty_snapshot
from neat_insight.peripherals.client import PeripheralClient
from neat_insight.peripherals.microphones import check_nodes, microphones_of

peripherals_bp = Blueprint("peripherals", __name__)

CHECK_PATH = Path(__file__).with_name("board_check.py")
CHECK_TIMEOUT_SEC = 45.0

scans = ScanCache()


@peripherals_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _check_board(session, catalog: dict):
    """Run the read-only peripheral check on the board in one command; None when it cannot run.

    Availability is an extra on top of Sentinel's catalog, so a failure here degrades it to unknown
    instead of failing the scan.
    """
    cameras, microphones = cameras_of(catalog), microphones_of(catalog)
    if not cameras and not microphones:
        return {"tools": {}, "availability_method": None, "users": {}, "failures": []}
    payload = {"cameras": {device["id"]: camera_nodes(device) for device in cameras}, "support": True}
    if microphones:
        payload["microphones"] = {device["id"]: check_nodes(device) for device in microphones}
    return _run_check(session, payload)


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
    session = get_board_manager().session()
    with scans.refresh_lock(session.generation):
        in_flight = scans.completed_since(session.generation, requested)
        if in_flight:
            session.require_current()
            return in_flight
        board = board_summary(session, session.identity())
        started = time.monotonic()
        catalog = PeripheralClient(session).refresh()
        check = _check_board(session, catalog)
        scan_ms = int((time.monotonic() - started) * 1000)
        session.require_current()
        snapshot = scans.record(session.generation, board, catalog, check, scan_ms)
        session.require_current()
        return snapshot


# API: render an input configuration for one camera mode from the last scan.
@peripherals_bp.post("/api/peripherals/cameras/export")
def export_camera():
    """Return code and config for one cached MIPI mode, or V4L2 descriptors for USB; never touches the board."""
    selection = export.parse_request(request.get_json(silent=True))
    session = get_board_manager().session()
    if selection["generation"] is not None and selection["generation"] != session.generation:
        raise BoardError(
            "stale_snapshot",
            "The camera selection belongs to an earlier board scan.",
            hint="Click Refresh, then export again.",
        )
    snapshot = scans.snapshot(session.generation)
    if snapshot is None:
        raise BoardError(
            "stale_snapshot",
            "There is no camera scan for the selected board; it was never scanned or has changed since the scan.",
            hint="Click Refresh, then export again.",
        )
    if selection["scan_id"] is not None and selection["scan_id"] != snapshot["scan_id"]:
        raise BoardError(
            "stale_snapshot",
            "The camera selection belongs to an earlier peripheral scan.",
            hint="Click Refresh, then export again.",
        )
    rendered = export.render(snapshot, selection)
    session.require_current()
    return rendered


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
    mictest.refuse_if_running()
    bound = mictest.bind_microphone(PeripheralClient(session).catalog(), scanned, mic_id)
    node = [bound["node"]] if isinstance(bound["node"], str) and bound["node"].startswith("/dev/") else []
    mictest.refuse_if_held(_run_check(session, {"microphones": {mic_id: node}}), mic_id)
    session.require_current()
    return {"test": mictest.start(session, mic_id, bound, seconds)}, 202


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
    return Response(wav, mimetype="audio/wav")
