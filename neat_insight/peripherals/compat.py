from typing import Optional

from neat_insight.peripherals.probe import sensor_model

# Only modes with evidence from Core or Apps belong here.
VERIFIED_MODES = (
    {
        "model": "imx477",
        "format": "NV12",
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "evidence": "captured with CPU fallback allowed on a Modalix DevKit (Neat 0.4.0, 2026-09-22); "
        "also Core tutorial 023_run_mipi_camera_model and the Apps mipi-camera-capture example",
        "delivered_fps": 66,
    },
)


def model_token(camera_id: str, model: Optional[str] = None) -> str:
    return sensor_model(model) or sensor_model(camera_id)


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
