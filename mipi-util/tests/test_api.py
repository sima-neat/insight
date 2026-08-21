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
    # The endpoint now rejects nodes that are not actually present, so the
    # test must not depend on the host machine's /dev/video* inventory.
    monkeypatch.setattr(api, "discover_cameras",
                        lambda: [{"device": "/dev/video0"}, {"device": "/dev/video1"}])

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


def test_idle_producer_stop_runs_after_grace(api, monkeypatch):
    timers = []
    stopped = []

    class FakeTimer:
        def __init__(self, delay, callback):
            self.delay = delay
            self.callback = callback
            self.daemon = False
            self.cancelled = False
            timers.append(self)

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

    producer = {"clients": 0}
    monkeypatch.setattr(api.threading, "Timer", FakeTimer)
    monkeypatch.setattr(
        api, "_stop_producer",
        lambda **kwargs: stopped.append(kwargs),
    )

    api._schedule_idle_producer_stop(producer)
    assert timers[0].delay == api.PRODUCER_IDLE_TIMEOUT
    timers[0].callback()
    assert stopped == [{"expected": producer, "only_if_idle": True}]


def test_reconnect_cancels_idle_producer_stop(api, monkeypatch):
    timers = []
    stopped = []

    class FakeTimer:
        def __init__(self, _delay, callback):
            self.callback = callback
            self.daemon = False
            self.cancelled = False
            timers.append(self)

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

    monkeypatch.setattr(api.threading, "Timer", FakeTimer)
    monkeypatch.setattr(
        api, "_stop_producer",
        lambda **kwargs: stopped.append(kwargs),
    )

    api._schedule_idle_producer_stop({"clients": 0})
    api._cancel_idle_producer_stop()
    assert timers[0].cancelled is True
    timers[0].callback()
    assert stopped == []


def test_idle_stop_keeps_producer_with_active_client(api):
    producer = {"clients": 1}
    old_producer = api._producer
    api._producer = producer
    try:
        api._stop_producer(expected=producer, only_if_idle=True)
        assert api._producer is producer
    finally:
        api._producer = old_producer


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
    monkeypatch.setattr(api, "discover_cameras",
                        lambda: [{"device": "/dev/video0"}, {"device": "/dev/video1"}])
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


# ── Stream stall recovery (P1: stalled generators exhausted Waitress) ─────────
def test_stalled_stream_generator_exits_after_timeout(api, monkeypatch):
    """A producer that stays alive but stops publishing JPEGs must not pin its
    Waitress thread (and the camera lease) forever: the per-client generator
    closes itself once no fresh frame arrives within STREAM_STALL_TIMEOUT."""
    prod = {"stop": api.threading.Event(), "clients": 0,
            "jpeg_lock": api.threading.Lock(),
            "latest_jpeg": {"seq": 0, "data": None}}
    monkeypatch.setattr(api, "_ensure_producer", lambda: prod)
    monkeypatch.setattr(api, "_cancel_idle_producer_stop", lambda: None)
    scheduled = []
    monkeypatch.setattr(api, "_schedule_idle_producer_stop", scheduled.append)
    monkeypatch.setattr(api, "STREAM_STALL_TIMEOUT", 0.05)

    frames = list(api._libcamera_encoded_stream())

    assert frames == []                # generator gave up instead of spinning
    assert prod["clients"] == 0        # its client slot was released
    assert scheduled == [prod]         # idle teardown can now reap the producer


