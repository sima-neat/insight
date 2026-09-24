"""Turn probe output into the Peripherals camera snapshot."""
import re
import threading
import time
from datetime import datetime, timezone
from typing import List, Optional

from neat_insight.peripherals import compat
from neat_insight.peripherals.probe import OUT_OF_TIME

STANDARD_FPS = (60, 30, 25, 20, 15, 10, 5)
# libcamera snaps a faster request to the mode's rate limit, so a 29.97 fps mode still serves 30.
FPS_SNAP_TOLERANCE = 0.5
PLATFORM_TOOLS = ("cam", "v4l2-ctl", "media-ctl", "gst-inspect-1.0", "fuser")
_RAW_BAYER_RE = re.compile(r"^S(RGGB|BGGR|GRBG|GBRG)")


def _link(repo: str, number: int) -> dict:
    return {"label": f"{repo}#{number}", "url": f"https://github.com/sima-neat/{repo}/issues/{number}"}


CORE_838 = _link("core", 838)
CORE_883 = _link("core", 883)
CORE_903 = _link("core", 903)
INTERNALS_244 = _link("internals", 244)

ADVERTISED_REASON = (
    "Modes are enumerated by libcamera but not validated with Core; advertised modes can fail, see core#883."
)
VERIFIED_REASON = "Verified modes are validated with Core CameraInput; the rest are advertised by libcamera only."
NV12_ONLY_REASON = (
    "Core CameraInput is exercised with NV12 only: the neatcamerabridge zero-copy path repacks NV12 "
    "and the Apps example rejects other formats."
)
RAW_REASON = "Raw sensor format; CameraInput needs ISP output."
NO_LIBCAMERASRC_REASON = (
    "GStreamer libcamerasrc was not found on the board, so Core CameraInput cannot open MIPI cameras."
)
UNCHECKED_LIBCAMERASRC_REASON = "libcamerasrc could not be checked on the board (see the warnings above). " + ADVERTISED_REASON
USB_REASON = (
    "Detected through V4L2. Core CameraInput supports libcamera/MIPI cameras only; "
    "USB support is tracked in core#838."
)
USB_FORMAT_NOTES = {
    "MJPG": (
        "MJPG chroma subsampling cannot be read without decoding; "
        "4:2:2 MJPEG stalls neatdecoder without an error (core#903).",
        CORE_903,
    ),
    "YUYV": ("There is no YUYV to NV12 conversion on the CVU (internals#244).", INTERNALS_244),
}
FORMAT_LABELS = {
    "NV12": "NV12 (YUV 4:2:0)",
    "YUYV": "YUYV (YUV 4:2:2)",
    "RGB888": "RGB888 (packed 24-bit)",
    "BGR888": "BGR888 (packed 24-bit)",
}
INSTALL_CAM_HINT = "Install the libcamera tools that provide `cam` on the board, then Refresh."
TOOL_ISSUES = {
    "cam": (
        "libcamera's `cam` tool was not found on the board, so MIPI camera names and modes cannot be enumerated.",
        INSTALL_CAM_HINT,
    ),
    "media-ctl": (
        "`media-ctl` was not found, so MIPI cameras cannot be matched to CSI ports or checked for other users.",
        "Install v4l-utils (media-ctl) on the board, then Refresh.",
    ),
    "v4l2-ctl": (
        "`v4l2-ctl` was not found, so USB camera modes and the ISP's output sizes cannot be listed.",
        "Install v4l-utils (v4l2-ctl) on the board, then Refresh.",
    ),
    "gst-inspect-1.0": (
        "`gst-inspect-1.0` was not found, so the libcamerasrc plugin that Core CameraInput needs could not be checked.",
        "Install the GStreamer tools on the board, then Refresh.",
    ),
}
UNKNOWN_USERS_REASON = "processes owned by other users cannot be inspected without root"
UNMATCHED_REASON = (
    "libcamera's name for this camera matched no sensor in the media graph, so its device nodes were not "
    "checked for other processes"
)
AVAILABILITY_ISSUES = {
    "proc-user": (
        "info",
        "Insight connects as a non-root user without passwordless sudo, so cameras held by other users' processes "
        "cannot be detected; idle-looking cameras show as unknown.",
        "Connect as root, or allow passwordless sudo and install fuser (psmisc), then Refresh.",
    ),
    "none": (
        "warning",
        "Processes cannot be inspected on this board, so camera availability is unknown.",
        "Check that /proc is mounted on the board, then Refresh.",
    ),
}
NO_SENSOR_HINT = "Check the camera ribbon cable and that the camera's device-tree overlay is enabled, then Refresh."
OUT_OF_TIME_HINT = (
    "Other board tools were slow (see the warnings above). Refresh again; if it keeps happening, "
    "check those tools on the board."
)
ISP_SIZE_CAUSES = {
    "not_read": "the discovery probe did not read them",
    "tool_missing": "`v4l2-ctl` was not found",
    "no_nodes": "no ISP output node (arm-isp-out) was found",
    "no_common_sizes": "the ISP output nodes list no size in common",
    "timeout": "`{show}` timed out",
    "out_of_time": "the discovery probe ran out of time",
    "unparseable": "`{show}` listed no discrete sizes",
    "failed": "`{show}` failed: {detail}",
}
PERMISSION_HINT = (
    "Add the account Insight connects as to the board's `video` group (`sudo usermod -aG video <user>`, then "
    "reconnect), or connect as root; then Refresh."
)


