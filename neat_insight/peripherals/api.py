import json
import logging
import time
from pathlib import Path

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.manager import board_summary
from neat_insight.peripherals import export
from neat_insight.peripherals.cameras import ScanCache, camera_nodes, cameras_of, empty_snapshot
from neat_insight.peripherals.client import PeripheralClient

peripherals_bp = Blueprint("peripherals", __name__)

CHECK_PATH = Path(__file__).with_name("board_check.py")
CHECK_TIMEOUT_SEC = 45.0

scans = ScanCache()


@peripherals_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _check_board(session, catalog: dict):
    """Run the read-only camera check on the board in one command; None when it cannot run.

    Availability is an extra on top of Sentinel's catalog, so a failure here degrades it to unknown
    instead of failing the scan.
    """
    cameras = cameras_of(catalog)
    if not cameras:
        return {"tools": {}, "availability_method": None, "users": {}, "failures": []}
    payload = {"cameras": {device["id"]: camera_nodes(device) for device in cameras}}
    try:
        # This probe is best-effort, so its failure must not mark the selected board disconnected.
        result = session.raw_transport.exec(
            ["python3", "-", json.dumps(payload)], timeout=CHECK_TIMEOUT_SEC, stdin=CHECK_PATH.read_bytes()
        )
        session.require_current()
        check = json.loads(result.stdout.decode("utf-8", errors="replace")) if result.exit_code == 0 else None
    except ValueError:
        check = None
    except BoardError as exc:
        session.require_current()
        if exc.code == "stale_snapshot":
            raise
        logging.warning("The peripheral camera check failed on %s: %s", session.target.label, exc)
        check = None
    return check if isinstance(check, dict) else None


# API: return the last camera scan of the selected board.
@peripherals_bp.get("/api/peripherals")
def get_peripherals():
    """Return the cached snapshot for the current board generation, or an empty one before any Refresh."""
    session = get_board_manager().session()
    snapshot = scans.snapshot(session.generation) or empty_snapshot(board_summary(session), session.generation)
    session.require_current()
    return snapshot


# API: rescan the selected board for cameras.
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
    if selection["generation"] != session.generation:
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
    if selection["scan_id"] != snapshot["scan_id"]:
        raise BoardError(
            "stale_snapshot",
            "The camera selection belongs to an earlier peripheral scan.",
            hint="Click Refresh, then export again.",
        )
    rendered = export.render(snapshot, selection)
    session.require_current()
    return rendered
