"""Turn SiMa Sentinel's peripheral catalog into the Peripherals camera snapshot."""
import math
import threading
import time
from datetime import datetime, timezone
from fractions import Fraction
from typing import Optional

STANDARD_FPS = (60, 30, 25, 20, 15, 10, 5)
# CameraInputOptions' default framerate_num/den: the rate CameraInput requests from a mode that reports none.
CAMERAINPUT_RATE = Fraction(30, 1)


# Neat fact: CameraInput's default output format (CameraInputOptions.format = "NV12" in Neat Core
# include/nodes/io/CameraInput.h, unchanged since v0.4.0). Written here as a constant on purpose:
# Insight does not call or import Neat to decide support.
CAMERAINPUT_FORMAT = "NV12"
# A mode is Available when the board's camera overlays support the camera's sensor, the ISP outputs its size,
# and its format is CAMERAINPUT_FORMAT; every other mode is Unsupported, for one of these reasons.
NO_BOARD_REASON = "This board's SiMa Sentinel does not report camera overlays; update Sentinel."
USB_REASON = "USB cameras have no camera overlay on this board."
NOT_IN_OVERLAYS_REASON = "{name} is not in this board's camera overlays."
NOT_ISP_SIZE_REASON = "The ISP cannot output this size."
NO_ISP_SIZE_REASON = "The ISP cannot output any size this camera reports."
FORMAT_REASON = f"Neat's CameraInput outputs {CAMERAINPUT_FORMAT} only."
NO_MODES_REASON = "SiMa Sentinel reported no modes for this camera."
NO_BY_ID_NOTE = "No /dev/v4l/by-id link was found; /dev/videoN numbering can change across reboots and replugs."
# Sentinel names a MIPI camera after its sensor entity in the kernel media graph.
NAME_SOURCE = "media-graph"
# V4L2 FourCCs, named as the kernel describes them (v4l_fill_fmtdesc).
FORMAT_LABELS = {
    "NV12": "NV12 (YUV 4:2:0)",
    "YUYV": "YUYV (YUV 4:2:2)",
    "MJPG": "MJPG (Motion-JPEG)",
    "RGB3": "RGB3 (packed 24-bit)",
    "AR24": "AR24 (packed 32-bit)",
}
STATUS_HINT = "Check `systemctl status simaai-sentinel` and `journalctl -u simaai-sentinel` on the board, then Refresh."
TOOL_ISSUES = {
    "media-ctl": (
        "`media-ctl` was not found, so only the media device of each MIPI camera is checked for other processes.",
        "Install v4l-utils (media-ctl) on the board, then Refresh.",
    ),
}
UNKNOWN_USERS_REASON = "processes owned by other users cannot be inspected without root"
UNCHECKED_REASON = "the camera's device nodes could not be checked for other users"
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _support(tier: str, reason: str) -> dict:
    return {"tier": tier, "reason": reason}


def _issue(severity: str, code: str, message: str, hint: str) -> dict:
    return {"severity": severity, "code": code, "message": message, "hint": hint}


def _error(code: str, message: str, hint: str) -> dict:
    return {"code": code, "message": message, "hint": hint}


def _selection(fmt: str, size: dict, fps) -> dict:
    return {"format": fmt, "width": size["width"], "height": size["height"], "fps": fps}


def _fps(num: int, den: int):
    value = Fraction(num, den)
    return int(value) if value.denominator == 1 else round(float(value), 3)


def _choice(rate: Fraction, **verdict) -> dict:
    """One frame-rate choice: a display value plus the exact rate as a fraction."""
    return {"value": _fps(rate.numerator, rate.denominator), "framerate_num": rate.numerator,
            "framerate_den": rate.denominator, **verdict}


def empty_snapshot(board: dict, generation: int) -> dict:
    return {
        "board": board,
        "generation": generation,
        "scan_id": None,
        "scanned_at": None,
        "items": [],
        "issues": [],
        "changes": None,
        "platform": None,
        "camera_setup": None,
    }