def _permission_denied(text: Optional[str]) -> bool:
    return "permission denied" in (text or "").lower()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _support(tier: str, reason: str, links: list) -> dict:
    return {"tier": tier, "reason": reason, "links": links}


def _issue(severity: str, code: str, message: str, hint: str) -> dict:
    return {"severity": severity, "code": code, "message": message, "hint": hint}


def _error(code: str, message: str, hint: str) -> dict:
    return {"code": code, "message": message, "hint": hint}


def _command_error(show: str, detail: str) -> dict:
    if _permission_denied(detail):
        return _error("permission_denied", f"`{show}` was denied access to the camera: {detail}", PERMISSION_HINT)
    return _error("command_failed", f"`{show}` failed: {detail}", f"Run `{show}` on the board to see why.")


def _selection(fmt: str, size: dict, fps) -> dict:
    return {"format": fmt, "width": size["width"], "height": size["height"], "fps": fps}


def fps_choices(max_fps: Optional[float]) -> List[int]:
    if not max_fps:
        return [30]
    limit = max(1, int(max_fps + FPS_SNAP_TOLERANCE))
    return sorted({limit, *(fps for fps in STANDARD_FPS if fps <= limit)}, reverse=True)


def empty_snapshot(board: dict, generation: int) -> dict:
    return {
        "board": board,
        "generation": generation,
        "scanned_at": None,
        "items": [],
        "issues": [],
        "changes": None,
        "platform": None,
    }


def build_snapshot(probe: dict, board: dict, generation: int, previous: Optional[dict], scan_ms: int):
    """Return (snapshot, modes); modes keeps each camera's last live formats for carry-forward."""
    scanned_at = now_iso()
    platform = _platform(probe)
    modes = dict(previous["modes"]) if previous else {}
    media = {device["path"]: device for device in probe.get("media_devices") or []}
    isp_sizes = _isp_sizes(probe)
    items = [_mipi_item(camera, probe, platform, media, modes, isp_sizes) for camera in probe.get("mipi") or []]
    items += [_usb_item(camera, platform) for camera in probe.get("usb") or []]
    for item in items:
        if item["modes_source"] == "live":
            modes[item["id"]] = {key: item[key] for key in ("formats", "default_selection")}
            modes[item["id"]]["scanned_at"] = scanned_at
    isp_unread = isp_sizes is None and any(i["connection"] == "mipi" and i["modes_source"] == "live" for i in items)
    snapshot = {
        "board": board,
        "generation": generation,
        "scanned_at": scanned_at,
        "scan_ms": scan_ms,
        "platform": platform,
        "items": items,
        "issues": _issues(probe, platform, media, isp_unread),
        "changes": _changes(previous["snapshot"]["items"], items) if previous else None,
    }
    return snapshot, modes


