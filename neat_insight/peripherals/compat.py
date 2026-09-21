"""Camera modes validated with Core CameraInput.

Only modes with evidence from Core or Apps belong here. A camera matches on its
model token: the first whitespace-separated token of the libcamera camera id,
lowercased ("imx477 5-001a" -> "imx477").
"""
from typing import Optional

VERIFIED_MODES = (
    {
        "model": "imx477",
        "format": "NV12",
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "evidence": "Core tutorial 023_run_mipi_camera_model and the Apps mipi-camera-capture example",
    },
)


def model_token(camera_id: str) -> str:
    parts = camera_id.split()
    return parts[0].lower() if parts else ""


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
