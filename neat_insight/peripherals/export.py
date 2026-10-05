"""Render camera input configurations for one mode of the cached scan."""
import json
import math
from typing import Optional

from neat_insight.board import BoardError
from neat_insight.peripherals import compat
from neat_insight.peripherals.cameras import USB_FORMAT_NOTES

BUFFER_NAME = "camera0"
QUEUE_DEPTH = 2
MODE_HINT = "Pick a format, size, and frame rate listed for the camera in the last scan."


def _invalid(message: str) -> BoardError:
    return BoardError("invalid_request", message, hint=MODE_HINT)


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _finite(value) -> bool:
    # An integer too large for a float would raise OverflowError when compared with a fractional rate.
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def parse_request(body) -> dict:
    if not isinstance(body, dict):
        raise _invalid("The request body must be a JSON object.")
    # The Peripherals page sends neither scan token; a client that sends them gets them checked.
    generation = body.get("generation")
    if isinstance(generation, float) and generation.is_integer():
        generation = int(generation)
    if generation is not None and not _positive_int(generation):
        raise _invalid("generation must be a positive integer from the last scan.")
    if body.get("scan_id") is not None and (not isinstance(body["scan_id"], str) or not body["scan_id"]):
        raise _invalid("scan_id must be the identifier from the last scan.")
    if not isinstance(body.get("id"), str) or not body["id"]:
        raise _invalid("id must be a camera id from the last scan.")
    if not isinstance(body.get("format"), str) or not body["format"]:
        raise _invalid("format must be a pixel format name.")
    if not (_positive_int(body.get("width")) and _positive_int(body.get("height"))):
        raise _invalid("width and height must be positive integers.")
    fps = body.get("fps")
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not _finite(fps) or fps <= 0:
        raise _invalid("fps must be a positive number.")
    return {
        "generation": generation,
        "scan_id": body.get("scan_id"),
        **{key: body[key] for key in ("id", "format", "width", "height", "fps")},
    }


def render(snapshot: dict, request: dict) -> dict:
    item = next((item for item in snapshot["items"] if item["id"] == request["id"]), None)
    if item is None:
        raise BoardError(
            "not_found",
            f"Camera {request['id']} is not in the last scan.",
            hint="Refresh and pick a camera from the list.",
        )
    fmt, choice = _find_mode(item, request)
    if choice is None:
        raise _invalid(
            f"{request['format']} {request['width']}x{request['height']} at {request['fps']} fps "
            "is not a mode this camera reported."
        )
    if not fmt["exportable"]:
        raise _invalid(f"{fmt['format']} cannot be exported: {fmt['support']['reason']}")
    if item["connection"] == "usb" and not (item["device"].get("by_id") or item["device"].get("video_node")):
        raise _invalid("This camera reports no device path, so a V4L2 descriptor cannot name it.")
    if item["connection"] != "usb" and not item["device"].get("camera_name"):
        raise _invalid("This camera does not report the camera_name CameraInput needs.")
    if item["connection"] != "usb" and choice["tier"] != "verified":
        raise _invalid(
            f"{fmt['format']} {request['width']}x{request['height']} at {request['fps']} fps cannot be exported: "
            + (choice.get("reason") or "Neat Core does not accept it.")
        )
    selection = {
        "format": fmt["format"],
        "width": request["width"],
        "height": request["height"],
        "fps": choice["value"],
    }
    if item["connection"] == "usb":
        return _usb_export(item, fmt, choice, selection)
    return _mipi_export(item, choice, selection, snapshot)


def _find_mode(item: dict, request: dict):
    for fmt in item["formats"]:
        if fmt["format"] != request["format"]:
            continue
        for size in fmt["sizes"]:
            if (size["width"], size["height"]) != (request["width"], request["height"]):
                continue
            for choice in size["fps"]:
                if abs(choice["value"] - request["fps"]) < 1e-3:
                    return fmt, choice
    return None, None


def _export(export_id: str, label: str, filename: str, language: str, content: str) -> dict:
    return {"id": export_id, "label": label, "filename": filename, "language": language, "content": content}


def _yaml_block(rows, comment: str) -> str:
    # JSON scalars are valid YAML flow scalars, which keeps device-reported strings quoted and escaped.
    return f"# {comment}\ncamera:\n" + "".join(f"  {key}: {json.dumps(value)}\n" for key, value in rows)


