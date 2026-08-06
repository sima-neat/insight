#!/usr/bin/env python3
"""On-device control-apply test for sima-mipi-util.

For every connected camera this:
  1. selects it through /api/device and opens the MJPEG stream so the ISP
     pipeline is definitely running,
  2. confirms that the selected stream device matches the requested camera and
     that the app has resolved the live ISP control context,
  3. dumps sensor diagnostics,
  4. sweeps every non-disruptive writable control using a per-control flow:
        snapshot current state -> enable its manual lock when needed -> lift any
        paired ceiling -> set a legal target -> wait -> read back through the
        API -> optionally read the real v4l2 register over SSH -> wait -> read
        again to confirm persistence -> restore control/ceiling/lock state,
  5. classifies PASS / CLAMP / FAIL / DRIFT / HW-MISMATCH / HW-ERROR /
     RESTORE-ERROR / ERROR / SKIP.

Verification layers:
  * webpage/API — /api/controls read-back (always)
  * hardware    — v4l2-ctl on the device over SSH (with --verify-device)

The test is deliberately conservative about controls that can destroy the live
capture format while the sweep is running (sensor preset, crop geometry, output
format). Those are reported as SKIP rather than being changed under an active
NV12 stream.

Usage:
  python3 device_control_sweep_fixed.py http://<ip>:5000 --token <token>
  python3 device_control_sweep_fixed.py http://<ip>:5000 --token <tok> \
          --verify-device --ssh root@<ip> --ssh-pass root --delay 1.5

Token resolution:
  --token  >  $SIMA_MIPI_UTIL_TOKEN  >  /etc/sima-mipi-util/token (on-device)
"""

import argparse
import datetime
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


class _TeeStream:
    """Mirror terminal output to a plain-text log without ANSI color codes."""

    def __init__(self, terminal, log_file):
        self.terminal = terminal
        self.log_file = log_file

    def write(self, text):
        self.terminal.write(text)
        self.log_file.write(_ANSI_RE.sub("", text))
        return len(text)

    def flush(self):
        self.terminal.flush()
        self.log_file.flush()

    def isatty(self):
        return self.terminal.isatty()


# ── App-internal maps (kept in sync with camera_api.py) ──────────────────────
# These controls can reconfigure/restart the live pipeline or alter frame
# geometry/format. Sweeping them while our keep-alive stream expects NV12 at a
# fixed size can invalidate all subsequent results, so leave them for a separate
# dedicated format/crop test.
SKIP = {
    "isp_sensor_preset": "restart/disruptive sensor preset",
    "image_output_format_id": "changes live pixel format",
    "image_crop_enable": "changes live frame geometry",
    "image_crop_xoffset": "crop geometry control",
    "image_crop_yoffset": "crop geometry control",
    "image_crop_width": "crop geometry control",
    "image_crop_height": "crop geometry control",
}

SDEV_CONTROLS = {
    "sdev_digital_gain": "digital_gain",
    # current_exposure is NOT sensor-routed: it lives on the ISP control device
    # (the sensor exposure register has no visible effect — the ISP overrides
    # it), so --verify-device must read it from the control device, not the
    # sensor subdev. Kept in sync with camera_api.py's SDEV_CONTROLS.
    "sensor_analog_gain": "analogue_gain",
}

CEILING_PAIRS = {
    "system_iridix_strength_target": "system_maximum_iridix_strength",
}