def camera_nodes(camera: dict) -> list:
    """The device nodes whose holders tell whether the camera is in use."""
    if camera.get("backend") == "mipi":
        isp = camera.get("isp") if isinstance(camera.get("isp"), dict) else {}
        nodes = [camera.get("media_device"), isp.get("device_path")]
        if isinstance(isp.get("device_paths"), list):
            nodes.extend(isp["device_paths"])
    else:
        nodes = [camera.get("device_path")]
    return list(dict.fromkeys(node for node in nodes if isinstance(node, str) and node.startswith("/dev/")))


def cameras_of(catalog: dict) -> list:
    return [device for device in catalog["devices"] if device["type"] == "camera"]


def provider_of(device: dict) -> str:
    """The Sentinel provider that reports a device; Sentinel names its providers `<type>.<backend>`."""
    return f"{device['type']}.{device.get('backend')}"


def _camera_reason(camera: dict, board: Optional[dict]) -> str:
    """Why none of a camera's modes can be Available; empty when the board's camera overlays support its sensor."""
    if _connection(camera) == "usb":
        return USB_REASON
    if not isinstance(board, dict):
        return NO_BOARD_REASON
    # The device tree names a detected camera's sensor by its compatible string; Sentinel links the two by id.
    configured = board.get("configured_cameras") or []
    compatible = next((entry["compatible"] for entry in configured if entry.get("camera_id") == camera["id"]), None)
    if compatible and compatible in {sensor["compatible"] for sensor in board.get("supported_sensors") or []}:
        return ""
    if compatible:
        name = sensor_name(compatible)
    else:
        name = (camera.get("model") or "").upper() or camera.get("camera_name") or camera["id"]
    return NOT_IN_OVERLAYS_REASON.format(name=name)


def _classified(mode: dict, camera_reason: str) -> dict:
    """A Sentinel mode with its state: `available` True or False, and why it is not (`reason`)."""
    if camera_reason:
        return dict(mode, available=False, reason=camera_reason)
    if mode.get("isp_output") is not True:
        return dict(mode, available=False, reason=NOT_ISP_SIZE_REASON)
    if mode["format"] != CAMERAINPUT_FORMAT:
        return dict(mode, available=False, reason=FORMAT_REASON)
    return dict(mode, available=True, reason="")


def build_snapshot(catalog: dict, check: Optional[dict], board: dict, generation: int, previous: Optional[dict], scan_ms: int):
    """Return the snapshot; `check` is the board_check output, or None when it could not run."""
    # A failed provider's devices from its last successful scan stay in the catalog.
    retained = {error["provider"] for error in catalog["errors"]}
    platform = {
        "tools": (check or {}).get("tools") or {},
        "availability_method": (check or {}).get("availability_method") or "none",
    }
    items = []
    for device in cameras_of(catalog):
        reason = _camera_reason(device, catalog.get("board"))
        modes = [_classified(mode, reason) for mode in device.get("modes") or []]
        items.append(_item(device, check, modes, reason, provider_of(device) in retained))
    return {
        "board": board,
        "generation": generation,
        "scan_id": f"{catalog['revision']}:{catalog['observed_at']}",
        "scanned_at": now_iso(),
        "scan_ms": scan_ms,
        "platform": platform,
        "items": items,
        "issues": _issues(catalog, check, items),
        "changes": _changes(previous["items"], items) if previous else None,
        "camera_setup": _camera_setup(catalog.get("board")),
    }


def sensor_name(compatible: str) -> str:
    """A sensor's display name from its device-tree compatible string: "sony,imx477" is IMX477."""
    return (compatible.split(",", 1)[-1] or compatible).upper()


def _camera_setup(block: Optional[dict]) -> Optional[dict]:
    """The board's camera setup from Sentinel's (validated) `board` block; None when Sentinel sends none."""
    if not isinstance(block, dict):
        return None
    # Sentinel lists every overlay U-Boot applies (PCIe, secure boot, ...); show those that configure a camera sensor.
    sensors = block.get("supported_sensors") or []
    camera_overlays = {overlay for sensor in sensors for overlay in sensor.get("overlays") or []}
    return {
        "model": block.get("model"),
        "overlays": [overlay for overlay in block.get("overlays") or [] if overlay in camera_overlays],
    }


