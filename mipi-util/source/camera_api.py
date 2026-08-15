#!/usr/bin/env python3
"""sima-mipi-util — SiMa.ai MIPI Camera Utility. Web UI for the IMX477 ISP on
Modalix. Serves http://<device-ip>:5000"""

import os, re, glob, time, threading, subprocess, logging, collections, queue, tempfile, shutil, secrets, functools, json
from pathlib import Path
from flask import Flask, request, jsonify, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("sima-mipi-util")
app = Flask(__name__)

# ── API auth ─────────────────────────────────────────────────────────────────
# State-changing endpoints require a shared token so a random host on the LAN —
# or a drive-by browser page — can't silently retune the ISP or restart the
# service. The token is provisioned once at install time (see postinst) into a
# root-only file. Reads (live view, status, capability reads) stay open so the
# view-only UI and MJPEG <img> stream load without a secret.
AUTH_TOKEN_FILE = os.environ.get("SIMA_MIPI_UTIL_TOKEN_FILE", "/etc/sima-mipi-util/token")

def _load_auth_token():
    try:
        with open(AUTH_TOKEN_FILE) as f:
            return f.read().strip() or None
    except OSError:
        return None

AUTH_TOKEN = _load_auth_token()

# Cross-origin is off by default: the page is served by the device itself, so
# same-origin requests need no CORS headers. Set this to a specific origin
# (e.g. http://host:5000) only if you deliberately want to drive the API from a
# page hosted elsewhere.
ALLOWED_ORIGIN = os.environ.get("SIMA_MIPI_UTIL_ALLOWED_ORIGIN")

@app.before_request
def _require_token():
    # Guard only state-changing verbs; GET/HEAD/OPTIONS stay open so the page
    # and stream load without a token.
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if AUTH_TOKEN is None:
        # Fail closed by default. A bare development run can explicitly opt out
        # with SIMA_MIPI_UTIL_REQUIRE_AUTH=0; production must never become
        # writable merely because the token file was deleted or mis-permissioned.
        require_auth = os.environ.get("SIMA_MIPI_UTIL_REQUIRE_AUTH", "1") != "0"
        if require_auth:
            return jsonify({"ok": False, "error": "server auth not configured"}), 503
        return None
    supplied = request.headers.get("X-Auth-Token", "")
    if not secrets.compare_digest(supplied, AUTH_TOKEN):
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return None

_lock = threading.Lock()
_hardware_lock = threading.RLock()

# One browser owns camera access while it has a live stream. Multiple stream
# connections from that same browser are allowed (normal <img> reconnect race),
# but another browser may neither stream nor mutate camera state until the owner
# disconnects all of its streams.
_camera_access_lock = threading.Lock()
_camera_access_owner = None
_camera_access_counts = {}

def _camera_client_id():
    client_id = request.headers.get("X-Camera-Client") or request.args.get("client_id")
    if client_id and re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", client_id):
        return client_id
    # Backward-compatible identity for scripts/older pages. Distinct browsers
    # use the generated X-Camera-Client value supplied by the current UI.
    return "ip:" + (request.remote_addr or "unknown")

def _camera_owner_conflict():
    with _camera_access_lock:
        owner = _camera_access_owner
    return owner is not None and owner != _camera_client_id()

@app.before_request
def _protect_active_camera_owner():
    if request.method not in ("GET", "HEAD", "OPTIONS") and _camera_owner_conflict():
        return jsonify({"ok": False, "error": "camera is in use by another user"}), 423

def _serialized_hardware(fn):
    """Serialize compound V4L2 operations across server request threads."""
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        with _hardware_lock:
            return fn(*args, **kwargs)
    return wrapped

def _camera_context_error(data):
    """Reject a stale client that is writing after another client switched cameras."""
    expected = data.get("camera") if isinstance(data, dict) else None
    if expected is not None and expected != state["stream_device"]:
        return (jsonify({
            "ok": False,
            "error": "selected camera changed; reload before applying controls",
            "expected_camera": expected,
            "selected_camera": state["stream_device"],
        }), 409)
    return None


def _json_object():
    """Return a JSON object or a consistent HTTP 400 response."""
    data = request.get_json(silent=True)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        return None, (jsonify({"ok": False, "error": "JSON body must be an object"}), 400)
    return data, None

state = {"stream_device": "/dev/video0", "control_device": "/dev/video0out", "camera_name": None}

# Cleared when switching cameras and set only after the new capture pipeline has
# re-applied that camera's remembered/default state. This prevents /api/controls
# from exposing the previous camera's registers while the shared ISP context is
# still being initialized.
_camera_controls_ready = threading.Event()
_camera_controls_ready.set()

# User-adjustable stream tuning (Settings panel). target_fps and jpeg_quality
# are read live by the running producer; num_encoders is fixed when a producer
# is created and therefore takes effect on the next producer rebuild.
stream_config = {"jpeg_quality": 85, "num_encoders": 6, "diag_interval_ms": 4000, "target_fps": 30}
_STREAM_CONFIG_BOUNDS = {
    "jpeg_quality": (30, 95),
    "num_encoders": (1, 8),
    "diag_interval_ms": (1000, 15000),
    "target_fps": (1, 30),
}

# Real encoded-frame rate, measured where frames actually get produced —
# the sensor_fps v4l2 control is unreliable (can report values far outside
# its own declared min/max), so the UI shouldn't trust it for display.
_frame_times = collections.deque(maxlen=30)
_frame_lock = threading.Lock()

# Cumulative average FPS for the current stream session — distinct from
# get_stream_fps()'s short rolling window (last 30 frames, ~1-2s), this
# tracks total frames served divided by total elapsed time since the
# session started, so it settles down over time instead of jittering with
# every momentary slowdown/speedup. Reset whenever the shared producer is
# genuinely rebuilt so reconnecting viewers do not create a new FPS session.
_session_start = None
_session_frames = 0

def _record_frame():
    """Record one newly published encoded frame (not one frame per viewer)."""
    global _session_frames
    now = time.monotonic()
    with _frame_lock:
        _frame_times.append(now)
        _session_frames += 1

def get_stream_fps():
    now = time.monotonic()
    with _frame_lock:
        times = list(_frame_times)
    if len(times) < 2 or now - times[-1] > 3:
        return None
    span = times[-1] - times[0]
    return round((len(times) - 1) / span, 1) if span > 0 else None

def get_avg_fps():
    now = time.monotonic()
    with _frame_lock:
        start, n = _session_start, _session_frames
    if start is None or n == 0:
        return None
    elapsed = now - start
    return round(n / elapsed, 1) if elapsed > 0 else None

def reset_fps_session():
    global _session_start, _session_frames
    with _frame_lock:
        _frame_times.clear()
        _session_start = time.monotonic()
        _session_frames = 0
    reset_capture_fps()

# Capture rate: raw frames arriving from the ISP, counted in reader() BEFORE
# the target_fps throttle and before JPEG encoding. Deliberately separate from
# the encoded-frame counter above, because the two answer different questions:
# _frame_times measures what reaches the browser, this measures what the
# hardware is actually delivering to us. Without it a drop in displayed FPS is
# ambiguous — sensor stalled, ISP stalled, or the encoders fell behind all look
# identical. Measured 34 fps capture against 17 fps display on this board, so
# the gap is real and worth surfacing.
_capture_times = collections.deque(maxlen=30)
_capture_lock = threading.Lock()

def _record_capture_frame():
    with _capture_lock:
        _capture_times.append(time.monotonic())

def get_capture_fps():
    now = time.monotonic()
    with _capture_lock:
        times = list(_capture_times)
    if len(times) < 2 or now - times[-1] > 3:
        return None
    span = times[-1] - times[0]
    return round((len(times) - 1) / span, 1) if span > 0 else None

def reset_capture_fps():
    with _capture_lock:
        _capture_times.clear()

# Nominal sensor frame rate, computed from the sensor's timing registers:
#
#     fps = pixel_rate / ((width + hblank) * (height + vblank))
#
# This is the standard V4L2 sensor timing calculation, but it is only as good
# as the driver behind it, so it is NOT treated as authoritative. Measured on
# this board:
#
#   imx477 6-001a  computed 33.98   measured 34.0   ← agrees, registers real
#   imx568 5-0042  computed 34.3    measured 64.3   ← disagrees badly
#
# The imx568 driver leaves these registers at their defaults (hblank=0, vblank
# at its minimum 48, pixel_rate with min==max==74250000, i.e. a fixed
# placeholder), so the arithmetic is meaningless for it. Reporting 34.3 for a
# sensor genuinely delivering 64 would be worse than reporting nothing.
#
# So this value is cross-checked against the measured capture rate and
# suppressed when the two disagree. The measured rate is what the UI shows as
# the sensor rate; this one is only a corroborating "nominal" figure.
#
# The sensor_fps v4l2 control is not used at all: it reads 193939 against its
# own declared max of 240, and matches neither camera's real rate under any
# scaling. The media graph's "1920x1080p190" dv label is equally inconsistent.
# Both appear to describe link-layer timing rather than frames.
_SENSOR_FPS_TOLERANCE = 0.15   # fractional disagreement before we distrust it
_sensor_fps_cache = {}
_sensor_fps_lock = threading.Lock()

def get_nominal_sensor_fps():
    """Register-derived sensor rate, or None if unreadable. Not validated here
    — see get_sensor_rates() for the cross-check against measurement."""
    sdev = get_sensor_subdev()
    if not sdev:
        return None
    w, h = v4l2_get("sensor_width"), v4l2_get("sensor_height")
    if not w or not h:
        return None
    key = (sdev, w, h)
    with _sensor_fps_lock:
        if key in _sensor_fps_cache:
            return _sensor_fps_cache[key]
    pixel_rate = v4l2_get("pixel_rate", dev=sdev)
    hblank = v4l2_get("horizontal_blanking", dev=sdev)
    vblank = v4l2_get("vertical_blanking", dev=sdev)
    if not pixel_rate or hblank is None or vblank is None:
        return None
    line_length, frame_length = w + hblank, h + vblank
    if line_length <= 0 or frame_length <= 0:
        return None
    fps = round(pixel_rate / (line_length * frame_length), 1)
    with _sensor_fps_lock:
        _sensor_fps_cache[key] = fps
    log.info("nominal sensor fps %.1f on %s (pixel_rate=%d, %dx%d, hblank=%d, vblank=%d)",
             fps, sdev, pixel_rate, w, h, hblank, vblank)
    return fps

def get_sensor_rates():
    """(sensor_fps, nominal_fps) for the UI.

    sensor_fps is the MEASURED rate of frames arriving from the sensor/ISP —
    trustworthy on every camera because it counts real frames rather than
    trusting a driver to populate its registers. nominal_fps is the
    register-derived figure, returned only when it corroborates the
    measurement; when a driver reports placeholder timing (see above) it would
    otherwise contradict observed reality, so it is dropped instead."""
    measured = get_capture_fps()
    nominal = get_nominal_sensor_fps()
    if measured and nominal:
        if abs(nominal - measured) / measured > _SENSOR_FPS_TOLERANCE:
            nominal = None
    return measured, nominal

def invalidate_sensor_fps():
    with _sensor_fps_lock:
        _sensor_fps_cache.clear()

