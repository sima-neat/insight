import math
from fractions import Fraction

from flask import Blueprint, Response, current_app, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.peripherals import api as peripherals_api
from neat_insight.preview import gst

preview_bp = Blueprint("preview", __name__)

MODE_KEYS = ("format", "width", "height", "fps")
MODE_HINT = "Pick a format, size, and frame rate listed for the camera in the last scan."


@preview_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def previews():
    return current_app.extensions["neat_preview"]


def _unsupported(message: str, hint: str) -> BoardError:
    return BoardError("invalid_request", message, hint=hint)


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _finite(value) -> bool:
    # An integer too large for a float would raise OverflowError when compared with a fractional rate.
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def parse_mode(body: dict) -> dict:
    """The requested {format, width, height, fps}, refused unless each is well formed."""
    def invalid(message):
        return BoardError("invalid_request", message, hint=MODE_HINT)

    if not isinstance(body.get("format"), str) or not body["format"]:
        raise invalid("format must be a pixel format name.")
    if not (_positive_int(body.get("width")) and _positive_int(body.get("height"))):
        raise invalid("width and height must be positive integers.")
    fps = body.get("fps")
    # JSON numbers such as 1e309 parse as inf and NaN is accepted too; neither is a frame rate.
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not _finite(fps) or fps <= 0:
        raise invalid("fps must be a positive number.")
    return {key: body[key] for key in MODE_KEYS}


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


def _source(item: dict) -> str:
    """What the pipeline opens: a MIPI camera's libcamera name, or a USB camera's stable by-id path
    (its /dev/videoN node when it has none), quoted for GStreamer."""
    device = item["device"]
    if item["connection"] == "mipi":
        source = device.get("camera_name")
    elif item["connection"] == "usb":
        source = device.get("by_id") or device.get("video_node")
        source = source if isinstance(source, str) and source.startswith("/dev/") else None
    else:
        raise _unsupported("Preview is available for MIPI and USB cameras.", "Pick a MIPI or USB camera.")
    quoted = gst.quoted(source) if isinstance(source, str) and source else None
    if quoted is None:
        raise _unsupported(f"{item['name']} reports no device Insight can open for a preview.",
                           "Refresh; if it persists, the camera's device details say what the board reported.")
    return quoted


def previewable_mode(item: dict, body: dict) -> dict:
    """The mode to preview, the one requested or the camera's default, with its exact frame rate and
    the quoted source: refused unless the scan lists it. A MIPI mode must be Available (an ISP size in
    NV12); a USB camera may preview any listed mode in MJPG or a raw format GStreamer converts."""
    mode = item.get("default_selection")
    if any(key in body for key in MODE_KEYS):
        mode = parse_mode(body)
    if not mode:
        raise _unsupported("This camera has no default mode to preview.",
                           "Send the format, width, height, and fps of a mode listed for the camera.")
    fps = mode["fps"]
    fmt = next((entry for entry in item["formats"] if entry["format"] == mode["format"]), None)
    if fmt is None:
        raise _unsupported(f"{mode['format']} is not a format this camera reported.", MODE_HINT)
    size = next((s for s in fmt["sizes"] if (s["width"], s["height"]) == (mode["width"], mode["height"])), None)
    if size is None:
        raise _unsupported(f"{mode['width']}x{mode['height']} is not a size this camera reported.",
                           "Pick a resolution from the list.")
    choice = next((entry for entry in size["fps"] if entry["value"] == fps), None)
    if choice is None:
        listed = ", ".join(str(entry["value"]) for entry in sorted(size["fps"], key=lambda entry: entry["value"]))
        raise _unsupported(f"{fps} fps is not a rate this camera reported for {mode['width']}x{mode['height']}.",
                           f"Pick one of: {listed}.")
    label = f"{mode['format']} {mode['width']}x{mode['height']} at {fps} fps"
    if item["connection"] == "mipi" and (choice["tier"] != "available" or mode["format"] != "NV12"):
        raise _unsupported(f"{label} cannot be previewed: " + (choice.get("reason") or "it is not Available."),
                           "Pick a mode marked Available.")
    if item["connection"] == "usb" and mode["format"] != "MJPG" and mode["format"] not in gst.RAW_FORMATS:
        raise _unsupported(f"{label} cannot be previewed: preview decodes MJPG and converts raw formats "
                           f"({', '.join(gst.RAW_FORMATS)}) only.", "Pick an MJPG or raw format.")
    source = _source(item)
    num, den = choice.get("framerate_num"), choice.get("framerate_den")
    if not (_positive_int(num) and _positive_int(den)):
        raise _unsupported(f"{label} has no exact frame rate in the scan.", "Refresh, then start the preview.")
    return {"format": mode["format"], "width": mode["width"], "height": mode["height"], "fps": choice["value"],
            "rate": Fraction(num, den), "source": source}


# API: report the preview running on the selected board, if any.
@preview_bp.get("/api/peripherals/preview")
def get_preview():
    """Return the preview running on the selected board, or null; never contacts the board."""
    return {"session": previews().current(get_board_manager().session().generation)}


# API: start an explicit, temporary camera preview on the selected board.
@preview_bp.post("/api/peripherals/cameras/preview")
def start_preview():
    """Run a GStreamer pipeline on the board that captures one scanned mode (or the camera's default) as JPEG frames."""
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    with previews().board_lock:
        session = get_board_manager().session()
        item = scanned_camera(session.generation, str(body.get("id") or ""))
        require_camera_free(item)
        return {"session": previews().start(session, item, previewable_mode(item, body))}


# API: stream a running preview's frames to one viewer.
@preview_bp.get("/api/peripherals/cameras/preview/<session_id>/stream")
def stream_preview(session_id):
    """Relay the board's JPEG frames as multipart/x-mixed-replace; the preview stops when this response ends."""
    relay = previews().relay(get_board_manager().session(), session_id)
    return Response(relay, mimetype=f"multipart/x-mixed-replace; boundary={gst.BOUNDARY}")


# API: stop a preview and release the camera.
@preview_bp.post("/api/peripherals/cameras/preview/<session_id>/stop")
def stop_preview(session_id):
    """Stop capture on the board that runs it; an older session id cannot stop a newer session."""
    return {"session": previews().stop(get_board_manager().session(), session_id)}
