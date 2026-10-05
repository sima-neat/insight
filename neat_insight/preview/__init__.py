from neat_insight.preview.api import preview_bp
from neat_insight.preview.manager import PreviewManager

__all__ = ["init_app", "preview_bp"]


def init_app(app, *, exposed_ports, channel_capacity, format_url) -> None:
    """Register camera preview; the callables are the app's port-map and viewer URL helpers.

    The board must be initialized first: a board change and a peripheral refresh stop the preview on
    its board before they proceed.
    """
    manager = PreviewManager(exposed_ports, channel_capacity, format_url)
    board = app.extensions["neat_board"]
    board.target_change_guard = manager.board_change
    app.extensions["neat_preview"] = manager
    app.extensions["neat_refresh_guard"] = lambda: manager.refresh(lambda: board.session().generation)
    app.register_blueprint(preview_bp)
