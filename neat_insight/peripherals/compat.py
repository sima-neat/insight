"""Camera modes validated with Core CameraInput.

Only modes with evidence from Core or Apps belong here. A camera matches on its
sensor model token, lowercased (see model_token).
"""
from typing import Optional

VERIFIED_MODES = (
    {
        "model": "imx477",
        "format": "NV12",
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "evidence": "captured with CPU fallback allowed on a Modalix DevKit (Neat 0.4.0, 2026-09-22); "
        "also Core tutorial 023_run_mipi_camera_model and the Apps mipi-camera-capture example",
        # Measured on that DevKit with 15 and 30 fps requested: the sensor mode sets the rate.
        "delivered_fps": 66,
    },
)


def _sensor_name(name: str) -> str:
    # Device-tree path ids end in the sensor node, "<model>@<i2c address>"; entity-name ids are
    # "<model> <bus>-<address>".
    leaf = name.strip().rstrip("/").rsplit("/", 1)[-1]
    parts = leaf.split()
    return parts[0].split("@", 1)[0].lower() if parts else ""


def model_token(camera_id: str, model: Optional[str] = None) -> str:
    """The sensor model: the model `cam -l` reported, else the one read from the libcamera id.

    libcamera names a camera by its sensor entity ("imx477 5-001a") or, when the sensor has a
    firmware node, by its device-tree path ("/base/axi/.../imx477@1a").
    """
    return _sensor_name(model or "") or _sensor_name(camera_id or "")


def has_model(model: str) -> bool:
    return any(mode["model"] == model for mode in VERIFIED_MODES)


def verified_mode(model: str, fmt: str, width: int, height: int, fps: float) -> Optional[dict]:
    for mode in VERIFIED_MODES:
        if (
            mode["model"] == model
            and mode["format"] == fmt
            and mode["width"] == width
            and mode["height"] == height
            and abs(mode["fps"] - fps) < 1e-3
        ):
            return mode
    return None
