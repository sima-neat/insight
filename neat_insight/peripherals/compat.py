"""Evidence for camera modes validated with Core CameraInput.

Whether a mode is supported comes from SiMa Sentinel's catalog, classified by
Neat Core's rules. This only adds what was measured for a mode, for the export.
Only modes with evidence from Core or Apps belong here. A camera matches on its
sensor model, lowercased.
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


def verified_mode(model: str, fmt: str, width: int, height: int, fps: float) -> Optional[dict]:
    for mode in VERIFIED_MODES:
        if (
            mode["model"] == (model or "").lower()
            and mode["format"] == fmt
            and mode["width"] == width
            and mode["height"] == height
            and abs(mode["fps"] - fps) < 1e-3
        ):
            return mode
    return None
