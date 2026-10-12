"""Turn SiMa Sentinel's peripheral catalog into the Peripherals camera snapshot."""
import math
from collections import Counter
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
# On a board whose ISP takes the sensor's sizes at run time (Platform 3.0), the ISP's RAW-input DMA needs a
# 32-byte line stride, so the sensor mode libcamera's Modalix pipeline picks must be 64 pixels wide at
# 12-bit RAW (128 at 10-bit, 32 at 8-bit): isp.ko rounds a 4056-wide RAW12 try-format to 4032, and the
# imx477 driver ships a 4032x3040 crop mode for that reason. libcamera still advertises the IMX477's
# 4056-wide sizes and silently serves them at 4032 wide (observed on 3.0.0_develop_B1859). Smaller sizes
# are served from a larger aligned sensor mode, so for the IMX477 the usable widths are those up to its
# widest aligned 12-bit mode, 4032. Sentinel reports the sensor's sizes as the kernel lists them. The limit
# is a property of each sensor's modes, so it is listed per sensor (Sentinel's MIPI `model`, the kernel's
# sensor name); a sensor not listed keeps Sentinel's verdict.
SENSOR_MAX_WIDTH = {"imx477": 4032}
MAX_WIDTH_REASON = "libcamera streams this camera at most {width} pixels wide on this board."
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
        "camera_setup": None,
    }


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


def _classified(mode: dict, camera_reason: str, max_width: Optional[int] = None) -> dict:
    """A Sentinel mode with its state: `available` True or False, and why it is not (`reason`). A Sentinel that
    decides this itself (sentinel#43, the same rule, and the only one that knows a Platform 3.0 sensor size) says so
    on the mode; older ones leave it to the rule below."""
    if isinstance(mode.get("available"), bool):
        reason = "" if mode["available"] else str(mode.get("reason") or camera_reason or NOT_ISP_SIZE_REASON)
        if not reason and max_width and mode.get("sensor_mode") is True and (mode.get("width") or 0) > max_width:
            reason = MAX_WIDTH_REASON.format(width=max_width)
        return dict(mode, available=not reason, reason=reason)
    if camera_reason:
        return dict(mode, available=False, reason=camera_reason)
    if mode.get("isp_output") is not True:
        return dict(mode, available=False, reason=NOT_ISP_SIZE_REASON)
    if mode["format"] != CAMERAINPUT_FORMAT:
        return dict(mode, available=False, reason=FORMAT_REASON)
    return dict(mode, available=True, reason="")