# ── ISP controls ───────────────────────────────────────────────────────────────
# type: "int" (slider, default), "bool" (toggle), "menu" (dropdown with options dict)
# restart: True → system reboot required after apply
CONTROLS = {
    # Daily · White Balance
    "en_manual_awb":                  {"min":0,"max":1,       "default":0,   "label":"Manual AWB Lock",           "type":"bool"},
    "awb_red_gain":                   {"min":0,"max":65535,   "default":278, "label":"AWB Red Gain"},
    "awb_blue_gain":                  {"min":0,"max":65535,   "default":281, "label":"AWB Blue Gain"},
    "system_awb_cct":                 {"min":0,"max":65535,   "default":5000,"label":"Colour Temp (K)"},
    # Daily · Exposure
    "en_manual_exposure":             {"min":0,"max":1,       "default":0,   "label":"Manual Exposure Lock",      "type":"bool"},
    # current_exposure is the ISP-side register, NOT the sensor subdevice's
    # "exposure" control (see SDEV_CONTROLS, which deliberately does not route
    # this one). It was briefly routed to the sensor subdev on the theory that
    # AE overwrote the ISP register even with the manual flag set. Retested
    # directly on this hardware and that does not reproduce: with
    # en_manual_exposure kicked 0->1 first — which _v4l2_set_verified always
    # does before trusting a write — the ISP register holds exactly. Writing
    # 20000 read back 20000 unchanged over 6s; 200000 held to within 0.5%. The
    # sensor's own exposure register moved in step, confirming the ISP write
    # drives real exposure rather than sitting in a shadow register.
    #
    # Routing it to the sensor subdev also silently changed what the slider
    # means: that register is in SENSOR LINES with a hard per-mode ceiling
    # (imx477: min=4 max=2175), so the UI offered a 4..2175 range that is
    # camera-specific and not in the same units as anything else here. The ISP
    # register is what the rest of this tool is built around — the
    # _HW_RANGE_OVERRIDES_BY_CAMERA safe-max cap and the reset path both
    # describe it.
    "current_exposure":               {"min":0,"max":2000000,  "default":100000,"label":"Exposure Time"},
    "max_integration_time":           {"min":0,"max":1000000, "default":5000,"label":"Max Integration Time"},
    # Daily · Analog Gain
    "en_manual_sensor_analog_gain":   {"min":0,"max":1,       "default":0,   "label":"Manual Analog Gain Lock",   "type":"bool"},
    # Route to the selected sensor analogue_gain register so manual gain is
    # retained instead of being overwritten in the ISP-side shadow control.
    "sensor_analog_gain":             {"min":0,"max":1048576, "default":0,   "label":"Sensor Analog Gain"},
    "max_sensor_analog_gain":         {"min":0,"max":255,     "default":160, "label":"Max Analog Gain"},
    # Daily · ISP Digital Gain — REMOVED: confirmed non-functional on this
    # firmware. Tested with the lock verified engaged and the raw register
    # confirmed holding the written value (0 vs 255, both with the ceiling
    # at its 0 default and with the ceiling raised to 255) — the actual
    # video frames showed no measurable brightness difference either way.
    # Same category as sensor_wdr_mode / system_iridix_digital_gain / etc.
    # below. Don't re-add without re-verifying on real hardware.
    #
    # Daily · Sensor Digital Gain — a DIFFERENT, genuinely working register.
    # Also tried "sensor_digital_gain" on the ISP device (0x0098f02d) —
    # confirmed just as dead as isp_digital_gain (0 vs 255 produced no real
    # brightness change). This one lives on the SENSOR SUBDEVICE itself
    # (/dev/v4l-subdev2's "digital_gain", not the ISP's), and is confirmed
    # to genuinely work: real, repeatable, substantial brightness swings
    # captured directly from live frames (e.g. mean luma 62 at gain=256
    # (1.0x, unity) vs 170 at gain=20000 (~78x), and clearly elevated at
    # intermediate values too). No separate manual-lock bit exists for this
    # control on the subdevice, so it's applied directly with no lock to
    # toggle — see SDEV_CONTROLS below for how it's routed to the right
    # device instead of the default ISP control device.
    "sdev_digital_gain":              {"min":256,"max":65535,  "default":256, "label":"Digital Gain"},
    # Daily · Sharpening
    "syst_man_direct_sharpening":     {"min":0,"max":1,       "default":0,   "label":"Direct Manual Lock",        "type":"bool"},
    "syst_direct_sharpening_target":  {"min":0,"max":255,     "default":32,  "label":"Direct Sharpness"},
    "syst_man_un_direct_sharpening":  {"min":0,"max":1,       "default":0,   "label":"Undirect Manual Lock",      "type":"bool"},
    "syst_un_direct_sharp_target":    {"min":0,"max":255,     "default":0,   "label":"Undirect Sharpness"},
    # Daily · Saturation
    "en_manual_saturation":           {"min":0,"max":1,       "default":0,   "label":"Manual Saturation Lock",    "type":"bool"},
    "system_saturation_target":       {"min":0,"max":255,     "default":128, "label":"Saturation"},
    # Daily · Noise Reduction
    "en_manual_sinter":               {"min":0,"max":1,       "default":0,   "label":"Manual Sinter Lock",        "type":"bool"},
    "system_sinter_threshold_target": {"min":0,"max":255,     "default":25,  "label":"Sinter Threshold"},
    # Daily · Tone Mapping (Iridix)
    "en_manual_iridix":               {"min":0,"max":1,       "default":0,   "label":"Manual Iridix Lock",        "type":"bool"},
    "system_minimum_iridix_strength": {"min":0,"max":255,     "default":0,   "label":"Iridix Min Strength"},
    "system_maximum_iridix_strength": {"min":0,"max":255,     "default":64,  "label":"Iridix Max Strength"},
    "system_iridix_strength_target":  {"min":0,"max":255,     "default":0,   "label":"Iridix Target"},
    # Daily · Antiflicker
    "system_antiflicker_enable":      {"min":0,"max":1,       "default":1,   "label":"Antiflicker",               "type":"bool"},
    "system_anti_flicker_frequency":  {"min":0,"max":255,     "default":50,  "label":"Frequency (Hz)"},
    # Advanced · Sensor Preset (triggers full reboot)
    "isp_sensor_preset":              {"min":0,"max":16,      "default":0,   "label":"ISP Sensor Preset",         "restart":True},
    # Advanced · Sensor Digital Gain
    "en_manual_sensor_digital_gain":  {"min":0,"max":1,       "default":0,   "label":"Manual Sensor Dig Lock",    "type":"bool"},
    "sensor_digital_gain":            {"min":0,"max":255,     "default":0,   "label":"Sensor Digital Gain"},
    "max_sensor_digital_gain":        {"min":0,"max":255,     "default":0,   "label":"Max Sensor Dig Gain"},
    # Advanced · Integration Time Bounds
    "en_manual_max_integration_time": {"min":0,"max":1,       "default":0,   "label":"Manual Max Int. Time Lock", "type":"bool"},
    # Advanced · Exposure Ratio (WDR)
    "en_manual_exposure_ratio":       {"min":0,"max":1,       "default":0,   "label":"Manual Exp. Ratio Lock",    "type":"bool"},
    "maximum_exposure_ratio":         {"min":0,"max":256,     "default":0,   "label":"Max Exposure Ratio"},
    "current_exposure_ratio":         {"min":0,"max":256,     "default":16,  "label":"Exposure Ratio"},
    # Advanced · Test Pattern
    "isp_test_pattern":               {"min":0,"max":1,       "default":0,   "label":"Test Pattern Enable",       "type":"bool"},
    "isp_test_pattern_type":          {"min":0,"max":5,       "default":3,   "label":"Pattern Type",              "type":"menu",
                                       "options":{"0":"FLAT_FIELD","1":"H_GRADIENT","2":"V_GRADIENT",
                                                  "3":"V_BARS","4":"ARB_RECT","5":"RANDOM"}},
    # Advanced · Image Crop
    "image_crop_enable":              {"min":0,"max":1,       "default":0,   "label":"Crop Enable",               "type":"bool"},
    "image_crop_xoffset":             {"min":0,"max":65535,   "default":0,   "label":"X Offset"},
    "image_crop_yoffset":             {"min":0,"max":65535,   "default":0,   "label":"Y Offset"},
    "image_crop_width":               {"min":0,"max":65535,   "default":0,   "label":"Crop Width"},
    "image_crop_height":              {"min":0,"max":65535,   "default":0,   "label":"Crop Height"},
    # Advanced · Output Format
    # Options trimmed to match the UI's dropdown (RGB888/BGR888/ARGB32/BGRA32/
    # RAW8/10/12/Y8, plus NV12 mapped to the ISP's OF_MODE_Y8UV88_2X2=24 —
    # confirmed that's exactly what the real capture pipeline uses).
    "image_output_format_id":         {"min":0,"max":43,      "default":38,  "label":"Output Format",             "type":"menu",
                                       "options":{"3":"RGB888","36":"BGR888","37":"ARGB32","38":"BGRA32",
                                                  "24":"NV12","17":"RAW8","18":"RAW10","19":"RAW12","33":"Y8"}},
}

# ── White balance ───────────────────────────────────────────────────────────
# awb_red_gain / awb_blue_gain / system_awb_cct used to be applied in software
# here — a per-channel gain multiply on every decoded frame, with the "current
# value" tracked in a local dict instead of read back from the ISP. That
# existed because on the 2.1.3 release build the firmware silently re-overrode
# these three registers and the value drifted on its own even with the manual
# lock set, so no userspace write would stick.
#
# The 2.1.2 release image honours the registers normally, so the workaround is
# gone: these three now take the exact same v4l2 path as every other control —
# written straight to the ISP, and read straight back from it.
#
# Do not reintroduce a software correction layer while the hardware write is
# still in place. Running both applies the gain twice, and makes the browser
# preview disagree with what the capture pipeline actually outputs (the
# software pass only ever touched the MJPEG preview, never a recording or a
# still capture). Note also that the neutral point differs between the two:
# the software gain was neutral at 256, but these controls default to 278/281,
# so the old path tinted the preview even at factory defaults.

# Read-only diagnostic controls
DIAG_CONTROLS = [
    "sensor_width", "sensor_height", "sensor_fps",
    "get_ae_hist_mean", "get_iridix_contrast", "get_awb_mix_light_contrast",
    "get_expososure_log2", "get_gain_log2",
]

# VBlank/HBlank/digital_gain/link_frequency live on the sensor's own v4l2
# subdevice (standard V4L2 "Image Source"/"Image Processing" controls), not
# on the ISP output node (/dev/video0out) — a separate device path.
# The sensor's subdevice node number is NOT stable across cameras: the imx477
# sat on /dev/v4l-subdev2 and the imx568 on /dev/v4l-subdev3 on this same
# board. Hardcoding it meant that after a camera swap every Sensor Overview
# field (VBlank, HBlank, Digital Gain, Link Frequency) silently read None,
# and sdev_digital_gain looked unsupported. Find it by the controls only a
# real sensor exposes instead.
_SENSOR_SUBDEV_MARKERS = ("pixel_rate", "analogue_gain")
_sensor_subdev = None
_sensor_subdev_lock = threading.Lock()

# libcamera's `cam` utility is not packaged in SiMa's libcamera-tools on this
# image (it ships only libcamerify), so every `cam -l` call raises
# FileNotFoundError. media-ctl is present and its graph names the sensor
# exactly as cam -l did, so it stands in as the source of camera names.
_MEDIA_ENTITY_RE = re.compile(r'^- entity \d+: (.+?) \([^)]*\)\s*$')

def _media_entities(mdev):
    """[(entity name, type line, device node)] for one /dev/mediaN graph.

    media-ctl prints an entity's node on a later line than its name, with a
    "type ... subtype ..." line in between, so this walks the block rather
    than pairing adjacent lines.
    """
    try:
        r = subprocess.run(["media-ctl", "-d", mdev, "-p"],
                           capture_output=True, text=True, timeout=5)
    except Exception as e:
        log.debug("media-ctl %s: %s", mdev, e)
        return []
    entities, name, typ, node = [], None, "", ""
    for line in r.stdout.splitlines():
        m = _MEDIA_ENTITY_RE.match(line)
        if m:
            if name:
                entities.append((name, typ, node))
            name, typ, node = m.group(1).strip(), "", ""
            continue
        s = line.strip()
        if name and s.startswith("type "):
            typ = s
        elif name and s.startswith("device node name "):
            node = s.split("device node name ", 1)[1].strip()
    if name:
        entities.append((name, typ, node))
    return entities

def sensor_for_video(dev):
    """(sensor name, sensor subdev path) feeding capture node dev, or (None, None).

    Scopes the lookup to the media graph that actually contains dev, which is
    what keeps two attached sensors apart — a plain scan of /dev/v4l-subdev*
    cannot tell which camera a sensor belongs to.
    """
    for mdev in sorted(glob.glob("/dev/media*")):
        entities = _media_entities(mdev)
        if not any(node == dev for _, _, node in entities):
            continue
        for name, typ, node in entities:
            if "subtype Sensor" in typ and node:
                return name, node
    return None, None

def get_sensor_subdev():
    """The sensor subdevice's node number isn't guaranteed stable across boots
    / driver-probe order or across camera models (imx477 on /dev/v4l-subdev2,
    imx568 on /dev/v4l-subdev3 on this same board), so resolve it dynamically
    rather than hardcoding. An explicit env override wins; otherwise match on
    the currently selected camera's name (so two attached sensors don't get
    confused), then fall back to a capability probe. Cached and invalidated by
    api_set_device() when the camera changes."""
    global _sensor_subdev
    # An explicit env override always wins — a dev/bring-up escape hatch that
    # must short-circuit all probing.
    override = os.environ.get("SIMA_MIPI_UTIL_SENSOR_SUBDEV")
    if override:
        return override
    with _sensor_subdev_lock:
        if _sensor_subdev:
            return _sensor_subdev
    found = None

    # With two cameras attached there are two sensor subdevs, so "first one
    # that looks like a sensor" picks the wrong camera half the time - it
    # reported the imx477's blanking and link frequency while the imx568 was
    # selected. /sys/class/video4linux/<node>/name holds exactly the string
    # `cam -l` reports, so match on that first.
    want = get_current_camera_name()
    if want:
        for path in sorted(glob.glob("/dev/v4l-subdev*")):
            try:
                with open("/sys/class/video4linux/%s/name" % os.path.basename(path)) as f:
                    if f.read().strip() == want:
                        found = path
                        break
            except OSError:
                continue

    # Fall back to the capability probe for a kernel that does not name the
    # node, or a single-camera board where the name lookup is unnecessary.
    if not found:
        for path in sorted(glob.glob("/dev/v4l-subdev*")):
            try:
                r = subprocess.run(["v4l2-ctl", "-d", path, "--list-ctrls"],
                                   capture_output=True, text=True, timeout=3)
            except Exception:
                continue
            if all(mark in r.stdout for mark in _SENSOR_SUBDEV_MARKERS):
                found = path
                break
    if found:
        log.info("sensor subdevice: %s", found)
    else:
        log.warning("no sensor subdevice found — sensor fields will be unavailable")
    with _sensor_subdev_lock:
        _sensor_subdev = found
    return found

# Controls that live on the sensor subdevice instead of the default ISP control
# device, keyed by our CONTROLS dict name -> the control's real v4l2 name on
# that subdevice (they can differ; e.g. our "sdev_digital_gain" is just
# "digital_gain" on the subdevice — kept distinct from CONTROLS' existing
# "sensor_digital_gain" key, which is the different, confirmed-dead ISP-side
# register). api_set()/api_set_many()/v4l2_get_all() all check this map to
# route reads/writes to the right device instead of assuming everything
# lives on state["control_device"].
SDEV_CONTROLS = {
    "sdev_digital_gain": "digital_gain",
    # current_exposure is NOT routed here: it is an ISP register and stays on
    # the control device. See the note on its CONTROLS entry — the ISP write
    # was re-verified to hold, and routing it to the sensor subdev changed the
    # slider's units to sensor lines (4..2175 on the imx477).
    "sensor_analog_gain": "analogue_gain",
}

def get_link_frequency_hz():
    """link_frequency is an intmenu control — v4l2-ctl prints the selected
    index plus the real Hz value in parens, e.g. "0 (450000000 0x1ad27480)"."""
    try:
        r = subprocess.run(["v4l2-ctl", "-d", get_sensor_subdev() or "", "--get-ctrl", "link_frequency"],
                           capture_output=True, text=True, timeout=3)
        m = re.search(r'\((\d+)\s', r.stdout)
        return int(m.group(1)) if m else None
    except Exception:
        return None

