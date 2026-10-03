"""Turn SiMa Sentinel's peripheral catalog into the Peripherals camera snapshot."""
import math
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from fractions import Fraction
from typing import Optional

STANDARD_FPS = (60, 30, 25, 20, 15, 10, 5)


def _link(repo: str, number: int) -> dict:
    return {"label": f"{repo}#{number}", "url": f"https://github.com/sima-neat/{repo}/issues/{number}"}


CORE_838 = _link("core", 838)
CORE_883 = _link("core", 883)
CORE_903 = _link("core", 903)
INTERNALS_244 = _link("internals", 244)

VERIFIED_REASON = "Neat Core's support rules accept these modes for CameraInput; the rest are not usable."
NO_MODES_REASON = "SiMa Sentinel reported no modes for this camera."
USB_TRACKED = "USB support is tracked in core#838."
USB_FORMAT_NOTES = {
    "MJPG": (
        "MJPG chroma subsampling cannot be read without decoding; "
        "4:2:2 MJPEG stalls neatdecoder without an error (core#903).",
        CORE_903,
    ),
    "YUYV": ("There is no YUYV to NV12 conversion on the CVU (internals#244).", INTERNALS_244),
}
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
SUPPORT_ISSUES = {
    "not_installed": (
        "warning",
        "Neat Core's camera support rules are not installed on the board, so SiMa Sentinel marks every camera mode "
        "as not usable.",
        "Install Neat Core on the board (`sima-cli neat install core`), then Refresh.",
    ),
    "invalid": (
        "warning",
        "Neat Core's camera support rules on the board cannot be read, so SiMa Sentinel marks every camera mode "
        "as not usable.",
        "Reinstall Neat Core on the board (`sima-cli neat install core`), then Refresh.",
    ),
    "stale": (
        "warning",
        "Neat Core's camera support rules on the board were updated with a file SiMa Sentinel cannot read; the "
        "previous rules still apply.",
        "Reinstall Neat Core on the board, or update SiMa Sentinel with `sima-cli neat install sentinel`, then Refresh.",
    ),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _support(tier: str, reason: str, links: tuple = ()) -> dict:
    return {"tier": tier, "reason": reason, "links": list(links)}


def _issue(severity: str, code: str, message: str, hint: str) -> dict:
    return {"severity": severity, "code": code, "message": message, "hint": hint}


def _error(code: str, message: str, hint: str) -> dict:
    return {"code": code, "message": message, "hint": hint}


def _selection(fmt: str, size: dict, fps) -> dict:
    return {"format": fmt, "width": size["width"], "height": size["height"], "fps": fps}


def _fps(num: int, den: int):
    value = Fraction(num, den)
    return int(value) if value.denominator == 1 else round(float(value), 3)


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


def camera_nodes(device: dict) -> list:
    """The device nodes whose holders tell whether the camera is in use."""
    camera = device["camera"]
    if camera.get("backend") == "mipi":
        node = camera.get("media_device")
    else:
        node = camera.get("device_path")
    return [node] if isinstance(node, str) and node.startswith("/dev/") else []


def cameras_of(catalog: dict) -> list:
    return [device for device in catalog["devices"] if device["type"] == "camera"]


def build_snapshot(catalog: dict, check: Optional[dict], board: dict, generation: int, previous: Optional[dict], scan_ms: int):
    """Return the snapshot; `check` is the board_check output, or None when it could not run."""
    retained = {issue["provider"] for issue in catalog.get("issues", []) if issue["retained_last_good"]}
    platform = {
        "tools": (check or {}).get("tools") or {},
        "availability_method": (check or {}).get("availability_method") or "none",
    }
    items = [_item(device, check, device["provider"] in retained) for device in cameras_of(catalog)]
    return {
        "board": board,
        "generation": generation,
        "scanned_at": now_iso(),
        "scan_ms": scan_ms,
        "platform": platform,
        "items": items,
        "issues": _issues(catalog, check, items),
        "changes": _changes(previous["items"], items) if previous else None,
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
    if camera.get("backend") == "mipi":
        return "mipi"
    return camera.get("connection") or camera.get("backend") or "unknown"


def _speed_mbps(speed):
    """The USB link speed sysfs reports in Mb/s ("1.5", "480", "5000"), as a number; None when unreadable."""
    try:
        value = float(speed)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(value) and value > 0):
        return None
    return int(value) if value.is_integer() else value


def _rate_label(values: list) -> str:
    return ", ".join(f"{value:g}" for value in sorted(values, reverse=True))


def _item(device: dict, check: Optional[dict], retained: bool) -> dict:
    camera = device["camera"]
    connection = _connection(camera)
    modes = camera.get("modes") or []
    usb = connection == "usb"
    formats = _formats(modes, usb)
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
        name = camera.get("model") or camera.get("device_path") or device["id"]
        default = _usb_default(formats)
    else:
        info = {"camera_name": camera.get("camera_name")}
        if camera.get("camera_name"):
            info["camera_name_source"] = NAME_SOURCE
        for key, source in (("media_device", "media_device"), ("bus_info", "bus_info"), ("csi", "csi_receiver")):
            if camera.get(source):
                info[key] = camera[source]
        name = camera.get("camera_name") or device["id"]
        default = _default(formats)
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
            f"Modes are from SiMa Sentinel's last successful scan; its {device['provider']} provider failed "
            "during this refresh."
        )
    users = (check or {}).get("users", {}).get(device["id"])
    return {
        "id": device["id"],
        "kind": "camera",
        "connection": connection,
        "name": name,
        "model": camera.get("model") or None,
        "device": info,
        "availability": _availability(users, (check or {}).get("availability_method"), camera.get("availability")),
        "support": _camera_support(modes, usb),
        "modes_source": "unavailable" if not modes else "previous-scan" if retained else "live",
        "formats": formats,
        "default_selection": default,
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
            f"The sensor reports {max_fps:g} fps for its fastest mode. The delivered frame "
            "rate follows the sensor mode libcamera picks and can differ from the requested rate."
        )
    else:
        nominal = {_fps(m["framerate_num"], m["framerate_den"]) for m in modes if m.get("framerate_source") == "nominal"}
        if nominal:
            rates = _rate_label(nominal)
            notes.append(f"The sensor did not report a maximum frame rate, so only {rates} fps is offered.")
    sizes = sorted({(mode["width"], mode["height"]) for mode in modes if mode.get("isp_output") and "width" in mode})
    if sizes:
        offered = ", ".join(f"{w}x{h}" for w, h in sizes)
        notes.append(
            f"Only sizes the ISP can output ({offered}) are offered; libcamera also advertises sizes the ISP "
            "cannot produce, which fail to start (core#883)."
        )
    return notes