def _mipi_export(item: dict, choice: dict, selection: dict, snapshot: dict) -> dict:
    mode = compat.verified_mode(
        item.get("model"), selection["format"], selection["width"], selection["height"], selection["fps"]
    )
    options = {
        "camera_name": item["device"]["camera_name"],
        "width": selection["width"],
        "height": selection["height"],
        "framerate_num": choice["framerate_num"],
        "framerate_den": choice["framerate_den"],
        "format": selection["format"],
        "buffer_name": BUFFER_NAME,
        "queue_depth": QUEUE_DEPTH,
        "allow_cpu_fallback": True,
    }
    descriptor = {
        "kind": "neat.camera-input",
        "version": 1,
        "camera_id": item["id"],
        "board": {"label": snapshot["board"].get("label"), "hostname": snapshot["board"].get("hostname")},
        "scanned_at": snapshot["scanned_at"],
        "options": options,
        # Core rejects capture_buffer_count > 0 when libcamerasrc lacks buffer-count, and Insight does not
        # read libcamerasrc's properties on the board, so the code leaves it unset.
        "capture_buffer_count": 0,
        "support_tier": choice["tier"],
    }
    # Apps treats capture_buffers as a positive capture-buffer request; unlike the Core APIs it
    # has no value that means "do not set buffer-count", so no Apps config.yaml block is offered.
    exports = [
        _export("python", "Python (pyneat)", "camera_input.py", "python", _python(options)),
        _export("cpp", "C++ (Neat)", "camera_input.cpp", "cpp", _cpp(options)),
        _export("json", "JSON", "camera_input.json", "json", json.dumps(descriptor, indent=2) + "\n"),
    ]
    return {
        "camera_id": item["id"],
        "selection": selection,
        "support": _mode_support(mode),
        "warnings": _mipi_warnings(item, choice, mode),
        "exports": exports,
    }


def _mode_support(mode: Optional[dict]) -> dict:
    if mode:
        return {"tier": "verified", "reason": f"Validated with Core CameraInput: {mode['evidence']}.", "links": []}
    return {"tier": "verified", "reason": "Neat Core accepts this mode.", "links": []}


def _mipi_warnings(item: dict, choice: dict, mode: Optional[dict]) -> list:
    warnings = []
    if mode and mode.get("delivered_fps") and mode["delivered_fps"] != choice["value"]:
        warnings.append(
            f"Measured on a DevKit, this mode delivered about {mode['delivered_fps']} fps regardless of the "
            "requested rate: CameraInput's frame rate does not slow the sensor. Drop frames downstream if you "
            "need fewer."
        )
    if item["modes_source"] == "previous-scan":
        warnings.append("These modes come from an earlier scan; the last refresh could not enumerate the camera.")
    if item["availability"]["state"] == "in_use":
        users = item["availability"]["users"]
        holders = ", ".join(f"{user['command']} (pid {user['pid']})" for user in users) or "another process"
        warnings.append(f"The camera is in use by {holders}; CameraInput cannot acquire it until it is released.")
    warnings.append(
        "Insight does not read libcamerasrc's properties on the board, so the code omits capture_buffer_count."
    )
    return warnings


def _cpp_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    escaped = []
    for byte in value.encode("utf-8"):
        char = chr(byte)
        # Octal escapes stop after three digits, unlike \x, so a following character cannot be absorbed.
        escaped.append(char if 0x20 <= byte < 0x7F and char not in '"\\?' else f"\\{byte:03o}")
    return '"' + "".join(escaped) + '"'


def _python(options: dict) -> str:
    lines = ["import pyneat", "", "camera = pyneat.CameraInputOptions()"]
    lines += [f"camera.{key} = {value!r}" for key, value in options.items()]
    lines += ["", 'graph = pyneat.Graph("camera_input")', "graph.add(pyneat.nodes.camera_input(camera))"]
    return "\n".join(lines) + "\n"


def _cpp(options: dict) -> str:
    lines = [
        "#include <neat.h>",
        "",
        "namespace neat = simaai::neat;",
        "",
        "void add_camera_input(neat::Graph& graph) {",
        "  neat::CameraInputOptions camera;",
    ]
    lines += [f"  camera.{key} = {_cpp_value(value)};" for key, value in options.items()]
    lines += ["  graph.add(neat::nodes::CameraInput(camera));", "}"]
    return "\n".join(lines) + "\n"


def _usb_export(item: dict, fmt: dict, choice: dict, selection: dict) -> dict:
    usb = item["device"]["usb"]
    device = item["device"].get("by_id") or item["device"].get("video_node")
    warnings = ["Core CameraInput does not support USB cameras (core#838); this is a V4L2 descriptor, not Neat code."]
    if fmt["format"] in USB_FORMAT_NOTES:
        warnings.append(USB_FORMAT_NOTES[fmt["format"]][0])
    if device and not item["device"].get("by_id"):
        warnings.append(f"{device} numbering is not stable across reboots or replugs; prefer a /dev/v4l/by-id path.")
    descriptor = {
        "kind": "v4l2-camera",
        "version": 1,
        "core_support": "unsupported",
        "camera_id": item["id"],
        "device": device,
        "name": item["name"],
        **{key: usb.get(key) for key in ("vendor_id", "product_id", "serial")},
        "format": selection["format"],
        "width": selection["width"],
        "height": selection["height"],
        "framerate_num": choice["framerate_num"],
        "framerate_den": choice["framerate_den"],
    }
    comment = "V4L2 camera descriptor. Core CameraInput does not support USB cameras (core#838)."
    return {
        "camera_id": item["id"],
        "selection": selection,
        "support": fmt["support"],
        "warnings": warnings,
        "exports": [
            _export("yaml", "YAML descriptor", "v4l2_camera.yaml", "yaml", _yaml_block(descriptor.items(), comment)),
            _export("json", "JSON descriptor", "v4l2_camera.json", "json", json.dumps(descriptor, indent=2) + "\n"),
        ],
    }
