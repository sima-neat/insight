#!/usr/bin/env python3
"""cam-settings-tools — Web UI for IMX477 ISP on Modalix. Serves http://<device-ip>:5000"""

import os, re, glob, time, threading, subprocess, logging, collections, queue, tempfile, shutil
from pathlib import Path
from flask import Flask, request, jsonify, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cam-settings")
app = Flask(__name__)

_lock = threading.Lock()
state = {"stream_device": "/dev/video0", "control_device": "/dev/video0out", "camera_name": None}

# User-adjustable stream tuning (Settings panel). Read fresh by each new
# stream connection — an in-progress stream keeps its own worker threads and
# isn't reconfigured live, but the next connection picks up new values.
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
# every momentary slowdown/speedup. Reset whenever a genuinely new stream
# session starts (see _libcamera_encoded_stream) so switching channels or
# reconnecting doesn't average across an unrelated previous session.
_session_start = None
_session_frames = 0

def _record_frame():
    global _session_frames
    with _frame_lock:
        _frame_times.append(time.time())
        _session_frames += 1

def get_stream_fps():
    with _frame_lock:
        times = list(_frame_times)
    if len(times) < 2 or time.time() - times[-1] > 3:
        return None
    span = times[-1] - times[0]
    return round((len(times) - 1) / span, 1) if span > 0 else None

def get_avg_fps():
    with _frame_lock:
        start, n = _session_start, _session_frames
    if start is None or n == 0:
        return None
    elapsed = time.time() - start
    return round(n / elapsed, 1) if elapsed > 0 else None

def reset_fps_session():
    global _session_start, _session_frames
    with _frame_lock:
        _session_start = time.time()
        _session_frames = 0

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
    # NOTE: current_integration_time is read-only on this ISP (its live v4l2
    # range is reported as min=0 max=0 — writes are silently dropped).
    # current_exposure is the control that actually drives real exposure
    # changes (verified: setting it moves current_integration_time
    # proportionally). Bound the slider to that instead.
    "current_exposure":               {"min":0,"max":2000000,  "default":100000,"label":"Exposure Time"},
    "max_integration_time":           {"min":0,"max":1000000, "default":5000,"label":"Max Integration Time"},
    # Daily · Analog Gain
    "en_manual_sensor_analog_gain":   {"min":0,"max":1,       "default":0,   "label":"Manual Analog Gain Lock",   "type":"bool"},
    "sensor_analog_gain":             {"min":0,"max":255,     "default":0,   "label":"Analog Gain"},
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
SENSOR_SUBDEV = "/dev/v4l-subdev2"

# Controls that live on SENSOR_SUBDEV instead of the default ISP control
# device, keyed by our CONTROLS dict name -> the control's real v4l2 name on
# that subdevice (they can differ; e.g. our "sdev_digital_gain" is just
# "digital_gain" on the subdevice — kept distinct from CONTROLS' existing
# "sensor_digital_gain" key, which is the different, confirmed-dead ISP-side
# register). api_set()/api_set_many()/v4l2_get_all() all check this map to
# route reads/writes to the right device instead of assuming everything
# lives on state["control_device"].
SDEV_CONTROLS = {
    "sdev_digital_gain": "digital_gain",
}

