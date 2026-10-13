"""Turn SiMa Sentinel's ALSA capture devices into Peripherals microphone items.

Neat Core has no audio input node, so a microphone item carries identity, capture
capabilities and SiMa Sentinel's availability fact only: there is nothing to export for it.
"""
import hashlib
import json

from neat_insight.peripherals.cameras import _availability, provider_of

# The fields of Sentinel's record a microphone test binds to: a change in either is another device.
RECORD_KEYS = ("capture_target", "identity")

NO_CAPABILITIES_NOTE = "Capture formats cannot be read without opening the device."
# Sentinel's issue for a device without read-only formats; NO_CAPABILITIES_NOTE already says it.
CAPABILITIES_ISSUE = "peripherals.capabilities_unavailable"
KERNEL_IN_USE_REASON = "The kernel reports the capture device open in another process."


def microphones_of(catalog: dict) -> list:
    return [device for device in catalog["devices"] if device["type"] == "microphone"]


def microphone_items(catalog: dict, cameras: list, retained: set) -> list:
    usb_cameras = {}
    for camera in cameras:
        bus_path = (camera["device"].get("usb") or {}).get("bus_path")
        if camera["connection"] == "usb" and bus_path:
            # Sentinel's camera topology is the USB device's sysfs path; ALSA names the device by its last part.
            usb_cameras[bus_path.rsplit("/", 1)[-1]] = camera
    return [
        _item(device, usb_cameras, provider_of(device) in retained)
        for device in microphones_of(catalog)
    ]


def _item(mic: dict, usb_cameras: dict, retained: bool) -> dict:
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
            f"Details are from SiMa Sentinel's last successful scan; its {provider_of(mic)} provider failed "
            "during this refresh."
        )
    return {
        "id": mic["id"],
        "kind": "microphone",
        "connection": "usb" if mic["connection"] == "usb" else "onboard",
        "name": (usb or {}).get("product") or mic["name"],
        "device": info,
        "availability": _availability(mic.get("availability")),
        "capture": [_capture(mode) for mode in modes] if modes else None,
        "record": record_key(mic),
        "notes": notes,
        "errors": [],
    }


def record_key(mic: dict) -> str:
    """A short fingerprint of the record a microphone test binds to, so the page can tell a replaced device."""
    record = {key: mic.get(key) for key in RECORD_KEYS}
    return hashlib.sha256(json.dumps(record, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


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
