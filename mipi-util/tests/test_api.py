"""Host-side smoke tests for the review-flagged behaviours. No camera required.

Covers, in order of the PR review findings:
  * token auth on writes (reads stay open)
  * int() validation returns 400, not 500
  * system reboot disabled (403); service restart allowed and uses systemctl
  * CORS is not wildcard by default; opt-in works
  * sensor-subdevice routing for get/set/detect
"""
from _fakes import FakeCompleted, POPEN_CALLS


# ── Auth ─────────────────────────────────────────────────────────────────────
def test_reads_open_without_token(client):
    assert client.get("/api/status").status_code == 200
    assert client.get("/api/health").status_code == 200


def test_write_without_token_is_401(client):
    r = client.post("/api/set", json={"control": "sdev_digital_gain", "value": 300})
    assert r.status_code == 401


def test_write_with_token_ok(client, token, api, monkeypatch):
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    r = client.post("/api/set", json={"control": "sdev_digital_gain", "value": 300},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 200
    assert r.get_json()["ok"] is True


def test_write_with_bad_token_is_401(client):
    r = client.post("/api/set", json={"control": "sdev_digital_gain", "value": 300},
                    headers={"X-Auth-Token": "wrong"})
    assert r.status_code == 401


def test_controls_poll_retains_last_manual_lock_value_on_read_failure(api, monkeypatch):
    """A failed polling cycle must not make a manual toggle flash off."""
    good = FakeCompleted(
        stdout="en_manual_exposure 0x1 (bool) : default=0 value=1\n"
    )
    failed = FakeCompleted(stderr="Device or resource busy", returncode=1)
    responses = iter((good, FakeCompleted(stdout=""), failed, failed))
    monkeypatch.setattr(api.subprocess, "run", lambda *a, **k: next(responses))

    first = api.v4l2_get_all()
    second = api.v4l2_get_all()

    assert first["en_manual_exposure"] == 1
    assert second["en_manual_exposure"] == 1


def test_controls_endpoint_is_hardware_serialized(api):
    # Prevent polling from observing a lock's internal 0 -> 1 re-arm sequence.
    assert hasattr(api._api_controls_snapshot, "__wrapped__")


def test_camera_change_hides_controls_until_restore(client, token, api, monkeypatch):
    api.state["stream_device"] = "/dev/video0"
    api.state["control_device"] = "/dev/video0out"
    api._camera_controls_ready.set()
    monkeypatch.setattr(api, "_stop_producer", lambda: None)

    r = client.post(
        "/api/device", json={"camera": "/dev/video1"},
        headers={"X-Auth-Token": token},
    )

    assert r.status_code == 200
    assert not api._camera_controls_ready.is_set()


def test_per_camera_settings_survive_reload(api, monkeypatch):
    api.state["stream_device"] = "/dev/video1"
    api._remember("awb_red_gain", 777)
    api.state["stream_device"] = "/dev/video0"
    api._remember("awb_red_gain", 333)

    with api._desired_lock:
        api._desired_by_camera.clear()
    api._load_desired_settings()

    assert set(api._desired_by_camera) == {"imx477", "imx568"}
    assert api._desired_by_camera["imx568"]["awb_red_gain"] == 777
    assert api._desired_by_camera["imx477"]["awb_red_gain"] == 333


# ── int() validation (was HTTP 500) ─────────────────────────────────────────
def test_non_integer_value_is_400(client, token):
    r = client.post("/api/set", json={"control": "sdev_digital_gain", "value": "not-a-number"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 400
    assert "integer" in r.get_json()["error"]


def test_out_of_range_value_is_400(client, token):
    r = client.post("/api/set", json={"control": "sdev_digital_gain", "value": 10_000_000},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 400


def test_set_many_bad_value_is_per_control_error_not_500(client, token):
    r = client.post("/api/set_many",
                    json={"controls": {"sdev_digital_gain": "oops"}},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 200
    assert r.get_json()["results"]["sdev_digital_gain"]["ok"] is False


# ── Reboot removal ───────────────────────────────────────────────────────────
def test_system_reboot_disabled(client, token):
    r = client.post("/api/restart", json={"type": "system"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 403
    # Nothing was launched — definitely not `reboot`.
    assert not any("reboot" in c[0] for c in POPEN_CALLS)


def test_service_restart_uses_systemctl(client, token):
    r = client.post("/api/restart", json={"type": "service"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 200
    assert ["systemctl", "restart", "sima-mipi-util"] in POPEN_CALLS



def test_only_one_browser_can_access_camera(client, api, token, monkeypatch):
    def fake_stream():
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\ntest\r\n"

    monkeypatch.setattr(api, "_libcamera_encoded_stream", fake_stream)
    first = client.get("/api/stream?client_id=browser-a", buffered=False)
    assert first.status_code == 200

    # A reconnect from the owner is allowed, but another browser is locked out.
    reconnect = api.app.test_client().get("/api/stream?client_id=browser-a", buffered=False)
    assert reconnect.status_code == 200
    second = api.app.test_client().get("/api/stream?client_id=browser-b")
    assert second.status_code == 423

    blocked_write = api.app.test_client().post(
        "/api/device", json={"camera": "/dev/video1"},
        headers={"X-Auth-Token": token, "X-Camera-Client": "browser-b"},
    )
    assert blocked_write.status_code == 423

    first.close()
    reconnect.close()

    after_release = api.app.test_client().get("/api/stream?client_id=browser-b", buffered=False)
    assert after_release.status_code == 200
    after_release.close()


# ── CORS ─────────────────────────────────────────────────────────────────────
def test_no_wildcard_cors_by_default(client):
    r = client.get("/api/status")
    assert r.headers.get("Access-Control-Allow-Origin") != "*"
    assert "Access-Control-Allow-Origin" not in r.headers


def test_cors_opt_in(client, api, monkeypatch):
    monkeypatch.setattr(api, "ALLOWED_ORIGIN", "http://example:5000")
    r = client.get("/api/status")
    assert r.headers.get("Access-Control-Allow-Origin") == "http://example:5000"


# ── Regression coverage for review fixes ─────────────────────────────────────
def test_routed_control_fails_closed_without_sensor_subdev(api, monkeypatch):
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: None)
    calls = []
    monkeypatch.setattr(api, "v4l2_set", lambda *a, **k: calls.append((a, k)))
    assert api._v4l2_set_routed("sdev_digital_gain", 300) == (False, "sensor subdevice unavailable")
    assert api._v4l2_get_routed("sdev_digital_gain") is None
    assert calls == []

def test_set_many_rejects_non_object_controls(client, token):
    for controls in (None, []):
        r = client.post("/api/set_many", json={"controls": controls},
                        headers={"X-Auth-Token": token})
        assert r.status_code == 400
        assert "object" in r.get_json()["error"]

def test_write_endpoints_reject_non_object_json(client, token):
    headers = {"X-Auth-Token": token}
    for endpoint in ("/api/set", "/api/set_many", "/api/device",
                     "/api/settings", "/api/restart"):
        r = client.post(endpoint, json=[], headers=headers)
        assert r.status_code == 400
        assert "object" in r.get_json()["error"]

def test_camera_change_invalidates_capability_cache(client, token, api, monkeypatch):
    api.state["stream_device"] = "/dev/video0"
    api.state["control_device"] = "/dev/video0out"
    api._capability_cache = {"old-camera": {"supported": True}}
    monkeypatch.setattr(api, "_stop_producer", lambda: None)
    r = client.post("/api/device", json={"camera": "/dev/video1"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 200
    assert api._capability_cache == {}


def test_stale_camera_write_is_rejected(client, token, api):
    api.state["stream_device"] = "/dev/video1"
    r = client.post(
        "/api/set",
        json={
            "camera": "/dev/video0",
            "control": "system_saturation_target",
            "value": 128,
        },
        headers={"X-Auth-Token": token},
    )
    assert r.status_code == 409
    assert r.get_json()["selected_camera"] == "/dev/video1"


def test_matching_camera_write_is_allowed(client, token, api):
    api.state["stream_device"] = "/dev/video0"
    r = client.post(
        "/api/set",
        json={
            "camera": "/dev/video0",
            "control": "system_saturation_target",
            "value": 128,
        },
        headers={"X-Auth-Token": token},
    )
    assert r.status_code == 200


def test_camera_switch_uses_hardware_serialization(api):
    assert hasattr(api.api_set_device, "__wrapped__")


# ── Sensor-subdevice routing (the 3 Codex findings) ─────────────────────────────────────────────────
# Routing now resolves the subdev dynamically via get_sensor_subdev() rather
# than a fixed SENSOR_SUBDEV global (imx477 and imx568 sit on different nodes),
# so these pin it to a known path and assert writes/reads land there.
def test_set_routed_targets_subdev(api, monkeypatch):
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    calls = []
    monkeypatch.setattr(api.subprocess, "run",
                        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(returncode=0))
    api._v4l2_set_routed("sdev_digital_gain", 300)
    assert any("/dev/v4l-subdev2" in c and "digital_gain=300" in " ".join(c) for c in calls)


def test_get_routed_targets_subdev(api, monkeypatch):
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    calls = []
    monkeypatch.setattr(api.subprocess, "run",
                        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(stdout="digital_gain: 512\n"))
    val = api._v4l2_get_routed("sdev_digital_gain")
    assert val == 512
    assert any("/dev/v4l-subdev2" in c and "digital_gain" in c for c in calls)


def test_current_exposure_stays_on_isp_control_device(api, monkeypatch):
    # current_exposure is the ISP master register on the control device, NOT the
    # sensor subdev — verified on imx477 that writing the sensor exposure
    # register has no visible effect, so it must not be routed there.
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    calls = []
    monkeypatch.setattr(
        api.subprocess, "run",
        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(returncode=0),
    )
    assert api._v4l2_set_routed("current_exposure", 1200)[0] is True
    # Written to the default ISP control device, never the sensor subdevice.
    assert all("/dev/v4l-subdev2" not in call for call in calls)
    assert any("current_exposure=1200" in " ".join(call) for call in calls)


def test_gain_routes_to_sensor_on_imx477(api, monkeypatch):
    # imx477: gain uses the sensor subdevice registers (the working path).
    monkeypatch.setattr(api, "get_current_camera_name", lambda: "imx477 6-001a")
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    calls = []
    monkeypatch.setattr(
        api.subprocess, "run",
        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(returncode=0),
    )
    assert api._v4l2_set_routed("sensor_analog_gain", 100)[0] is True
    assert api._v4l2_set_routed("sdev_digital_gain", 300)[0] is True
    joined = [" ".join(c) for c in calls]
    assert any("/dev/v4l-subdev2" in c and "analogue_gain=100" in c for c in joined)
    assert any("/dev/v4l-subdev2" in c and "digital_gain=300" in c for c in joined)


def test_gain_routes_to_isp_on_imx568(api, monkeypatch):
    # imx568: gain reads/writes the ISP register on the control device, NOT the
    # sensor subdev (the sensor gain register holds but the ISP overrides it).
    monkeypatch.setattr(api, "get_current_camera_name", lambda: "imx568 5-0042")
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev6")
    calls = []
    monkeypatch.setattr(
        api.subprocess, "run",
        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(returncode=0),
    )
    assert api._v4l2_set_routed("sensor_analog_gain", 100)[0] is True
    assert api._v4l2_set_routed("sdev_digital_gain", 40)[0] is True
    joined = [" ".join(c) for c in calls]
    assert all("/dev/v4l-subdev6" not in c for c in joined)
    assert any("sensor_analog_gain=100" in c for c in joined)
    assert any("sensor_digital_gain=40" in c for c in joined)


def test_sensor_analog_gain_uses_sensor_range(api, monkeypatch):
    api._hw_ranges["sensor_analog_gain"] = {"min": 0, "max": 978}
    monkeypatch.setattr(api, "get_current_camera_name", lambda: "imx477 6-001a")
    assert api.effective_range("sensor_analog_gain") == (0, 978)


def test_awb_cct_uses_verified_operating_range(api):
    api._hw_ranges["system_awb_cct"] = {"min": 0, "max": 65535}
    assert api.effective_range("system_awb_cct") == (2000, 10000)


def test_current_exposure_capped_by_camera_override(api, monkeypatch):
    # current_exposure is the ISP register whose declared max is a bogus 2^31;
    # the per-camera override caps it below the firmware overflow (~2^30). The
    # override is matched on sensor MODEL, so it applies to this board's
    # "imx477 6-001a" even though the registry key is "imx477 5-001a".
    api._hw_ranges["current_exposure"] = {"min": 0, "max": 2147483647}
    monkeypatch.setattr(api, "get_current_camera_name", lambda: "imx477 6-001a")
    assert api.effective_range("current_exposure") == (0, 1000000000)


def test_non_routed_control_stays_on_default_device(api, monkeypatch):
    monkeypatch.setattr(api, "get_sensor_subdev", lambda: "/dev/v4l-subdev2")
    calls = []
    monkeypatch.setattr(api.subprocess, "run",
                        lambda cmd, *a, **k: calls.append(list(cmd)) or FakeCompleted(returncode=0))
    api._v4l2_set_routed("system_saturation_target", 128)
    # Not routed to the sensor subdevice.
    assert all("/dev/v4l-subdev2" not in c for c in calls)


def test_get_sensor_subdev_picks_node_exposing_markers(api, monkeypatch):
    # get_sensor_subdev() identifies the sensor node by the controls only a real
    # sensor exposes (pixel_rate + analogue_gain). No selected-camera name match
    # is possible here (the /sys name files don't exist under test), so it falls
    # through to this capability probe.
    monkeypatch.delenv("SIMA_MIPI_UTIL_SENSOR_SUBDEV", raising=False)
    monkeypatch.setattr(api, "_sensor_subdev", None, raising=False)
    monkeypatch.setattr(api, "get_current_camera_name", lambda: None)
    monkeypatch.setattr(api.glob, "glob",
                        lambda p: ["/dev/v4l-subdev0", "/dev/v4l-subdev2"])

    def fake_run(cmd, *a, **k):
        node = cmd[cmd.index("-d") + 1]
        if node == "/dev/v4l-subdev2":
            return FakeCompleted(stdout="pixel_rate 0x1 (int64): value=450000000\n"
                                        "analogue_gain 0x2 (int): min=0 max=255 value=0\n")
        return FakeCompleted(stdout="brightness 0x3 (int): min=0 max=255 value=0\n")

    monkeypatch.setattr(api.subprocess, "run", fake_run)
    assert api.get_sensor_subdev() == "/dev/v4l-subdev2"


def test_get_sensor_subdev_env_override_wins(api, monkeypatch):
    monkeypatch.setenv("SIMA_MIPI_UTIL_SENSOR_SUBDEV", "/dev/v4l-subdev9")
    assert api.get_sensor_subdev() == "/dev/v4l-subdev9"


# ── Live control-device resolution (imx568 "writes don't apply" fix) ─────────
# The control node can't be derived from the camera index: it's context 0
# (video0out) for both cameras, so writes must target whichever out-node reports
# sensor_streaming==1 — otherwise every imx568 write lands on a dormant context
# (stored + read back fine, picture never changes).
def test_resolve_live_control_device_picks_streaming_context(api, monkeypatch):
    monkeypatch.setattr(api.glob, "glob",
                        lambda p: ["/dev/video0out", "/dev/video1out"])
    monkeypatch.setattr(api, "v4l2_get",
                        lambda ctrl, dev=None: 1 if dev == "/dev/video0out" else 0)
    assert api.resolve_live_control_device() == "/dev/video0out"


def test_resolve_live_control_device_none_when_nothing_streaming(api, monkeypatch):
    monkeypatch.setattr(api.glob, "glob",
                        lambda p: ["/dev/video0out", "/dev/video1out"])
    monkeypatch.setattr(api, "v4l2_get", lambda ctrl, dev=None: 0)
    assert api.resolve_live_control_device() is None