_PRESETS = {
    "daylight": {"awb_red_gain":461,"awb_blue_gain":410,"system_awb_cct":5500,
                 "system_saturation_target":128,"syst_direct_sharpening_target":48,
                 "syst_un_direct_sharp_target":16,"system_antiflicker_enable":1,
                 "system_anti_flicker_frequency":50,"system_sinter_threshold_target":25,
                 "system_maximum_iridix_strength":64,"system_minimum_iridix_strength":0},
    # Re-tuned from a measured, near-neutral baseline (255/255) rather than
    # an assumed warm-tungsten indoor scene — under this room's actual
    # lighting (cool white LED panels), the old 380/520 gains overshot badly
    # into a visible magenta cast (measured on bright/well-exposed pixels:
    # R/G=1.46, B/G=1.52 vs. a neutral ~1.0). 290/270 lands close to neutral
    # with just a gentle, deliberate warm-up (R/G=1.06, B/G=1.08).
    "indoor":   {"awb_red_gain":290,"awb_blue_gain":270,"system_awb_cct":4600,
                 "system_saturation_target":140,"syst_direct_sharpening_target":40,
                 "syst_un_direct_sharp_target":20,"system_antiflicker_enable":1,
                 "system_anti_flicker_frequency":50,"system_sinter_threshold_target":35,
                 "system_maximum_iridix_strength":80,"system_minimum_iridix_strength":0},
    "night":    {"awb_red_gain":420,"awb_blue_gain":460,"system_awb_cct":4000,
                 "system_saturation_target":110,"syst_direct_sharpening_target":20,
                 "syst_un_direct_sharp_target":8,"system_antiflicker_enable":1,
                 "system_anti_flicker_frequency":50,"system_sinter_threshold_target":60,
                 "system_maximum_iridix_strength":120,"system_minimum_iridix_strength":0,
                 "max_sensor_analog_gain":200},
    # Unity/no-correction values — the sensor's native color response with no
    # white balance or saturation adjustment applied (255/255/5000 is this
    # driver's true "no gain" baseline, confirmed empirically: it's what the
    # hardware reports before any AWB convergence has ever run).
    "raw":      {"awb_red_gain":255,"awb_blue_gain":255,"system_awb_cct":5000,
                 "system_saturation_target":128,"syst_direct_sharpening_target":32,
                 "syst_un_direct_sharp_target":0,"system_antiflicker_enable":1,
                 "system_anti_flicker_frequency":50,"system_sinter_threshold_target":25,
                 "system_maximum_iridix_strength":64,"system_minimum_iridix_strength":0},
}

# ── Camera discovery ───────────────────────────────────────────────────────────
def is_device_busy(dev):
    # fuser reports EVERY process with the device open, including our own
    # gst-launch capture process serving the live view you're already
    # watching — that's not a real conflict, just this app doing its job,
    # but surfacing it as "in use by another application" reads like one.
    # Exclude PIDs we know belong to our own active stream(s) so the busy
    # flag only fires for a genuinely separate process.
    try:
        r = subprocess.run(["fuser", dev], capture_output=True, text=True, timeout=3)
        pids = {int(p) for p in r.stdout.split()}
    except Exception:
        return False
    with _stream_lock:
        own = set(_own_stream_pids)
    return bool(pids - own)

def resolve_live_control_device():
    """The ISP out-node currently processing the live stream — the one that
    reports sensor_streaming==1.

    Which node that is varies by camera and boot, and the ISP reuses a single
    active context across camera switches: after switching imx477 (video0out) ->
    imx568, imx568 streams through the SAME video0out context (confirmed via
    sensor_streaming). So the streaming node IS the correct control target — but
    note it carries whatever the previous camera left in that context's
    registers, which is handled separately by re-applying the selected camera's
    settings on pipeline start. current_exposure is NOT a usable discriminator: a
    dormant node reports 2147483647, which would pass a naive ">0" test.
    """
    for dev in sorted(glob.glob("/dev/video*out")):
        try:
            if v4l2_get("sensor_streaming", dev=dev) == 1:
                return dev
        except Exception:
            continue
    return None

def ctrl_dev(stream):
    m = re.match(r'^(/dev/video)(\d+)$', stream)
    return f"{m.group(1)}{m.group(2)}out" if m else stream

def discover_cameras():
    cameras = []
    # libcamera's `cam -l` is NOT packaged on this image (see _media_entities),
    # so it raised FileNotFoundError on every call and fell through to a
    # /dev/video* scan that named a camera after its capture node
    # ("raw-capture.1.0") instead of its sensor ("imx477 5-001a"). That broke
    # both consumers of the name: get_sensor_subdev() could no longer tell two
    # attached sensors apart, and no _HW_RANGE_OVERRIDES_BY_CAMERA key could
    # ever match. Take the sensor name from the media graph instead, so it
    # matches exactly what cam -l would have reported.
    for dev in sorted(glob.glob("/dev/video*")):
        if re.match(r'^/dev/video\d+$', dev):
            # Sensor name from the media graph where available, so the name
            # matches what cam -l would have reported; the capture node's own
            # Card type is only a last resort.
            sensor_name = sensor_for_video(dev)[0]
            name = sensor_name or dev
            driver = ""
            try:
                r = subprocess.run(["v4l2-ctl", "-d", dev, "--info"],
                                   capture_output=True, text=True, timeout=3)
                for line in r.stdout.splitlines():
                    if "Card type" in line and not sensor_name:
                        name = line.split(":", 1)[1].strip()
                    elif "Driver name" in line:
                        driver = line.split(":", 1)[1].strip()
            except Exception:
                pass
            cameras.append({"device": dev, "name": name, "driver": driver,
                            "busy": is_device_busy(dev),
                            "index": int(re.search(r'\d+', dev).group())})
    return cameras

def get_current_camera_name():
    """Name of whatever camera is currently selected as stream_device, used
    to key per-camera-model fixes (see _HW_RANGE_OVERRIDES_BY_CAMERA) — a
    fix confirmed correct for one camera model (e.g. the current_exposure
    safe-max cap, verified specifically for imx477 5-001a) isn't
    necessarily true for a different camera ever connected to this app.
    Cached in state["camera_name"] and invalidated by api_set_device()
    whenever the selected camera actually changes, so this doesn't re-run
    the camera-discovery subprocess on every single /api/controls poll."""
    if state.get("camera_name") is None:
        for cam in discover_cameras():
            if cam["device"] == state["stream_device"]:
                state["camera_name"] = cam["name"]
                break
    return state.get("camera_name")

def list_out_devices():
    """Enumerate ISP output/control channels (/dev/videoNout) that correspond
    to an actually-present camera.

    The ISP hardware exposes a fixed bank of video*out nodes (video0out
    through roughly video15out) regardless of how many real sensors are
    wired up — confirmed on this device: only video0out has a real imx477
    behind it, every other channel reads all-zero stats because there's
    nothing there. Rather than listing every raw kernel device node (most
    of which are dead), filter to the indices discover_cameras() actually
    found — so exactly one out channel shows up per real camera: one camera
    means one video0/video0out pair; N cameras would mean N matched pairs.
    We can't change how many nodes the driver creates (that's fixed by the
    kernel/device-tree, not this app), but we control what we offer here.
    """
    real_indices = {c["index"] for c in discover_cameras()}
    devices = []
    for dev in sorted(glob.glob("/dev/video*out")):
        if not re.match(r'^/dev/video\d+out$', dev):
            continue
        idx = int(re.search(r'\d+', dev).group())
        if idx not in real_indices:
            continue
        name = dev
        driver = ""
        try:
            r = subprocess.run(["v4l2-ctl", "-d", dev, "--info"],
                               capture_output=True, text=True, timeout=3)
            for line in r.stdout.splitlines():
                if "Card type" in line:
                    name = line.split(":", 1)[1].strip()
                elif "Driver name" in line:
                    driver = line.split(":", 1)[1].strip()
        except Exception:
            pass
        devices.append({"device": dev, "name": name, "driver": driver, "index": idx})
    return devices

