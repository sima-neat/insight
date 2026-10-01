"""Render CameraInput examples from one exact daemon catalog mode."""
import json

from neat_insight.board import BoardError

MODE_HINT = "Refresh the peripheral catalog and select a supported camera mode."


def _invalid(message: str) -> BoardError:
    return BoardError("invalid_request", message, hint=MODE_HINT)


def _integer(value, *, positive=False) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= (1 if positive else 0)


def parse_request(body) -> dict:
    if not isinstance(body, dict):
        raise _invalid("The request body must be a JSON object.")
    strings = ("instance_id", "device_id", "format")
    if any(not isinstance(body.get(key), str) or not body[key] or len(body[key]) > 512 for key in strings):
        raise _invalid("instance_id, device_id, and format must be non-empty strings from the catalog.")
    if not all(_integer(body.get(key)) for key in ("board_generation", "revision")):
        raise _invalid("board_generation and revision must be non-negative integers from the catalog.")
    if not all(_integer(body.get(key), positive=True) for key in ("width", "height", "framerate_num", "framerate_den")):
        raise _invalid("width, height, framerate_num, and framerate_den must be positive integers.")
    return {key: body[key] for key in (
        "board_generation", "instance_id", "revision", "device_id", "format",
        "width", "height", "framerate_num", "framerate_den",
    )}


def render(catalog: dict, selection: dict) -> dict:
    if catalog["instance_id"] != selection["instance_id"] or catalog["revision"] != selection["revision"]:
        raise BoardError(
            "stale_snapshot",
            "The peripheral catalog changed since this mode was selected.",
            hint=MODE_HINT,
            current_instance_id=catalog["instance_id"],
            current_revision=catalog["revision"],
        )
    device = next((item for item in catalog["devices"] if item["id"] == selection["device_id"]), None)
    if device is None:
        raise BoardError("not_found", "That device is no longer in the peripheral catalog.", hint=MODE_HINT)
    camera = device.get("camera") if device.get("type") == "camera" else None
    if not isinstance(camera, dict):
        raise _invalid("The selected device is not a camera.")
    camera_name = camera.get("camera_name")
    if not isinstance(camera_name, str) or not camera_name:
        raise _invalid("This camera does not provide the CameraInput camera_name required for export.")

    wanted = {key: selection[key] for key in ("format", "width", "height", "framerate_num", "framerate_den")}
    mode = next((mode for mode in camera.get("modes", []) if isinstance(mode, dict) and all(mode.get(key) == value for key, value in wanted.items())), None)
    if mode is None:
        raise _invalid("That exact camera mode is no longer present in the daemon catalog.")
    if mode.get("supported") is not True:
        reason = mode.get("reason") if isinstance(mode.get("reason"), str) else "the daemon did not mark it supported"
        raise _invalid(f"That camera mode cannot be exported: {reason}.")

    # CameraInput's zero-copy default is not valid for every daemon-supported
    # libcamera mode on Modalix. Generated examples must match the proven path.
    options = {"camera_name": camera_name, **wanted, "allow_cpu_fallback": True}
    descriptor = {
        "kind": "neat.camera-input",
        "version": 1,
        "device_id": device["id"],
        "provider": device["provider"],
        "catalog": {"instance_id": catalog["instance_id"], "revision": catalog["revision"]},
        "options": options,
    }
    return {
        "device_id": device["id"],
        "mode": wanted,
        "exports": [
            _export("python", "Python (PyNeat)", "camera_input.py", "python", _python(options)),
            _export("cpp", "C++ (Neat)", "camera_input.cpp", "cpp", _cpp(options)),
            _export("json", "JSON configuration", "camera_input.json", "json", json.dumps(descriptor, indent=2) + "\n"),
        ],
    }


def _export(export_id: str, label: str, filename: str, language: str, content: str) -> dict:
    return {"id": export_id, "label": label, "filename": filename, "language": language, "content": content}


def _python(options: dict) -> str:
    lines = ["import pyneat", "", "camera = pyneat.CameraInputOptions()"]
    lines.extend(f"camera.{key} = {value!r}" for key, value in options.items())
    lines.extend([
        "",
        'graph = pyneat.Graph("camera_input")',
        "graph.add(pyneat.nodes.camera_input(camera))",
        'graph.add(pyneat.nodes.output("frames"))',
    ])
    return "\n".join(lines) + "\n"


def _cpp_value(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    encoded = []
    for byte in value.encode("utf-8"):
        char = chr(byte)
        encoded.append(char if 0x20 <= byte < 0x7F and char not in '"\\?' else f"\\{byte:03o}")
    return '"' + "".join(encoded) + '"'


def _cpp(options: dict) -> str:
    lines = [
        "#include <neat.h>", "", "namespace neat = simaai::neat;", "",
        "void add_camera_input(neat::Graph& graph) {", "  neat::CameraInputOptions camera;",
    ]
    lines.extend(f"  camera.{key} = {_cpp_value(value)};" for key, value in options.items())
    lines.extend([
        "  graph.add(neat::nodes::CameraInput(camera));",
        '  graph.add(neat::nodes::Output("frames"));',
        "}",
    ])
    return "\n".join(lines) + "\n"