def build_snapshot(catalog: dict, board: dict, generation: int, previous: Optional[dict], scan_ms: int):
    """Return the snapshot built from Sentinel's catalog."""
    # microphones.py reuses this module's helpers, so it is imported here, not at the top.
    from neat_insight.peripherals.microphones import microphone_items

    # A failed provider's devices from its last successful scan stay in the catalog.
    retained = {error["provider"] for error in catalog["errors"]}
    cameras = []
    for device in cameras_of(catalog):
        reason = _camera_reason(device, catalog.get("board"))
        max_width = SENSOR_MAX_WIDTH.get(str(device.get("model") or "").lower()) if device.get("backend") == "mipi" else None
        modes = [_classified(mode, reason, max_width) for mode in device.get("modes") or []]
        cameras.append(_item(device, modes, reason, provider_of(device) in retained))
    items = cameras + microphone_items(catalog, cameras, retained)
    return {
        "board": board,
        "generation": generation,
        "scan_id": f"{catalog['revision']}:{catalog['observed_at']}",
        "scanned_at": now_iso(),
        "scan_ms": scan_ms,
        "items": items,
        "issues": _issues(catalog, items),
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


def _availability(reported: Optional[dict]) -> dict:
    """Sentinel's own availability fact, passed through. Sentinel never opens a stream, so for cameras it is
    always `unknown` with a reason; Insight does not inspect the board's processes for this. Whether a camera is
    busy is found out, and reported, when a preview tries to open it."""
    state = (reported or {}).get("state")
    if state not in ("available", "in_use", "unknown"):
        state = "unknown"
    return {"state": state, "users": [], "reason": (reported or {}).get("reason") or None}


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


def _item(camera: dict, modes: list, reason: str, retained: bool) -> dict:
    """`modes` are the camera's classified modes (_classified); `reason` is why none can be Available, if any."""
    connection = _connection(camera)
    usb = connection == "usb"
    # A Sentinel that gives each mode a verdict (sentinel#43) also gives the reasons a camera is unusable.
    decided = any(isinstance(mode.get("available"), bool) for mode in camera.get("modes") or [])
    formats = _formats(modes, usb, reason, decided)
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
    return {
        "id": camera["id"],
        "kind": "camera",
        "connection": connection,
        "name": name,
        "model": camera.get("model") or None,
        "device": info,
        "availability": _availability(camera.get("availability")),
        "support": _verdict(modes, reason, decided),
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
    sizes = sorted({(mode["width"], mode["height"]) for mode in modes if mode.get("isp_output") and "width" in mode})
    if sizes:
        offered = ", ".join(f"{w}x{h}" for w, h in sizes)
        notes.append(
            f"Only sizes the ISP can output ({offered}) are offered; libcamera also advertises sizes the ISP "
            "cannot produce, which fail to start (core#883)."
        )
    return notes


def _verdict(modes: list, reason: str, decided: bool = False) -> dict:
    """A camera or format is Available when any of its modes is; `reason` is why none of the camera's can be.

    When Sentinel decided each mode (`decided`), the reason is the one it gave most often for the NV12 modes
    (CameraInput's format), else for all modes, rather than one Insight infers."""
    if any(mode["available"] for mode in modes):
        return _support("available", "")
    if reason or not modes:
        return _support("unsupported", reason or NO_MODES_REASON)
    if decided:
        wanted = [mode for mode in modes if mode["format"] == CAMERAINPUT_FORMAT] or modes
        given = Counter(mode["reason"] for mode in wanted if mode.get("reason"))
        if given:
            return _support("unsupported", given.most_common(1)[0][0])
    # The sensor is supported: either the ISP outputs none of these sizes, or none it outputs is in NV12. On a
    # Platform 3.0 ISP the sizes are the sensor's (`sensor_mode`).
    isp_sizes = any(mode.get("isp_output") is True or mode.get("sensor_mode") is True for mode in modes)
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


def _choices(modes: list, usb: bool) -> list:
    """The frame rates of one format and size, each with its mode's state. A MIPI mode that reports no rate
    offers CameraInput's default rate; a USB mode offers only the rates it advertises."""
    choices = {}
    for mode in modes:
        rates = [
            rate
            for entry in mode.get("frame_intervals") or []
            if (entry.get("width"), entry.get("height")) == (mode.get("width"), mode.get("height"))
            for rate in _interval_rates(entry)
        ] or ([] if usb else [CAMERAINPUT_RATE])
        state = {"tier": "available"} if mode["available"] else {"tier": "unsupported", "reason": mode["reason"]}
        for rate in rates:
            value = _fps(rate.numerator, rate.denominator)
            if value not in choices or mode["available"]:
                choices[value] = _choice(rate, **state)
    return [choices[value] for value in sorted(choices, reverse=True)]


def _formats(modes: list, usb: bool, reason: str, decided: bool = False) -> list:
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
            "support": _verdict(entries, reason, decided),
            "range": {key: ranged[key] for key in ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")}
            if ranged else None,
            "sizes": [{"width": w, "height": h, "fps": _choices(group, usb)} for (w, h), group in sizes.items()],
        })
    return formats


DEFAULT_WIDTH = 1920


def _default(formats: list) -> Optional[dict]:
    """The mode to preselect: 1920 wide when a size that wide is Available, else the widest Available size
    narrower than that, else the smallest Available one; None when no mode is Available. A 3.0 sensor lists
    sizes from 1280 wide up, and starting a developer at the smallest is not a useful default."""
    candidates = []
    for fmt in formats:
        if not fmt["exportable"]:
            continue
        for size in fmt["sizes"]:
            for choice in size["fps"]:
                if choice["tier"] == "available":
                    candidates.append((fmt["format"], size, choice["value"]))
                    break
    if not candidates:
        return None
    preferred = [c for c in candidates if c[1]["width"] <= DEFAULT_WIDTH]
    fmt, size, fps = max(preferred, key=lambda c: (c[1]["width"], c[1]["height"])) if preferred \
        else min(candidates, key=lambda c: (c[1]["width"], c[1]["height"]))
    return _selection(fmt, size, fps)


def _issues(catalog: dict, items: list) -> list:
    issues = []
    listed = {provider_of(device) for device in catalog["devices"]}
    for error in catalog["errors"]:
        # Sentinel names a board-block error's provider after the field it could not read (`board.<field>`).
        board_field = error["provider"] == "board" or error["provider"].startswith("board.")
        if board_field and error["code"] == "platform.unsupported":
            # The firmware predates MIPI camera support (provider `board.firmware`); Sentinel's reason says which.
            message = f"SiMa Sentinel: {error['reason']}"
        elif board_field:
            message = f"SiMa Sentinel could not read part of the board's camera setup: {error['reason']}"
        else:
            message = f"SiMa Sentinel's {error['provider']} provider failed: {error['reason']}"
        if error["provider"] in listed:
            message += " The devices it found last time are still listed."
        issues.append(_issue("warning", error["code"], message, STATUS_HINT))
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

    def scan(self, generation: int) -> tuple:
        """The last scan of this board as (snapshot, catalog revision), read together; (None, None) without one.

        One read keeps a refresh that lands in between from pairing one scan's snapshot with another's revision.
        """
        with self._lock:
            entry = self._entry
        return (entry["snapshot"], entry["catalog"]) if entry and entry["generation"] == generation else (None, None)

    def completed_since(self, generation: int, since: float) -> Optional[dict]:
        """The snapshot of a refresh that finished after `since` (monotonic), i.e. one that was in flight."""
        with self._lock:
            entry = self._entry
        if entry and entry["generation"] == generation and entry["completed"] >= since:
            return entry["snapshot"]
        return None

    def record(self, generation: int, board: dict, catalog: dict, scan_ms: int) -> dict:
        with self._lock:
            previous = self._entry
        if previous and (previous["generation"], previous["fingerprint"]) != (generation, board.get("fingerprint")):
            previous = None
        snapshot = build_snapshot(catalog, board, generation, previous and previous["snapshot"], scan_ms)
        with self._lock:
            if self._entry is None or self._entry["generation"] <= generation:
                self._entry = {
                    "generation": generation,
                    "fingerprint": board.get("fingerprint"),
                    "snapshot": snapshot,
                    "catalog": {"revision": catalog["revision"]},
                    "completed": time.monotonic(),
                }
            self._refresh_locks = {g: lock for g, lock in self._refresh_locks.items() if g >= generation}
        return snapshot