def _platform(probe: dict) -> dict:
    tools = probe.get("tools") or {}
    libcamerasrc = probe.get("libcamerasrc")
    return {
        "tools": {name: bool(tools.get(name)) for name in PLATFORM_TOOLS},
        "libcamerasrc": None
        if libcamerasrc is None
        else {key: bool(libcamerasrc.get(key)) for key in ("present", "external_buffer_mode", "buffer_count")},
        "availability_method": probe.get("availability_method") or "none",
    }


def _isp_sizes(probe: dict) -> Optional[set]:
    isp = probe.get("isp") or {}
    if isp.get("reason") or not isp.get("sizes"):
        return None
    return {(size["width"], size["height"]) for size in isp["sizes"]}


def _libcamerasrc_state(probe: dict) -> Optional[bool]:
    """True/False when gst-inspect answered, None when it could not run."""
    libcamerasrc = probe.get("libcamerasrc")
    return None if libcamerasrc is None else bool(libcamerasrc.get("present"))


def _availability(users: Optional[list], method: str, acquire: Optional[str] = None, unmatched: bool = False) -> dict:
    if users:
        holders = ", ".join(f"{user['command']} (pid {user['pid']})" for user in users)
        return {"state": "in_use", "users": users, "reason": f"Open in {holders}."}
    if acquire == "busy":
        state, reason = "in_use", "libcamera could not acquire the camera; another process holds it."
    elif unmatched:
        # A libcamera acquire does not see processes using the V4L2 nodes directly.
        state, reason = "unknown", UNMATCHED_REASON
    elif acquire == "ok" or (users is not None and method in ("proc-root", "sudo-fuser")):
        state, reason = "available", None
    elif method == "proc-user":
        state, reason = "unknown", UNKNOWN_USERS_REASON
    elif method == "none":
        state, reason = "unknown", "processes cannot be inspected on this board"
    else:
        state, reason = "unknown", "the camera's device nodes could not be checked for other users"
    return {"state": state, "users": [], "reason": reason}


def _mipi_item(camera: dict, probe: dict, platform: dict, media: dict, modes: dict, isp_sizes: Optional[set]) -> dict:
    camera_id = camera["id"]
    item_id = "mipi:" + camera_id
    model = compat.model_token(camera_id, camera.get("model"))
    libcamerasrc = _libcamerasrc_state(probe)
    device = {"camera_name": camera_id, "camera_name_source": camera["source"]}
    graph = media.get(camera.get("media_device")) or {}
    for key, graph_key in (("media_device", "path"), ("bus_info", "bus_info"), ("csi", "csi")):
        if graph.get(graph_key):
            device[key] = graph[graph_key]

    notes, errors = [], []
    formats, hidden = [], 0
    for fmt in camera.get("formats") or []:
        sizes = fmt["sizes"]
        # libcamera advertises any size the sensor can be scaled to, but the ISP only outputs its preset
        # sizes; for any other the ISP keeps its current size and libcamera aborts the stream (core#883).
        if isp_sizes is not None and not _RAW_BAYER_RE.match(fmt["format"]):
            sizes = [size for size in sizes if (size["width"], size["height"]) in isp_sizes]
            hidden += len(fmt["sizes"]) - len(sizes)
        formats.append(_mipi_format(dict(fmt, sizes=sizes), model, camera.get("max_fps"), libcamerasrc))
    if formats:
        modes_source, default = "live", _mipi_default(formats)
        if camera.get("max_fps"):
            notes.append(
                f"libcamera reports {camera['max_fps']:g} fps for the sensor's fastest mode. The delivered frame "
                "rate follows the sensor mode libcamera picks and can differ from the requested rate."
            )
        else:
            notes.append("libcamera did not report a maximum frame rate, so only 30 fps is offered.")
        if hidden:
            offered = ", ".join(f"{w}x{h}" for w, h in sorted(isp_sizes))
            notes.append(
                f"Only sizes the ISP can output ({offered}) are offered; libcamera also advertises sizes the ISP "
                "cannot produce, which fail to start (core#883)."
            )
    else:
        errors.append(_mipi_modes_error(camera, probe))
        previous = modes.get(item_id)
        if previous:
            modes_source, formats, default = "previous-scan", previous["formats"], previous["default_selection"]
            scanned_at = previous["scanned_at"]
            notes.append(f"Modes are from the scan at {scanned_at}; they could not be read during this refresh.")
        else:
            modes_source, default = "unavailable", None

    return {
        "id": item_id,
        "kind": "camera",
        "connection": "mipi",
        "name": camera_id,
        "model": model or None,
        "device": device,
        "availability": _availability(
            camera.get("users"), platform["availability_method"], camera.get("acquire"), _unmatched(camera)
        ),
        "support": _mipi_support(model, libcamerasrc),
        "modes_source": modes_source,
        "formats": formats,
        "default_selection": default,
        "notes": notes,
        "errors": errors,
    }