def get_link_frequency_hz():
    """link_frequency is an intmenu control — v4l2-ctl prints the selected
    index plus the real Hz value in parens, e.g. "0 (450000000 0x1ad27480)"."""
    try:
        r = subprocess.run(["v4l2-ctl", "-d", SENSOR_SUBDEV, "--get-ctrl", "link_frequency"],
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

def ctrl_dev(stream):
    m = re.match(r'^(/dev/video)(\d+)$', stream)
    return f"{m.group(1)}{m.group(2)}out" if m else stream

def discover_cameras():
    cameras = []
    try:
        r = subprocess.run(["cam", "-l"], capture_output=True, text=True, timeout=6)
        combined = r.stdout + r.stderr
        if "Available cameras" in combined:
            for line in combined.splitlines():
                m = re.match(r'\s*(\d+):\s*\(([^)]+)\)', line)
                if m:
                    idx = int(m.group(1)) - 1
                    dev = f"/dev/video{idx}"
                    if os.path.exists(dev):
                        driver = ""
                        try:
                            ri = subprocess.run(["v4l2-ctl", "-d", dev, "--info"],
                                                capture_output=True, text=True, timeout=3)
                            for ln in ri.stdout.splitlines():
                                if "Driver name" in ln:
                                    driver = ln.split(":", 1)[1].strip(); break
                        except Exception:
                            pass
                        cameras.append({"device": dev, "name": m.group(2), "driver": driver,
                                        "busy": is_device_busy(dev), "index": idx})
            if cameras:
                return cameras
    except Exception:
        pass
    for dev in sorted(glob.glob("/dev/video*")):
        if re.match(r'^/dev/video\d+$', dev):
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
    for name, real_name in SDEV_CONTROLS.items():
        v = v4l2_get(real_name, dev=SENSOR_SUBDEV)
        if v is not None:
            values[name] = v
    return {c: values.get(c, CONTROLS[c]["default"]) for c in CONTROLS}

# ── MJPEG streaming ────────────────────────────────────────────────────────────
_BLANK_JPEG = bytes([
    0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
    0x00,0x01,0x00,0x00,0xff,0xdb,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
    0x07,0x07,0x07,0x09,0x09,0x08,0x0a,0x0c,0x14,0x0d,0x0c,0x0b,0x0b,0x0c,0x19,0x12,
    0x13,0x0f,0x14,0x1d,0x1a,0x1f,0x1e,0x1d,0x1a,0x1c,0x1c,0x20,0x24,0x2e,0x27,0x20,
    0x22,0x2c,0x23,0x1c,0x1c,0x28,0x37,0x29,0x2c,0x30,0x31,0x34,0x34,0x34,0x1f,0x27,
    0x39,0x3d,0x38,0x32,0x3c,0x2e,0x33,0x34,0x32,0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,
    0x00,0x01,0x01,0x01,0x11,0x00,0xff,0xc4,0x00,0x1f,0x00,0x00,0x01,0x05,0x01,0x01,
    0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
    0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0xff,0xc4,0x00,0xb5,0x10,0x00,0x02,0x01,0x03,
    0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7d,0x01,0x02,0x03,0x00,
    0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,
    0x81,0x91,0xa1,0x08,0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,0x24,0x33,0x62,0x72,
    0x82,0x09,0x0a,0x16,0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,0x29,0x2a,0x34,0x35,
    0x36,0x37,0x38,0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,0x4a,0x53,0x54,0x55,
    0x56,0x57,0x58,0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,0x6a,0x73,0x74,0x75,
    0x76,0x77,0x78,0x79,0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x92,0x93,0x94,
    0x95,0x96,0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,
    0xb3,0xb4,0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,
    0xca,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,
    0xe7,0xe8,0xe9,0xea,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa,0xff,0xda,
    0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0xfb,0xd3,0xff,0xd9,
])

# GStreamer's jpegenc element takes ~493ms/frame on this hardware regardless of
# quality or SIMD settings (measured with the latency tracer) — a fixed
# overhead unrelated to actual JPEG compute, capping the pipeline at ~2fps
# even though raw capture alone reaches ~23fps. Encoding the same frames in
# Python with OpenCV/libjpeg-turbo directly takes ~74ms/frame instead, and
# running several encode workers in parallel (this CPU has 16 cores) pushes
# throughput past the capture rate, so capture — not encoding — becomes the
# limit. GStreamer/libcamera is kept for capture only, since raw v4l2 can't
# perform the ISP's required 3A/IPA initialization.
# This ISP only allows one exclusive libcamerasrc capture session at a time.
# Every place the UI reassigns the stream <img> src (Apply, the fullscreen
# quality bump, the stall watchdog) opens a NEW /api/stream connection, and
# browsers don't always close the OLD multipart connection immediately — so
# two generator instances can briefly overlap. When that happens, the SECOND
# gst-launch fails to acquire the camera and silently produces nothing:
# its reader() thread finds an empty tmpfs dir forever, the response never
# yields a single frame, and the <img> (now pointed at that connection)
# goes blank — while the abandoned first connection, still holding the
# camera, keeps running invisibly. Verified directly: with one real viewer
# connected, a second concurrent /api/stream request received zero bytes
# for its entire duration. Enforce exclusivity server-side instead of
# hoping the client tears down cleanly in time.
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
# settings afterwards papered over that but always left a visible window, and
# could never recover system_awb_cct at all (a read-only status register the
# ISP computes — writes to it are discarded).
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
    _producer_lock."""
    import cv2
    import numpy as np

    if width is None or height is None:
        width, height = _probe_stream_size()
    num_encoders = stream_config["num_encoders"]
    frame_len = width * height * 3 // 2  # NV12 = 1 byte/px Y + 0.5 byte/px UV
    log.info("stream: starting pipeline %dx%d NV12 (%d bytes/frame)", width, height, frame_len)

    stop = threading.Event()
    # gst's fdsink corrupts the start of every raw buffer it writes to a pipe
    # (verified: multifilesink writing the identical buffers to separate files
    # is clean across 100+ frames, fdsink piped to stdout is not). Route around
    # it with a small rolling buffer of frame files on tmpfs.
    shm_dir = tempfile.mkdtemp(prefix="cam-settings-tools-", dir="/dev/shm")
    cmd = ["gst-launch-1.0","-q","libcamerasrc","!",
           f"video/x-raw,width={width},height={height},format=NV12","!",
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
    _own_stream_pids.add(proc.pid)

    latest_lock = threading.Lock()
    latest = {"seq": 0, "data": None}
    jpeg_lock = threading.Lock()
    latest_jpeg = {"seq": 0, "data": None}

    def reader():
        seq = 0
        last_idx = -1
        mismatch = 0
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
                # skip the newest index — multifilesink may still be writing it
                candidate = indices[-2] if len(indices) >= 2 else None
                if candidate is None or candidate == last_idx:
                    time.sleep(0.005)
                    continue
                try:
                    with open(f"{shm_dir}/frame_{candidate}.raw", "rb") as fh:
                        frame = fh.read()
                except OSError:
                    continue
                if len(frame) != frame_len:
                    # An occasional mismatch is a torn read or a file that
                    # rotated out mid-read. A persistent one means the
                    # negotiated resolution is not the requested one, and
                    # skipping forever would be a silent black stream.
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
                last_idx = candidate
                seq += 1
                with latest_lock:
                    latest["seq"] = seq
                    latest["data"] = frame
        except Exception as ex:
            log.warning("libcamera reader: %s", ex)
            stop.set()

    def encoder():
        last_seq = 0
        while not stop.is_set():
            with latest_lock:
                seq, data = latest["seq"], latest["data"]
            if data is None or seq == last_seq:
                time.sleep(0.005)
                continue
            last_seq = seq
            try:
                yuv = np.frombuffer(data, dtype=np.uint8).reshape((height * 3 // 2, width))
                bgr = cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR_NV12)
                ok, jpg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY,
                                                     stream_config["jpeg_quality"]])
            except Exception as ex:
                log.warning("libcamera encoder: %s", ex)
                continue
            if not ok:
                continue
            # Publish to the shared slot instead of a queue, so any number of
            # clients can read the same frame. Monotonic guard: a slower
            # worker must not overwrite a newer frame with a stale one.
            with jpeg_lock:
                if seq > latest_jpeg["seq"]:
                    latest_jpeg["seq"] = seq
                    latest_jpeg["data"] = jpg.tobytes()

    threads = [threading.Thread(target=reader, daemon=True)]
    threads += [threading.Thread(target=encoder, daemon=True) for _ in range(num_encoders)]
    for t in threads:
        t.start()

    # A genuine pipeline start still re-initialises the ISP, so remembered
    # settings are re-asserted here. With the producer shared this now runs
    # once at first connect (and on an explicit device change) rather than on
    # every reload.
    def _restore_after_init():
        time.sleep(2.5)
        if stop.is_set():
            return
        try:
            _reapply_desired()
        except Exception as ex:
            log.warning("re-apply after pipeline start failed: %s", ex)
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
            _producer = None
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
            _record_frame()
    finally:
        with _producer_lock:
            prod["clients"] = max(0, prod["clients"] - 1)
            log.info("stream: client disconnected (%d active) — pipeline left running",
                     prod["clients"])

def stream_generator(device):
    if re.match(r'^/dev/video\d+$', device):
        # This ISP requires libcamera's IPA to upload calibration data and start
        # the 3A/AWB context before the hardware will emit frames — raw v4l2
        # capture (ffmpeg/v4l2src) fails ISP firmware use-case negotiation.
        yield from _libcamera_encoded_stream()
        return
    cmds = [
        # Native MJPEG input (fastest path)
        ["ffmpeg","-loglevel","fatal","-f","v4l2","-input_format","mjpeg",
         "-i",device,"-f","mjpeg","-q:v","5","pipe:1"],
        # Auto-detect format (YUYV etc.)
        ["ffmpeg","-loglevel","fatal","-f","v4l2",
         "-i",device,"-f","mjpeg","-q:v","5","pipe:1"],
        # BGRA32 — ISP output format used by Modalix pipeline
        ["ffmpeg","-loglevel","fatal","-f","v4l2","-pixel_format","bgra",
         "-i",device,"-f","mjpeg","-q:v","5","pipe:1"],
        # NV12 — common on ISP pipelines
        ["ffmpeg","-loglevel","fatal","-f","v4l2","-pixel_format","nv12",
         "-i",device,"-f","mjpeg","-q:v","5","pipe:1"],
        # YUYV with explicit resolution hint
        ["ffmpeg","-loglevel","fatal","-f","v4l2","-pixel_format","yuyv422",
         "-video_size","1280x720","-i",device,"-f","mjpeg","-q:v","5","pipe:1"],
        # GStreamer fallback
        ["gst-launch-1.0","-q","v4l2src",f"device={device}","!",
         "videoconvert","!","jpegenc","!","multipartmux","boundary=frame","!",
         "fdsink","fd=1"],
    ]
    for cmd in cmds:
        proc = None
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            buf, got = b"", False
            while True:
                chunk = proc.stdout.read(65536)
                if not chunk: break
                buf += chunk
                while True:
                    s = buf.find(b"\xff\xd8")
                    if s == -1: buf = b""; break
                    e = buf.find(b"\xff\xd9", s+2)
                    if e == -1: buf = buf[s:]; break
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + buf[s:e+2] + b"\r\n"
                    buf = buf[e+2:]; got = True
                    _record_frame()
            if got: return
        except Exception as ex:
            log.warning("stream: %s", ex)
        finally:
            if proc:
                try: proc.kill(); proc.wait(timeout=2)
                except: pass
    # No capture method worked — keep connection alive with blank frames so the
    # browser doesn't fire onerror; the JS retry timer will reconnect later.
    while True:
        yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + _BLANK_JPEG + b"\r\n"
        time.sleep(3)

# ── CORS ───────────────────────────────────────────────────────────────────────
@app.after_request
def _cors(r):
    r.headers["Access-Control-Allow-Origin"]  = "*"
    r.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    r.headers["Access-Control-Allow-Headers"] = "Content-Type"
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
def api_set_device():
    changed = False
    data = request.json or {}
    with _lock:
        if "camera" in data:
            cam = data["camera"]
            if not _STREAM_DEV_RE.match(cam):
                return jsonify({"ok": False, "error": "invalid camera device"}), 400
            state["stream_device"]  = cam
            state["control_device"] = ctrl_dev(cam)
            state["camera_name"] = None  # force a fresh lookup for the new camera
            changed = True
        if "control_device" in data:
            cd = data["control_device"]
            if not _CONTROL_DEV_RE.match(cd):
                return jsonify({"ok": False, "error": "invalid control device"}), 400
            state["control_device"] = cd
            changed = True
    # A genuine device change has to rebuild the pipeline; a browser reload
    # deliberately does not (see the shared producer comment block).
    if changed:
        log.info("device changed — stopping the shared pipeline so it rebuilds")
        _stop_producer()
    log.info("devices → stream=%s  control=%s", state["stream_device"], state["control_device"])
    return jsonify({"ok": True, **state})

@app.route("/api/stream")
def api_stream():
    dev = request.args.get("device", state["stream_device"])
    # This app has no authentication (normal for a LAN-local device-control
    # tool), so an unvalidated device string here would let anyone on the
    # network point stream_generator()'s ffmpeg fallback path at an
    # arbitrary local file or, worse, a network URL via ffmpeg's own input
    # protocol support (ffmpeg -i accepts http://, file://, concat:, etc.,
    # not just device paths) — a real SSRF/local-file-read surface.
    # Reject anything that isn't exactly a /dev/videoN path before it ever
    # reaches stream_generator(), same pattern already enforced in
    # api_set_device() for the equivalent "camera" field.
    if not _STREAM_DEV_RE.match(dev):
        return jsonify({"ok": False, "error": "invalid device"}), 400
    return Response(stream_generator(dev),
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
    cam_overrides = _HW_RANGE_OVERRIDES_BY_CAMERA.get(get_current_camera_name(), {})
    ov = cam_overrides.get(ctrl)
    if ov:
        lo = ov.get("min", lo)
        hi = ov.get("max", hi)
    return lo, hi

@app.route("/api/controls")
def api_controls():
    vals = v4l2_get_all()
    def merged(c, m):
        lo, hi = effective_range(c)
        return {**m, "value": vals[c], "min": lo, "max": hi}
    return jsonify({c: merged(c, m) for c, m in CONTROLS.items()})

@app.route("/api/diagnostics")
def api_diagnostics():
    result = {}
    for c in DIAG_CONTROLS:
        result[c] = v4l2_get(c)
    result["vertical_blanking"] = v4l2_get("vertical_blanking", dev=SENSOR_SUBDEV)
    result["horizontal_blanking"] = v4l2_get("horizontal_blanking", dev=SENSOR_SUBDEV)
    result["digital_gain_raw"] = v4l2_get("digital_gain", dev=SENSOR_SUBDEV)
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
    "sensor_analog_gain": "max_sensor_analog_gain",
}

def _ensure_ceiling(ctrl, val):
    ceiling_ctrl = _CEILING_PAIRS.get(ctrl)
    if not ceiling_ctrl:
        return
    current_ceiling = v4l2_get(ceiling_ctrl)
    if current_ceiling is not None and val > current_ceiling:
        v4l2_set(ceiling_ctrl, val)

def _v4l2_set_routed(ctrl, val):
    """v4l2_set(), but redirected to the sensor subdevice (and its real
    control name) for controls listed in SDEV_CONTROLS instead of assuming
    everything lives on the default ISP control device."""
    real_name = SDEV_CONTROLS.get(ctrl)
    if real_name:
        return v4l2_set(real_name, val, dev=SENSOR_SUBDEV)
    return v4l2_set(ctrl, val)

@app.route("/api/set", methods=["POST"])
def api_set():
    d = request.json or {}
    ctrl, val = d.get("control"), d.get("value")
    if ctrl not in CONTROLS:
        return jsonify({"ok": False, "error": f"Unknown: {ctrl}"}), 400
    m = CONTROLS[ctrl]
    lo, hi = effective_range(ctrl)
    if not (lo <= int(val) <= hi):
        return jsonify({"ok": False, "error": "Out of range"}), 400
    _ensure_ceiling(ctrl, int(val))
    ok, err = _v4l2_set_verified(ctrl, int(val))
    return jsonify({"ok": ok, "error": err, "restart": m.get("restart", False)})

@app.route("/api/set_many", methods=["POST"])
def api_set_many():
    d = request.json or {}
    results, restart = {}, False
    for ctrl, val in d.get("controls", {}).items():
        if ctrl not in CONTROLS:
            results[ctrl] = {"ok": False, "error": "unknown"}; continue
        lo, hi = effective_range(ctrl)
        if not (lo <= int(val) <= hi):
            results[ctrl] = {"ok": False, "error": "Out of range"}; continue
        _ensure_ceiling(ctrl, int(val))
        ok, err = _v4l2_set_verified(ctrl, int(val))
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
    _remember(ctrl, val)
    ok, err = _v4l2_set_routed(ctrl, val)
    lock = _AUTO_LOCK_PAIRS.get(ctrl)
    if not ok or lock is None:
        return ok, err
    if v4l2_get(ctrl) == val:
        return True, err
    log.info("set %s=%s did not take, kicking %s and retrying", ctrl, val, lock)
    v4l2_set(lock, 0)
    v4l2_set(lock, 1)
    ok, err = _v4l2_set_routed(ctrl, val)
    if ok and v4l2_get(ctrl) != val:
        return False, (f"{ctrl} was not accepted by the ISP even after re-arming "
                       f"{lock} — the auto algorithm is overriding it")
    return ok, err


# ── Desired state ───────────────────────────────────────────────────────────
# Restarting the capture pipeline re-initialises the ISP's 3A context and
# every manual lock lapses at once: the auto algorithms take back over and
# White Balance / Gain Control / Color & Tone all snap to algorithm-driven
# values. The lock registers keep reading 1 throughout (they are volatile —
# see _v4l2_set_verified), so nothing in the system notices it happened.
#
# A browser reload requests /api/stream afresh, which tears the pipeline down
# and builds a new one, so simply reloading the page silently threw away
# everything the user had dialled in.
#
# Remember what was asked for and re-assert it once the new pipeline is up.
# This stores intent, not readback: the readback of a lapsed control is the
# algorithm's own output, so snapshotting the hardware at teardown would
# capture drift rather than the user's setting.
_desired_lock = threading.Lock()
_desired = {}
_LOCK_NAMES = set(_AUTO_LOCK_PAIRS.values())

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
    with _desired_lock:
        _desired[ctrl] = val

def forget_desired():
    with _desired_lock:
        _desired.clear()


# ── Re-apply audit log ──────────────────────────────────────────────────────
# A plain-text record of exactly what gets restored after each pipeline
# restart (i.e. every browser reload), written somewhere obvious rather than
# buried in journalctl among the per-second poller lines. Each entry shows
# the value the ISP reset the control to, the value being restored, and the
# readback afterwards — so a restore that silently failed is visible rather
# than assumed.
REAPPLY_LOG = "/root/cam-settings-tools-reapply.log"
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

def _reapply_desired():
    """Re-assert remembered settings after the pipeline re-initialises the
    ISP. Locks are kicked 0->1 first (a lock that merely reads 1 is not
    necessarily armed), then each value goes through the verifying setter so
    a write that still doesn't land is logged rather than assumed."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with _desired_lock:
        want = dict(_desired)
    if not want:
        _audit(["", "=" * 78,
                f"{ts}  pipeline restart (browser reload)",
                "  nothing remembered yet — no settings changed in this session,",
                "  so there is nothing to restore. Controls are at ISP defaults.",
                "=" * 78])
        return

    lines = ["", "=" * 78,
             f"{ts}  pipeline restart (browser reload)",
             f"  restoring {len(want)} remembered setting(s): "
             f"{len([c for c in want if c in _LOCK_NAMES])} lock(s) + "
             f"{len([c for c in want if c not in _LOCK_NAMES])} value(s)",
             "-" * 78,
             f"  {'CONTROL':<34}{'AFTER RESET':>12}{'RESTORING':>12}{'READBACK':>11}  RESULT"]

    # What the pipeline restart left them at, before we touch anything.
    before = {c: v4l2_get(c) for c in want}

    needed = {_AUTO_LOCK_PAIRS[c] for c in want if c in _AUTO_LOCK_PAIRS}
    needed |= {c for c in want if c in _LOCK_NAMES and want[c] == 1}
    for lock in needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)
        lines.append(f"  {lock:<34}{str(before.get(lock,'?')):>12}{'0->1 kick':>12}"
                     f"{str(v4l2_get(lock)):>11}  LOCK ARMED")
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
            continue  # handled by the kick above
        _ensure_ceiling(ctrl, val)
        ok, err = _v4l2_set_verified(ctrl, val)
        actual = v4l2_get(ctrl)
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
    v = v4l2_get(c)
    return v if v is not None else v4l2_get(c)  # one retry for a transient hiccup

