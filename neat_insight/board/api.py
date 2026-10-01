from flask import Blueprint, jsonify, request

from neat_insight.board.errors import BoardError
from neat_insight.board.manager import get_board_manager

board_bp = Blueprint("board", __name__)


@board_bp.app_errorhandler(BoardError)
def board_error(exc: BoardError):
    return jsonify(exc.to_dict()), exc.status


@board_bp.after_request
def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def _json_body() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


@board_bp.get("/api/board")
def board_state():
    """Return the selected board and the last connection status."""
    return get_board_manager().state()


@board_bp.post("/api/board/select")
def select_board():
    """Save a manual SSH target, or clear it to use the environment default."""
    body = _json_body()
    if "reset" in body and not isinstance(body["reset"], bool):
        raise BoardError("invalid_request", "`reset` must be a boolean.")
    manager = get_board_manager()
    if body.get("reset") is True:
        manager.reset()
    else:
        manager.select(body.get("host"), body.get("port"), body.get("user"))
    return manager.state()


@board_bp.post("/api/board/test")
def test_board():
    """Connect to the selected board and read its identity."""
    manager = get_board_manager()
    manager.session().identity()
    return manager.state()


@board_bp.post("/api/board/trust-host-key")
def trust_board_host_key():
    """Trust the exact SSH host key presented by a reflashed board."""
    body = _json_body()
    manager = get_board_manager()
    manager.trust_host_key(str(body.get("fingerprint") or ""))
    return manager.state()