def _unmatched(camera: dict) -> bool:
    return camera.get("sensor_match") == "none"


def _unmatched_issue(camera: dict) -> dict:
    message = (
        f'libcamera camera "{camera["id"]}" could not be matched to a sensor in the media graph, so its media '
        "device is not shown and its availability is unknown."
    )
    possible = camera.get("possible_sensors") or []
    if possible:
        names = ", ".join(f'"{name}"' for name in possible)
        message += f" Media-graph sensor {names} is not listed separately because it may be the same camera."
    hint = (
        "Compare `cam -l` with the sensor entities in `media-ctl -p` on the board. libcamera names a sensor by "
        "its entity or its device-tree node (/sys/bus/i2c/devices/<bus>-<addr>/of_node); report both outputs."
    )
    return _issue("warning", "sensor_unmatched", message, hint)


def _mipi_support(model: str, libcamerasrc: Optional[bool]) -> dict:
    if libcamerasrc is False:
        return _support("unsupported", NO_LIBCAMERASRC_REASON, [])
    if libcamerasrc is None:
        return _support("advertised", UNCHECKED_LIBCAMERASRC_REASON, [CORE_883])
    if compat.has_model(model):
        # No model prefix: this sits directly under the camera's own heading.
        return _support("verified", VERIFIED_REASON, [CORE_883])
    return _support("advertised", ADVERTISED_REASON, [CORE_883])


def _fps_tier(model: str, fmt: str, size: dict, fps: int, libcamerasrc: Optional[bool]) -> str:
    if fmt != "NV12" or libcamerasrc is False:
        return "unsupported"
    if libcamerasrc and compat.verified_mode(model, fmt, size["width"], size["height"], fps):
        return "verified"
    return "advertised"


def _mipi_format(fmt: dict, model: str, max_fps: Optional[float], libcamerasrc: Optional[bool]) -> dict:
    name = fmt["format"]
    raw = bool(_RAW_BAYER_RE.match(name))
    sizes = [
        {
            "width": size["width"],
            "height": size["height"],
            "fps": [
                {"value": fps, "tier": _fps_tier(model, name, size, fps, libcamerasrc)} for fps in fps_choices(max_fps)
            ],
        }
        for size in fmt["sizes"]
    ]
    if name != "NV12":
        support = _support("unsupported", RAW_REASON if raw else NV12_ONLY_REASON, [])
    elif libcamerasrc is False:
        support = _support("unsupported", NO_LIBCAMERASRC_REASON, [])
    elif any(choice["tier"] == "verified" for size in sizes for choice in size["fps"]):
        support = _support("verified", VERIFIED_REASON, [CORE_883])
    else:
        support = _support("advertised", ADVERTISED_REASON, [CORE_883])
    return {
        "format": name,
        "label": FORMAT_LABELS.get(name) or (f"{name} (raw Bayer)" if raw else name),
        "exportable": name == "NV12",
        "support": support,
        "range": fmt.get("range"),
        "sizes": sizes,
    }


