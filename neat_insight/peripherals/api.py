import json
import logging
import time
from pathlib import Path

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
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


def _board_summary(session, identity=None) -> dict:
    identity = identity or {}
    return {
        "label": session.target.label,
        "source": session.target.source,
        **{key: identity.get(key) for key in ("hostname", "machine", "build_version", "fingerprint")},
    }


def _check_board(session, catalog: dict):
    """Run the read-only camera check on the board in one command; None when it cannot run.

    Availability and libcamerasrc facts are extras on top of Sentinel's catalog, so a failure here
    degrades them to unknown instead of failing the scan.
    """
    cameras = cameras_of(catalog)
    if not cameras:
        return {"tools": {}, "availability_method": None, "users": {}, "libcamerasrc": None, "failures": []}
    payload = {
        "cameras": {device["id"]: camera_nodes(device) for device in cameras},
        "libcamerasrc": any(device["camera"].get("backend") == "mipi" for device in cameras),
    }
    try:
        result = session.transport.exec(
            ["python3", "-", json.dumps(payload)], timeout=CHECK_TIMEOUT_SEC, stdin=CHECK_PATH.read_bytes()
        )
        check = json.loads(result.stdout.decode("utf-8", errors="replace")) if result.exit_code == 0 else None
    except ValueError:
        check = None
    except BoardError as exc:
        if exc.code == "stale_snapshot":
            raise
        logging.warning("The peripheral camera check failed on %s: %s", session.target.label, exc)
        check = None
    return check if isinstance(check, dict) else None


# API: return the last camera scan of the selected board.
@peripherals_bp.get("/api/peripherals")
def get_peripherals():
    """Return the cached snapshot for the current board generation, or an empty one before any Refresh."""
    try:
        session = get_board_manager().session()
    except BoardError as err:
        return err.to_dict(), err.status
    return scans.snapshot(session.generation) or empty_snapshot(_board_summary(session), session.generation)


# API: rescan the selected board for cameras.
@peripherals_bp.post("/api/peripherals/refresh")
def refresh_peripherals():
    """Ask SiMa Sentinel to rescan, then return a new snapshot, or the result of a refresh in flight."""
    requested = time.monotonic()
    try:
        session = get_board_manager().session()
        with scans.refresh_lock(session.generation):
            in_flight = scans.completed_since(session.generation, requested)
            if in_flight:
                return in_flight
            board = _board_summary(session, session.identity())
            started = time.monotonic()
            catalog = PeripheralClient(session).refresh()
            check = _check_board(session, catalog)
            scan_ms = int((time.monotonic() - started) * 1000)
            session.require_current()
            return scans.record(session.generation, board, catalog, check, scan_ms)
    except BoardError as err:
        return err.to_dict(), err.status


# API: render an input configuration for one camera mode from the last scan.
@peripherals_bp.post("/api/peripherals/cameras/export")
def export_camera():
    """Return code and config for one cached MIPI mode, or V4L2 descriptors for USB; never touches the board."""
    try:
        selection = export.parse_request(request.get_json(silent=True))
        session = get_board_manager().session()
        snapshot = scans.snapshot(session.generation)
        if snapshot is None:
            raise BoardError(
                "stale_snapshot",
                "There is no camera scan for the selected board; it was never scanned or has changed since the scan.",
                hint="Click Refresh, then export again.",
            )
        return export.render(snapshot, selection)
    except BoardError as err:
        return err.to_dict(), err.status