# ── Preset manual locks survive a pipeline rebuild (P2 regression) ────────────
def test_preset_locks_persist_and_rearm_after_rebuild(client, token, api,
                                                      monkeypatch, tmp_path):
    """/api/preset must remember each successfully armed lock so
    _reapply_desired() re-arms it after a camera switch or producer rebuild.
    Unremembered locks are released by the rebuild and the preset silently
    stopped applying."""
    api.state["stream_device"] = "/dev/video0"  # the imx477 settings slot

    r = client.post("/api/preset/daylight", headers={"X-Auth-Token": token})
    assert r.status_code == 200

    # Persistence: the armed lock landed in the same per-camera store that
    # _reapply_desired() restores from.
    assert api._desired_by_camera["imx477"].get("en_manual_awb") == 1

    # Restoration: a rebuild re-arms the remembered lock instead of releasing
    # it. Record every lock write the reapply pass makes.
    monkeypatch.setattr(api, "REAPPLY_LOG", str(tmp_path / "reapply.log"))
    writes = []

    def record_set(ctrl, val, **kwargs):
        writes.append((ctrl, val))
        return True, None

    monkeypatch.setattr(api, "v4l2_set", record_set)
    monkeypatch.setattr(api, "_v4l2_set_verified", record_set)
    api._reapply_desired()

    awb_lock_writes = [v for c, v in writes if c == "en_manual_awb"]
    assert awb_lock_writes, "rebuild never touched the remembered lock"
    assert awb_lock_writes[-1] == 1    # re-armed (a 0->1 kick may precede)


# ── Arming a lock needs a 0->1 edge (volatile registers) ──────────────────────
def test_arming_lock_via_api_kicks_zero_to_one(client, token, api, monkeypatch):
    """Lock registers can read 1 while the algorithm actually runs again, and
    writing 1 produces no edge — the user's toggle must go through the same
    0->1 kick presets/reset use, or manual mode silently never engages."""
    writes = []
    monkeypatch.setattr(api, "v4l2_set",
                        lambda c, v, **kw: writes.append((c, v)) or (True, None))

    r = client.post("/api/set", json={"control": "en_manual_exposure", "value": 1},
                    headers={"X-Auth-Token": token})

    assert r.get_json()["ok"] is True
    assert writes == [("en_manual_exposure", 0), ("en_manual_exposure", 1)]

    # Releasing must stay a single plain write: a kick here would blip manual
    # mode back on for a frame while the user is turning it off.
    writes.clear()
    r = client.post("/api/set", json={"control": "en_manual_exposure", "value": 0},
                    headers={"X-Auth-Token": token})
    assert r.get_json()["ok"] is True
    assert writes == [("en_manual_exposure", 0)]


# ── Readback settle grace (false "rejected by ISP" on frame-cadence lag) ──────
def test_lagging_readback_settles_instead_of_false_rejection(api, monkeypatch):
    """A write the ISP reflects one frame later must verify OK, not raise
    "rejected by ISP (auto override)" — poll up to the grace, return early."""
    monkeypatch.setattr(api, "VERIFY_READBACK_GRACE", 0.5)
    monkeypatch.setattr(api, "VERIFY_READBACK_POLL", 0.01)
    monkeypatch.setattr(api, "_v4l2_set_routed", lambda c, v, **kw: (True, None))
    # First read returns the algorithm's old value, the register catches up next poll.
    reads = iter([100, 100, 1000])
    monkeypatch.setattr(api, "_v4l2_get_routed",
                        lambda c, **kw: next(reads, 1000))

    ok, err = api._do_set_verified("current_exposure", 1000)

    assert ok is True
    assert not err


# ── Stalled producer is replaced, not reused ──────────────────────────────────
def test_ensure_producer_replaces_stalled_producer(api, monkeypatch):
    """A gst process that published frames and then went silent must be
    rebuilt — watchdog reconnects were re-attaching to the dead stream."""
    class AliveProc:
        def poll(self):
            return None
    stalled = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
               "latest_jpeg": {"seq": 5, "data": b"x",
                               "ts": api.time.monotonic() - 60}}
    fresh = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
             "latest_jpeg": {"seq": 0, "data": None, "ts": None}}
    stopped = []

    def fake_stop(**kw):
        stopped.append(kw)
        api._producer = None
    api._producer = stalled
    try:
        monkeypatch.setattr(api, "_stop_producer", fake_stop)
        monkeypatch.setattr(api, "_start_producer", lambda: fresh)
        monkeypatch.setattr(api, "reset_fps_session", lambda: None)

        prod = api._ensure_producer()

        assert prod is fresh
        assert stopped and stopped[0]["expected"] is stalled
    finally:
        api._producer = None
        api._camera_controls_ready.set()