def _common_reason(modes: list) -> str:
    reasons = [mode["reason"] for mode in modes if not mode["supported"] and mode["reason"]]
    return Counter(reasons).most_common(1)[0][0] if reasons else ""


def _camera_support(modes: list, usb: bool) -> dict:
    if any(mode["supported"] for mode in modes):
        return _support("verified", VERIFIED_REASON, () if usb else (CORE_883,))
    reason = _common_reason(modes) or NO_MODES_REASON
    return _support("unsupported", f"{reason} {USB_TRACKED}", (CORE_838,)) if usb else _support("unsupported", reason)


def _format_support(name: str, entries: list, usb: bool) -> dict:
    if any(mode["supported"] for mode in entries):
        return _support("verified", VERIFIED_REASON, () if usb else (CORE_883,))
    reason = _common_reason(entries)
    if not usb:
        return _support("unsupported", reason)
    note, link = USB_FORMAT_NOTES.get(name, (None, None))
    text = " ".join(part for part in (reason, USB_TRACKED, note) if part)
    return _support("unsupported", text, (CORE_838, link) if link else (CORE_838,))


def _interval_rates(entry: dict) -> list:
    """Frame rates from one Sentinel `frame_intervals` entry (periods, as V4L2 reports them)."""
    rates = []
    for interval in entry.get("intervals") or []:
        if not isinstance(interval, dict):
            continue
        if interval.get("type") == "discrete":
            num, den = interval.get("numerator"), interval.get("denominator")
            if isinstance(num, int) and isinstance(den, int) and num > 0 and den > 0:
                rates.append(_fps(den, num))
            continue
        low, high = interval.get("maximum") or {}, interval.get("minimum") or {}
        try:
            slowest, fastest = low["denominator"] / low["numerator"], high["denominator"] / high["numerator"]
        except (KeyError, TypeError, ZeroDivisionError):
            continue
        rates += [fps for fps in STANDARD_FPS if slowest - 1e-3 <= fps <= fastest + 1e-3]
    return rates