def _mipi_default(formats: list) -> Optional[dict]:
    nv12 = next((fmt for fmt in formats if fmt["format"] == "NV12"), None)
    if nv12 is None:
        return None
    for size in nv12["sizes"]:
        for choice in size["fps"]:
            if choice["tier"] == "verified":
                return _selection("NV12", size, choice["value"])
    for size in nv12["sizes"]:
        if (size["width"], size["height"]) == (1920, 1080) and any(c["value"] == 30 for c in size["fps"]):
            return _selection("NV12", size, 30)
    offered = [s for s in nv12["sizes"] if s["fps"]]
    fitting = [s for s in offered if s["width"] <= 1920 and s["height"] <= 1080]
    if fitting:
        best = max(fitting, key=lambda s: s["width"] * s["height"])
    elif offered:
        best = min(offered, key=lambda s: s["width"] * s["height"])
    else:
        return None
    return _selection("NV12", best, max(choice["value"] for choice in best["fps"]))


def _mipi_modes_error(camera: dict, probe: dict) -> dict:
    acquire = camera.get("acquire")
    show = f'cam -c "{camera["id"]}" -I'
    if acquire in ("skipped", "busy"):
        return _error(
            "camera_in_use",
            "Modes could not be read because another process is using the camera.",
            "Stop the process using the camera, then Refresh.",
        )
    if acquire == "timeout":
        return _error("timeout", f"`{show}` timed out.", "Refresh again; if it keeps timing out, reboot the board.")
    if acquire == "out_of_time":
        message = "The discovery probe ran out of time before reading this camera's modes."
        return _error("timeout", message, OUT_OF_TIME_HINT)
    if acquire == "failed":
        return _command_error(show, camera.get("detail") or "no output")
    if acquire == "ok":
        return _error("no_modes", "libcamera reported no formats for this camera.", f"Run `{show}` on the board.")
    if not (probe.get("tools") or {}).get("cam"):
        cause, code, hint = "libcamera's `cam` tool is missing", "tool_missing", INSTALL_CAM_HINT
    elif not (probe.get("libcamera") or {}).get("listed"):
        cause, code, hint = "`cam -l` failed", "command_failed", "Run `cam -l` on the board to see why, then Refresh."
    else:
        cause = "libcamera did not list it (another process may hold it, or its driver failed to probe)"
        code, hint = "not_listed", "Stop other camera users and check `dmesg` for sensor errors, then Refresh."
    message = f"This sensor was found only in the media graph because {cause}, so its modes are unknown."
    return _error(code, message, hint)


def _usb_item(camera: dict, platform: dict) -> dict:
    usb = camera["usb"]
    device = {"video_node": camera["node"], "usb": usb}
    notes, errors = [], []
    if camera.get("by_id"):
        device["by_id"] = camera["by_id"]
    else:
        notes.append("No /dev/v4l/by-id link was found; /dev/videoN numbering can change across reboots and replugs.")

    formats = [_usb_format(fmt) for fmt in camera.get("formats") or []]
    if camera.get("formats") is None:
        if camera.get("detail"):
            show = f"v4l2-ctl -d {camera['node']} --list-formats-ext"
            if camera["detail"] == OUT_OF_TIME:
                message = "The discovery probe ran out of time before listing this camera's modes."
                errors.append(_error("timeout", message, OUT_OF_TIME_HINT))
            else:
                errors.append(_command_error(show, camera["detail"]))
        else:
            message = "`v4l2-ctl` is missing, so this camera's modes cannot be listed."
            errors.append(_error("tool_missing", message, TOOL_ISSUES["v4l2-ctl"][1]))

    return {
        "id": f"usb:{usb.get('vendor_id')}:{usb.get('product_id')}:{usb.get('serial') or usb.get('bus_path')}",
        "kind": "camera",
        "connection": "usb",
        "name": usb.get("product") or camera.get("name") or camera["node"],
        "model": usb.get("product") or camera.get("name"),
        "device": device,
        "availability": _availability(camera.get("users"), platform["availability_method"]),
        "support": _support("unsupported", USB_REASON, [CORE_838]),
        "modes_source": "unavailable" if camera.get("formats") is None else "live",
        "formats": formats,
        "default_selection": _usb_default(formats),
        "notes": notes,
        "errors": errors,
    }


