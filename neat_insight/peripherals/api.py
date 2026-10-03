from flask import Blueprint, jsonify, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.api import no_store
from neat_insight.peripherals import export
from neat_insight.peripherals.client import PeripheralClient

peripherals_bp = Blueprint("peripherals", __name__)
peripherals_bp.after_request(no_store)


@peripherals_bp.app_errorhandler(BoardError)
def peripheral_error(exc: BoardError):
    return jsonify(exc.to_dict()), exc.status


def _integer_arg(name: str, default=None):
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0 or str(value) != raw:
        raise BoardError("invalid_request", f"`{name}` must be a non-negative integer.")
    return value


def _with_board(session, payload: dict) -> dict:
    session.require_current()
    return {
        **payload,
        "board_generation": session.generation,
        "board": {"label": session.target.label, "source": session.target.source},
    }


def _session():
    return get_board_manager().session()


@peripherals_bp.get("/api/peripherals")
def get_peripherals():
    """Return the selected board's Sentinel catalog, or Sentinel's short
    ``unchanged`` reply when ``since_revision`` and ``instance_id`` are current."""
    session = _session()
    expected_generation = _integer_arg("board_generation", session.generation)
    if expected_generation != session.generation:
        raise BoardError(
            "stale_snapshot",
            "The selected board changed since this catalog was read.",
            hint="Read the current peripheral catalog without `since_revision`.",
            expected_generation=expected_generation,
            current_generation=session.generation,
        )
    catalog = PeripheralClient(session).catalog(_integer_arg("since_revision"), request.args.get("instance_id"))
    return _with_board(session, catalog)


@peripherals_bp.post("/api/peripherals/refresh")
def refresh_peripherals():
    """Ask Sentinel to rescan and wait until its target scan has completed."""
    session = _session()
    body = request.get_json(silent=True)
    if isinstance(body, dict) and "board_generation" in body:
        generation = body["board_generation"]
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
            raise BoardError("invalid_request", "`board_generation` must be a non-negative integer.")
        if generation != session.generation:
            raise BoardError(
                "stale_snapshot",
                "The selected board changed since this catalog was read.",
                hint="Read the current peripheral catalog, then refresh again.",
                expected_generation=generation,
                current_generation=session.generation,
            )
    return _with_board(session, PeripheralClient(session).refresh())


@peripherals_bp.post("/api/peripherals/cameras/export")
def export_camera():
    """Re-read the Sentinel catalog and render one exact supported CameraInput mode."""
    selection = export.parse_request(request.get_json(silent=True))
    session = _session()
    if selection["board_generation"] != session.generation:
        raise BoardError(
            "stale_snapshot",
            "The selected board changed since this mode was selected.",
            hint=export.MODE_HINT,
            expected_generation=selection["board_generation"],
            current_generation=session.generation,
        )
    catalog = PeripheralClient(session).catalog()
    result = export.render(catalog, selection)
    session.require_current()
    return result