def _detect_one(c):
    meta = CONTROLS[c]
    original = _get_with_retry(c)
    if original is None:
        return {"supported": False, "reason": "unreadable"}
    test_val = _pick_test_value(meta, original)
    ok, err = v4l2_set(c, test_val)
    readback = _get_with_retry(c) if ok else None
    supported = bool(ok and readback is not None and _values_roughly_match(meta, readback, test_val))
    v4l2_set(c, original)
    return {"supported": supported}

@app.route("/api/detect_capabilities", methods=["POST"])
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
def api_reset():
    # Every manual-lock control's own default is 0 (auto), so the previous
    # approach — skip writing a value control's default whenever its lock
    # defaults to auto — ended up skipping nearly everything (WB, exposure,
    # gain, sharpening, saturation, sinter, iridix all have auto-defaulting
    # locks). Reset All only ever turned the locks off; the actual numbers
    # were left to whatever the free-running auto algorithm currently
    # computed, which drifts and rarely matches the documented default —
    # looking like "reset doesn't change the values."
    # Fix: give locked controls the same engage-write-unstick-rewrite
    # treatment already proven safe for presets (see api_preset) — this is
    # exactly how the "Raw/Unprocessed" preset reliably lands on stable,
    # exact values instead of drifting. Locks end up manual (1) rather than
    # their own nominal auto default, trading true free-running auto mode
    # for a reset that actually, visibly, lands on known values.
    #
    # Target values: the "raw" preset's numbers (255/255/5000 WB, etc.) where
    # it defines one — that's the sensor's actual native, unprocessed output,
    # confirmed empirically (see _PRESETS["raw"] comment) — rather than the
    # generic CONTROLS "default" field, which for some controls (e.g. WB:
    # 278/281) is a reasonable starting point but not the true zero-gain/
    # no-correction value the camera itself produces. Controls the raw preset
    # doesn't cover (exposure, sensor/digital gain, etc.) still fall back to
    # their CONTROLS default.
    # NB: the "raw" entry has no button in the UI any more, but it is not
    # dead data — Set Default derives its target values from it here.
    raw_values = _PRESETS["raw"]
    def _reset_target(c):
        return raw_values.get(c, CONTROLS[c]["default"])
    locked_controls = set(_AUTO_LOCK_PAIRS.keys())
    locks_needed = set(_AUTO_LOCK_PAIRS.values())
    for lock in locks_needed:
        v4l2_set(lock, 1)
    for c in locked_controls:
        v4l2_set(c, _reset_target(c))
    for lock in locks_needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)
    for c in locked_controls:
        v4l2_set(c, _reset_target(c))
    for c, m in CONTROLS.items():
        if c in locked_controls or c in locks_needed:
            continue
        v4l2_set(c, m["default"])
    # Drop remembered intent as well, or the next pipeline restart would
    # re-assert the settings this reset just cleared.
    forget_desired()
    return jsonify({"ok": True})

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
def api_preset(name):
    if name not in _PRESETS:
        return jsonify({"ok": False, "error": f"Unknown preset: {name}"}), 400
    locks_needed = {_PRESET_LOCKS[c] for c in _PRESETS[name] if c in _PRESET_LOCKS}
    for lock in locks_needed:
        v4l2_set(lock, 1)
    for c, v in _PRESETS[name].items():
        v4l2_set(c, v)
    # Writing an explicit value (e.g. system_awb_cct) applies correctly but
    # leaves that register pinned against any *further* individual writes —
    # confirmed: after a preset, dragging a slider silently has no effect
    # until the lock is toggled off/on again. Do that kick here so live
    # preview keeps working after a preset, then re-apply the preset's
    # values since the toggle itself can reset them.
    for lock in locks_needed:
        v4l2_set(lock, 0)
        v4l2_set(lock, 1)
    for c, v in _PRESETS[name].items():
        v4l2_set(c, v)
    return jsonify({"ok": True, "preset": name})