def test_ensure_producer_keeps_healthy_and_starting_producers(api):
    """Publishing recently, or never having published yet (still starting),
    must not trigger a rebuild."""
    class AliveProc:
        def poll(self):
            return None
    healthy = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
               "latest_jpeg": {"seq": 5, "data": b"x",
                               "ts": api.time.monotonic()}}
    starting = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
                "started": api.time.monotonic(),
                "latest_jpeg": {"seq": 0, "data": None, "ts": None}}
    for prod in (healthy, starting):
        api._producer = prod
        try:
            assert api._ensure_producer() is prod
        finally:
            api._producer = None


# ── Controls gated on every rebuild, not only camera switches ─────────────────
def test_rebuild_marks_controls_unready_before_start(api, monkeypatch):
    seen = []
    api._camera_controls_ready.set()
    api._producer = None
    monkeypatch.setattr(
        api, "_start_producer",
        lambda: seen.append(api._camera_controls_ready.is_set()) or
        {"stop": api.threading.Event(), "proc": None, "clients": 0,
         "latest_jpeg": {"seq": 0, "data": None, "ts": None}})
    monkeypatch.setattr(api, "reset_fps_session", lambda: None)
    try:
        api._ensure_producer()
        assert seen == [False]
    finally:
        api._producer = None
        api._camera_controls_ready.set()


# ── Stream settings persist across restarts ───────────────────────────────────
def test_stream_settings_persist_and_reload(client, token, api):
    r = client.post("/api/settings", json={"num_encoders": 3, "jpeg_quality": 70},
                    headers={"X-Auth-Token": token})
    assert r.get_json()["ok"] is True

    # Simulate the restart: defaults back in memory, then load from disk.
    api.stream_config.update({"num_encoders": 6, "jpeg_quality": 85})
    api._load_stream_settings()

    assert api.stream_config["num_encoders"] == 3
    assert api.stream_config["jpeg_quality"] == 70


def test_corrupt_stream_settings_fall_back_to_defaults(api):
    with open(api.STREAM_SETTINGS_FILE, "w", encoding="utf-8") as fh:
        fh.write('{"num_encoders": 9999, "jpeg_quality": "junk", not json')
    before = dict(api.stream_config)
    api._load_stream_settings()
    assert api.stream_config == before


# ── Detection probes digital gain lock-aware without persisting the probe ─────
def test_detection_probes_digital_gain_lock_aware(api, monkeypatch):
    calls = {"verified": [], "raw": []}
    monkeypatch.setattr(api, "_get_with_retry", lambda c: 100)
    monkeypatch.setattr(api, "_do_set_verified",
                        lambda c, v: calls["verified"].append((c, v)) or (True, None))
    monkeypatch.setattr(api, "_v4l2_set_routed",
                        lambda c, v, **kw: calls["raw"].append((c, v)) or (True, None))

    api._detect_one("sdev_digital_gain")
    assert calls["verified"] and not calls["raw"]
    assert api._desired_by_camera["imx477"] == {}

    calls["verified"].clear()
    api._detect_one("system_saturation_target")
    assert calls["raw"] and not calls["verified"]