LOCK_PAIRS = {
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


# Mirrors the five control cards rendered in camera_ui.html. Hidden backend
# controls remain covered under Other / Advanced rather than being omitted.
UI_BLOCKS = [
    ("White Balance", [
        "awb_red_gain", "system_awb_cct", "awb_blue_gain", "en_manual_awb",
    ]),
    ("Exposure", [
        "current_exposure", "en_manual_exposure",
    ]),
    ("Gain Control", [
        "sensor_analog_gain", "sdev_digital_gain",
        "en_manual_sensor_analog_gain",
    ]),
    ("Image Enhancement", [
        "syst_direct_sharpening_target", "system_saturation_target",
        "system_sinter_threshold_target", "syst_un_direct_sharp_target",
        "syst_man_direct_sharpening", "en_manual_saturation",
        "en_manual_sinter", "syst_man_un_direct_sharpening",
    ]),
    ("Color & Tone", [
        "system_iridix_strength_target", "system_maximum_iridix_strength",
        "en_manual_iridix",
    ]),
]

UI_BLOCK_LOCKS = {
    "White Balance": ["en_manual_awb"],
    "Exposure": ["en_manual_exposure"],
    "Gain Control": ["en_manual_sensor_analog_gain"],
    "Image Enhancement": [
        "syst_man_direct_sharpening", "en_manual_saturation",
        "en_manual_sinter", "syst_man_un_direct_sharpening",
    ],
    "Color & Tone": ["en_manual_iridix"],
}

TEST_PRESETS = {
    "daylight": {
        "awb_red_gain": 461, "awb_blue_gain": 410, "system_awb_cct": 5500,
        "system_saturation_target": 128,
        "syst_direct_sharpening_target": 48,
        "syst_un_direct_sharp_target": 16,
        "system_antiflicker_enable": 1,
        "system_anti_flicker_frequency": 50,
        "system_sinter_threshold_target": 25,
        "system_maximum_iridix_strength": 64,
        "system_minimum_iridix_strength": 0,
    },
    "night": {
        "awb_red_gain": 420, "awb_blue_gain": 460, "system_awb_cct": 4000,
        "system_saturation_target": 110,
        "syst_direct_sharpening_target": 20,
        "syst_un_direct_sharp_target": 8,
        "system_antiflicker_enable": 1,
        "system_anti_flicker_frequency": 50,
        "system_sinter_threshold_target": 60,
        "system_maximum_iridix_strength": 120,
        "system_minimum_iridix_strength": 0,
        "max_sensor_analog_gain": 200,
    },
}

def grouped_control_names(names):
    """Return [(HTML block name, controls)] without dropping backend controls."""
    remaining = set(names)
    groups = []
    for block_name, members in UI_BLOCKS:
        present = [name for name in members if name in remaining]
        if present:
            groups.append((block_name, present))
            remaining.difference_update(present)
    if remaining:
        groups.append(("Other / Advanced", sorted(remaining)))
    return groups


# ── CLI ──────────────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser(description="sima-mipi-util on-device control test")
ap.add_argument("base_url", nargs="?", default="http://127.0.0.1:5000")
ap.add_argument(
    "--token",
    default=None,
    help="API token (else $SIMA_MIPI_UTIL_TOKEN or /etc file)",
)
ap.add_argument(
    "--delay",
    type=float,
    default=2.0,
    help="settle time after a web write before readback (minimum 2.0 seconds)",
)
ap.add_argument(
    "--block",
    action="append",
    choices=[name for name, _ in UI_BLOCKS] + ["Other / Advanced"],
    help="test only this HTML control block (repeatable; default: all blocks)",
)
ap.add_argument(
    "--verify-device",
    action="store_true",
    help="also read the raw v4l2 register on the device over SSH",
)
ap.add_argument(
    "--ssh",
    default=None,
    help="ssh target for --verify-device (default root@<host>)",
)
ap.add_argument(
    "--ssh-pass",
    default=None,
    help="ssh password (uses sshpass; key auth is preferred)",
)
ap.add_argument(
    "--no-color",
    action="store_true",
    help="disable ANSI result colors (colors are otherwise enabled on a TTY)",
)
ap.add_argument(
    "--test-defaults",
    action="store_true",
    help="also set and verify safe controls at their metadata default",
)
ap.add_argument(
    "--test-presets",
    action="store_true",
    help="apply and verify the daylight and night webpage presets",
)
ap.add_argument(
    "--test-force-exposure",
    action="store_true",
    help=(
        "replace the webpage Exposure block with a forced sensor-register "
        "retention test (requires --verify-device)"
    ),
)
ap.add_argument(
    "--force-exposure-only",
    action="store_true",
    help="run only the forced sensor-exposure retention test",
)
ap.add_argument(
    "--log-file",
    default=None,
    help="plain-text log path (default: ./mipi-sweep-<timestamp>.log)",
)
A = ap.parse_args()

BASE = A.base_url.rstrip("/")
DELAY = max(2.0, A.delay)
HOST = urlparse(BASE).hostname or "127.0.0.1"
SSH_TARGET = A.ssh or ("root@%s" % HOST)
_TERMINAL_IS_TTY = sys.stdout.isatty()
USE_COLOR = (_TERMINAL_IS_TTY and not A.no_color and
             "NO_COLOR" not in os.environ)
_LOG_HANDLE = None
_TRACE_LOCK = threading.Lock()
LOG_PATH = os.path.abspath(A.log_file or (
    "mipi-sweep-%s.log" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
))
try:
    log_parent = os.path.dirname(LOG_PATH)
    if log_parent:
        os.makedirs(log_parent, exist_ok=True)
    _LOG_HANDLE = open(LOG_PATH, "w", encoding="utf-8", buffering=1)
    sys.stdout = _TeeStream(sys.stdout, _LOG_HANDLE)
    sys.stderr = _TeeStream(sys.stderr, _LOG_HANDLE)
except OSError as exc:
    print("WARNING: cannot create log %s: %s" % (LOG_PATH, exc), file=sys.stderr)
    LOG_PATH = None


def _trace(action, control="-", value="-", result="-", detail=""):
    """Write an aligned execution event to the log without cluttering stdout."""
    if _LOG_HANDLE is None:
        return
    timestamp = datetime.datetime.now().strftime("%H:%M:%S.%f")[:-3]
    line = "%-12s | %-12s | %-44s | %12s | %-8s | %s\n" % (
        timestamp, action, control, str(value), result, detail
    )
    with _TRACE_LOCK:
        _LOG_HANDLE.write(line)


def _resolve_token():
    if A.token:
        return A.token.strip()
    if os.environ.get("SIMA_MIPI_UTIL_TOKEN", "").strip():
        return os.environ["SIMA_MIPI_UTIL_TOKEN"].strip()
    try:
        with open("/etc/sima-mipi-util/token", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


TOKEN = _resolve_token()
ACTIVE_CAMERA = None
if not TOKEN:
    print(
        "WARNING: no API token was found. Production writes will normally be "
        "rejected; the script will stop if camera selection is not accepted.",
        file=sys.stderr,
    )


# ── HTTP ─────────────────────────────────────────────────────────────────────
def req(path, method="GET", body=None):
    """Return (HTTP status, decoded JSON-or-error-dict)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["X-Auth-Token"] = TOKEN
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, {}
            try:
                return resp.status, json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return resp.status, {"error": raw.decode("utf-8", "replace")}
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            payload = {"error": str(e)}
        return e.code, payload
    except Exception as e:
        return 0, {"error": str(e)}


def controls():
    st, data = req("/api/controls")
    if st != 200 or not isinstance(data, dict):
        _trace("GET-WEB", "/api/controls", "n/a", "FAIL", "HTTP %s" % st)
        return {}
    _trace("GET-WEB", "/api/controls", len(data), "PASS",
           "HTTP %s controls=%s" % (st, len(data)))
    return data


def set_ctrl(name, value):
    """Set through the same API path as the GUI and validate JSON success too."""
    _trace("SET-WEB", name, value, "START", "POST /api/set")
    st, data = req("/api/set", "POST", {"camera": ACTIVE_CAMERA, "control": name, "value": value})
    ok = st == 200 and isinstance(data, dict) and data.get("ok") is True
    detail = "HTTP %s" % st
    if not ok and isinstance(data, dict) and data.get("error"):
        detail += " " + str(data.get("error"))
    _trace("SET-WEB", name, value, "PASS" if ok else "FAIL", detail)
    return ok, st, data if isinstance(data, dict) else {}


def _set_error(status, data):
    if isinstance(data, dict) and data.get("error"):
        message = str(data.get("error"))
        legacy_auto_override = (
            "was not accepted by the ISP" in message and
            "auto algorithm is overriding it" in message
        )
        if legacy_auto_override or "rejected by ISP (auto override)" in message:
            control = message.split()[0]
            return "%s: auto override" % control
        return "HTTP %s: %s" % (status, message)
    return "HTTP %s" % status


# ── SSH (hardware verification) ──────────────────────────────────────────────
def ssh_run(remote_cmd):
    base = []
    if A.ssh_pass:
        base = ["sshpass", "-p", A.ssh_pass]
    cmd = base + [
        "ssh",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=8",
        SSH_TARGET,
        remote_cmd,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if r.returncode != 0:
            detail = r.stderr.strip() or r.stdout.strip() or ("rc=%d" % r.returncode)
            return "ERR:%s" % detail
        return r.stdout.strip()
    except Exception as e:
        return "ERR:%s" % e


def ssh_ok():
    return ssh_run("echo OK") == "OK"


_subdev_cache = {}


def sensor_subdev(cam_name):
    """Find the sensor subdev matching the selected camera's sysfs name."""
    if cam_name in _subdev_cache:
        return _subdev_cache[cam_name]

    qname = shlex.quote(cam_name)
    command = (
        'for s in /dev/v4l-subdev*; do '
        'n=$(cat /sys/class/video4linux/$(basename "$s")/name 2>/dev/null); '
        '[ "$n" = %s ] && echo "$s" && break; done' % qname
    )
    out = ssh_run(command)
    node = out if out.startswith("/dev/") else None
    _subdev_cache[cam_name] = node
    return node


def sensor_ctrl_info(cam_name, control):
    """Return (device, current, minimum, maximum) for a sensor control."""
    dev = sensor_subdev(cam_name)
    if not dev:
        return None, None, None, None
    out = ssh_run(
        "v4l2-ctl -d %s --list-ctrls 2>/dev/null"
        % shlex.quote(dev)
    )
    if out.startswith("ERR:"):
        return dev, None, None, None
    pattern = (
        r"^\s*%s\s+.*?min=(-?\d+)\s+max=(-?\d+).*?value=(-?\d+)"
        % re.escape(control)
    )
    match = re.search(pattern, out, re.MULTILINE)
    if not match:
        return dev, None, None, None
    return dev, int(match.group(3)), int(match.group(1)), int(match.group(2))


def sensor_ctrl_write(dev, control, value):
    """Write a sensor control directly and return an optional error string."""
    _trace("SET-HW", control, value, "START", dev)
    out = ssh_run(
        "v4l2-ctl -d %s --set-ctrl %s=%d 2>/dev/null"
        % (shlex.quote(dev), shlex.quote(control), value)
    )
    if out.startswith("ERR:"):
        _trace("SET-HW", control, value, "FAIL", out[4:])
        return out[4:]
    _trace("SET-HW", control, value, "PASS", dev)
    return None


def sensor_ctrl_read(dev, control):
    """Read a sensor control directly, recording the operation in the log."""
    out = ssh_run(
        "v4l2-ctl -d %s --get-ctrl %s 2>/dev/null"
        % (shlex.quote(dev), shlex.quote(control))
    )
    match = None if out.startswith("ERR:") else re.search(r":\s*(-?\d+)", out)
    value = int(match.group(1)) if match else None
    detail = out[4:] if out.startswith("ERR:") else dev
    _trace("GET-HW", control, value, "PASS" if value is not None else "FAIL", detail)
    return value


# Per-camera gain routing (kept in sync with camera_api.py's _ISP_GAIN_ON_IMX568):
# on imx568 gain lives on the ISP register (control device), not the sensor subdev.
_ISP_GAIN_ON_IMX568 = {
    "sensor_analog_gain": "sensor_analog_gain",
    "sdev_digital_gain": "sensor_digital_gain",
}


def hw_read(name, control_device, cam_name):
    """Read a control directly from the underlying V4L2 node over SSH."""
    if "imx568" in (cam_name or "").lower() and name in _ISP_GAIN_ON_IMX568:
        dev, v4l_name = control_device, _ISP_GAIN_ON_IMX568[name]
        if not dev:
            _trace("GET-HW", name, "n/a", "FAIL", "control device unavailable")
            return None
    elif name in SDEV_CONTROLS:
        dev = sensor_subdev(cam_name)
        v4l_name = SDEV_CONTROLS[name]
        if not dev:
            _trace("GET-HW", name, "n/a", "FAIL", "sensor subdevice unavailable")
            return None
    else:
        dev, v4l_name = control_device, name
        if not dev:
            _trace("GET-HW", name, "n/a", "FAIL", "control device unavailable")
            return None

    out = ssh_run(
        "v4l2-ctl -d %s --get-ctrl %s 2>/dev/null"
        % (shlex.quote(dev), shlex.quote(v4l_name))
    )
    if out.startswith("ERR:"):
        _trace("GET-HW", name, "n/a", "FAIL", out[4:])
        return None
    # Plain controls: "name: 123"; menu controls: "name: 24 (SYMBOL)".
    m = re.search(r":\s*(-?\d+)", out)
    value = int(m.group(1)) if m else None
    _trace("GET-HW", name, value, "PASS" if value is not None else "FAIL",
           "%s:%s" % (dev, v4l_name))
    return value


# ── Stream keep-alive ────────────────────────────────────────────────────────
class Streamer:
    def __init__(self):
        self._stop = threading.Event()
        self._t = None
        self._resp = None
        self._resp_lock = threading.Lock()

    def _run(self):
        resp = None
        try:
            headers = {"X-Auth-Token": TOKEN} if TOKEN else {}
            r = urllib.request.Request(BASE + "/api/stream", headers=headers)
            resp = urllib.request.urlopen(r, timeout=20)
            with self._resp_lock:
                self._resp = resp
            while not self._stop.is_set():
                if not resp.read(4096):
                    break
        except Exception:
            pass
        finally:
            if resp is not None:
                try:
                    resp.close()
                except Exception:
                    pass
            with self._resp_lock:
                if self._resp is resp:
                    self._resp = None

    def start(self):
        self._stop.clear()
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def stop(self):
        self._stop.set()
        # Closing the response interrupts a thread blocked in resp.read().
        with self._resp_lock:
            resp = self._resp
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        if self._t:
            self._t.join(timeout=3)
            return not self._t.is_alive()
        return True


# ── Per-control test helpers ─────────────────────────────────────────────────
def target_for(meta, cam_idx=0):
    """Pick a different legal target, including sparse V4L2 menu values."""
    cur, lo, hi = meta["value"], meta["min"], meta["max"]
    typ = meta.get("type")

    if typ == "bool":
        return 0 if cur else 1

    if typ == "menu":
        options = []
        for key in (meta.get("options") or {}):
            try:
                value = int(key)
            except (TypeError, ValueError):
                continue
            if lo <= value <= hi:
                options.append(value)
        options = sorted(set(options))
        if not options:
            return cur
        candidates = [v for v in options if v != cur]
        if not candidates:
            return cur
        # Choose different valid values for different cameras where possible.
        return candidates[cam_idx % len(candidates)]

    span = hi - lo
    if span <= 0:
        return cur

    # Distinct target per camera. Bound the step so huge controls such as
    # current_exposure still receive a realistic test value.
    step = max(1, min(span // 10, 50000))
    mult = cam_idx + 1
    target = cur + step * mult
    if target > hi:
        target = cur - step * mult
    if target < lo or target > hi:
        target = lo + (span * (3 + cam_idx)) // 10
    if target == cur:
        target = cur + 1 if cur < hi else cur - 1
    return max(lo, min(hi, target))


def values_close(meta, a, b, rel):
    if a is None or b is None:
        return a == b
    if meta.get("type") in ("bool", "menu"):
        return a == b
    return abs(a - b) <= max(1, abs(b) * rel)


def _read_value(name):
    value = controls().get(name, {}).get("value")
    _trace("GET-WEB", name, value, "PASS" if value is not None else "FAIL",
           "GET /api/controls")
    return value


def _settle(control, detail):
    _trace("WAIT", control, "%.1fs" % DELAY, "START", detail)
    time.sleep(DELAY)
    _trace("WAIT", control, "%.1fs" % DELAY, "DONE", detail)


_VERDICT_ORDER = ("PASS", "CLAMP", "SKIP", "FAIL", "ERROR", "DRIFT",
                  "HW-MISMATCH", "HW-ERROR", "RESTORE-ERROR", "INVALID")
REPORT_WIDTH = 88
REGULAR_CONTROL_WIDTH = 44
REGULAR_REPORT_WIDTH = 104

def _shown(value):
    return "n/a" if value is None else str(value)


def _color_text(verdict, text):
    if not USE_COLOR:
        return text
    if verdict == "PASS":
        code = "32"  # green
    elif verdict in ("WARN", "CLAMP"):
        code = "33"  # yellow
    elif verdict == "SKIP":
        code = "36"  # cyan
    else:
        code = "31"  # red
    return "\033[%sm%s\033[0m" % (code, text)


def _verdict_field(verdict, width):
    """Pad before adding ANSI codes so table alignment remains unchanged."""
    return _color_text(verdict, ("%-*s" % (width, verdict)))

def _counts_text(counts):
    ordered = [(key, counts[key]) for key in _VERDICT_ORDER if counts.get(key)]
    ordered += sorted((key, value) for key, value in counts.items()
                      if key not in _VERDICT_ORDER and value)
    return "  ".join(
        "%s=%s" % (_color_text(key, key), value) for key, value in ordered
    ) or "none"

def _print_table_header(verify_device):
    line = "%-7s %-*s %12s %12s %12s" % (
        "RESULT", REGULAR_CONTROL_WIDTH, "CONTROL",
        "CURRENT", "TARGET", "WEB"
    )
    if verify_device:
        line += " %12s" % "HARDWARE"
    print(line)
    print("-" * len(line))

def _format_result_row(verdict, name, current, target, web, hardware, verify_device):
    display_verdict = verdict if verdict in ("PASS", "WARN", "CLAMP", "SKIP") else "FAIL"
    line = "%s %-*s %12s %12s %12s" % (
        _verdict_field(display_verdict, 7), REGULAR_CONTROL_WIDTH, name.lower(),
        _shown(current), _shown(target), _shown(web)
    )
    if verify_device:
        line += " %12s" % _shown(hardware)
    return line


def _row_with_note(row, note):
    """Keep result explanations on their control row."""
    return row if not note else row + "  | " + note


def _print_step(number, title, verify_device=True, drift=False):
    print("\n[%s/5] %s" % (number, title))
    print("-" * REPORT_WIDTH)
    if drift:
        line = "%-7s %-36s %10s %10s" % (
            "RESULT", "CONTROL", "SET VALUE", "WEB"
        )
        if verify_device:
            line += " %10s" % "HW"
        line += " %10s" % "DRIFT"
    else:
        line = "%-7s %-36s %10s %10s %10s" % (
            "RESULT", "CONTROL", "BEFORE", "TARGET", "WEB"
        )
        if verify_device:
            line += " %10s" % "HW"
    print(line)
    print("-" * REPORT_WIDTH)


def _format_step_row(verdict, name, before, target, web, hardware,
                     verify_device=True):
    display_verdict = verdict if verdict in ("PASS", "WARN", "CLAMP", "SKIP") else "FAIL"
    line = "%s %-36s %10s %10s %10s" % (
        _verdict_field(display_verdict, 7), name.lower(), _shown(before),
        _shown(target), _shown(web)
    )
    if verify_device:
        line += " %10s" % _shown(hardware)
    return line


def _format_drift_row(verdict, name, set_value, web, hardware, drift,
                      verify_device=True):
    display_verdict = verdict if verdict in ("PASS", "WARN", "CLAMP", "SKIP") else "FAIL"
    line = "%s %-36s %10s %10s" % (
        _verdict_field(display_verdict, 7), name.lower(), _shown(set_value),
        _shown(web)
    )
    if verify_device:
        line += " %10s" % _shown(hardware)
    line += " %10s" % _shown(drift)
    return line


def _print_named_summary(title, summary):
    passed = summary.get("PASS", 0)
    warnings = summary.get("WARN", 0) + summary.get("CLAMP", 0)
    failed = sum(value for key, value in summary.items()
                 if key not in ("PASS", "WARN", "CLAMP", "SKIP"))
    total = passed + warnings + failed
    result = ("FAIL" if failed else
              "PASS WITH WARNINGS" if warnings else "PASS")
    print("\n" + "=" * REPORT_WIDTH)
    print(title.upper())
    print("=" * REPORT_WIDTH)
    print("Passed     : %d" % passed)
    print("Warnings   : %d" % warnings)
    print("Failed     : %d" % failed)
    print("Total      : %d" % total)
    result_verdict = "FAIL" if result == "FAIL" else (
        "WARN" if result == "PASS WITH WARNINGS" else "PASS"
    )
    print("Result     : %s" % _color_text(result_verdict, result))


def _run_manual_control_block(block_name, block_controls, block_locks,
                              control_device, cam_name, verify_device, cam_idx):
    """Run one manual-control card as a readable five-step transition."""
    value_names = [name for name in block_controls if name not in block_locks]
    snapshot = controls()
    original_locks = {
        name: snapshot.get(name, {}).get("value") for name in block_locks
    }
    originals = {name: snapshot.get(name, {}).get("value")
                 for name in value_names}
    original_ceilings = {
        ceiling: snapshot.get(ceiling, {}).get("value")
        for ceiling in (CEILING_PAIRS.get(name) for name in value_names)
        if ceiling
    }
    counts = {}
    bad = []
    set_values = {}

    def record(verdict, label):
        counts[verdict] = counts.get(verdict, 0) + 1
        if verdict not in ("PASS", "WARN", "SKIP"):
            bad.append(label)

    _print_step(1, "Enable Manual Mode", verify_device)
    for lock_name in block_locks:
        verdict, cur, tgt, web, hw, note = test_lock_state(
            lock_name, 1, control_device, cam_name, verify_device
        )
        record(verdict, lock_name + "(manual-on)")
        print(_row_with_note(_format_step_row(
            verdict, lock_name, cur, tgt, web, hw, verify_device
        ), note))

    _print_step(2, "Test Values with Manual Mode Enabled", verify_device)
    for cname in value_names:
        meta = controls().get(cname)
        if not isinstance(meta, dict):
            result = ("ERROR", None, None, None, None,
                      "control metadata unavailable")
        else:
            result = test_control(
                cname, meta, control_device, cam_name, verify_device, cam_idx,
                restore_after=False,
            )
        verdict, cur, tgt, web, hw, note = result
        record(verdict, cname)
        shown_note = note if verdict not in ("PASS", "SKIP") else ""
        print(_row_with_note(_format_step_row(
            verdict, cname, cur, tgt, web, hw, verify_device
        ), shown_note))
        if verdict in ("PASS", "CLAMP") and web is not None:
            set_values[cname] = web

    if A.test_defaults:
        _print_step("2D", "Test Metadata Defaults", verify_device)
        for cname in value_names:
            meta = controls().get(cname)
            default = meta.get("default") if isinstance(meta, dict) else None
            if default is None:
                result = ("SKIP", None, None, None, None,
                          "metadata default unavailable")
            else:
                result = test_control(
                    cname, meta, control_device, cam_name, verify_device,
                    cam_idx, restore_after=False, target_override=default,
                )
            verdict, cur, tgt, web, hw, note = result
            record(verdict, cname + "(default)")
            shown_note = note if verdict not in ("PASS", "SKIP") else ""
            print(_row_with_note(_format_step_row(
                verdict, cname, cur, tgt, web, hw, verify_device
            ), shown_note))
            if verdict in ("PASS", "CLAMP") and web is not None:
                set_values[cname] = web

    _print_step(3, "Disable Manual Mode", verify_device)
    for lock_name in block_locks:
        verdict, cur, tgt, web, hw, note = test_lock_state(
            lock_name, 0, control_device, cam_name, verify_device
        )
        record(verdict, lock_name + "(manual-off)")
        print(_row_with_note(_format_step_row(
            verdict, lock_name, cur, tgt, web, hw, verify_device
        ), note))

    _settle("manual-controls", "automatic-mode drift")
    _print_step(4, "Check Drift with Manual Mode Disabled",
                verify_device, drift=True)
    for cname in value_names:
        set_value = set_values.get(cname)
        hw = hw_read(cname, control_device, cam_name) if verify_device else None
        meta = controls().get(cname, {})
        web = meta.get("value") if isinstance(meta, dict) else None
        drift = (web - set_value if isinstance(web, (int, float)) and
                 isinstance(set_value, (int, float)) else None)
        drift_tolerance = 0.20 if cname == "current_exposure" else 0.05
        hardware_matches = (not verify_device or
                            values_close(meta, hw, web, drift_tolerance))
        if set_value is None or web is None or not hardware_matches:
            verdict = "FAIL"
        elif drift:
            verdict = "WARN"
        else:
            verdict = "PASS"
        record(verdict, cname + "(manual-off-drift)")
        if verdict == "WARN":
            note = ("Automatic-mode drift observed; web and hardware "
                    "values match.")
        elif verdict == "FAIL":
            note = ("Drift verification failed or web and hardware values "
                    "do not match.")
        else:
            note = ""
        print(_row_with_note(_format_drift_row(
            verdict, cname, set_value, web, hw, drift, verify_device
        ), note))

    # Restore value/ceiling state while manual control is temporarily armed.
    before_restore = {name: _read_value(name) for name in block_locks}
    restore_failures = []
    for lock_name in block_locks:
        ok, st, data = set_ctrl(lock_name, 1)
        if not ok:
            restore_failures.append("%s: %s" %
                                    (lock_name, _set_error(st, data)))
    for cname, original in originals.items():
        if original is None:
            continue
        ok, st, data = set_ctrl(cname, original)
        if not ok:
            restore_failures.append("%s: %s" %
                                    (cname, _set_error(st, data)))
    for ceiling, original in original_ceilings.items():
        if original is None:
            continue
        ok, st, data = set_ctrl(ceiling, original)
        if not ok:
            restore_failures.append("%s: %s" %
                                    (ceiling, _set_error(st, data)))

    _print_step(5, "Restore Original Manual State", verify_device)
    for lock_name in block_locks:
        original_lock = original_locks.get(lock_name)
        target_lock = original_lock if original_lock is not None else 0
        verdict, _, tgt, web, hw, note = test_lock_state(
            lock_name, target_lock, control_device, cam_name, verify_device
        )
        lock_failures = list(restore_failures)
        if note:
            lock_failures.append(note)
        if lock_failures or verdict != "PASS":
            verdict = "RESTORE-ERROR"
            bad.append(lock_name + "(restore)")
            counts[verdict] = counts.get(verdict, 0) + 1
        print(_row_with_note(_format_step_row(
            verdict, lock_name, before_restore.get(lock_name), tgt, web, hw,
            verify_device
        ), "; ".join(lock_failures)))

    _print_named_summary(block_name + " Summary", counts)
    return counts, bad


def _run_preset_tests(control_device, cam_name, verify_device):
    """Apply daylight/night through the webpage API and restore prior state."""
    initial = controls()
    tested_names = {
        cname for values in TEST_PRESETS.values() for cname in values
        if cname in initial
    }
    original_values = {
        cname: initial[cname].get("value") for cname in tested_names
    }
    lock_names = {
        LOCK_PAIRS[cname] for cname in tested_names if cname in LOCK_PAIRS
    }
    original_locks = {
        lock: initial.get(lock, {}).get("value") for lock in lock_names
    }
    counts = {}
    bad = []

    for preset_name, expected in TEST_PRESETS.items():
        print("\n" + "=" * REPORT_WIDTH)
        print(("PRESET: " + preset_name).upper())
        print("=" * REPORT_WIDTH)
        _print_step("P", "Apply and Verify Webpage Preset", verify_device)
        _trace("SET-PRESET", preset_name, "-", "START",
               "POST /api/preset/" + preset_name)
        status, response = req("/api/preset/" + preset_name, "POST")
        preset_ok = (status == 200 and isinstance(response, dict) and
                     response.get("ok") is True)
        _trace("SET-PRESET", preset_name, "-", "PASS" if preset_ok else "FAIL",
               "HTTP %s" % status)
        _settle(preset_name, "preset propagation")

        hardware = {
            cname: (hw_read(cname, control_device, cam_name)
                    if verify_device else None)
            for cname in expected if cname in initial
        }
        webpage = controls()
        endpoint_ok = (status == 200 and isinstance(response, dict) and
                       response.get("ok") is True)

        for cname, target in expected.items():
            if cname not in initial:
                verdict = "SKIP"
                before = web = hw = None
                note = "control unavailable"
            else:
                meta = webpage.get(cname, initial[cname])
                before = original_values.get(cname)
                web = meta.get("value") if isinstance(meta, dict) else None
                hw = hardware.get(cname)
                web_ok = values_close(meta, web, target, 0.03)
                hw_ok = (not verify_device or
                         values_close(meta, hw, target, 0.03))
                verdict = "PASS" if endpoint_ok and web_ok and hw_ok else "FAIL"
                note = "" if verdict == "PASS" else "preset readback mismatch"
            counts[verdict] = counts.get(verdict, 0) + 1
            if verdict == "FAIL":
                bad.append("%s(%s)" % (cname, preset_name))
            print(_row_with_note(_format_step_row(
                verdict, cname, before, target, web, hw, verify_device
            ), note))

    restore_errors = []
    for cname, original in original_values.items():
        if original is None:
            continue
        ok, status, data = set_ctrl(cname, original)
        if not ok:
            restore_errors.append("%s: %s" %
                                  (cname, _set_error(status, data)))
    for lock, original in original_locks.items():
        if original is None:
            continue
        ok, status, data = set_ctrl(lock, original)
        if not ok:
            restore_errors.append("%s: %s" %
                                  (lock, _set_error(status, data)))
    _settle("preset-state", "restore verification")

    restored_hardware = {
        cname: (hw_read(cname, control_device, cam_name)
                if verify_device else None)
        for cname in set(original_values) | set(original_locks)
    }
    restored_web = controls()
    for cname, original in dict(original_values, **original_locks).items():
        if original is None:
            continue
        meta = restored_web.get(cname, initial.get(cname, {}))
        web = meta.get("value") if isinstance(meta, dict) else None
        hw = restored_hardware.get(cname)
        web_ok = values_close(meta, web, original, 0.03)
        hw_ok = (not verify_device or
                 values_close(meta, hw, original, 0.03))
        if not web_ok or not hw_ok:
            restore_errors.append(
                "%s restore web=%s hw=%s expected=%s" %
                (cname, web, hw, original)
            )

    if restore_errors:
        counts["RESTORE-ERROR"] = counts.get("RESTORE-ERROR", 0) + 1
        bad.append("preset-state-restore")
        print(_row_with_note(
            _format_step_row("FAIL", "preset_state_restore", None, None,
                             None, None, verify_device),
            "; ".join(restore_errors),
        ))

    _print_named_summary("Preset Test Summary", counts)
    return counts, bad


def test_lock_state(name, target, control_device, cam_name, verify_device):
    """Set and verify one manual-mode control through web API and hardware."""
    current = _read_value(name)
    ok, status, data = set_ctrl(name, target)
    # Allow the web/API write to propagate through the ISP before either
    # webpage or direct hardware readback is sampled.
    _settle(name, "manual-mode propagation")
    hardware = hw_read(name, control_device, cam_name) if verify_device else None
    web = _read_value(name)
    good = ok and web == target and (not verify_device or hardware == target)
    note = ""
    if not ok:
        note = _set_error(status, data)
    elif web != target:
        note = "web readback=%s expected=%s" % (web, target)
    elif verify_device and hardware != target:
        note = "hardware readback=%s expected=%s" % (hardware, target)
    return ("PASS" if good else "ERROR", current, target, web, hardware, note)


def _restore_state(name, cur, lock, orig_lock, ceiling, orig_ceiling):
    """Best-effort restoration. Return a list of restoration failures.

    Restore the tested value while a dependent manual lock is still engaged,
    then restore its ceiling, and restore the original lock LAST. This avoids
    the auto algorithm racing the value/ceiling restoration.
    """
    failures = []

    ok, st, data = set_ctrl(name, cur)
    if not ok:
        failures.append("%s=%s (%s)" % (name, cur, _set_error(st, data)))

    if ceiling and orig_ceiling is not None and ceiling != name:
        ok, st, data = set_ctrl(ceiling, orig_ceiling)
        if not ok:
            failures.append(
                "%s=%s (%s)" % (ceiling, orig_ceiling, _set_error(st, data))
            )

    if lock and orig_lock is not None and lock != name:
        ok, st, data = set_ctrl(lock, orig_lock)
        if not ok:
            failures.append("%s=%s (%s)" % (lock, orig_lock, _set_error(st, data)))
        else:
            # Read back lock state. Lock values are bools and must match exactly.
            _settle(lock, "restore lock readback")
            rb = _read_value(lock)
            if rb != orig_lock:
                failures.append("%s restore readback=%s expected=%s" % (lock, rb, orig_lock))

    return failures


def test_control(name, meta, control_device, cam_name, verify_device, cam_idx=0,
                 manage_manual_lock=True, restore_after=True,
                 target_override=None):
    """Test one control and restore all state touched by the test."""
    # Refresh the whole snapshot immediately before this test. A full sweep can
    # take minutes and auto-controlled values may have changed since enumeration.
    snapshot = controls()
    live_meta = snapshot.get(name)
    if not isinstance(live_meta, dict):
        return ("ERROR", None, None, None, None, "control disappeared from /api/controls")
    meta = live_meta
    cur = meta.get("value")
    if cur is None:
        return ("ERROR", None, None, None, None, "current value is unreadable")

    target = (target_for(meta, cam_idx) if target_override is None
              else target_override)
    if target == cur and target_override is None:
        return ("SKIP", cur, target, cur, None, "no distinct legal target")

    # Disabled-mode tests must not silently re-enable manual control.
    lock = LOCK_PAIRS.get(name) if manage_manual_lock else None
    ceiling = CEILING_PAIRS.get(name)
    orig_lock = snapshot.get(lock, {}).get("value") if lock else None
    orig_ceiling = snapshot.get(ceiling, {}).get("value") if ceiling else None

    verdict = "ERROR"
    api1 = None
    api2 = None
    hw = None
    note = ""

    try:
        # 1. Engage the manual lock when this value is normally algorithm-owned.
        if lock:
            ok, st, data = set_ctrl(lock, 1)
            if not ok:
                note = "cannot enable %s: %s" % (lock, _set_error(st, data))
                return_tuple = None
            else:
                return_tuple = True
                _settle(lock, "manual-lock propagation")
                engaged = _read_value(lock) == 1
                if not engaged:
                    note = "%s did not read back as 1" % lock
                    return_tuple = None
                else:
                    if verify_device:
                        lock_hw = hw_read(lock, control_device, cam_name)
                        if lock_hw != 1:
                            note = "%s hardware readback=%s expected=1" % (lock, lock_hw)
                            return_tuple = None
            if return_tuple is None:
                verdict = "ERROR"
                return_result = True
            else:
                return_result = False
        else:
            return_result = False

        # 2. Temporarily lift the paired ceiling if needed.
        if not return_result and ceiling:
            ceiling_meta = snapshot.get(ceiling, {})
            ceiling_target = ceiling_meta.get("max", meta.get("max"))
            if ceiling_target is None:
                verdict = "ERROR"
                note = "cannot determine ceiling range for %s" % ceiling
                return_result = True
            else:
                ok, st, data = set_ctrl(ceiling, ceiling_target)
                if not ok:
                    verdict = "ERROR"
                    note = "cannot lift %s: %s" % (ceiling, _set_error(st, data))
                    return_result = True
                else:
                    # No readback is needed here, but preserve the same minimum
                    # propagation time before writing the dependent control.
                    _settle(ceiling, "ceiling propagation")

        # 3. Set from the API exactly as the GUI does.
        if not return_result:
            ok, st, data = set_ctrl(name, target)
            if not ok:
                verdict = "ERROR"
                note = _set_error(st, data)
                return_result = True

        # 4. Wait at least two seconds, then sample hardware before webpage.
        if not return_result:
            _settle(name, "set-to-readback propagation")
            if verify_device:
                hw = hw_read(name, control_device, cam_name)
                if hw is None:
                    verdict = "HW-ERROR"
                    note = "direct v4l2 readback unavailable"
                    return_result = True
            if not return_result:
                api1 = _read_value(name)
                if api1 is None:
                    verdict = "ERROR"
                    note = "first API readback unavailable"
                    return_result = True

        # 5. Persistence check.
        if not return_result:
            _settle(name, "persistence verification")
            api2 = _read_value(name)
            if api2 is None:
                verdict = "ERROR"
                note = "persistence API readback unavailable"
                return_result = True

        # 6. Classify only after all required verification data exists.
        if not return_result:
            if api1 == target:
                verdict = "PASS"
            elif (name == "current_exposure" and
                  values_close(meta, api1, target, 0.03)):
                verdict = "CLAMP"
                note = "applied %s; difference %s" % (
                    api1, "%+d" % (api1 - target),
                )
            elif values_close(meta, api1, target, 0.03):
                verdict = "PASS"
            elif api1 != cur:
                verdict = "CLAMP"
                note = "moved to %s not %s" % (api1, target)
            else:
                verdict = "FAIL"
                note = "read back unchanged"

            if not values_close(meta, api2, api1, 0.05):
                verdict = "DRIFT"
                note = "%s -> %s after %.1fs (not held)" % (api1, api2, DELAY)

            if verify_device and not values_close(meta, hw, api1, 0.05):
                verdict = "HW-MISMATCH"
                note = "hw=%s webpage=%s" % (hw, api1)

    except Exception as exc:
        verdict = "ERROR"
        note = "exception: %s" % exc
    finally:
        restore_failures = []
        if restore_after:
            restore_failures = _restore_state(
                name, cur, lock, orig_lock, ceiling, orig_ceiling
            )

    if restore_failures:
        restore_note = "restore failed: " + "; ".join(restore_failures)
        if note:
            note += "; " + restore_note
        else:
            note = restore_note
        # State restoration failure is more important than a test PASS/CLAMP.
        if verdict in ("PASS", "CLAMP", "SKIP"):
            verdict = "RESTORE-ERROR"

    return (verdict, cur, target, api1, hw, note)


def _run_force_exposure_test(cam_name):
    """Force the raw sensor exposure register and prove that it stays fixed."""
    control = "exposure"
    dev, original, minimum, maximum = sensor_ctrl_info(cam_name, control)
    target = None
    immediate = None
    after_first = None
    after_second = None
    restored = None
    verdict = "ERROR"
    note = "sensor exposure metadata unavailable"

    print("\n" + "=" * REGULAR_REPORT_WIDTH)
    print("FORCE ISP EXPOSURE")
    print("=" * REGULAR_REPORT_WIDTH)
    print("RESULT  CONTROL                 BEFORE     TARGET  IMMEDIATE   AFTER %.0fs   AFTER %.0fs   RESTORED" % (DELAY, DELAY * 2))
    print("-" * REGULAR_REPORT_WIDTH)

    if dev is not None and None not in (original, minimum, maximum):
        span = maximum - minimum
        step = max(1, min(max(1, span // 10), 100))
        target = original + step if original + step <= maximum else original - step
        if target < minimum or target == original:
            note = "no different safe exposure value in sensor range"
        else:
            try:
                error = sensor_ctrl_write(dev, control, target)
                if error:
                    note = "force write failed: %s" % error
                else:
                    immediate = sensor_ctrl_read(dev, control)
                    _settle(control, "forced exposure stability sample 1")
                    after_first = sensor_ctrl_read(dev, control)
                    _settle(control, "forced exposure stability sample 2")
                    after_second = sensor_ctrl_read(dev, control)
                    if immediate == after_first == after_second == target:
                        verdict = "PASS"
                        note = "sensor register remained fixed while ISP was live"
                    else:
                        verdict = "FAIL"
                        note = "ISP changed the forced sensor exposure value"
            finally:
                restore_error = sensor_ctrl_write(dev, control, original)
                restored = sensor_ctrl_read(dev, control) if not restore_error else None
                if restore_error or restored != original:
                    verdict = "RESTORE-ERROR"
                    note = "original sensor exposure was not restored"

    print("%s %-22s %10s %10s %10s %10s %10s %10s  | %s" % (
        _verdict_field(verdict if verdict == "PASS" else "FAIL", 7),
        "sensor exposure", _shown(original), _shown(target), _shown(immediate),
        _shown(after_first), _shown(after_second), _shown(restored), note,
    ))
    _print_named_summary("Force ISP Exposure", {verdict: 1})
    print("=" * REPORT_WIDTH)
    return {verdict: 1}, ([] if verdict == "PASS" else ["force-exposure"] )


# ── Camera/live-context checks ───────────────────────────────────────────────
def node_streaming(node):
    """True only when this ISP out-node reports sensor_streaming == 1."""
    if not node:
        return False
    out = ssh_run(
        "v4l2-ctl -d %s --get-ctrl sensor_streaming 2>/dev/null"
        % shlex.quote(node)
    )
    if out.startswith("ERR:"):
        return False
    m = re.search(r":\s*(-?\d+)", out)
    return bool(m and int(m.group(1)) == 1)


def _invalid_camera_result(name, dev, control_device, reason):
    return {
        "camera": name,
        "device": dev,
        "control_device": control_device,
        "live_context_ok": False,
        "counts": {"INVALID": 1},
        "bad": [reason],
    }


def run_camera(dev, name, verify_device, cam_idx=0):
    global ACTIVE_CAMERA
    print("\n" + "=" * 74)
    print("CAMERA %s  (%s)" % (name, dev))
    print("=" * 74)

    st, selected = req("/api/device", "POST", {"camera": dev})
    api_ok = st == 200 and isinstance(selected, dict) and selected.get("ok") is True
    if not api_ok:
        reason = _set_error(st, selected if isinstance(selected, dict) else {})
        print("  select FAILED -> %s" % reason)
        return _invalid_camera_result(name, dev, None, "camera-select")

    # Verify immediately that the API accepted the requested stream device.
    if selected.get("stream_device") != dev:
        print(
            "  select FAILED: API reports stream_device=%s, requested=%s"
            % (selected.get("stream_device"), dev)
        )
        return _invalid_camera_result(
            name, dev, selected.get("control_device"), "camera-select-mismatch"
        )

    ACTIVE_CAMERA = dev
    print("  select -> HTTP %s ; opening stream, waiting for live pipeline..." % st)
    streamer = Streamer()
    streamer.start()

    cd = selected.get("control_device")
    waited = 0.0
    live_ok = False
    cams = {}

    try:
        wait_started = time.monotonic()
        deadline = wait_started + 60.0
        while time.monotonic() < deadline:
            time.sleep(1.0)
            waited = time.monotonic() - wait_started
            cam_st, cams = req("/api/cameras")
            if cam_st != 200 or not isinstance(cams, dict):
                continue

            # Never test a different camera under this camera's label.
            if cams.get("stream_device") != dev:
                continue

            cd = cams.get("control_device")
            if verify_device:
                # sensor_streaming becomes true before camera_api finishes its
                # delayed per-camera restore (currently 2.5s). Do not snapshot
                # or write controls from the previous camera context.
                if node_streaming(cd) and waited >= 4.0:
                    live_ok = True
                    break
            elif waited >= 6.0:
                # Without SSH we cannot prove sensor_streaming, but we can at
                # least require the app to still report the requested camera and
                # a concrete control device after its pipeline-init delay.
                live_ok = bool(cd)
                break

        _, cams_final = req("/api/cameras")
        if isinstance(cams_final, dict):
            cams = cams_final
            cd = cams.get("control_device") or cd

        selected_matches = isinstance(cams, dict) and cams.get("stream_device") == dev
        if not selected_matches:
            live_ok = False

        verdict_txt = (
            "LIVE (sensor_streaming=1)"
            if live_ok and verify_device
            else "control_device set (API-only verification)"
            if live_ok
            else "NOT STREAMING / WRONG CAMERA"
        )
        print(
            "  stream_device=%s  control_device=%s  [%s after %.0fs]"
            % ((cams or {}).get("stream_device"), cd, verdict_txt, waited)
        )

        _, diag = req("/api/diagnostics")
        diag = diag if isinstance(diag, dict) else {}
        print(
            "  diag: vblank=%s hblank=%s dgain_raw=%s unity=%s exp_log2=%s"
            % (
                diag.get("vertical_blanking"),
                diag.get("horizontal_blanking"),
                diag.get("digital_gain_raw"),
                diag.get("digital_gain_unity"),
                diag.get("get_expososure_log2"),
            )
        )

        if not live_ok:
            print(
                "  SKIPPING sweep: requested camera/live ISP context was not "
                "confirmed. Testing now could create false PASS results."
            )
            return _invalid_camera_result(name, dev, cd, "live-context")

        initial_controls = controls()
        control_groups = grouped_control_names(initial_controls)
        if A.block:
            selected_blocks = set(A.block)
            control_groups = [
                (block, names) for block, names in control_groups
                if block in selected_blocks
            ]
        if A.force_exposure_only:
            control_groups = []
        control_names = [name for _, names in control_groups for name in names]
        if not control_names and not (A.test_force_exposure or A.force_exposure_only):
            print("  /api/controls returned no controls; skipping camera")
            return _invalid_camera_result(name, dev, cd, "controls-unavailable")

        counts = {}
        block_counts = {}
        bad = []
        failing_verdicts = {
            "FAIL",
            "ERROR",
            "DRIFT",
            "HW-MISMATCH",
            "HW-ERROR",
            "RESTORE-ERROR",
        }

        for block_name, block_controls in control_groups:
            block_counts.setdefault(block_name, {})
            block_locks = [
                lock_name for lock_name in UI_BLOCK_LOCKS.get(block_name, [])
                if lock_name in initial_controls
            ]
            if block_locks:
                print("\n" + "=" * REPORT_WIDTH)
                print(block_name.upper())
                print("=" * REPORT_WIDTH)
                manual_counts, manual_bad = _run_manual_control_block(
                    block_name, block_controls, block_locks,
                    cd, name, verify_device, cam_idx
                )
                block_counts[block_name] = manual_counts
                for verdict, number in manual_counts.items():
                    counts[verdict] = counts.get(verdict, 0) + number
                bad.extend(manual_bad)
                continue

            print("\n" + "=" * REGULAR_REPORT_WIDTH)
            print(block_name.upper())
            print("=" * REGULAR_REPORT_WIDTH)
            _print_table_header(verify_device)

            for cname in block_controls:
                if cname in block_locks:
                    continue
                if cname in SKIP:
                    counts["SKIP"] = counts.get("SKIP", 0) + 1
                    block_counts[block_name]["SKIP"] = block_counts[block_name].get("SKIP", 0) + 1
                    skip_meta = initial_controls.get(cname, {})
                    web_value = skip_meta.get("value") if isinstance(skip_meta, dict) else None
                    hardware_value = hw_read(cname, cd, name) if verify_device else None
                    print(_row_with_note(_format_result_row(
                        "SKIP", cname, web_value, None, web_value, hardware_value,
                        verify_device,
                    ), SKIP[cname]))
                    continue

                meta = controls().get(cname)
                if not isinstance(meta, dict):
                    verdict, cur, tgt, web, hw, note = (
                        "ERROR", None, None, None, None,
                        "control metadata unavailable",
                    )
                else:
                    verdict, cur, tgt, web, hw, note = test_control(
                        cname, meta, cd, name, verify_device, cam_idx
                    )
                counts[verdict] = counts.get(verdict, 0) + 1
                block_counts[block_name][verdict] = block_counts[block_name].get(verdict, 0) + 1
                shown_note = note if verdict not in ("PASS", "SKIP") else ""
                print(_row_with_note(_format_result_row(
                    verdict, cname, cur, tgt, web, hw, verify_device
                ), shown_note))
                if verdict in failing_verdicts:
                    bad.append(cname)

                if A.test_defaults:
                    default = meta.get("default") if isinstance(meta, dict) else None
                    if default is None:
                        default_result = (
                            "SKIP", cur, None, web, hw,
                            "metadata default unavailable",
                        )
                    else:
                        default_result = test_control(
                            cname, meta, cd, name, verify_device, cam_idx,
                            target_override=default,
                        )
                    d_verdict, d_cur, d_tgt, d_web, d_hw, d_note = default_result
                    counts[d_verdict] = counts.get(d_verdict, 0) + 1
                    block_counts[block_name][d_verdict] = (
                        block_counts[block_name].get(d_verdict, 0) + 1
                    )
                    print(_row_with_note(_format_result_row(
                        d_verdict, cname + " [default]", d_cur, d_tgt,
                        d_web, d_hw, verify_device
                    ), d_note if d_verdict != "PASS" else ""))
                    if d_verdict in failing_verdicts:
                        bad.append(cname + "(default)")

        if A.test_force_exposure or A.force_exposure_only:
            force_counts, force_bad = _run_force_exposure_test(name)
            block_counts["Force ISP Exposure"] = force_counts
            for verdict, number in force_counts.items():
                counts[verdict] = counts.get(verdict, 0) + number
            bad.extend(force_bad)

        if A.test_presets and not A.force_exposure_only:
            preset_counts, preset_bad = _run_preset_tests(
                cd, name, verify_device
            )
            block_counts["Presets"] = preset_counts
            for verdict, number in preset_counts.items():
                counts[verdict] = counts.get(verdict, 0) + number
            bad.extend(preset_bad)

        if (len(control_groups) == 1 and
                UI_BLOCK_LOCKS.get(control_groups[0][0])):
            _print_named_summary("Camera Total", counts)
            print("=" * REPORT_WIDTH)
        else:
            print("\n  Block summary")
            print("  " + "-" * 48)
            for block_name, _ in control_groups:
                print("  %-22s %s" % (
                    block_name,
                    _counts_text(block_counts.get(block_name, {})),
                ))
            print("  %-22s %s" % ("CAMERA TOTAL", _counts_text(counts)))
        return {
            "camera": name,
            "device": dev,
            "control_device": cd,
            "live_context_ok": live_ok,
            "counts": counts,
            "blocks": block_counts,
            "bad": bad,
        }
    finally:
        if not streamer.stop():
            print("  WARNING: MJPEG keep-alive thread did not exit cleanly", file=sys.stderr)


def main():
    verify_device = A.verify_device
    if (A.test_force_exposure or A.force_exposure_only) and not verify_device:
        print("forced exposure testing requires --verify-device", file=sys.stderr)
        return 2
    if LOG_PATH:
        print("Log file: %s" % LOG_PATH)
        _LOG_HANDLE.write(
            "\nEXECUTION TRACE\n"
            "TIME         | ACTION       | CONTROL                                      "
            "|        VALUE | RESULT   | DETAIL\n"
            "-------------+--------------+----------------------------------------------"
            "+--------------+----------+------------------------------\n"
        )
        _trace("RUN", "-", "-", "START", BASE)
    if verify_device:
        print(
            "Hardware verification: SSH %s%s"
            % (SSH_TARGET, " (password)" if A.ssh_pass else " (key)")
        )
        if not ssh_ok():
            print(
                "  SSH check FAILED. --verify-device was requested, so the sweep "
                "is stopping rather than silently downgrading to API-only checks.",
                file=sys.stderr,
            )
            return 2
        print("  SSH OK")

    st, cams = req("/api/cameras")
    cam_list = (cams or {}).get("cameras", []) if isinstance(cams, dict) else []
    if st != 200 or not cam_list:
        print("No cameras from /api/cameras — is the service up?")
        return 1

    print(
        "Detected %d camera(s): %s  |  delay=%.1fs"
        % (
            len(cam_list),
            ", ".join("%s=%s" % (c["name"], c["device"]) for c in cam_list),
            DELAY,
        )
    )

    results = [
        run_camera(c["device"], c["name"], verify_device, i)
        for i, c in enumerate(cam_list)
    ]

    print("\n" + "=" * 74)
    print("OVERALL")
    print("=" * 74)
    bad_any = False
    for result in results:
        status_ok = result["live_context_ok"] and not result["bad"]
        bad_any = bad_any or not status_ok
        print("  %s (%s)" % (result["camera"], result["device"]))
        print("    control device : %s" % result["control_device"])
        print("    live context   : %s" % ("OK" if result["live_context_ok"] else "FAILED"))
        print("    results        : %s" % _counts_text(result["counts"]))
        if result["bad"]:
            print("    issues         : %s" % ", ".join(result["bad"]))
    print("=" * 74)
    exit_code = 1 if bad_any else 0
    _trace("RUN", "-", exit_code, "FAIL" if bad_any else "PASS",
           "sweep complete")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
