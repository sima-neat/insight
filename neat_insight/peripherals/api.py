import contextlib
import time

from flask import Blueprint, current_app

from neat_insight.board import get_board_manager
from neat_insight.board.manager import board_summary
from neat_insight.peripherals.cameras import ScanCache, empty_snapshot
from neat_insight.peripherals.client import PeripheralClient

peripherals_bp = Blueprint("peripherals", __name__)

scans = ScanCache()


@peripherals_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


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
