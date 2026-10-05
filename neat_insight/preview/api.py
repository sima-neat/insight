import ipaddress
import re
from typing import Optional

from flask import Blueprint, current_app, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.peripherals import export
from neat_insight.peripherals import api as peripherals_api

preview_bp = Blueprint("preview", __name__)

MODE_KEYS = ("format", "width", "height", "fps")
_HOST = re.compile(r"(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9_.-]+))(?::(\d{1,5}))?")
_HOST_LABEL = re.compile(r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?")


@preview_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def previews():
    return current_app.extensions["neat_preview"]


def browser_host(host_header) -> Optional[str]:
    """The host of a Host header, or None unless it is a plain host name or IP literal."""
    match = _HOST.fullmatch(str(host_header or "").strip())
    if not match or (match[3] and not 1 <= int(match[3]) <= 65535):
        return None
    if match[1]:
        try:
            return match[1] if ipaddress.ip_address(match[1]).version == 6 else None
        except ValueError:
            return None
    name = match[2]
    labels = name[:-1].split(".") if name.endswith(".") else name.split(".")
    return name if len(name) <= 253 and all(_HOST_LABEL.fullmatch(label) for label in labels) else None


def _host() -> str:
    host = browser_host(request.host)
    if host is None:
        raise BoardError("invalid_request", "Insight cannot build a viewer link for this request's Host header.",
                         hint="Open Insight by its hostname or IP address.")
    return host


def _respond(session, host: str):
    # The session is shared, so each response builds the viewer URL from its own validated Host.
    return {"session": session and {**session, "viewer_url": previews().viewer_url(host, session["channel"])}}


def _unsupported(message: str, hint: str) -> BoardError:
    return BoardError("invalid_request", message, hint=hint)


def scanned_camera(generation: int, camera_id: str) -> dict:
    snapshot = peripherals_api.scans.snapshot(generation)
    if snapshot is None:
        raise BoardError("stale_snapshot", "There is no camera scan for the selected board.",
                         hint="Click Refresh, then start the preview.")
    item = next((entry for entry in snapshot["items"] if entry["id"] == camera_id), None)
    if item is None:
        raise BoardError("not_found", f"Camera {camera_id} is not in the last scan.",
                         hint="Refresh and pick a camera from the list.")
    return item


def require_camera_free(item: dict) -> None:
    """Refuse a camera the last scan found busy, by name, before looking at modes."""
    if item["availability"]["state"] == "in_use":
        holders = item["availability"].get("reason") or "another process is using it"
        raise BoardError("camera_in_use", f"{item['name']} is already in use: {holders}",
                         hint="Stop the application using the camera, then start the preview.")


def previewable_mode(item: dict, body: dict) -> dict:
    """The mode to preview: the one requested, or the camera's default; refused unless the scan
    lists it and Neat Core verified it."""
    mode = item.get("default_selection")
    if any(key in body for key in MODE_KEYS):
        parsed = export.parse_request({"id": item["id"], **{key: body.get(key) for key in MODE_KEYS}})
        mode = {key: parsed[key] for key in MODE_KEYS}
    if not mode:
        raise _unsupported("This camera has no mode Insight can preview.",
                           "Refresh; if the camera reports no usable modes, the errors on the camera say why.")
    if item["connection"] != "mipi" or not item["device"].get("camera_name"):
        raise _unsupported("Preview is available for MIPI cameras only in this release.",
                           "USB cameras are discovered and can be exported, but preview is not implemented for them yet.")
    # parse_request and the scan only yield positive numbers; preview also needs a whole one.
    fps = mode["fps"]
    if fps != int(fps):
        raise _unsupported(f"{fps} fps cannot be previewed: preview needs a whole-number frame rate.",
                           "Pick one of the rates Insight lists for this size.")
    fmt = next((entry for entry in item["formats"] if entry["format"] == mode["format"]), None)
    # The preview graph captures NV12, the format Core's camera-memory path delivers.
    if fmt is None or not fmt["exportable"] or mode["format"] != "NV12":
        raise _unsupported(f"{mode['format']} cannot be previewed on this camera.",
                           "Pick a format Insight lists as usable with Core; preview uses the same capture path.")
    size = next((s for s in fmt["sizes"] if (s["width"], s["height"]) == (mode["width"], mode["height"])), None)
    if size is None:
        raise _unsupported(f"{mode['width']}x{mode['height']} is not a size this camera reported.",
                           "Pick a resolution from the list.")
    choice = next((entry for entry in size["fps"] if entry["value"] == fps), None)
    if choice is None:
        listed = ", ".join(str(entry["value"]) for entry in sorted(size["fps"], key=lambda entry: entry["value"]))
        raise _unsupported(f"{fps} fps is not a rate this camera reported for {mode['width']}x{mode['height']}.",
                           f"Pick one of: {listed}.")
    if choice["tier"] != "verified":
        raise _unsupported(f"{mode['format']} {mode['width']}x{mode['height']} at {fps} fps cannot be previewed: "
                           + (choice.get("reason") or "Neat Core has not verified it."), "Pick a mode marked Verified.")
    return {"format": mode["format"], "width": mode["width"], "height": mode["height"], "fps": int(fps)}


# API: report the preview running on the selected board, if any.
@preview_bp.get("/api/peripherals/preview")
def get_preview():
    """Return the preview running on the selected board, or null; never contacts the board."""
    host = _host()
    return _respond(previews().current(get_board_manager().session().generation), host)


# API: start an explicit, temporary camera preview on the selected board.
@preview_bp.post("/api/peripherals/cameras/preview")
def start_preview():
    """Run a PyNeat CameraInput graph on the board that sends one scanned mode (or the camera's default) to a free viewer channel."""
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    host = _host()  # Refuse a bad Host before any board work.
    with previews().board_lock:
        session = get_board_manager().session()
        item = scanned_camera(session.generation, str(body.get("id") or ""))
        require_camera_free(item)
        return _respond(previews().start(session, item, previewable_mode(item, body)), host)


# API: keep a preview alive while a viewer is watching.
@preview_bp.post("/api/peripherals/cameras/preview/<session_id>/heartbeat")
def heartbeat_preview(session_id):
    """Extend the preview; without heartbeats the board-side worker stops capture on its own."""
    host = _host()
    return _respond(previews().heartbeat(get_board_manager().session(), session_id), host)


# API: stop a preview and release the camera and the channel.
@preview_bp.post("/api/peripherals/cameras/preview/<session_id>/stop")
def stop_preview(session_id):
    """Stop capture on the board that runs it; an older session id cannot stop a newer session."""
    host = _host()
    return _respond(previews().stop(get_board_manager().session(), session_id), host)