# ── Device switch rejects absent nodes before mutating anything ───────────────
def test_absent_camera_node_is_rejected_without_mutation(client, token, api, monkeypatch):
    api.state["stream_device"] = "/dev/video0"
    api.state["control_device"] = "/dev/video0out"
    monkeypatch.setattr(api, "discover_cameras",
                        lambda: [{"device": "/dev/video0"}, {"device": "/dev/video1"}])
    # Real list_out_devices() returns dicts — the mock must match its shape,
    # or the test validates an assumption instead of the code.
    monkeypatch.setattr(api, "list_out_devices",
                        lambda: [{"device": "/dev/video0out"}])

    r = client.post("/api/device", json={"camera": "/dev/video999"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 400
    assert api.state["stream_device"] == "/dev/video0"

    r = client.post("/api/device",
                    json={"camera": "/dev/video1", "control_device": "/dev/video9out"},
                    headers={"X-Auth-Token": token})
    assert r.status_code == 400
    assert api.state["stream_device"] == "/dev/video0"
    assert api.state["control_device"] == "/dev/video0out"


# ── Failed reset keeps the remembered recovery state ──────────────────────────
def test_incomplete_reset_preserves_remembered_settings(client, token, api, monkeypatch):
    api.state["stream_device"] = "/dev/video0"
    api._remember("awb_red_gain", 777)
    forgotten = []
    monkeypatch.setattr(api, "forget_desired",
                        lambda *a, **kw: forgotten.append(True))
    # Make one reset write fail so the endpoint reports ok: false.
    monkeypatch.setattr(api, "_v4l2_set_routed",
                        lambda c, v, **kw: (False, "busy"))

    r = client.post("/api/reset", headers={"X-Auth-Token": token})

    assert r.get_json()["ok"] is False
    assert not forgotten, "failed reset must not discard remembered settings"


# ── A present control_device must be accepted (dict-vs-string regression) ─────
def test_valid_control_device_is_accepted(client, token, api, monkeypatch):
    api.state["stream_device"] = "/dev/video0"
    api.state["control_device"] = "/dev/video0out"
    monkeypatch.setattr(api, "discover_cameras",
                        lambda: [{"device": "/dev/video0"}])
    monkeypatch.setattr(api, "list_out_devices",
                        lambda: [{"device": "/dev/video0out"}])

    r = client.post("/api/device", json={"control_device": "/dev/video0out"},
                    headers={"X-Auth-Token": token})

    assert r.status_code == 200
    assert r.get_json()["ok"] is True


# ── Stream settings apply atomically ──────────────────────────────────────────
def test_mixed_settings_request_applies_nothing(client, token, api):
    before = dict(api.stream_config)

    r = client.post("/api/settings",
                    json={"jpeg_quality": 50, "num_encoders": "bad"},
                    headers={"X-Auth-Token": token})

    assert r.status_code == 400
    assert api.stream_config == before          # valid prefix did not apply
    import os as _os
    assert not _os.path.exists(api.STREAM_SETTINGS_FILE)   # nothing persisted


# ── A producer that never publishes its first frame is rebuilt after grace ────
def test_ensure_producer_replaces_never_publishing_producer(api, monkeypatch):
    class AliveProc:
        def poll(self):
            return None
    hung = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
            "started": api.time.monotonic() - 120,        # past the grace
            "latest_jpeg": {"seq": 0, "data": None, "ts": None}}
    fresh = {"stop": api.threading.Event(), "proc": AliveProc(), "clients": 0,
             "started": api.time.monotonic(),
             "latest_jpeg": {"seq": 0, "data": None, "ts": None}}
    stopped = []

    def fake_stop(**kw):
        stopped.append(kw)
        api._producer = None
    api._producer = hung
    try:
        monkeypatch.setattr(api, "_stop_producer", fake_stop)
        monkeypatch.setattr(api, "_start_producer", lambda: fresh)
        monkeypatch.setattr(api, "reset_fps_session", lambda: None)

        prod = api._ensure_producer()

        assert prod is fresh
        assert stopped and stopped[0]["expected"] is hung
    finally:
        api._producer = None
        api._camera_controls_ready.set()


# ── Preset and reset are camera-bound like /api/set ───────────────────────────
def test_preset_and_reset_reject_stale_camera(client, token, api):
    api.state["stream_device"] = "/dev/video0"
    for path in ("/api/preset/daylight", "/api/reset"):
        r = client.post(path, json={"camera": "/dev/video1"},
                        headers={"X-Auth-Token": token})
        assert r.status_code == 409, path


def test_preset_and_reset_work_without_camera_field(client, token, api):
    api.state["stream_device"] = "/dev/video0"
    for path in ("/api/preset/daylight", "/api/reset"):
        r = client.post(path, headers={"X-Auth-Token": token})
        assert r.status_code == 200, path


# ── HEAD /api/stream must not claim the camera lease (P1) ─────────────────────
def test_head_stream_does_not_claim_camera_lease(client, api, token):
    r = client.head("/api/stream?client_id=head-probe")
    assert r.status_code == 200

    with api._camera_access_lock:
        assert api._camera_access_owner is None

    # A different client can still write — nothing got pinned.
    r = client.post("/api/set", json={"control": "system_saturation_target",
                                      "value": 140},
                    headers={"X-Auth-Token": token,
                             "X-Camera-Client": "browser-a"})
    assert r.status_code != 423