@app.route("/api/restart", methods=["POST"])
def api_restart():
    # This endpoint has no authentication (normal for a LAN-local
    # device-control tool), and a full reboot is the single most disruptive
    # action this app can take. The previous logic treated ANY value other
    # than the exact string "service" — including a missing/empty body, a
    # typo, or a malformed request — as "reboot the whole device," which
    # meant a stray or malicious POST with no body would silently trigger a
    # full reboot. Require an explicit, exact match on one of the two known
    # values instead; reject anything else rather than defaulting to the
    # most destructive option.
    rtype = (request.json or {}).get("type")
    if rtype == "service":
        subprocess.Popen(["systemctl", "restart", "cam-settings-tools"])
        return jsonify({"ok": True, "message": "Service restarting..."})
    if rtype == "system":
        subprocess.Popen(["reboot"])
        return jsonify({"ok": True, "message": "Rebooting..."})
    return jsonify({"ok": False, "error": "type must be 'system' or 'service'"}), 400

@app.route("/api/status")
def api_status():
    return jsonify({"ok": True, **state})

@app.route("/api/stream_fps")
def api_stream_fps():
    return jsonify({"fps": get_stream_fps(), "avg_fps": get_avg_fps()})

@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        return jsonify(stream_config)
    data = request.json or {}
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
                     "note": "target_fps applies immediately to the running stream; jpeg_quality/num_encoders apply on the next connection"})

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
    # HTTPS temporarily reverted: the TLS handshake hung indefinitely under
    # Werkzeug's dev server with this cert (TCP accepted, SSL negotiation
    # never completed), leaving the tool completely unreachable. Restoring
    # plain HTTP to get back to a known-working state; investigating the
    # hang separately before re-enabling.
    log.info("Starting on 0.0.0.0:5000  stream=%s  control=%s",
             state["stream_device"], state["control_device"])
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
