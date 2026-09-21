from flask import Blueprint, jsonify, request

from neat_insight.board.errors import BoardError
from neat_insight.board.manager import get_board_manager

board_bp = Blueprint("board", __name__)


@board_bp.app_errorhandler(BoardError)
def _board_error(exc: BoardError):
    return jsonify(exc.to_dict()), exc.status


# API: report the selected board without connecting to it.
@board_bp.get("/api/board")
def board_state():
    """Return the selected board target, where it came from, the defaults, and the last connection status."""
    return get_board_manager().state()


# API: select a board by SSH address, or clear the selection to fall back to the default.
@board_bp.post("/api/board/select")
def select_board():
    """Accept JSON {host, port, user} to save a manual target, or {reset: true} to clear it."""
    body = request.get_json(silent=True) or {}
    manager = get_board_manager()
    if body.get("reset"):
        manager.reset()
    else:
        manager.select(body.get("host"), body.get("port"), body.get("user"))
    return manager.state()


# API: connect to the selected board and read its identity.
@board_bp.post("/api/board/test")
def test_board():
    """Connect to the selected board, read its host name and build, and return the updated board state."""
    manager = get_board_manager()
    manager.test()
    return manager.state()


# API: trust the host key a reflashed board now presents.
@board_bp.post("/api/board/trust-host-key")
def trust_board_host_key():
    """Accept JSON {fingerprint}; replace the stored host key when it matches the key the board presented."""
    body = request.get_json(silent=True) or {}
    manager = get_board_manager()
    manager.trust_host_key(str(body.get("fingerprint") or ""))
    return manager.state()
