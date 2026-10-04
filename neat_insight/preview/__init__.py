from neat_insight.preview.api import preview_bp
from neat_insight.preview.manager import PreviewManager

__all__ = ["init_app", "preview_bp"]


def init_app(app, *, exposed_ports, channel_capacity, format_url) -> None:
    """Register camera preview; the callables are the app's port-map and viewer URL helpers."""
    app.extensions["neat_preview"] = PreviewManager(exposed_ports, channel_capacity, format_url)
    app.register_blueprint(preview_bp)