def _availability(users: Optional[list], method: Optional[str], fallback: Optional[dict]) -> dict:
    if users:
        holders = ", ".join(f"{user['command']} (pid {user['pid']})" for user in users)
        return {"state": "in_use", "users": users, "reason": f"Open in {holders}."}
    if users is not None and method in ("proc-root", "sudo-fuser"):
        return {"state": "available", "users": [], "reason": None}
    if users is not None and method == "proc-user":
        reason = UNKNOWN_USERS_REASON
    elif method == "none":
        reason = "processes cannot be inspected on this board"
    else:
        # Sentinel never opens a stream, so its own availability is always "unknown" with a reason.
        reason = (fallback or {}).get("reason") or UNCHECKED_REASON
    return {"state": "unknown", "users": [], "reason": reason}


def _connection(camera: dict) -> str:
    # Sentinel's V4L2 provider reports USB cameras only.
    return {"mipi": "mipi", "v4l2": "usb"}.get(camera.get("backend"), camera.get("backend") or "unknown")


def _speed_mbps(speed):
    """The USB link speed sysfs reports in Mb/s ("1.5", "480", "5000"), as a number; None when unreadable."""
    try:
        value = float(speed)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(value) and value > 0):
        return None
    return int(value) if value.is_integer() else value


def _item(camera: dict, check: Optional[dict], modes: list, reason: str, retained: bool) -> dict:
    """`modes` are the camera's classified modes (_classified); `reason` is why none can be Available, if any."""
    connection = _connection(camera)
    usb = connection == "usb"
    formats = _formats(modes, usb, reason, _sensor_rate(camera))
    notes, errors = [], []
    if usb:
        identity = camera.get("identity") or {}
        details = {
            "vendor_id": identity.get("vendor_id"),
            "product_id": identity.get("product_id"),
            "manufacturer": identity.get("manufacturer"),
            "serial": identity.get("serial"),
            "product": camera.get("model"),
            "bus_path": identity.get("topology"),
            "speed_mbps": _speed_mbps(identity.get("speed")),
        }
        info = {"usb": {key: value for key, value in details.items() if value}}
        if camera.get("device_path"):
            info = {"video_node": camera["device_path"], **info}
        if camera.get("by_id_path"):
            info["by_id"] = camera["by_id_path"]
        else:
            notes.append(NO_BY_ID_NOTE)
        name = camera.get("model") or camera.get("device_path") or camera["id"]
    else:
        info = {"camera_name": camera.get("camera_name")}
        if camera.get("camera_name"):
            info["camera_name_source"] = NAME_SOURCE
        for key, source in (("media_device", "media_device"), ("bus_info", "bus_info"), ("csi", "csi_receiver")):
            if camera.get(source):
                info[key] = camera[source]
        name = camera.get("camera_name") or camera["id"]
        notes += _mipi_notes(camera, modes)
    if not modes:
        isp = camera.get("isp") or {}
        if isp.get("state") == "unavailable":
            message = f"The ISP output node could not be read, so this camera's modes are unknown: {isp.get('reason')}"
            errors.append(_error("no_modes", message, STATUS_HINT))
        else:
            errors.append(_error("no_modes", NO_MODES_REASON, STATUS_HINT))
    elif retained:
        notes.append(
            f"Modes are from SiMa Sentinel's last successful scan; its {provider_of(camera)} provider failed "
            "during this refresh."
        )
    users = (check or {}).get("users", {}).get(camera["id"])
    return {
        "id": camera["id"],
        "kind": "camera",
        "connection": connection,
        "name": name,
        "model": camera.get("model") or None,
        "device": info,
        "availability": _availability(users, (check or {}).get("availability_method"), camera.get("availability")),
        "support": _verdict(modes, reason),
        "modes_source": "unavailable" if not modes else "previous-scan" if retained else "live",
        "formats": formats,
        "default_selection": _default(formats),
        "notes": notes,
        "errors": errors,
    }


