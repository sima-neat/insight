import json
import time
from pathlib import Path

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.peripherals import export
from neat_insight.peripherals.cameras import ScanCache, empty_snapshot
from neat_insight.peripherals.probe import BUDGET_SEC, SCHEMA

peripherals_bp = Blueprint("peripherals", __name__)

PROBE_PATH = Path(__file__).with_name("probe.py")
PROBE_TIMEOUT_SEC = BUDGET_SEC + 20.0
DETAIL_LIMIT = 2000

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


def _run_probe(session) -> dict:
    result = session.transport.exec(["python3", "-"], timeout=PROBE_TIMEOUT_SEC, stdin=PROBE_PATH.read_bytes())
    if result.exit_code == 127:
        raise BoardError(
            "tool_missing",
            "python3 was not found on the board.",
            hint="Install python3 (3.8 or newer) on the board, then Refresh.",
            tool="python3",
        )
    detail = result.stderr.decode("utf-8", errors="replace").strip()[-DETAIL_LIMIT:]
    if result.exit_code != 0:
        raise BoardError(
            "command_failed",
            "The camera discovery probe failed on the board.",
            hint="Check that python3 on the board is 3.8 or newer; the probe's error output is in detail.",
            detail=detail,
        )
    try:
        probe = json.loads(result.stdout.decode("utf-8", errors="replace"))
    except ValueError:
        probe = None
    if not isinstance(probe, dict) or probe.get("schema") != SCHEMA:
        raise BoardError(
            "command_failed",
            "The camera discovery probe returned output Insight cannot read.",
            hint="Refresh again; if it persists, check detail for errors from python3 on the board.",
            detail=detail,
        )
    return probe


def _export_generation(body: dict) -> int:
    generation = body.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise BoardError(
            "invalid_request",
            "`generation` must be the whole-number board generation from the camera scan.",
            hint="Send the `generation` returned by GET /api/peripherals with the selected mode.",
        )
    return generation


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
    """Run the discovery probe on the board and return a new snapshot, or the result of a refresh in flight."""
    requested = time.monotonic()
    try:
        session = get_board_manager().session()
        with scans.refresh_lock(session.generation):
            in_flight = scans.completed_since(session.generation, requested)
            if in_flight:
                return in_flight
            board = _board_summary(session, session.identity())
            started = time.monotonic()
            probe = _run_probe(session)
            scan_ms = int((time.monotonic() - started) * 1000)
            return scans.record(session.generation, board, probe, scan_ms)
    except BoardError as err:
        return err.to_dict(), err.status


# API: render an input configuration for one camera mode from the last scan.
@peripherals_bp.post("/api/peripherals/cameras/export")
def export_camera():
    """Return code and config for one cached MIPI mode, or V4L2 descriptors for USB; never touches the board."""
    try:
        body = request.get_json(silent=True)
        selection = export.parse_request(body)
        expected_generation = _export_generation(body)
        session = get_board_manager().session()
        if expected_generation != session.generation:
            raise BoardError(
                "stale_snapshot",
                "The selected board changed since this camera scan was read, so no configuration was exported.",
                hint="Refresh the selected board, then export again.",
                expected_generation=expected_generation,
            )
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
