"""Turn SiMa Sentinel's ALSA capture devices into Peripherals microphone items.

Neat Core has no audio input node, so a microphone item carries identity, capture
capabilities and availability only: there is nothing to export for it.
"""
from typing import Optional

from neat_insight.peripherals.cameras import _availability

SOUND_SERVER_NAMES = {"pulseaudio": "PulseAudio", "pipewire": "PipeWire", "pipewire-pulse": "PipeWire"}
NO_CAPABILITIES_NOTE = "Capture formats cannot be read without opening the device."
# Sentinel's issue for a device without read-only formats; NO_CAPABILITIES_NOTE already says it.
CAPABILITIES_ISSUE = "peripherals.capabilities_unavailable"
KERNEL_IN_USE_REASON = "The kernel reports the capture device open in another process."


def microphones_of(catalog: dict) -> list:
    return [device for device in catalog["devices"] if device["type"] == "microphone"]


def free_by_kernel(device: dict) -> bool:
    """Every capture substream is free, so nobody holds the device and the process check can be skipped."""
    availability = device["microphone"]["availability"]
    count, free = availability.get("subdevices"), availability.get("subdevices_available")
    return isinstance(count, int) and count > 0 and count == free


def check_nodes(device: dict) -> list:
    """The capture PCM node whose holders the board check looks up; none when the kernel proves it free."""
    node = device["microphone"]["identity"].get("pcm_node")
    return [node] if isinstance(node, str) and node.startswith("/dev/") and not free_by_kernel(device) else []


def microphone_items(catalog: dict, check: Optional[dict], cameras: list, retained: set) -> list:
    servers = sorted({SOUND_SERVER_NAMES.get(name, name) for name in (check or {}).get("sound_servers") or []})
    usb_cameras = {}
    for camera in cameras:
        bus_path = (camera["device"].get("usb") or {}).get("bus_path")
        if camera["connection"] == "usb" and bus_path:
            # Sentinel's camera topology is the USB device's sysfs path; ALSA names the device by its last part.
            usb_cameras[bus_path.rsplit("/", 1)[-1]] = camera
    return [
        _item(device, check, servers, usb_cameras, device["provider"] in retained)
        for device in microphones_of(catalog)
    ]


def _availability_of(mic: dict, users: Optional[list], method: Optional[str]) -> dict:
    counts = mic["availability"]
    count, free = counts.get("subdevices"), counts.get("subdevices_available")
    opened = count - free if isinstance(count, int) and isinstance(free, int) else None
    if not users and opened:
        # The kernel counts open capture substreams for every process, including ones Insight cannot inspect.
        return {"state": "in_use", "users": [], "reason": KERNEL_IN_USE_REASON}
    if not users and opened == 0:
        return {"state": "available", "users": [], "reason": None}
    return _availability(users, method, None)


def _item(device: dict, check: Optional[dict], servers: list, usb_cameras: dict, retained: bool) -> dict:
    mic = device["microphone"]
    identity, target = mic["identity"], mic["capture_target"]
    usb = identity.get("usb")
    card_id = identity.get("card_id") or target.get("card_id") or None
    info = {
        "card_index": identity.get("card_index"),
        "card_id": card_id,
        "card_name": identity.get("card_name"),
        "card_driver": identity.get("card_driver"),
        "pcm_device": target["device"],
        "pcm_node": identity.get("pcm_node"),
    }
    if card_id:
        info["alsa_name"] = f"hw:CARD={card_id},DEV={target['device']}"
    for key in ("by_path", "by_id"):
        if identity.get(key):
            info[key] = identity[key]
    if usb:
        info["usb"] = usb
        camera = usb_cameras.get(usb.get("bus_path"))
        if camera:
            info["part_of"] = {"id": camera["id"], "name": camera["name"]}

    modes = mic["modes"]
    notes = [] if modes else [NO_CAPABILITIES_NOTE]
    notes += [issue["reason"] for issue in mic.get("issues", []) if issue["code"] != CAPABILITIES_ISSUE]
    if retained:
        notes.append(
            f"Details are from SiMa Sentinel's last successful scan; its {device['provider']} provider failed "
            "during this refresh."
        )
    for server in servers:
        notes.append(
            f"{server} is running: applications usually record through it, so this microphone can look free "
            "here while a sound-server client is using it."
        )

    users = (check or {}).get("users", {}).get(device["id"])
    return {
        "id": device["id"],
        "kind": "microphone",
        "connection": "usb" if mic["connection"] == "usb" else "onboard",
        "name": (usb or {}).get("product") or mic["name"],
        "device": info,
        "availability": _availability_of(mic, users, (check or {}).get("availability_method")),
        "capture": [_capture(mode) for mode in modes] if modes else None,
        "notes": notes,
        "errors": [],
    }


def _capture(mode: dict) -> dict:
    span = mode.get("rate_range_hz")
    return {
        "format": mode.get("format"),
        "channels": mode.get("channels"),
        "bits": mode.get("sample_bits"),
        "rates": list(mode.get("rates_hz") or []),
        "rate_range": {"min": span["min"], "max": span["max"]} if span else None,
        "channel_map": mode.get("channel_map"),
    }