def _usb_fps(size: dict) -> list:
    values = list(size.get("fps") or [])
    if size.get("fps_range"):
        low, high = size["fps_range"]
        values += [fps for fps in STANDARD_FPS if low - 1e-3 <= fps <= high + 1e-3]
    return sorted({int(round(v)) if abs(v - round(v)) < 1e-3 else round(v, 3) for v in values}, reverse=True)


def _usb_format(fmt: dict) -> dict:
    name = fmt["format"]
    note = USB_FORMAT_NOTES.get(name)
    links = [CORE_838, note[1]] if note else [CORE_838]
    description = fmt.get("description")
    return {
        "format": name,
        "label": f"{name} ({description})" if description else name,
        "exportable": True,
        "support": _support("unsupported", f"{USB_REASON} {note[0]}" if note else USB_REASON, links),
        "range": fmt.get("range"),
        "sizes": [
            {
                "width": size["width"],
                "height": size["height"],
                "fps": [{"value": fps, "tier": "unsupported"} for fps in _usb_fps(size)],
            }
            for size in fmt["sizes"]
        ],
    }


def _usb_default(formats: list) -> Optional[dict]:
    for fmt in formats:
        for size in fmt["sizes"]:
            if fmt["format"] == "MJPG" and (size["width"], size["height"]) == (1280, 720) and size["fps"]:
                values = [choice["value"] for choice in size["fps"]]
                return _selection("MJPG", size, 30 if 30 in values else values[0])
    for fmt in formats:
        for size in fmt["sizes"]:
            if size["fps"]:
                return _selection(fmt["format"], size, size["fps"][0]["value"])
    return None


def _no_sensor_devices(probe: dict, media: dict) -> list:
    listing = probe.get("libcamera")
    if listing and listing.get("listed"):
        return sorted(set(listing.get("no_sensor") or []))
    return sorted(path for path, device in media.items() if device.get("csi") and not device.get("sensors"))


def _isp_issue(probe: dict) -> dict:
    isp = probe.get("isp") or {}
    reason = isp.get("reason") or "not_read"
    show = f"v4l2-ctl -d {isp.get('node') or '/dev/video0out'} --list-formats-ext"
    cause = ISP_SIZE_CAUSES.get(reason, ISP_SIZE_CAUSES["failed"])
    cause = cause.format(show=show, detail=isp.get("detail") or "no output")
    message = (
        f"The ISP's output sizes could not be read ({cause}), so MIPI cameras offer every size libcamera "
        "advertises; sizes the ISP cannot produce fail to start (core#883)."
    )
    if reason == "tool_missing":
        hint = TOOL_ISSUES["v4l2-ctl"][1]
    elif reason == "no_nodes":
        hint = "Run `v4l2-ctl --list-devices` on the board and look for arm-isp-out nodes, then Refresh."
    else:
        hint = f"Run `{show}` on the board, then Refresh."
    return _issue("warning", "isp_sizes_unavailable", message, hint)