def _choices(modes: list) -> list:
    """The frame rates of one format and size: each Sentinel mode's rate carries its verdict; the other
    rates the device advertises have none, so they share an unsupported verdict and are unknown otherwise."""
    choices = {}
    for mode in modes:
        value = _fps(mode["framerate_num"], mode["framerate_den"])
        if mode["supported"]:
            choices[value] = {"value": value, "tier": "verified"}
        elif choices.get(value, {}).get("tier") != "verified":
            choices[value] = {"value": value, "tier": "unsupported", "reason": mode["reason"] or _common_reason(modes)}
    supported = any(mode["supported"] for mode in modes)
    extra = {"tier": ""} if supported else {"tier": "unsupported", "reason": _common_reason(modes)}
    for mode in modes:
        for entry in mode.get("frame_intervals") or []:
            if (entry.get("width"), entry.get("height")) == (mode.get("width"), mode.get("height")):
                for value in _interval_rates(entry):
                    choices.setdefault(value, {"value": value, **extra})
    return [choices[value] for value in sorted(choices, reverse=True)]


def _formats(modes: list, usb: bool) -> list:
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
        supported = any(mode["supported"] for mode in entries)
        description = next((mode["format_description"] for mode in entries if mode.get("format_description")), None)
        formats.append({
            "format": name,
            # A USB driver names its own formats.
            "label": f"{name} ({description})" if usb and description else FORMAT_LABELS.get(name, name),
            # A USB format exports as a V4L2 descriptor, not CameraInput code, so it is exportable regardless.
            "exportable": usb or supported,
            "support": _format_support(name, entries, usb),
            "range": {key: ranged[key] for key in ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")}
            if ranged else None,
            "sizes": [{"width": w, "height": h, "fps": _choices(group)} for (w, h), group in sizes.items()],
        })
    return formats


def _default(formats: list) -> Optional[dict]:
    for fmt in formats:
        if not fmt["exportable"]:
            continue
        for size in fmt["sizes"]:
            for choice in size["fps"]:
                if choice["tier"] == "verified":
                    return _selection(fmt["format"], size, choice["value"])
    return None


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


def _issues(catalog: dict, check: Optional[dict], items: list) -> list:
    issues = []
    error = catalog.get("error")
    if isinstance(error, dict):
        message = str(error.get("reason") or error.get("code") or "SiMa Sentinel reported a problem.")
        issues.append(_issue("warning", "sentinel_degraded", f"SiMa Sentinel: {message}", STATUS_HINT))
    for issue in catalog.get("issues", []):
        message = f"SiMa Sentinel's {issue['provider']} provider failed: {issue['reason']}"
        if issue["retained_last_good"]:
            message += " The devices it found last time are still listed."
        issues.append(_issue("warning", issue["code"], message, STATUS_HINT))
    support = catalog.get("support")
    if isinstance(support, dict) and support.get("state") in SUPPORT_ISSUES:
        issues.append(_issue(SUPPORT_ISSUES[support["state"]][0], "support_rules", *SUPPORT_ISSUES[support["state"]][1:]))
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
