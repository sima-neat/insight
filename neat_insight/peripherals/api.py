import json
import time
from pathlib import Path

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.peripherals import export
from neat_insight.peripherals.cameras import ScanCache, empty_snapshot
from neat_insight.peripherals.preview import PreviewManager, require_camera_free
from neat_insight.peripherals.probe import BUDGET_SEC, SCHEMA

peripherals_bp = Blueprint("peripherals", __name__)

PROBE_PATH = Path(__file__).with_name("probe.py")
PROBE_TIMEOUT_SEC = BUDGET_SEC + 20.0
DETAIL_LIMIT = 2000

scans = ScanCache()
previews = PreviewManager()


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
            previews.stop_for_scan(session)
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


def _preview_host() -> str:
    host = request.host.split(":")[0].strip()
    return host or "127.0.0.1"


def _camera_or_404(session, camera_id: str):
    snapshot = scans.snapshot(session.generation)
    if snapshot is None:
        raise BoardError(
            "stale_snapshot",
            "There is no camera scan for the selected board.",
            hint="Click Refresh, then start the preview.",
        )
    item = next((entry for entry in snapshot["items"] if entry["id"] == camera_id), None)
    if item is None:
        raise BoardError(
            "not_found",
            f"Camera {camera_id} is not in the last scan.",
            hint="Refresh and pick a camera from the list.",
        )
    return item


# API: report the preview running on the selected board, if any.
@peripherals_bp.get("/api/peripherals/preview")
def get_preview():
    """Return the current preview session for the selected board, or null; never contacts the board."""
    try:
        session = get_board_manager().session()
    except BoardError as err:
        return err.to_dict(), err.status
    previews.stop_stale()
    return {"session": previews.current(session.generation)}


# API: start an explicit, temporary camera preview on the selected board.
@peripherals_bp.post("/api/peripherals/cameras/preview")
def start_preview():
    """Capture and hardware-encode one camera into a reserved viewer channel until stopped or expired."""
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    try:
        session = get_board_manager().session()
        item = _camera_or_404(session, str(body.get("id") or ""))
        require_camera_free(item)
        mode = item.get("default_selection")
        if any(key in body for key in ("format", "width", "height", "fps")):
            mode = export.parse_request({"id": item["id"], **{k: body.get(k) for k in ("format", "width", "height", "fps")}})
            mode = {key: mode[key] for key in ("format", "width", "height", "fps")}
        if not mode:
            raise BoardError(
                "invalid_request",
                "This camera has no mode Insight can preview.",
                hint="Refresh; if the camera reports no usable modes, the errors on the camera say why.",
            )
        return {"session": previews.start(session, item, mode, _preview_host())}
    except BoardError as err:
        return err.to_dict(), err.status


# API: keep a preview alive while a viewer is watching.
@peripherals_bp.post("/api/peripherals/cameras/preview/<session_id>/heartbeat")
def heartbeat_preview(session_id):
    """Extend the preview; without heartbeats the board-side worker stops capture on its own."""
    try:
        session = get_board_manager().session()
        return {"session": previews.heartbeat(session, session_id)}
    except BoardError as err:
        return err.to_dict(), err.status


# API: stop a preview and release the camera and the channel.
@peripherals_bp.post("/api/peripherals/cameras/preview/<session_id>/stop")
def stop_preview(session_id):
    """Stop capture on the board; an older session id cannot stop a newer session."""
    try:
        session = get_board_manager().session()
        return {"session": previews.stop(session, session_id)}
    except BoardError as err:
        return err.to_dict(), err.status