def _mipi_notes(camera: dict, modes: list) -> list:
    if not modes:
        return []
    notes = []
    max_fps = camera.get("max_fps")
    if isinstance(max_fps, (int, float)) and not isinstance(max_fps, bool) and max_fps > 0:
        notes.append(
            f"The sensor's timing gives {max_fps:g} fps for its current mode, so that rate is offered. "
            "libcamera delivers the sensor's rate whatever rate is requested."
        )
    elif any(not mode.get("frame_intervals") for mode in modes):
        rate = _fps(CAMERAINPUT_RATE.numerator, CAMERAINPUT_RATE.denominator)
        notes.append(
            f"The camera reports no frame rates, so only CameraInput's default {rate} fps is offered for those modes."
        )
    sizes = sorted({(mode["width"], mode["height"]) for mode in modes if mode.get("isp_output") and "width" in mode})
    if sizes:
        offered = ", ".join(f"{w}x{h}" for w, h in sizes)
        notes.append(
            f"Only sizes the ISP can output ({offered}) are offered; libcamera also advertises sizes the ISP "
            "cannot produce, which fail to start (core#883)."
        )
    return notes


def _verdict(modes: list, reason: str) -> dict:
    """A camera or format is Available when any of its modes is; `reason` is why none of the camera's can be."""
    if any(mode["available"] for mode in modes):
        return _support("available", "")
    if reason or not modes:
        return _support("unsupported", reason or NO_MODES_REASON)
    # The sensor is supported: either the ISP outputs none of these sizes, or none it outputs is in NV12.
    isp_sizes = any(mode.get("isp_output") is True for mode in modes)
    return _support("unsupported", FORMAT_REASON if isp_sizes else NO_ISP_SIZE_REASON)


def _interval_rates(entry: dict) -> list:
    """Frame rates from one Sentinel `frame_intervals` entry (periods, as V4L2 reports them)."""
    rates = []
    for interval in entry.get("intervals") or []:
        if not isinstance(interval, dict):
            continue
        if interval.get("type") == "discrete":
            num, den = interval.get("numerator"), interval.get("denominator")
            if isinstance(num, int) and isinstance(den, int) and num > 0 and den > 0:
                rates.append(Fraction(den, num))
            continue
        low, high = interval.get("maximum") or {}, interval.get("minimum") or {}
        try:
            slowest, fastest = low["denominator"] / low["numerator"], high["denominator"] / high["numerator"]
            step = (
                interval["step"]["numerator"] / interval["step"]["denominator"]
                if interval.get("type") == "stepwise"
                else None
            )
        except (KeyError, TypeError, ZeroDivisionError):
            continue
        rates += [
            Fraction(fps)
            for fps in STANDARD_FPS
            if slowest - 1e-3 <= fps <= fastest + 1e-3
            and (step is None or _on_step(1 / fps, 1 / fastest, step))
        ]
    return rates


def _on_step(period: float, first: float, step: float) -> bool:
    """Return whether period is first + k * step, allowing for driver unit rounding."""
    k = round((period - first) / step)
    return abs(first + k * step - period) <= period * 1e-3


def _sensor_rate(camera: dict) -> Fraction:
    """The rate to offer for a MIPI mode that reports none: the sensor's rate from its timing (Sentinel's
    `max_fps`), which is what libcamera delivers whatever rate is requested; CameraInput's default without it."""
    max_fps = camera.get("max_fps")
    if isinstance(max_fps, (int, float)) and not isinstance(max_fps, bool) and math.isfinite(max_fps) and max_fps > 0:
        return Fraction(max_fps).limit_denominator(100)
    return CAMERAINPUT_RATE


def _choices(modes: list, usb: bool, fallback: Fraction = CAMERAINPUT_RATE) -> list:
    """The frame rates of one format and size, each with its mode's state. A MIPI mode that reports no rate
    offers `fallback` (_sensor_rate); a USB mode offers only the rates it advertises."""
    choices = {}
    for mode in modes:
        rates = [
            rate
            for entry in mode.get("frame_intervals") or []
            if (entry.get("width"), entry.get("height")) == (mode.get("width"), mode.get("height"))
            for rate in _interval_rates(entry)
        ] or ([] if usb else [fallback])
        state = {"tier": "available"} if mode["available"] else {"tier": "unsupported", "reason": mode["reason"]}
        for rate in rates:
            value = _fps(rate.numerator, rate.denominator)
            if value not in choices or mode["available"]:
                choices[value] = _choice(rate, **state)
    return [choices[value] for value in sorted(choices, reverse=True)]