# ── V4L2 helpers ───────────────────────────────────────────────────────────────
def v4l2_set(ctrl, val, dev=None):
    d = dev or state["control_device"]
    try:
        r = subprocess.run(["v4l2-ctl", "-d", d, "--set-ctrl", f"{ctrl}={val}"],
                           capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        log.warning("SET %s=%s on %s timed out", ctrl, val, d)
        return False, "timed out"
    log.info("SET %s=%s on %s  rc=%d", ctrl, val, d, r.returncode)
    return r.returncode == 0, r.stderr.strip()

_GET_CTRL_RE = re.compile(r':\s*(-?\d+)\s*(?:\(|$)')

def v4l2_get(ctrl, dev=None):
    d = dev or state["control_device"]
    try:
        r = subprocess.run(["v4l2-ctl", "-d", d, "--get-ctrl", ctrl],
                           capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        log.warning("GET %s on %s timed out", ctrl, d)
        return None
    if r.returncode != 0:
        return None
    # Menu-type controls print a descriptive name after the number, e.g.
    # "image_output_format_id: 24 (OF_MODE_Y8UV88_2X2)" — naively taking
    # everything after the last ":" and int()-ing it broke on that trailing
    # "(NAME)" text for every such control (confirmed: this silently made
    # menu controls like image_output_format_id look "unreadable" everywhere
    # this function was used, including capability detection). Anchor on the
    # number itself instead of raw string splitting.
    m = _GET_CTRL_RE.search(r.stdout.strip())
    return int(m.group(1)) if m else None

# Captures name, optional min/max (bool-type controls print neither — v4l2
# implies 0/1 for those, which is what CONTROLS already declares), and value.
_LIST_CTRLS_RE = re.compile(
    r'^\s*(\w+)\s+0x[0-9a-fA-F]+\s+\([a-z0-9_]+\)\s*:\s*'
    r'(?:min=(-?\d+)\s+max=(-?\d+)\s+)?.*?\bvalue=(-?\d+)')

# The device's own declared min/max per control (VIDIOC_QUERYCTRL, surfaced
# by v4l2-ctl --list-ctrls) — the authoritative range, since CONTROLS' own
# hand-typed min/max have been caught wrong before (current_exposure's real
# max is 2,147,483,647; we'd guessed 2,000,000). Populated the first time
# v4l2_get_all() parses --list-ctrls output and reused after that, since a
# control's declared range doesn't change at runtime — only its value does.
_hw_ranges = {}

# Last values successfully read from hardware. A transient --list-ctrls
# failure must not be translated into each control's configured default: for
# boolean manual locks that default is 0, which made the UI switch them off for
# one polling cycle and back on after the next successful read.
_last_control_values = {}
_last_control_values_lock = threading.Lock()

def v4l2_list_values(dev):
    """Every readable control's current value from one device, in a SINGLE
    subprocess spawn (~60ms) rather than one spawn per control. Returns {} if
    the device could not be read at all, so callers can tell "no data this
    poll" from "this control is absent"."""
    values = {}
    if not dev:
        return values
    try:
        r = subprocess.run(["v4l2-ctl", "-d", dev, "--list-ctrls"],
                           capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        log.warning("list-ctrls on %s timed out", dev)
        return values
    except Exception as ex:
        log.warning("list-ctrls on %s: %s", dev, ex)
        return values
    for line in r.stdout.splitlines():
        m = _LIST_CTRLS_RE.match(line)
        if m:
            values[m.group(1)] = int(m.group(4))
    return values

# Last successfully read (sensor_width, sensor_height). See api_diagnostics.
_last_sensor_geometry = None

def v4l2_get_all(dev=None):
    # A single "--list-ctrls" call returns every control's current value in
    # one subprocess spawn (~60ms). The previous approach called v4l2_get()
    # once per control (~40 separate v4l2-ctl subprocess spawns, ~3s total) —
    # fine for a one-off fetch, but this is polled repeatedly by the UI's
    # background controls-sync timer, and that sustained subprocess churn was
    # starving the capture/encoder threads badly enough to stall the video
    # stream entirely (frames stop, FPS drops to null) under load, e.g. while
    # also dragging a slider for live preview.
    d = dev or state["control_device"]
    values = {}
    try:
        r = subprocess.run(["v4l2-ctl", "-d", d, "--list-ctrls"],
                           capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            m = _LIST_CTRLS_RE.match(line)
            if m:
                values[m.group(1)] = int(m.group(4))
                if m.group(2) is not None:
                    _hw_ranges[m.group(1)] = {"min": int(m.group(2)), "max": int(m.group(3))}
    except Exception as ex:
        log.warning("v4l2_get_all: %s", ex)
    # A couple of controls (currently just Digital Gain) live on the sensor
    # subdevice rather than this device — fetch those separately since
    # they're not part of the --list-ctrls dump above.
    # Subdevice controls are not in the ISP dump above, so their value AND
    # their declared range have to come from the sensor's own listing - the
    # imx477 reports digital_gain as 256..65535 while the imx568 reports
    # 0..1048576, so a hardcoded range would be wrong for one of them. The
    # range is what api_diagnostics reports as the digital-gain unity.
    # Per-camera gain routing: on imx568 the gain values/ranges come from the
    # ISP registers (already parsed from the control-device dump above), so map
    # them onto our control names and skip the sensor-subdevice override below.
    isp_gain = _ISP_GAIN_ON_IMX568 if _is_imx568() else {}
    for name, isp_name in isp_gain.items():
        if isp_name in values:
            values[name] = values[isp_name]
        if isp_name in _hw_ranges:
            _hw_ranges[name] = dict(_hw_ranges[isp_name])
    sdev = get_sensor_subdev()
    if sdev and SDEV_CONTROLS:
        try:
            rs = subprocess.run(["v4l2-ctl", "-d", sdev, "--list-ctrls"],
                                capture_output=True, text=True, timeout=5)
            for line in rs.stdout.splitlines():
                m = _LIST_CTRLS_RE.match(line)
                if not m:
                    continue
                for name, real_name in SDEV_CONTROLS.items():
                    if name in isp_gain:      # imx568: this control uses the ISP register
                        continue
                    if m.group(1) != real_name:
                        continue
                    values[name] = int(m.group(4))
                    if m.group(2) is not None:
                        _hw_ranges[name] = {"min": int(m.group(2)), "max": int(m.group(3))}
        except Exception as ex:
            log.warning("sensor subdev list: %s", ex)
    # Only replace cached entries that were genuinely present in this hardware
    # response. Missing entries retain their last known values; defaults are
    # used solely until a control has been read successfully for the first time.
    with _last_control_values_lock:
        _last_control_values.update(values)
        return {
            c: _last_control_values.get(c, CONTROLS[c]["default"])
            for c in CONTROLS
        }

# ── MJPEG streaming ────────────────────────────────────────────────────────────
# GStreamer's jpegenc element takes ~493ms/frame on this hardware regardless of
# quality or SIMD settings (measured with the latency tracer) — a fixed
# overhead unrelated to actual JPEG compute, capping the pipeline at ~2fps
# even though raw capture alone reaches ~23fps. Encoding the same frames in
# Python with OpenCV/libjpeg-turbo directly takes ~74ms/frame instead, and
# running several encode workers in parallel (this CPU has 16 cores) pushes
# throughput past the capture rate, so capture — not encoding — becomes the
# limit. GStreamer/libcamera is kept for capture only, since raw v4l2 can't
# perform the ISP's required 3A/IPA initialization.
# This ISP only allows one exclusive libcamerasrc capture session at a time,
# which is why the capture pipeline is a singleton (see _start_producer). It is
# NOT a reason to allow only one HTTP viewer: every connection reads the same
# shared encoded frame slot and none of them touch the camera, so any number of
# viewers can watch the one pipeline.
#
# An earlier server-side exclusivity lease conflated the two. It dated from the
# design where each /api/stream connection started its own gst-launch — there a
# second connection really did fail to acquire the camera and go blank. Once the
# producer became a singleton that reasoning no longer held, but the lease
# stayed and started refusing legitimate viewers with 409 "another live-view
# connection is already active": a second browser, a second machine, or a second
# tab showed "Stream unavailable — retrying" indefinitely while the first worked
# fine. Worse, the lease was released only by the generator's finally: and
# response.call_on_close(), neither of which is guaranteed to run under
# waitress, so a client that vanished uncleanly could wedge it permanently and
# lock out ALL viewers until the service restarted.
_stream_lock = threading.Lock()
_own_stream_pids = set()

# NV12 byte counts for the resolutions this pipeline realistically
# negotiates (imx477 sensor modes plus the usual scaler outputs), used to
# name the size actually delivered when it disagrees with what was asked for.
_KNOWN_NV12_SIZES = {
    w * h * 3 // 2: (w, h)
    for w, h in [(4056,3040),(3840,2160),(2592,1944),(2028,1520),(2028,1080),
                 (1920,1080),(1640,1232),(1456,1088),(1332,990),(1280,720),
                 (1024,768),(800,600),(640,480)]
}

def _probe_stream_size(default=(1920, 1080)):
    """Ask the ISP what resolution it is actually running at rather than
    assuming 1080p. Both the gst caps and the NV12 frame length derive from
    this, and they must agree with what libcamerasrc delivers: the reader
    drops every frame whose byte count doesn't match frame_len, so a
    hardcoded size that disagrees with the sensor discards 100% of frames
    and the view goes black with no error anywhere — exactly what a 720p
    sensor mode did against the previous hardcoded 1920x1080."""
    w, h = v4l2_get("sensor_width"), v4l2_get("sensor_height")
    if w and h and w > 0 and h > 0:
        return int(w), int(h)
    log.warning("stream: sensor_width/sensor_height unreadable, assuming %dx%d", *default)
    return default


# ── Shared capture producer ─────────────────────────────────────────────────
# The pipeline used to be owned by the HTTP response generator, so every
# /api/stream request tore the running pipeline down and built a new one. A
# browser reload is a fresh request, which meant reloading re-initialised the
# ISP's 3A context: every manual lock lapsed and White Balance, Gain Control
# and Color & Tone all reverted to algorithm-driven values. Re-applying the
# settings afterwards papered over that but always left a visible window.
#
# The pipeline is a singleton now. The first client starts it and it keeps
# running across client disconnects, so a reload just attaches a new reader
# to the pipeline that is already going: the ISP is never re-initialised, so
# there is nothing to restore and nothing to flicker. Encoded frames go to
# one shared slot that each client reads independently, which also means two
# browsers no longer fight over the camera.
_producer_lock = threading.Lock()
_producer = None

def _start_producer(width=None, height=None):
    """Build the capture pipeline and its worker threads. Caller must hold
    _producer_lock.

    Raw frames are distributed through a bounded queue, so each frame is
    encoded by exactly one worker. The old shared-latest-frame design let every
    encoder pick the same sequence number and waste CPU encoding duplicates.
    """
    import cv2
    import numpy as np

    if width is None or height is None:
        width, height = _probe_stream_size()
    num_encoders = stream_config["num_encoders"]
    frame_len = width * height * 3 // 2  # NV12 = 1 byte/px Y + 0.5 byte/px UV
    log.info("stream: starting pipeline %dx%d NV12 (%d bytes/frame, %d encoders)",
             width, height, frame_len, num_encoders)

    stop = threading.Event()
    # gst's fdsink corrupts the start of every raw buffer it writes to a pipe
    # (verified: multifilesink writing the identical buffers to separate files
    # is clean across 100+ frames, fdsink piped to stdout is not). Route around
    # it with a small rolling buffer of frame files on tmpfs.
    shm_dir = tempfile.mkdtemp(prefix="sima-mipi-util-", dir="/dev/shm")
    # libcamerasrc MUST be told which camera to open. Without camera-name it
    # takes whichever libcamera enumerates first, so with two cameras attached
    # the dropdown would switch state["stream_device"] and the ISP control node
    # correctly while the video kept coming from the other camera.
    src = ["libcamerasrc"]
    cam_name = get_current_camera_name()
    if cam_name:
        src.append(f"camera-name={cam_name}")
        log.info("stream: opening camera %r (%s)", cam_name, state["stream_device"])
    else:
        log.warning("stream: camera name unknown for %s — libcamerasrc will "
                    "pick its default, which may not be the selected camera",
                    state["stream_device"])
    cmd = ["gst-launch-1.0", "-q"] + src + ["!",
           f"video/x-raw,width={width},height={height},format=NV12", "!",
           "multifilesink", f"location={shm_dir}/frame_%d.raw", "max-files=4"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def _log_gst_stderr():
        try:
            for line in iter(proc.stderr.readline, b""):
                text = line.decode("utf-8", "replace").strip()
                if text:
                    log.warning("gst: %s", text)
        except Exception:
            pass
    threading.Thread(target=_log_gst_stderr, daemon=True).start()
    with _stream_lock:
        _own_stream_pids.add(proc.pid)

    # Keep latency bounded. If encoders temporarily fall behind, discard the
    # oldest queued frame rather than allowing seconds of stale video to build.
    frame_queue = queue.Queue(maxsize=max(2, num_encoders))
    jpeg_lock = threading.Lock()
    latest_jpeg = {"seq": 0, "data": None}

    def _enqueue_latest(item):
        try:
            frame_queue.put_nowait(item)
            return
        except queue.Full:
            pass
        try:
            frame_queue.get_nowait()  # drop one stale frame
        except queue.Empty:
            pass
        try:
            frame_queue.put_nowait(item)
        except queue.Full:
            # A worker raced us and the queue filled again. Dropping this frame
            # is preferable to blocking capture and increasing live-view latency.
            pass

    def reader():
        seq = 0
        last_idx = -1
        mismatch = 0
        last_enqueued_ts = 0.0
        try:
            while not stop.is_set():
                if proc.poll() is not None:
                    stop.set()
                    return
                files = glob.glob(f"{shm_dir}/frame_*.raw")
                if not files:
                    time.sleep(0.01)
                    continue
                indices = sorted(int(re.search(r'frame_(\d+)\.raw$', f).group(1)) for f in files)
                # Skip the newest index — multifilesink may still be writing it.
                candidate = indices[-2] if len(indices) >= 2 else None
                if candidate is None or candidate == last_idx:
                    time.sleep(0.005)
                    continue
                try:
                    with open(f"{shm_dir}/frame_{candidate}.raw", "rb") as fh:
                        frame = fh.read()
                except OSError:
                    continue

                # Mark the file consumed even when we deliberately FPS-throttle
                # it, otherwise the same on-disk frame would be reconsidered.
                last_idx = candidate
                if len(frame) != frame_len:
                    mismatch += 1
                    if mismatch == 1:
                        got = _KNOWN_NV12_SIZES.get(len(frame))
                        log.warning("stream: frame is %d bytes, expected %d (%dx%d)%s",
                                    len(frame), frame_len, width, height,
                                    " — that is %dx%d" % got if got else "")
                    elif mismatch >= 60:
                        log.error("stream: %d consecutive wrong-size frames, aborting", mismatch)
                        stop.set()
                        return
                    continue
                mismatch = 0

                # A complete, correctly-sized frame really arrived from the
                # ISP. Count it HERE — before the throttle below and before
                # encoding — so capture rate reflects what the hardware
                # delivers, independent of what we choose to forward.
                _record_capture_frame()

                # Apply target_fps before JPEG encoding. This makes a lower FPS
                # setting reduce CPU load as well as network/browser delivery.
                target_fps = max(1, int(stream_config.get("target_fps", 30)))
                min_interval = 1.0 / target_fps
                now = time.monotonic()
                if last_enqueued_ts and now - last_enqueued_ts < min_interval:
                    continue
                last_enqueued_ts = now

                seq += 1
                _enqueue_latest((seq, frame))
        except Exception as ex:
            log.warning("libcamera reader: %s", ex)
            stop.set()

    def encoder():
        while not stop.is_set():
            try:
                seq, data = frame_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                yuv = np.frombuffer(data, dtype=np.uint8).reshape((height * 3 // 2, width))
                bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12)
                quality = int(stream_config.get("jpeg_quality", 85))
                ok, jpg = cv2.imencode(".jpg", bgr,
                                       [cv2.IMWRITE_JPEG_QUALITY, quality])
            except Exception as ex:
                log.warning("libcamera encoder: %s", ex)
                continue
            if not ok:
                continue
            # Workers can finish out of order. Only publish a newer sequence;
            # count FPS here so multiple HTTP viewers do not multiply the rate.
            with jpeg_lock:
                if seq > latest_jpeg["seq"]:
                    latest_jpeg["seq"] = seq
                    latest_jpeg["data"] = jpg.tobytes()
                    _record_frame()

    threads = [threading.Thread(target=reader, daemon=True)]
    threads += [threading.Thread(target=encoder, daemon=True)
                for _ in range(num_encoders)]
    for t in threads:
        t.start()

    # A genuine pipeline start still re-initialises the ISP, so remembered
    # settings are re-asserted here. With the producer shared this runs once at
    # first connect and on an actual pipeline rebuild, not on browser reload.
    def _restore_after_init():
        time.sleep(2.5)
        if stop.is_set():
            return
        live = resolve_live_control_device()
        if live and live != state["control_device"]:
            log.info("control device corrected: %s -> %s (live ISP context)",
                     state["control_device"], live)
            state["control_device"] = live
        elif not live:
            log.warning("no ISP context reports sensor_streaming=1 — keeping %s",
                        state["control_device"])
        try:
            _reapply_desired()
        except Exception as ex:
            log.warning("re-apply after pipeline start failed: %s", ex)
        finally:
            # Publish controls only after this camera's restore attempt is over;
            # even a failed individual control must not leave the UI waiting
            # forever.
            if not stop.is_set():
                _camera_controls_ready.set()
    threading.Thread(target=_restore_after_init, daemon=True).start()

    return {"proc": proc, "stop": stop, "shm_dir": shm_dir, "clients": 0,
            "jpeg_lock": jpeg_lock, "latest_jpeg": latest_jpeg,
            "width": width, "height": height}

def _stop_producer():
    """Tear the shared pipeline down. Used on device change and shutdown —
    not on client disconnect, which is the whole point of the singleton."""
    global _producer
    with _producer_lock:
        prod, _producer = _producer, None
    if not prod:
        return
    prod["stop"].set()
    proc = prod["proc"]
    try:
        proc.kill(); proc.wait(timeout=2)
    except Exception:
        pass
    with _stream_lock:
        _own_stream_pids.discard(proc.pid)
    # rmtree rather than glob+rmdir: multifilesink keeps writing between the
    # two, so rmdir hit ENOTEMPTY and the error was swallowed, stranding ~12MB
    # of tmpfs per teardown (119MB observed across 14 orphaned directories).
    shutil.rmtree(prod["shm_dir"], ignore_errors=True)
    log.info("stream: pipeline stopped")

def _ensure_producer():
    """Return the running producer, starting or rebuilding it if needed."""
    global _producer
    with _producer_lock:
        prod = _producer
        if prod is not None:
            if not prod["stop"].is_set() and prod["proc"].poll() is None:
                return prod
            log.info("stream: producer died, rebuilding")
    # Leave _producer set here so _stop_producer() below can actually see the
    # stale producer and tear it down. Nulling it before the call makes
    # _stop_producer() a no-op (it returns early when the global is None),
    # which leaks the old gst-launch process — it can keep the camera
    # exclusively held and block recovery until the service is restarted.
    _stop_producer()
    with _producer_lock:
        if _producer is None:
            _producer = _start_producer()
            reset_fps_session()
        return _producer

def _libcamera_encoded_stream():
    """Per-client MJPEG generator. Owns no hardware — it only reads the
    shared producer's latest encoded frame, so disconnecting (or reloading
    the page) leaves the pipeline and the ISP completely untouched."""
    prod = _ensure_producer()
    with _producer_lock:
        prod["clients"] += 1
        log.info("stream: client connected (%d active)", prod["clients"])
    last_seq = 0
    last_yield_ts = 0.0
    try:
        while not prod["stop"].is_set():
            with prod["jpeg_lock"]:
                seq, jpg = prod["latest_jpeg"]["seq"], prod["latest_jpeg"]["data"]
            if jpg is None or seq == last_seq:
                time.sleep(0.003)
                continue
            # Read target_fps fresh every frame so dragging the FPS slider
            # throttles the stream already running instead of only taking
            # effect on the next reconnect.
            target_fps = stream_config.get("target_fps", 30)
            min_interval = 1.0 / target_fps if target_fps > 0 else 0
            now = time.monotonic()
            if now - last_yield_ts < min_interval:
                time.sleep(0.002)
                continue
            last_seq = seq
            last_yield_ts = now
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
    finally:
        with _producer_lock:
            prod["clients"] = max(0, prod["clients"] - 1)
            log.info("stream: client disconnected (%d active) — pipeline left running",
                     prod["clients"])

def _release_camera_access(client_id):
    global _camera_access_owner
    with _camera_access_lock:
        remaining = max(0, _camera_access_counts.get(client_id, 1) - 1)
        if remaining:
            _camera_access_counts[client_id] = remaining
        else:
            _camera_access_counts.pop(client_id, None)
            if _camera_access_owner == client_id:
                _camera_access_owner = None
                log.info("camera access released by %s", client_id)

def _owned_encoded_stream(client_id):
    try:
        yield from _libcamera_encoded_stream()
    finally:
        _release_camera_access(client_id)



# ── CORS ───────────────────────────────────────────────────────────────────────
@app.after_request
def _cors(r):
    # No wildcard: same-origin (page served by this device) needs no CORS
    # headers at all, and advertising "*" let any browser page on the LAN
    # drive the controls. Emit an allow-origin only when an operator has
    # explicitly opted a specific origin in.
    if ALLOWED_ORIGIN:
        r.headers["Access-Control-Allow-Origin"]  = ALLOWED_ORIGIN
        r.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        r.headers["Access-Control-Allow-Headers"] = "Content-Type,X-Auth-Token,X-Camera-Client"
        r.headers["Vary"] = "Origin"
    return r

@app.route("/options", methods=["OPTIONS"])
@app.route("/<path:p>", methods=["OPTIONS"])
def _opt(p=""): return _cors(jsonify({}))

# ── Routes ─────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    ui = Path(__file__).parent / "camera_ui.html"
    body = ui.read_text() if ui.exists() else "camera_ui.html not found"
    # No cache headers were set here before, which left it up to the browser's
    # own heuristics — Chrome in particular can silently reuse a cached copy
    # of this page across ordinary reloads, so a UI fix can be live on the
    # server yet invisible to the user until a hard refresh. Force revalidation
    # every load instead of guessing at browser cache behavior.
    resp = Response(body, mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp

@app.route("/api/cameras")
def api_cameras():
    cams = discover_cameras()
    return jsonify({"cameras": cams, "stream_device": state["stream_device"],
                    "control_device": state["control_device"]})

@app.route("/api/control_devices")
def api_control_devices():
    return jsonify({"control_devices": list_out_devices(),
                    "control_device": state["control_device"]})

_STREAM_DEV_RE  = re.compile(r'^/dev/video\d+$')
_CONTROL_DEV_RE = re.compile(r'^/dev/video\d+out$')

@app.route("/api/device", methods=["POST"])
@_serialized_hardware
def api_set_device():
    camera_changed = False
    control_changed = False
    data, error = _json_object()
    if error:
        return error
    with _lock:
        if "camera" in data:
            cam = data["camera"]
            if not isinstance(cam, str) or not _STREAM_DEV_RE.match(cam):
                return jsonify({"ok": False, "error": "invalid camera device"}), 400
            if cam != state["stream_device"]:
                state["stream_device"] = cam
                state["control_device"] = ctrl_dev(cam)
                state["camera_name"] = None  # force a fresh lookup for the new camera
                camera_changed = True
        if "control_device" in data:
            cd = data["control_device"]
            if not isinstance(cd, str) or not _CONTROL_DEV_RE.match(cd):
                return jsonify({"ok": False, "error": "invalid control device"}), 400
            if cd != state["control_device"]:
                state["control_device"] = cd
                control_changed = True

    global _sensor_subdev, _capability_cache
    if camera_changed:
        _camera_controls_ready.clear()
        # A different camera can have a different sensor subdevice and ranges.
        with _sensor_subdev_lock:
            _sensor_subdev = None
        _hw_ranges.clear()
        with _last_control_values_lock:
            _last_control_values.clear()
        _capability_cache = {}
        # A different sensor has its own timing registers, so the computed
        # frame rate must be recomputed rather than carried over.
        invalidate_sensor_fps()
        # The new camera may run a different mode, so the remembered geometry
        # is no longer a safe stand-in for a failed read.
        global _last_sensor_geometry
        _last_sensor_geometry = None
        log.info("camera changed — cleared subdev/range caches and stopping "
                 "the shared pipeline so it rebuilds")
        _stop_producer()
    elif control_changed:
        # Changing only the control node does not require restarting capture,
        # but ranges must be rediscovered for the new control endpoint.
        _hw_ranges.clear()
        with _last_control_values_lock:
            _last_control_values.clear()
        _capability_cache = {}
        log.info("control device changed — cleared hardware range cache")

    log.info("devices → stream=%s  control=%s", state["stream_device"], state["control_device"])
    return jsonify({"ok": True, "changed": camera_changed or control_changed, **state})

@app.route("/api/stream")
def api_stream():
    global _camera_access_owner
    # The ?device= parameter is ADVISORY. It is still format-validated (reject a
    # malformed device string defensively rather than trusting client input),
    # but a value that merely disagrees with the currently selected camera is
    # not an error: the live view always shows the selected camera.
    #
    # This used to 409 on a mismatch. The page appends ?device=<its own idea of
    # the camera> to the <img> src on every (re)connect, so any moment where the
    # page's copy lagged the server's — the reload right after Set Default, a
    # camera switch, a tab left open — produced a 409, the <img> failed, and the
    # user got "Stream unavailable — retrying..." with a Start button over a
    # camera that was streaming perfectly well.
    requested = request.args.get("device")
    if requested is not None:
        if not isinstance(requested, str) or not _STREAM_DEV_RE.match(requested):
            return jsonify({"ok": False, "error": "invalid device"}), 400
        if requested != state["stream_device"]:
            log.info("stream: ?device=%s differs from selected %s — serving the "
                     "selected camera", requested, state["stream_device"])
    client_id = _camera_client_id()
    with _camera_access_lock:
        if _camera_access_owner not in (None, client_id):
            return jsonify({"ok": False, "error": "camera is in use by another user"}), 423
        _camera_access_owner = client_id
        _camera_access_counts[client_id] = _camera_access_counts.get(client_id, 0) + 1
    return Response(_owned_encoded_stream(client_id),
                    mimetype="multipart/x-mixed-replace; boundary=frame")

# For most controls, the device's own declared VIDIOC_QUERYCTRL min/max
# (see _hw_ranges above) is the authoritative range — and that stays true
# automatically for whatever camera is currently connected, since _hw_ranges
# is fetched live from that camera's own v4l2-ctl output, not hardcoded.
#
# current_exposure is a confirmed exception, but specifically for the
# imx477 5-001a unit tested on this device — NOT a general truth about
# every possible camera. Direct v4l2-ctl writes (bypassing this app
# entirely) track correctly and proportionally all the way up to
# ~1,000,000,000 (confirmed at 2M, 5M, 10M, 50M, 500M), but the device's
# declared max of 2,147,483,647 is itself the lie: there's a real firmware
# overflow right around 2^30 (1,073,741,824) — 1,073,741,823 lands oddly,
# and 1,200,000,000 catastrophically wraps to 64. That's a defect in THIS
# camera's specific firmware build, not something we can assume applies to
# a different camera ever connected here — so this override is keyed by
# camera model. A different, untested camera gets its own device-reported
# range trusted fully, with no override applied, until/unless it's
# separately tested and found to need one of its own.
_HW_RANGE_OVERRIDES_BY_CAMERA = {
    "imx477 5-001a": {
        "current_exposure": {"max": 1000000000},
    },
    # Independently verified on this second camera too (same sweep test:
    # proportional and correct up to 1,000,000,000; breaks at the same
    # ~2^30 boundary, landing on the same stuck value 1,073,660,374). Since
    # current_exposure is an ISP-side register rather than anything
    # sensor-specific, this looks like a platform/ISP-firmware defect that
    # may affect any sensor on this ISP — but keeping this keyed per-camera
    # rather than making it a blanket default until a third camera confirms
    # the pattern, per the "verify, don't assume" approach we've been using.
    "imx568 5-0042": {
        "current_exposure": {"max": 1000000000},
    },
}

# Hardware metadata exposes system_awb_cct as a raw uint16 (0..65535), but
# the ISP AWB algorithm rejects extreme values even with manual AWB engaged.
# Both sensors were verified to accept and retain normal CCT values in this range.
_APP_RANGE_LIMITS = {
    "system_awb_cct": {"min": 2000, "max": 10000},
}

def _camera_range_overrides(name):
    """Overrides registered for this camera, matched on SENSOR MODEL.

    The keys in _HW_RANGE_OVERRIDES_BY_CAMERA carry a full v4l2 name like
    "imx477 5-001a", where the suffix is the I2C adapter and address the sensor
    happens to sit on. That suffix is a property of how the board is wired, not
    of the sensor — this very board reports "imx477 6-001a" (adapter 6, not 5),
    so an exact-match lookup silently found nothing and the current_exposure
    safe-max cap never applied. The UI then offered the full declared 2^31-1,
    which walks straight into the documented firmware overflow just above 2^30
    (1,200,000,000 wraps to 64).

    Match on the model token instead, so a camera keeps its verified override
    wherever it is wired. Still an explicit per-model registry rather than a
    blanket default — an untested sensor gets its own declared range trusted,
    exactly as before."""
    if not name:
        return {}
    model = name.split()[0].lower()
    for key, overrides in _HW_RANGE_OVERRIDES_BY_CAMERA.items():
        if key.split()[0].lower() == model:
            return overrides
    return {}

def effective_range(ctrl):
    """The single source of truth for a control's usable min/max: start from
    CONTROLS' own declaration, prefer the device's real VIDIOC_QUERYCTRL
    range where we have one, then apply any override registered for the
    CURRENTLY CONNECTED camera model (see _HW_RANGE_OVERRIDES_BY_CAMERA) for
    controls where even that camera's declared range is confirmed wrong.
    Used by both api_controls() (what the UI displays) and
    api_set()/api_set_many() (what's actually allowed) so the two can never
    disagree again — that exact mismatch (UI offering up to
    current_exposure's device-declared 2^31-1 while validation silently
    still enforced a stale, never-updated 2,000,000 from CONTROLS) is why
    writes above 2M were being rejected with no visible explanation while
    the slider implied they'd work."""
    m = CONTROLS[ctrl]
    lo, hi = m["min"], m["max"]
    hw = _hw_ranges.get(ctrl)
    if hw:
        lo, hi = hw["min"], hw["max"]
    cam_overrides = _camera_range_overrides(get_current_camera_name())
    ov = cam_overrides.get(ctrl)
    if ov and ctrl not in SDEV_CONTROLS:
        lo = ov.get("min", lo)
        hi = ov.get("max", hi)
    app_limit = _APP_RANGE_LIMITS.get(ctrl)
    if app_limit:
        lo = max(lo, app_limit.get("min", lo))
        hi = min(hi, app_limit.get("max", hi))
    return lo, hi

@app.route("/api/controls")
def api_controls():
    # During a camera switch, the active ISP context initially contains values
    # left by the previous sensor. Wait for the new pipeline's restore pass so
    # those transient shared values never appear as this camera's GUI settings.
    _camera_controls_ready.wait(timeout=5)
    return _api_controls_snapshot()

@_serialized_hardware
def _api_controls_snapshot():
    vals = v4l2_get_all()
    def merged(c, m):
        lo, hi = effective_range(c)
        return {**m, "value": vals[c], "min": lo, "max": hi}
    return jsonify({c: merged(c, m) for c, m in CONTROLS.items()})

@app.route("/api/diagnostics")
def api_diagnostics():
    # ONE --list-ctrls spawn per device instead of one per control. This used to
    # fire eleven separate v4l2-ctl subprocesses every poll (every 4s by
    # default, alongside the controls poll and the capture threads). Under that
    # contention individual reads returned non-zero, v4l2_get() turned that into
    # None, and the UI blanked the field — which is why Resolution kept
    # disappearing for a few seconds and coming back. Same consolidation already
    # applied to v4l2_get_all() for exactly this reason.
    result = {}
    vals = v4l2_list_values(state["control_device"])
    for c in DIAG_CONTROLS:
        result[c] = vals.get(c)

    # Sensor geometry is fixed for a given mode, so a failed read means "we
    # could not ask right now", not "the resolution changed". Serve the last
    # known value instead of a null the UI would render as "-". Cleared on
    # camera change, where the mode genuinely can differ.
    global _last_sensor_geometry
    w, h = result.get("sensor_width"), result.get("sensor_height")
    if w and h:
        _last_sensor_geometry = (w, h)
    elif _last_sensor_geometry:
        result["sensor_width"], result["sensor_height"] = _last_sensor_geometry

    sdev = get_sensor_subdev()
    svals = v4l2_list_values(sdev) if sdev else {}
    result["vertical_blanking"] = svals.get("vertical_blanking")
    result["horizontal_blanking"] = svals.get("horizontal_blanking")
    result["digital_gain_raw"] = svals.get("digital_gain")
    # The UI used to divide digital_gain_raw by a hardcoded 256, which is the
    # imx477's unity. The imx568 declares 0..1048576 where 256 means nothing,
    # so the panel showed a meaningless multiplier. Send the sensor's own
    # declared minimum as the unity reference: >0 means the register is a
    # multiplier scaled to that value, 0/absent means there is no unity to
    # divide by and the raw number is all we can honestly show.
    dg = _hw_ranges.get("sdev_digital_gain")
    result["digital_gain_unity"] = dg["min"] if dg and dg["min"] else None
    result["link_frequency_hz"] = get_link_frequency_hz()
    return jsonify(result)

# Some target controls are silently clamped to a paired "ceiling" register's
# CURRENT value instead of erroring or being rejected (confirmed directly:
# writing e.g. system_iridix_strength_target above system_maximum_iridix_strength
# just clamps down to the ceiling with no indication anything happened — see
# the same finding already worked around in api_detect_capabilities). Without
# this, dragging a slider past its ceiling silently stops having any visible
# effect partway through the slider's own declared range, which looks
# indistinguishable from "decreasing/increasing this doesn't work." Widen the
# ceiling to match whenever a write would exceed it, so the full declared
# range of the target slider is always actually reachable.
_CEILING_PAIRS = {
    "system_iridix_strength_target": "system_maximum_iridix_strength",
}

def _ensure_ceiling(ctrl, val):
    ceiling_ctrl = _CEILING_PAIRS.get(ctrl)
    if not ceiling_ctrl:
        return
    current_ceiling = v4l2_get(ceiling_ctrl)
    if current_ceiling is not None and val > current_ceiling:
        v4l2_set(ceiling_ctrl, val)

# Gain routing is per-camera. On the imx477 the sensor subdevice registers
# (analogue_gain/digital_gain) are the working path. On the imx568 those
# registers accept and hold a write but the ISP overrides the actual applied
# gain, so gain must read/write the ISP register on the control device instead.
# Maps our CONTROLS name -> the ISP register name on state["control_device"].
_ISP_GAIN_ON_IMX568 = {
    "sensor_analog_gain": "sensor_analog_gain",
    "sdev_digital_gain":  "sensor_digital_gain",
}

def _is_imx568():
    return "imx568" in (get_current_camera_name() or "").lower()

def _routed_target(ctrl):
    """(device, v4l2_name) for a control, honouring per-camera gain routing:
    imx568 -> ISP register on the control device; imx477 (and any SDEV_CONTROLS
    entry) -> sensor subdevice; everything else -> control device under its own
    name. device is None only when a sensor-routed control needs the subdev but
    it cannot be resolved."""
    if _is_imx568() and ctrl in _ISP_GAIN_ON_IMX568:
        return state["control_device"], _ISP_GAIN_ON_IMX568[ctrl]
    real_name = SDEV_CONTROLS.get(ctrl)
    if real_name:
        return get_sensor_subdev(), real_name
    return state["control_device"], ctrl

def _v4l2_set_routed(ctrl, val):
    """v4l2_set(), redirected to whichever device/register the current camera
    uses for this control (see _routed_target)."""
    dev, name = _routed_target(ctrl)
    if not dev:
        return False, "sensor subdevice unavailable"
    return v4l2_set(name, val, dev=dev)

def _v4l2_get_routed(ctrl):
    """v4l2_get()'s counterpart to _v4l2_set_routed — reads from the same
    device/register the routed setter writes, so reads and writes stay on the
    same node (per camera)."""
    dev, name = _routed_target(ctrl)
    if not dev:
        return None
    return v4l2_get(name, dev=dev)

@app.route("/api/set", methods=["POST"])
@_serialized_hardware
def api_set():
    d, error = _json_object()
    if error:
        return error
    context_error = _camera_context_error(d)
    if context_error:
        return context_error
    ctrl, val = d.get("control"), d.get("value")
    if ctrl not in CONTROLS:
        return jsonify({"ok": False, "error": f"Unknown: {ctrl}"}), 400
    m = CONTROLS[ctrl]
    try:
        ival = int(val)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "value must be an integer"}), 400
    lo, hi = effective_range(ctrl)
    if not (lo <= ival <= hi):
        return jsonify({"ok": False, "error": "Out of range"}), 400
    _ensure_ceiling(ctrl, ival)
    ok, err = _v4l2_set_verified(ctrl, ival)
    return jsonify({"ok": ok, "error": err, "restart": m.get("restart", False)})

@app.route("/api/set_many", methods=["POST"])
@_serialized_hardware
def api_set_many():
    d, error = _json_object()
    if error:
        return error
    context_error = _camera_context_error(d)
    if context_error:
        return context_error
    controls = d.get("controls", {})
    if not isinstance(controls, dict):
        return jsonify({"ok": False, "error": "controls must be an object"}), 400
    results, restart = {}, False
    for ctrl, val in controls.items():
        if ctrl not in CONTROLS:
            results[ctrl] = {"ok": False, "error": "unknown"}; continue
        try:
            ival = int(val)
        except (TypeError, ValueError):
            results[ctrl] = {"ok": False, "error": "value must be an integer"}; continue
        lo, hi = effective_range(ctrl)
        if not (lo <= ival <= hi):
            results[ctrl] = {"ok": False, "error": "Out of range"}; continue
        _ensure_ceiling(ctrl, ival)
        ok, err = _v4l2_set_verified(ctrl, ival)
        results[ctrl] = {"ok": ok, "error": err}
        if ok and CONTROLS[ctrl].get("restart"):
            restart = True
    return jsonify({"results": results, "restart_required": restart})

# Maps a value control to the manual-lock control that gates whether the
# ISP's auto algorithm is allowed to freely compute it. Writing an explicit
# value can pin the algorithm to that number even once the lock reports
# "auto" — observed with AWB: writing system_awb_cct froze white balance at
# a flat, uncorrected value indefinitely, even though en_manual_awb read
# back as 0. Reset should only write the value when the paired lock's
# default is manual (on); if the lock's default is auto, leave the value
# alone so the algorithm stays genuinely free-running.
_AUTO_LOCK_PAIRS = {
    "awb_red_gain": "en_manual_awb",
    "awb_blue_gain": "en_manual_awb",
    "system_awb_cct": "en_manual_awb",
    "current_exposure": "en_manual_exposure",
    "sensor_analog_gain": "en_manual_sensor_analog_gain",
    "syst_direct_sharpening_target": "syst_man_direct_sharpening",
    "syst_un_direct_sharp_target": "syst_man_un_direct_sharpening",
    "system_saturation_target": "en_manual_saturation",
    "system_sinter_threshold_target": "en_manual_sinter",
    "system_minimum_iridix_strength": "en_manual_iridix",
    "system_maximum_iridix_strength": "en_manual_iridix",
    "system_iridix_strength_target": "en_manual_iridix",
    "sensor_digital_gain": "en_manual_sensor_digital_gain",
    "max_sensor_digital_gain": "en_manual_sensor_digital_gain",
    "max_integration_time": "en_manual_max_integration_time",
    "maximum_exposure_ratio": "en_manual_exposure_ratio",
    "current_exposure_ratio": "en_manual_exposure_ratio",
}

# Writes to a control paired with an auto-algorithm lock are silently
# ignored whenever that algorithm is actually running — v4l2-ctl returns
# success, the value simply never lands. Worse, the lock register is itself
# volatile: en_manual_awb reads back 1 while the AWB algorithm is provably
# still overwriting awb_red_gain, so "is the lock on?" cannot be answered by
# reading it. Manual mode lapses on its own and the only way to re-arm it is
# an explicit 0->1 toggle.
#
# Confirmed on this device: with en_manual_awb reading 1, two consecutive
# writes of 450 and 700 both returned ok and both left the hardware sitting
# at ~303, drifting. After a 0->1 kick the identical write landed on 450 and
# held for 15+ seconds, and a follow-up write of 350 landed with no new kick.
#
# So don't trust the write or the lock readback — verify the value actually
# took, and if it didn't, kick the lock and write again. A spurious retry
# (readback raced the write) is harmless: it re-arms and rewrites the same
# value. This is what made UI sliders appear dead while reporting success,
# and it is almost certainly what the original "the ISP ignores writes /
# values drift on their own" notes were actually describing.
def _v4l2_set_verified(ctrl, val):
    """Write a value and confirm it landed.

    A manual lock's state belongs to the USER. This function may RE-ARM a lock
    the user already switched on (the registers are volatile — manual mode
    lapses on its own and only an explicit 0->1 toggle re-engages it, which is
    why the kick exists at all), but it must never switch a lock ON that the
    user left off. It used to do exactly that: a value write that didn't stick
    engaged the lock and left it engaged, so moving a single slider silently
    flipped its toggle on in the UI with no user action — reproduced directly:
    after a Set Default with every lock off, writing system_saturation_target
    alone left en_manual_saturation reading 1.

    When the lock is off, the ISP's auto algorithm owns that control and the
    write genuinely cannot stick. Say so plainly instead of quietly taking the
    control away from the algorithm."""
    ok, err = _do_set_verified(ctrl, val)
    if ok:
        # Persist only writes that actually took. A rejected value (lock off,
        # auto override) must not land in the settings file, or
        # _reapply_desired() would quietly apply it on the next pipeline
        # rebuild as if it had succeeded.
        _remember(ctrl, val)
    return ok, err


def _do_set_verified(ctrl, val):
    ok, err = _v4l2_set_routed(ctrl, val)
    lock = _AUTO_LOCK_PAIRS.get(ctrl)
    # imx568 digital gain routes to the ISP sensor_digital_gain register, which
    # is gated by en_manual_sensor_digital_gain — an internal lock with no UI
    # toggle. sdev_digital_gain has no _AUTO_LOCK_PAIRS entry, so without this
    # the write lands unlocked and the ISP auto algorithm overwrites it
    # ("digital gain won't apply"). Engage that internal lock (0->1) and retry.
    if lock is None and ok and _is_imx568() and ctrl == "sdev_digital_gain":
        if _v4l2_get_routed(ctrl) == val:
            return True, err
        # Freshly kicking the lock briefly lets AE run, which can race the write,
        # so retry a few times — once the lock is stably armed it holds.
        for _ in range(3):
            v4l2_set("en_manual_sensor_digital_gain", 0)
            v4l2_set("en_manual_sensor_digital_gain", 1)
            ok, err = _v4l2_set_routed(ctrl, val)
            if ok and _v4l2_get_routed(ctrl) == val:
                return ok, err
        return False, f"{ctrl} rejected by ISP (auto override)"
    if not ok or lock is None:
        return ok, err
    if _v4l2_get_routed(ctrl) == val:
        return True, err

    if v4l2_get(lock) != 1:
        # Lock is off — auto owns this control. Do not engage it behind the
        # user's back; report why the value did not take.
        meta = CONTROLS.get(lock, {})
        return False, (f"{ctrl} was not applied because {meta.get('label', lock)} "
                       f"is off — the ISP's automatic algorithm is controlling it. "
                       f"Turn that lock on to set this value manually.")

    # Lock is already on: re-arm it (0->1) and retry. This ends with the lock
    # in the state the user chose, so nothing changes from their point of view.
    log.info("set %s=%s did not take, re-arming %s (already on) and retrying", ctrl, val, lock)
    v4l2_set(lock, 0)
    v4l2_set(lock, 1)
    ok, err = _v4l2_set_routed(ctrl, val)
    if ok and _v4l2_get_routed(ctrl) != val:
        return False, f"{ctrl} rejected by ISP (auto override)"
    return ok, err


# ── Desired state ───────────────────────────────────────────────────────────
# Restarting the capture pipeline re-initialises the ISP's 3A context and
# every manual lock lapses at once: the auto algorithms take back over and
# White Balance / Gain Control / Color & Tone all snap to algorithm-driven
# values. The lock registers keep reading 1 throughout (they are volatile —
# see _v4l2_set_verified), so nothing in the system notices it happened.
#
# A camera switch (and a service restart or a producer crash) rebuilds the
# pipeline, so anything the user dialled in on that camera would be lost unless
# we re-assert it. A plain browser reload does NOT rebuild the pipeline — it is a
# singleton that survives client disconnects (see the shared-producer block) — so
# a reload leaves the ISP untouched and needs no restore.
#
# Remember what was asked for and re-assert it once the new pipeline is up.
# This stores intent, not readback: the readback of a lapsed control is the
# algorithm's own output, so snapshotting the hardware at teardown would
# capture drift rather than the user's setting.
_desired_lock = threading.Lock()
# Remembered settings are filed PER CAMERA. imx477 and imx568 stream through
# different ISP contexts, so a single shared dict would re-apply one camera's
# adjustments onto the other on the next pipeline restart — the "same setting
# shows up on both cameras" bug. Key by camera identity instead, so returning to
# a camera restores what was set on it and nothing leaks across.
# This product currently supports exactly two camera inputs. Keep two explicit
# stores so a discovery-name change or shared ISP context can never collapse
# both cameras onto the same settings record.
_desired_by_camera = {"imx477": {}, "imx568": {}}
_LOCK_NAMES = set(_AUTO_LOCK_PAIRS.values())
CAMERA_SETTINGS_FILE = os.environ.get(
    "SIMA_MIPI_UTIL_CAMERA_SETTINGS_FILE",
    "/var/lib/sima-mipi-util/camera-settings.json",
)

def _save_desired_settings(snapshot=None):
    """Atomically persist camera-specific intent across service/device restarts."""
    try:
        if snapshot is None:
            with _desired_lock:
                snapshot = {k: dict(v) for k, v in _desired_by_camera.items()}
        path = Path(CAMERA_SETTINGS_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(snapshot, fh, sort_keys=True, indent=2)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception as ex:
        log.warning("could not persist per-camera settings to %s: %s",
                    CAMERA_SETTINGS_FILE, ex)

def _load_desired_settings():
    try:
        with open(CAMERA_SETTINGS_FILE, encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("top level must be an object")
        loaded = {"imx477": {}, "imx568": {}}
        for camera, controls in raw.items():
            if not isinstance(camera, str) or not isinstance(controls, dict):
                continue
            clean = {}
            for ctrl, val in controls.items():
                if ctrl in CONTROLS and ctrl not in _NEVER_REMEMBER:
                    try:
                        clean[ctrl] = int(val)
                    except (TypeError, ValueError):
                        continue
            # Accept the old full-name schema as a one-time migration, but
            # normalize all runtime/persisted state to exactly two fixed slots.
            lower = camera.lower()
            slot = ("imx477" if "imx477" in lower else
                    "imx568" if "imx568" in lower else None)
            if slot:
                loaded[slot].update(clean)
        with _desired_lock:
            _desired_by_camera.clear()
            _desired_by_camera.update(loaded)
        # Rewrite immediately so a legacy full camera-name key cannot remain on
        # disk and later be mistaken for a third store.
        _save_desired_settings(loaded)
        log.info("loaded settings for %d camera(s) from %s",
                 len(loaded), CAMERA_SETTINGS_FILE)
    except FileNotFoundError:
        # Materialize both empty slots immediately. Besides making the schema
        # explicit, this gives installation/device checks a direct indication
        # that persistence is active before the first user edit.
        _save_desired_settings({"imx477": {}, "imx568": {}})
        return
    except Exception as ex:
        log.warning("could not load per-camera settings from %s: %s",
                    CAMERA_SETTINGS_FILE, ex)

# Controls deliberately never remembered or auto-restored:
#   isp_sensor_preset  — flagged restart:True, re-applying it would reboot
#                        the device on every browser reload.
#   isp_test_pattern*  — replaces the whole picture with a synthetic pattern;
#                        silently restoring that after a reload would look
#                        like the camera had broken.
_NEVER_REMEMBER = {"isp_sensor_preset", "isp_test_pattern", "isp_test_pattern_type"}

def _remember(ctrl, val):
    """Record every control the user actually writes. This used to cover only
    the 17 controls in _AUTO_LOCK_PAIRS, so anything outside that set (tone
    mapping, digital gain, ...) was changed by the user, never remembered,
    and silently lost on the next browser reload. Restoring a control the
    pipeline restart happened not to disturb is harmless — it writes back the
    value it already holds — whereas omitting one loses the user's work."""
    if ctrl in _NEVER_REMEMBER:
        return
    if CONTROLS.get(ctrl, {}).get("restart"):
        return
    key = _camera_key()   # resolved before taking the lock
    with _desired_lock:
        _desired_by_camera.setdefault(key, {})[ctrl] = val
        snapshot = {k: dict(v) for k, v in _desired_by_camera.items()}
    _save_desired_settings(snapshot)

def _camera_key():
    """Fixed settings slot for the two supported camera inputs."""
    dev = state.get("stream_device")
    if dev == "/dev/video0":
        return "imx477"
    if dev == "/dev/video1":
        return "imx568"
    # Defensive fallback if device numbering changes unexpectedly: model name
    # still maps to one of the same two stores, never a third dynamic key.
    try:
        name = (get_current_camera_name() or "").lower()
    except Exception:
        name = ""
    return "imx568" if "imx568" in name else "imx477"

def forget_desired(camera=None):
    """Drop remembered settings for one camera (default: the current one), so
    resetting/Set-Default on one camera leaves the other's settings intact."""
    key = camera or _camera_key()
    with _desired_lock:
        _desired_by_camera.pop(key, None)
        snapshot = {k: dict(v) for k, v in _desired_by_camera.items()}
    _save_desired_settings(snapshot)

_load_desired_settings()


# ── Re-apply audit log ──────────────────────────────────────────────────────
# A plain-text record of exactly what gets restored after each pipeline
# restart (i.e. every browser reload), written somewhere obvious rather than
# buried in journalctl among the per-second poller lines. Each entry shows
# the value the ISP reset the control to, the value being restored, and the
# readback afterwards — so a restore that silently failed is visible rather
# than assumed.
REAPPLY_LOG = "/var/log/sima-mipi-util-reapply.log"
_reapply_log_lock = threading.Lock()

def _audit(lines):
    """Append a block to REAPPLY_LOG. Rotates at ~1 MB so it can't grow
    without bound on a long-running device. Never raises — an audit log
    failing must not take the stream down with it."""
    try:
        with _reapply_log_lock:
            try:
                if os.path.exists(REAPPLY_LOG) and os.path.getsize(REAPPLY_LOG) > 1_000_000:
                    os.replace(REAPPLY_LOG, REAPPLY_LOG + ".1")
            except OSError:
                pass
            with open(REAPPLY_LOG, "a", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
    except Exception as ex:
        log.warning("could not write %s: %s", REAPPLY_LOG, ex)

@_serialized_hardware
def _reapply_desired():
    """Re-assert remembered settings after the pipeline re-initialises the
    ISP. Locks are kicked 0->1 first (a lock that merely reads 1 is not
    necessarily armed), then each value goes through the verifying setter so
    a write that still doesn't land is logged rather than assumed."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    key = _camera_key()
    with _desired_lock:
        mine = dict(_desired_by_camera.get(key, {}))
        # The ISP reuses a single processing context across camera switches, so a
        # control another camera changed carries its value straight into this
        # camera's live context — that is the "same setting shows up on both
        # cameras" bug. Reset any control that SOME OTHER camera set but this one
        # hasn't, back to its default, so nothing bleeds across cameras.
        other = set()
        for k, d in _desired_by_camera.items():
            if k != key:
                other |= set(d)
    to_reset = {c: CONTROLS[c]["default"] for c in other
                if c not in mine and c in CONTROLS
                and c not in _NEVER_REMEMBER and not CONTROLS[c].get("restart")}
    want = dict(to_reset)
    want.update(mine)   # this camera's own remembered values win over a reset
    if not want:
        _audit(["", "=" * 78,
                f"{ts}  pipeline restart  [{key}]",
                "  nothing remembered yet — no settings changed in this session,",
                "  so there is nothing to restore. Controls are at ISP defaults.",
                "=" * 78])
        return

    lines = ["", "=" * 78,
             f"{ts}  pipeline (re)start  [{key}]",
             f"  restoring {len(want)} remembered setting(s): "
             f"{len([c for c in want if c in _LOCK_NAMES])} lock(s) + "
             f"{len([c for c in want if c not in _LOCK_NAMES])} value(s)",
             "-" * 78,
             f"  {'CONTROL':<34}{'AFTER RESET':>12}{'RESTORING':>12}{'READBACK':>11}  RESULT"]

    # What the pipeline restart left them at, before we touch anything.
    before = {c: _v4l2_get_routed(c) for c in want}

    # Set the manual-lock state to EXACTLY what THIS camera wants: arm the locks
    # it remembered ON, and release every other lock. Releasing the rest is what
    # stops a lock the OTHER camera engaged from leaking onto this one — the ISP
    # reuses a single processing context across camera switches, so a lock left
    # armed carries straight over ("same manual setting shows up on both
    # cameras"). A value remembered while its lock was off was on auto anyway, so
    # there is nothing to restore for it.
    needed = {c for c in want if c in _LOCK_NAMES and want[c] == 1}
    release = [lock for lock in _LOCK_NAMES if lock not in needed]
    for lock in needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)
        lines.append(f"  {lock:<34}{str(before.get(lock,'?')):>12}{'0->1 kick':>12}"
                     f"{str(v4l2_get(lock)):>11}  LOCK ARMED")
    for lock in release:
        prev = v4l2_get(lock)
        v4l2_set(lock, 0)
        # Only audit the ones that were actually engaged (i.e. leaked from the
        # other camera) — releasing an already-off lock is a silent no-op.
        if prev == 1:
            lines.append(f"  {lock:<34}{str(prev):>12}{'-> 0 auto':>12}"
                         f"{str(v4l2_get(lock)):>11}  LOCK RELEASED")
    # Ceiling registers reset along with everything else, and a target
    # written while its ceiling is still at the reset value gets silently
    # clamped down to it (confirmed: iridix strength 190 landed as 64
    # because system_maximum_iridix_strength had gone back to 64). Restore
    # any remembered ceilings first, then use the same _ensure_ceiling()
    # path api_set() uses so a target above its ceiling raises it.
    ceilings = set(_CEILING_PAIRS.values())
    ordered = ([c for c in want if c in ceilings] +
               [c for c in want if c not in ceilings])
    restored = failed = 0
    for ctrl in ordered:
        val = want[ctrl]
        if ctrl in _LOCK_NAMES:
            continue  # handled by the arm/release loops above
        # A control this camera did NOT set but another did, whose manual lock we
        # just released, is back on auto — do not write a manual default for it:
        # _v4l2_set_verified would find the write didn't take and kick the lock
        # 0->1, re-arming exactly what we just released. Let the algorithm own it.
        # Controls with no auto-lock still need an explicit reset (no algorithm
        # will reclaim them).
        if ctrl not in mine and ctrl in _AUTO_LOCK_PAIRS:
            continue
        _ensure_ceiling(ctrl, val)
        ok, err = _v4l2_set_verified(ctrl, val)
        actual = _v4l2_get_routed(ctrl)
        good = ok and actual == val
        if good:
            restored += 1
        else:
            failed += 1
        lines.append(f"  {ctrl:<34}{str(before.get(ctrl,'?')):>12}{val:>12}{str(actual):>11}  "
                     + ("OK" if good else "FAILED" + (f" ({err})" if err else "")))

    lines += ["-" * 78,
              f"  result: {restored} value(s) restored, {failed} failed, "
              f"{len(needed)} lock(s) armed",
              "=" * 78]
    _audit(lines)
    log.info("re-applied %d setting(s) after pipeline start (%d failed) — detail in %s",
             restored, failed, REAPPLY_LOG)


# Controls left out of automatic support-detection: isp_sensor_preset is
# flagged restart:True (triggers a full reboot — far too disruptive to probe
# automatically), and the test-pattern controls replace the entire live
# picture with a synthetic pattern while active, which is a much bigger
# visible disruption than every other control's brief flicker-and-restore.
_DETECTION_SKIP = {"isp_sensor_preset", "isp_test_pattern", "isp_test_pattern_type"}

_capability_cache = {}

def _pick_test_value(meta, current):
    lo, hi = meta["min"], meta["max"]
    if meta.get("type") == "bool":
        return 0 if current == 1 else 1
    if meta.get("type") == "menu" and "options" in meta:
        keys = sorted(int(k) for k in meta["options"])
        others = [k for k in keys if k != current]
        return others[0] if others else current
    if hi <= lo:
        return current
    # Cap the step: some controls report a raw C int32 max (e.g. 2147483647)
    # as their declared range, and 10% of that is a value the sensor would
    # reject regardless of whether the control is genuinely usable within
    # its real operating range — that's a bad test, not a real "unsupported".
    step = max(1, min((hi - lo) // 10, 5000))
    candidate = current + step
    if candidate > hi:
        candidate = current - step
    return max(lo, min(hi, candidate))

def _values_roughly_match(meta, a, b):
    if meta.get("type") in ("bool", "menu"):
        return a == b
    span = max(1, meta["max"] - meta["min"])
    tol = max(2, span * 0.02)
    return abs(a - b) <= tol

def _get_with_retry(c):
    # Routed get so SDEV_CONTROLS entries are probed on the sensor subdevice,
    # matching the routed setter used for the write half of detection/reset.
    v = _v4l2_get_routed(c)
    return v if v is not None else _v4l2_get_routed(c)  # one retry for a transient hiccup

def _detect_one(c):
    meta = CONTROLS[c]
    original = _get_with_retry(c)
    if original is None:
        return {"supported": False, "reason": "unreadable"}
    test_val = _pick_test_value(meta, original)
    ok, err = _v4l2_set_routed(c, test_val)
    readback = _get_with_retry(c) if ok else None
    supported = bool(ok and readback is not None and _values_roughly_match(meta, readback, test_val))
    _v4l2_set_routed(c, original)
    return {"supported": supported}

@app.route("/api/detect_capabilities", methods=["POST"])
@_serialized_hardware
def api_detect_capabilities():
    # Groups controls by whichever manual lock gates them so each lock gets
    # engaged and restored exactly once, instead of once per control.
    # Locks themselves are NOT independently flip-tested before their group —
    # an earlier version did that and produced flaky false negatives (e.g.
    # system_sinter_threshold_target passed or failed depending on run):
    # toggling a lock off/on right before testing its own dependents left it
    # not reliably "manual" yet even though the register read back correctly,
    # the same class of timing issue documented on _AUTO_LOCK_PAIRS. A lock's
    # own support is instead verified by confirming the engage-to-1 write for
    # its group actually took hold.
    global _capability_cache
    results = {}
    lock_names = set(_AUTO_LOCK_PAIRS.values())
    by_lock, unlocked = {}, []
    for c in CONTROLS:
        if c in _DETECTION_SKIP or c in lock_names:
            continue
        lock = _AUTO_LOCK_PAIRS.get(c)
        if lock:
            by_lock.setdefault(lock, []).append(c)
        else:
            unlocked.append(c)

    for c in unlocked:
        results[c] = _detect_one(c)

    for lock, controls in by_lock.items():
        orig_lock = _get_with_retry(lock)
        v4l2_set(lock, 1)
        engaged = _get_with_retry(lock) == 1
        results[lock] = {"supported": bool(engaged)}
        for c in controls:
            if not engaged:
                results[c] = {"supported": False, "reason": "lock not engageable"}
                continue
            if c == "system_iridix_strength_target":
                # This control's valid range is capped by whatever
                # system_maximum_iridix_strength currently is — confirmed
                # directly: writing a target above the current max silently
                # clamps down to max instead of erroring. A naive
                # write-then-compare test here misreads that clamp as
                # "unsupported" whenever max happens to be lower than the
                # chosen test value. Widen the ceiling first so the test
                # value can't get clamped, then restore it.
                max_orig = _get_with_retry("system_maximum_iridix_strength")
                v4l2_set("system_maximum_iridix_strength", 255)
                results[c] = _detect_one(c)
                if max_orig is not None:
                    v4l2_set("system_maximum_iridix_strength", max_orig)
            else:
                results[c] = _detect_one(c)
        if orig_lock is not None and orig_lock != 1:
            v4l2_set(lock, orig_lock)

    # Covers any lock control that isn't paired with dependent value controls
    # (shouldn't normally happen, but keeps every CONTROLS entry accounted for)
    for c in lock_names:
        if c not in results and c in CONTROLS and c not in _DETECTION_SKIP:
            results[c] = _detect_one(c)

    for c in _DETECTION_SKIP:
        if c in CONTROLS:
            results[c] = {"supported": None, "reason": "not tested (disruptive)"}

    _capability_cache = results
    return jsonify({"ok": True, "results": results})

@app.route("/api/capabilities")
def api_capabilities():
    return jsonify(_capability_cache)

@app.route("/api/reset", methods=["POST"])
@_serialized_hardware
def api_reset():
    # Reset to the known Raw/Unprocessed baseline where it defines a value and
    # to CONTROLS defaults elsewhere. Manual-lock controls use the same
    # engage/write/kick/verified-rewrite sequence used by presets so the values
    # actually land instead of being immediately overwritten by auto algorithms.
    # Controls marked restart=True are deliberately excluded: Reset All must
    # never reboot/restart the platform as a side effect.
    raw_values = _PRESETS["raw"]

    def _reset_target(c):
        return raw_values.get(c, CONTROLS[c]["default"])

    locked_controls = set(_AUTO_LOCK_PAIRS.keys())
    locks_needed = set(_AUTO_LOCK_PAIRS.values())
    results = {}
    lock_results = {}

    for lock in locks_needed:
        ok, err = v4l2_set(lock, 1)
        lock_results[lock] = {"ok": ok, "error": err or None}

    # First landing pass, followed by the known 0->1 lock kick.
    for c in locked_controls:
        target = _reset_target(c)
        _ensure_ceiling(c, target)
        _v4l2_set_routed(c, target)
    for lock in locks_needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)

    # Final authoritative pass with routed readback verification.
    for c in locked_controls:
        target = _reset_target(c)
        lo, hi = effective_range(c)
        if not (lo <= int(target) <= hi):
            results[c] = {"ok": False,
                          "error": f"reset value {target} outside effective range {lo}..{hi}"}
            continue
        _ensure_ceiling(c, target)
        ok, err = _v4l2_set_verified(c, target)
        actual = _v4l2_get_routed(c)
        good = bool(ok and actual == target)
        results[c] = {"ok": good,
                      "error": (err or None) if good
                               else (err or f"readback {actual}, expected {target}"),
                      "readback": actual}

    # Reset all remaining ordinary controls. Sensor-subdevice controls go
    # through the routed helper. Restart-triggering controls are skipped.
    for c, m in CONTROLS.items():
        if c in locked_controls or c in locks_needed:
            continue
        if m.get("restart"):
            results[c] = {"ok": True, "skipped": True,
                          "reason": "restart-triggering control is not changed by Reset All"}
            continue
        target = m["default"]
        lo, hi = effective_range(c)
        if not (lo <= int(target) <= hi):
            results[c] = {"ok": False,
                          "error": f"reset value {target} outside effective range {lo}..{hi}"}
            continue
        ok, err = _v4l2_set_routed(c, target)
        actual = _v4l2_get_routed(c)
        # If a driver exposes a write-only control, a successful write with no
        # readable value is accepted; otherwise require exact readback.
        good = bool(ok and (actual is None or actual == target))
        results[c] = {"ok": good,
                      "error": (err or None) if good
                               else (err or f"readback {actual}, expected {target}"),
                      "readback": actual}

    # Return every control to automatic operation. Releasing a manual lock
    # (back to its default of 0) hands that control back to the ISP's own
    # AWB/AE/gain/iridix algorithms so the picture auto-corrects — without this
    # the camera stays pinned to the raw baseline in manual mode and never
    # clears (observed dark/uncorrected on imx477). "Set Default" means every
    # manual toggle ends up off, with no exceptions: a reset that silently
    # leaves one lock engaged is indistinguishable, in the UI, from a reset
    # that failed to release it.
    #
    # Exposure used to be excluded here and re-pinned in manual afterwards.
    # That existed only because current_exposure was routed to the sensor
    # subdevice at the time, where releasing the other locks made 3A drive the
    # sensor's exposure register to its ceiling (the "landed on 2175 instead of
    # the default" note — 2175 is the imx477 exposure register's own max, not
    # an ISP value). current_exposure is an ISP register again, so it resets
    # and releases exactly like every other locked control, in the verified
    # pass above.
    for lock in locks_needed:
        ok, err = v4l2_set(lock, 0)
        lock_results[lock] = {"ok": ok, "error": err or None, "released": True}

    # Drop remembered intent as well, or the next pipeline restart would
    # re-assert the settings this reset just cleared.
    forget_desired()
    failed = {c: r for c, r in results.items() if not r.get("ok")}
    return jsonify({"ok": not failed, "results": results,
                    "lock_writes": lock_results, "failed": failed})

# Each preset control needs its manual-lock toggle enabled first, or the
# ISP's auto algorithm (AWB/saturation/sharpening/sinter/iridix) overwrites
# the preset's value on the very next frame — the value write "succeeds"
# but visibly reverts almost immediately.
_PRESET_LOCKS = {
    "awb_red_gain": "en_manual_awb",
    "awb_blue_gain": "en_manual_awb",
    "system_awb_cct": "en_manual_awb",
    "system_saturation_target": "en_manual_saturation",
    "syst_direct_sharpening_target": "syst_man_direct_sharpening",
    "syst_un_direct_sharp_target": "syst_man_un_direct_sharpening",
    "system_sinter_threshold_target": "en_manual_sinter",
    "system_maximum_iridix_strength": "en_manual_iridix",
    "system_minimum_iridix_strength": "en_manual_iridix",
}

@app.route("/api/preset/<name>", methods=["POST"])
@_serialized_hardware
def api_preset(name):
    if name not in _PRESETS:
        return jsonify({"ok": False, "error": f"Unknown preset: {name}"}), 400

    values = _PRESETS[name]
    locks_needed = {_PRESET_LOCKS[c] for c in values if c in _PRESET_LOCKS}
    results = {}
    lock_results = {}

    # Arm manual modes first. Some firmware reports the lock as 1 even when the
    # algorithm is still active, so lock readback is not used as success proof;
    # the final value readbacks below are authoritative.
    for lock in locks_needed:
        ok, err = v4l2_set(lock, 1)
        lock_results[lock] = {"ok": ok, "error": err or None}

    # Preserve the established unstick sequence: a preset write can pin a
    # control until its lock is toggled. First land the values, kick the locks,
    # then land and verify every value again through the central routed path.
    for c, v in values.items():
        _ensure_ceiling(c, v)
        _v4l2_set_routed(c, v)
    for lock in locks_needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)

    for c, v in values.items():
        lo, hi = effective_range(c)
        if not (lo <= int(v) <= hi):
            results[c] = {"ok": False,
                          "error": f"preset value {v} outside effective range {lo}..{hi}"}
            continue
        _ensure_ceiling(c, v)
        ok, err = _v4l2_set_verified(c, v)
        actual = _v4l2_get_routed(c)
        results[c] = {"ok": bool(ok and actual == v),
                      "error": (err or None) if ok and actual == v
                               else (err or f"readback {actual}, expected {v}"),
                      "readback": actual}

    failed = {c: r for c, r in results.items() if not r.get("ok")}
    return jsonify({"ok": not failed, "preset": name,
                    "results": results, "lock_writes": lock_results,
                    "failed": failed})

@app.route("/api/restart", methods=["POST"])
def api_restart():
    # Token-gated (see _require_token) — only "service" is honoured. Full
    # device reboot has been deliberately removed from this root-run web
    # process: letting an HTTP caller reboot the board is too dangerous even
    # with auth, and the earlier "any non-'service' value reboots" default
    # meant a stray/empty POST could take the whole device down.
    data, error = _json_object()
    if error:
        return error
    rtype = data.get("type")
    if rtype == "service":
        subprocess.Popen(["systemctl", "restart", "sima-mipi-util"])
        return jsonify({"ok": True, "message": "Service restarting..."})
    if rtype == "system":
        return jsonify({"ok": False,
                        "error": "system reboot is disabled over the web API; "
                                 "reboot from an SSH/console session instead"}), 403
    return jsonify({"ok": False, "error": "type must be 'service'"}), 400

@app.route("/api/status")
def api_status():
    # camera_owned_by_other lets the UI show a clear "in use by another user"
    # popup: it's True when another client currently owns the camera lease
    # (relative to this requester's X-Camera-Client id). The <img> stream can't
    # read the 423 status itself, so the UI polls this instead.
    return jsonify({"ok": True, "camera_owned_by_other": _camera_owner_conflict(),
                    **state})

@app.route("/api/stream_fps")
def api_stream_fps():
    # Rates along the same pipeline, so a drop can be located rather than just
    # observed:
    #   sensor_fps  — measured frames/s arriving from the sensor via the ISP
    #   nominal_fps — the sensor's register-derived rate, when it corroborates
    #                 the measurement (None when the driver reports placeholder
    #                 timing — see get_sensor_rates)
    #   fps         — encoded frames reaching the browser (throttled by
    #                 target_fps and limited by JPEG encode throughput)
    sensor_fps, nominal_fps = get_sensor_rates()
    return jsonify({"fps": get_stream_fps(),
                    "avg_fps": get_avg_fps(),
                    "sensor_fps": sensor_fps,
                    "nominal_fps": nominal_fps})

@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        return jsonify(stream_config)
    data, error = _json_object()
    if error:
        return error
    updated = {}
    with _lock:
        for key, (lo, hi) in _STREAM_CONFIG_BOUNDS.items():
            if key not in data:
                continue
            try:
                val = int(data[key])
            except (TypeError, ValueError):
                return jsonify({"ok": False, "error": f"{key} must be an integer"}), 400
            if not (lo <= val <= hi):
                return jsonify({"ok": False, "error": f"{key} must be between {lo} and {hi}"}), 400
            stream_config[key] = val
            updated[key] = val
    log.info("settings updated: %s", updated)
    return jsonify({"ok": True, "settings": stream_config,
                     "note": "target_fps and jpeg_quality apply immediately; num_encoders applies on the next producer rebuild",
                     "producer_restart_required": "num_encoders" in updated})

@app.route("/api/health")
def api_health():
    result = {"status": "ok", "cpu_percent": None, "memory_percent": None, "temperature_c": None}
    try:
        def _cpu():
            with open('/proc/stat') as f:
                fields1 = [float(x) for x in f.readline().split()[1:]]
            time.sleep(0.15)
            with open('/proc/stat') as f:
                fields2 = [float(x) for x in f.readline().split()[1:]]
            idle = fields2[3] - fields1[3]
            total = sum(fields2) - sum(fields1)
            return round(100.0 * (1.0 - idle / total), 1) if total else 0.0
        result["cpu_percent"] = _cpu()
    except Exception as e:
        log.debug("health cpu: %s", e)
    try:
        mem = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1)
                mem[k.strip()] = int(v.strip().split()[0])
        total = mem.get('MemTotal', 0)
        avail = mem.get('MemAvailable', 0)
        if total:
            result["memory_percent"] = round(100.0 * (total - avail) / total, 1)
    except Exception as e:
        log.debug("health mem: %s", e)
    try:
        with open('/sys/class/thermal/thermal_zone0/temp') as f:
            result["temperature_c"] = int(f.read().strip()) // 1000
    except Exception as e:
        log.debug("health temp: %s", e)
    return jsonify(result)

if __name__ == "__main__":
    host = os.environ.get("SIMA_MIPI_UTIL_HOST", "0.0.0.0")
    port = int(os.environ.get("SIMA_MIPI_UTIL_PORT", "5000"))
    if AUTH_TOKEN is None:
        if os.environ.get("SIMA_MIPI_UTIL_REQUIRE_AUTH", "1") == "0":
            log.warning("no auth token at %s — state-changing endpoints are explicitly "
                        "UNPROTECTED because SIMA_MIPI_UTIL_REQUIRE_AUTH=0", AUTH_TOKEN_FILE)
        else:
            log.error("no auth token at %s — state-changing endpoints will return 503 "
                      "until a token is provisioned", AUTH_TOKEN_FILE)
    log.info("Starting on %s:%d  stream=%s  control=%s", host, port,
             state["stream_device"], state["control_device"])
    # Serve behind waitress rather than Werkzeug's dev server (not intended for
    # production / hostile networks). threads sized for several long-lived MJPEG
    # stream responses plus concurrent control/poll requests; channel_timeout is
    # kept high so an actively-streaming connection isn't reaped as "idle".
    try:
        from waitress import serve
    except ImportError:
        log.warning("waitress not installed; falling back to the Flask dev server")
        app.run(host=host, port=port, debug=False, threaded=True)
    else:
        serve(app, host=host, port=port, threads=24, channel_timeout=300)
