from neat_insight.board.api import board_bp
from neat_insight.board.errors import BoardError
from neat_insight.board.manager import BoardManager, BoardSession, get_board_manager
from neat_insight.board.transport import ExecResult

__all__ = ["BoardError", "BoardManager", "BoardSession", "ExecResult", "board_bp", "get_board_manager", "init_app"]


def init_app(app, data_dir, on_board: bool) -> None:
    app.extensions["neat_board"] = BoardManager(data_dir, on_board=on_board)
    app.register_blueprint(board_bp)