def _issues(probe: dict, platform: dict, media: dict, isp_unread: bool) -> list:
    tools = probe.get("tools") or {}
    issues = [_issue("warning", "tool_missing", *TOOL_ISSUES[tool]) for tool in TOOL_ISSUES if not tools.get(tool)]
    if _libcamerasrc_state(probe) is False:
        hint = "Install the libcamera GStreamer plugin (libcamerasrc) on the board, then Refresh."
        issues.append(_issue("error", "tool_missing", NO_LIBCAMERASRC_REASON, hint))
    if platform["availability_method"] in AVAILABILITY_ISSUES:
        severity, message, hint = AVAILABILITY_ISSUES[platform["availability_method"]]
        issues.append(_issue(severity, "availability_limited", message, hint))
    for path in _no_sensor_devices(probe, media):
        bus_info = (media.get(path) or {}).get("bus_info")
        where = f"{path} ({bus_info})" if bus_info else path
        issues.append(_issue("info", "no_sensor", f"No MIPI sensor detected on {where}.", NO_SENSOR_HINT))
    # Without a media graph every camera is unmatched; the media-ctl issue above already says why.
    graph_read = tools.get("media-ctl") and not any(f.get("tool") == "media-ctl" for f in probe.get("failures") or [])
    if graph_read:
        issues += [_unmatched_issue(camera) for camera in probe.get("mipi") or [] if _unmatched(camera)]
    for failure in probe.get("failures") or []:
        tool = failure.get("tool")
        hint = f"Refresh again; if it keeps failing, run `{tool}` on the board to see the full error."
        if failure.get("reason") == "timeout":
            code, message = "timeout", f"`{tool}` timed out on the board."
        elif failure.get("reason") == "out_of_time":
            code, message = "timeout", f"`{tool}` was skipped: the discovery probe ran out of time."
            hint = OUT_OF_TIME_HINT
        elif _permission_denied(failure.get("detail")):
            code, message, hint = "permission_denied", f"`{tool}` was denied access: {failure['detail']}", PERMISSION_HINT
        else:
            code, message = "command_failed", f"`{tool}` failed: {failure.get('detail') or 'no output'}"
        issues.append(_issue("warning", code, message, hint))
    if isp_unread:
        issues.append(_isp_issue(probe))
    return issues


def _changes(before_items: list, after_items: list) -> dict:
    before = {item["id"]: item["name"] for item in before_items}
    after = {item["id"]: item["name"] for item in after_items}
    return {
        "added": [{"id": item_id, "name": name} for item_id, name in after.items() if item_id not in before],
        "removed": [{"id": item_id, "name": name} for item_id, name in before.items() if item_id not in after],
    }


class ScanCache:
    """The latest scan, keyed by board generation; a different board fingerprint starts a fresh history."""

    def __init__(self):
        self._lock = threading.Lock()
        self._entry: Optional[dict] = None
        self._refresh_locks = {}

    def refresh_lock(self, generation: int) -> threading.Lock:
        with self._lock:
            return self._refresh_locks.setdefault(generation, threading.Lock())

    def snapshot(self, generation: int) -> Optional[dict]:
        with self._lock:
            entry = self._entry
        return entry["snapshot"] if entry and entry["generation"] == generation else None

    def completed_since(self, generation: int, since: float) -> Optional[dict]:
        """The snapshot of a refresh that finished after `since` (monotonic), i.e. one that was in flight."""
        with self._lock:
            entry = self._entry
        if entry and entry["generation"] == generation and entry["completed"] >= since:
            return entry["snapshot"]
        return None

    def record(self, generation: int, board: dict, probe: dict, scan_ms: int) -> dict:
        with self._lock:
            previous = self._entry
        if previous and (previous["generation"], previous["fingerprint"]) != (generation, board.get("fingerprint")):
            previous = None
        snapshot, modes = build_snapshot(probe, board, generation, previous, scan_ms)
        with self._lock:
            if self._entry is None or self._entry["generation"] <= generation:
                self._entry = {
                    "generation": generation,
                    "fingerprint": board.get("fingerprint"),
                    "snapshot": snapshot,
                    "modes": modes,
                    "completed": time.monotonic(),
                }
            self._refresh_locks = {g: lock for g, lock in self._refresh_locks.items() if g >= generation}
        return snapshot
