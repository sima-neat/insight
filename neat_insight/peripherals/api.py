from flask import Blueprint, jsonify, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.api import no_store
from neat_insight.peripherals.client import PeripheralClient

peripherals_bp = Blueprint("peripherals", __name__)
peripherals_bp.after_request(no_store)


@peripherals_bp.app_errorhandler(BoardError)
def peripheral_error(exc: BoardError):
    return jsonify(exc.to_dict()), exc.status


def _integer_arg(name: str, default=None, maximum=None):
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = -1
    if value < 0 or (maximum is not None and value > maximum) or str(value) != raw:
        raise BoardError("invalid_request", f"`{name}` must be a non-negative integer" + (f" no greater than {maximum}." if maximum is not None else "."))
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
    """Return the selected board's authoritative daemon catalog."""
    session = _session()
    return _with_board(session, PeripheralClient(session).catalog())


@peripherals_bp.post("/api/peripherals/refresh")
def refresh_peripherals():
    """Request daemon reconciliation and wait for its target scan to complete."""
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


@peripherals_bp.get("/api/peripherals/events")
def get_peripheral_events():
    """Long-poll daemon events without computing or caching changes in Insight."""
    session = _session()
    expected_generation = _integer_arg("board_generation", session.generation)
    if expected_generation != session.generation:
        raise BoardError(
            "stale_snapshot",
            "The selected board changed since this event cursor was created.",
            hint="Read the current peripheral catalog and start a new event cursor.",
            expected_generation=expected_generation,
            current_generation=session.generation,
        )
    payload = PeripheralClient(session).events(
        _integer_arg("after_sequence", 0),
        _integer_arg("wait_ms", 0, maximum=30000),
        request.args.get("instance_id") or None,
    )
    return _with_board(session, payload)