def _formats(modes: list, usb: bool, reason: str, fallback: Fraction = CAMERAINPUT_RATE) -> list:
    grouped = {}
    for mode in modes:
        grouped.setdefault(mode["format"], []).append(mode)
    formats = []
    for name, entries in grouped.items():
        sizes = {}
        for mode in entries:
            if "width" in mode:
                sizes.setdefault((mode["width"], mode["height"]), []).append(mode)
        ranged = next((mode["size_range"] for mode in entries if "size_range" in mode), None)
        description = next((mode["format_description"] for mode in entries if mode.get("format_description")), None)
        formats.append({
            "format": name,
            # A USB driver names its own formats.
            "label": f"{name} ({description})" if usb and description else FORMAT_LABELS.get(name, name),
            "exportable": any(mode["available"] for mode in entries),
            "support": _verdict(entries, reason),
            "range": {key: ranged[key] for key in ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")}
            if ranged else None,
            "sizes": [{"width": w, "height": h, "fps": _choices(group, usb, fallback)} for (w, h), group in sizes.items()],
        })
    return formats


def _default(formats: list) -> Optional[dict]:
    """The first Available mode; None when no mode is Available."""
    for fmt in formats:
        if not fmt["exportable"]:
            continue
        for size in fmt["sizes"]:
            for choice in size["fps"]:
                if choice["tier"] == "available":
                    return _selection(fmt["format"], size, choice["value"])
    return None


def _issues(catalog: dict, check: Optional[dict], items: list) -> list:
    issues = []
    listed = {provider_of(device) for device in catalog["devices"]}
    for error in catalog["errors"]:
        if error["provider"] == "board":
            message = f"SiMa Sentinel could not read part of the board's camera setup: {error['reason']}"
        else:
            message = f"SiMa Sentinel's {error['provider']} provider failed: {error['reason']}"
        if error["provider"] in listed:
            message += " The devices it found last time are still listed."
        issues.append(_issue("warning", error["code"], message, STATUS_HINT))
    if not items:
        return issues
    if check is None:
        issues.append(_issue(
            "warning",
            "availability_limited",
            "Insight could not check which processes hold the cameras, so camera availability is unknown.",
            "Check that python3 (3.8 or newer) runs on the board, then Refresh.",
        ))
        return issues
    mipi = any(item["connection"] == "mipi" for item in items)
    tools = check.get("tools") or {}
    issues += [
        _issue("warning", "tool_missing", *TOOL_ISSUES[tool]) for tool in TOOL_ISSUES if mipi and not tools.get(tool)
    ]
    if check.get("availability_method") in AVAILABILITY_ISSUES:
        severity, message, hint = AVAILABILITY_ISSUES[check["availability_method"]]
        issues.append(_issue(severity, "availability_limited", message, hint))
    for failure in check.get("failures") or []:
        tool = failure.get("tool")
        hint = f"Refresh again; if it keeps failing, run `{tool}` on the board to see the full error."
        if failure.get("reason") == "timeout":
            code, message = "timeout", f"`{tool}` timed out on the board."
        else:
            code, message = "command_failed", f"`{tool}` failed: {failure.get('detail') or 'no output'}"
        issues.append(_issue("warning", code, message, hint))
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

    def record(self, generation: int, board: dict, catalog: dict, check: Optional[dict], scan_ms: int) -> dict:
        with self._lock:
            previous = self._entry
        if previous and (previous["generation"], previous["fingerprint"]) != (generation, board.get("fingerprint")):
            previous = None
        snapshot = build_snapshot(catalog, check, board, generation, previous and previous["snapshot"], scan_ms)
        with self._lock:
            if self._entry is None or self._entry["generation"] <= generation:
                self._entry = {
                    "generation": generation,
                    "fingerprint": board.get("fingerprint"),
                    "snapshot": snapshot,
                    "completed": time.monotonic(),
                }
            self._refresh_locks = {g: lock for g, lock in self._refresh_locks.items() if g >= generation}
        return snapshot
