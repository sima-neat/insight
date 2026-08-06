"""Test harness for sima-mipi-util's HTTP API.

The app reads its auth token at import time, so we must provision a token file
and set the env var BEFORE importing camera_api — hence the module-level setup
below rather than a fixture.
"""
import os
import sys
import pathlib
import importlib.util

import pytest

from _fakes import FakeCompleted, FakePopen, default_run, POPEN_CALLS  # noqa: E402

SRC = pathlib.Path(__file__).resolve().parent.parent / "source"

# A known token, written to a temp file the app will read on import.
TOKEN = "test-token-abc123"
_TOKEN_FILE = pathlib.Path(__file__).resolve().parent / ".test-token"
_TOKEN_FILE.write_text(TOKEN)
os.environ["SIMA_MIPI_UTIL_TOKEN_FILE"] = str(_TOKEN_FILE)
os.environ.pop("SIMA_MIPI_UTIL_ALLOWED_ORIGIN", None)
os.environ.pop("SIMA_MIPI_UTIL_SENSOR_SUBDEV", None)

_spec = importlib.util.spec_from_file_location("camera_api", SRC / "camera_api.py")
camera_api = importlib.util.module_from_spec(_spec)
sys.modules["camera_api"] = camera_api
_spec.loader.exec_module(camera_api)


@pytest.fixture(autouse=True)
def _mock_hw(monkeypatch, tmp_path):
    """Route every subprocess call through the fakes and pin a camera name so
    endpoints never try to discover real hardware."""
    POPEN_CALLS.clear()
    with camera_api._last_control_values_lock:
        camera_api._last_control_values.clear()
    with camera_api._camera_access_lock:
        camera_api._camera_access_owner = None
        camera_api._camera_access_counts.clear()
    camera_api._camera_controls_ready.set()
    monkeypatch.setattr(
        camera_api, "CAMERA_SETTINGS_FILE",
        str(tmp_path / "camera-settings.json"),
    )
    with camera_api._desired_lock:
        camera_api._desired_by_camera.clear()
        camera_api._desired_by_camera.update({"imx477": {}, "imx568": {}})
    monkeypatch.setattr(camera_api.subprocess, "run", default_run)
    monkeypatch.setattr(camera_api.subprocess, "Popen", FakePopen)
    camera_api.state["camera_name"] = "imx477 test"
    yield


@pytest.fixture
def client():
    camera_api.app.config.update(TESTING=True)
    return camera_api.app.test_client()


@pytest.fixture
def token():
    return TOKEN


@pytest.fixture
def api():
    return camera_api
