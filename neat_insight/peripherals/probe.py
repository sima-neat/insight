"""Camera discovery probe, executed on the board as ``python3 -``.

Stdlib only and Python 3.8 compatible. It reads sysfs, /proc and the output of
libcamera and V4L2 tools, never captures or changes controls, and prints one
JSON document that ``cameras.py`` turns into the Peripherals snapshot.
"""
import json
import os
import platform
import re
import shutil
import subprocess
import time

SCHEMA = 1
SYSFS_ROOT = "/sys"
PROC_ROOT = "/proc"
DEV_ROOT = "/dev"
COMMAND_TIMEOUT = 10
# cam -I opens the sensor and gst-inspect may rebuild the plugin registry.
SLOW_COMMAND_TIMEOUT = 15
# The backend waits BUDGET_SEC + a margin; commands past the budget are skipped, not waited for.
BUDGET_SEC = 70
TOOLS = ("cam", "media-ctl", "v4l2-ctl", "gst-inspect-1.0", "fuser", "sudo")
_deadline = None
OUT_OF_TIME = "skipped: the probe's time budget was used up"
SEARCH_PATH = os.pathsep.join(
    [os.environ.get("PATH") or "/usr/bin:/bin", "/usr/local/bin", "/usr/sbin", "/sbin"]
)
# LC_ALL=C keeps v4l2-ctl's decimal separator a dot.
COMMAND_ENV = dict(os.environ, PATH=SEARCH_PATH, LC_ALL="C")

_ENTITY_RE = re.compile(r"^- entity \d+: (.+?) \([^)]*\)\s*$")
_CAM_LINE_RE = re.compile(r"^\s*(\d+):\s*(\S.*?)\s*$")
_NO_SENSOR_RE = re.compile(r"Device (\S+) has no sensors")
_RATE_RE = re.compile(r"mode rate limit:\s*([\d.]+)\s*fps")
_ADDING_RE = re.compile(r"Adding camera '([^']+)'")
_ACQUIRE_FAILED_RE = re.compile(r"Failed to acquire camera|Device or resource busy")
_STREAM_RE = re.compile(r"^\s*(\d+):\s*\d+x\d+-\S+")
_PIXFMT_RE = re.compile(
    r"^\s*\*\s*Pixelformat:\s*(\S+)"
    r"(?:\s+\((\d+)x(\d+)\)-\((\d+)x(\d+)\)(?:/\(\+(\d+),\+(\d+)\))?)?"
)
_SIZE_LINE_RE = re.compile(r"^\s*-\s*(\d+)x(\d+)\s*$")
_GST_PROPERTY_RE = re.compile(r"^  ([a-z][a-z0-9-]*)\s*:")
_V4L2_FORMAT_RE = re.compile(r"^\s*\[\d+\]:\s*'([^']*)'\s*\((.*)\)\s*$")
_V4L2_DISCRETE_SIZE_RE = re.compile(r"^\s*Size:\s*Discrete\s+(\d+)x(\d+)")
_V4L2_RANGE_SIZE_RE = re.compile(
    r"^\s*Size:\s*(?:Stepwise|Continuous)\s+(\d+)x(\d+)\s*-\s*(\d+)x(\d+)(?:\s+with step\s+(\d+)/(\d+))?"
)
_V4L2_DISCRETE_INTERVAL_RE = re.compile(r"^\s*Interval:\s*Discrete\s.*\(([\d.]+)\s*fps\)")
_V4L2_RANGE_INTERVAL_RE = re.compile(r"^\s*Interval:\s*(?:Stepwise|Continuous)\s.*\(([\d.]+)-([\d.]+)\s*fps\)")
_V4L2_CARD_RE = re.compile(r"^\s*Card type\s*:\s*(.*?)\s*$", re.MULTILINE)
# The Modalix ISP's output nodes: sysfs name and V4L2 card.
ISP_OUTPUT_NAME = "isp_v4l2-vid-cap-out"
ISP_OUTPUT_CARD = "arm-isp-out"
# libcamera's UVC pipeline ids end in "<vid>:<pid>"; those cameras are reported through V4L2.
_USB_CAMERA_ID_RE = re.compile(r"[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$")


def which(name):
    return shutil.which(name, path=SEARCH_PATH)


def run(argv, timeout=COMMAND_TIMEOUT):
    """Run argv without a shell; return (exit code, stdout, stderr), exit code None on timeout."""
    if _deadline is not None:
        timeout = min(timeout, _deadline - time.monotonic())
        if timeout <= 0:
            return None, "", OUT_OF_TIME
    try:
        proc = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=COMMAND_ENV,
        )
    except subprocess.TimeoutExpired:
        return None, "", "timed out after %d s" % timeout
    except OSError as exc:
        return 127, "", str(exc)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


def _tail(text, lines=3):
    return "\n".join(line for line in text.strip().splitlines()[-lines:])


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return None


def _names(directory, pattern):
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    matcher = re.compile(pattern)
    matched = [name for name in names if matcher.fullmatch(name)]
    return sorted(matched, key=lambda name: [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)])


def parse_media_ctl(text):
    info = {"driver": None, "model": None, "bus_info": None, "entities": []}
    header_keys = {"driver": "driver", "model": "model", "bus info": "bus_info"}
    entity = None
    for line in text.splitlines():
        match = _ENTITY_RE.match(line)
        if match:
            entity = {"name": match.group(1).strip(), "type": "", "node": None}
            info["entities"].append(entity)
            continue
        stripped = line.strip()
        if entity is None:
            for label, key in header_keys.items():
                if stripped.startswith(label + " ") and info[key] is None:
                    info[key] = stripped[len(label):].strip() or None
        elif stripped.startswith("type "):
            entity["type"] = stripped
        elif stripped.startswith("device node name "):
            entity["node"] = stripped[len("device node name "):].strip()
    return info


def _split_camera_label(label):
    model = None
    match = re.match(r"(.*?)'([^']*)'\s*(.*)$", label)
    if match:
        model, label = match.group(2), match.group(3)
    if label.endswith(")") and "(" in label:
        return model, label[label.index("(") + 1:-1].strip()
    return model, label.strip()


def parse_rate_limits(text):
    """Map camera id -> max fps from the Modalix handler's log, which precedes each camera's registration."""
    rates, pending = {}, None
    for line in text.splitlines():
        match = _RATE_RE.search(line)
        if match:
            pending = float(match.group(1))
            continue
        match = _ADDING_RE.search(line)
        if match and pending is not None:
            rates[match.group(1)] = pending
            pending = None
    return rates


def parse_cam_list(text):
    cameras, listing = [], False
    for line in text.splitlines():
        if line.strip() == "Available cameras:":
            listing = True
            continue
        match = _CAM_LINE_RE.match(line)
        if listing and match:
            model, camera_id = _split_camera_label(match.group(2))
            cameras.append({"index": int(match.group(1)), "id": camera_id, "model": model})
    return {
        "cameras": cameras,
        "no_sensor": sorted(set(_NO_SENSOR_RE.findall(text))),
        "rates": parse_rate_limits(text),
    }


def parse_cam_info(text):
    """Formats of the first stream from `cam -c <id> -I`."""
    formats, current = [], None
    for line in text.splitlines():
        match = _STREAM_RE.match(line)
        if match:
            if int(match.group(1)) > 0:
                break
            continue
        match = _PIXFMT_RE.match(line)
        if match:
            current = {"format": match.group(1), "range": _size_range(match.groups()[1:]), "sizes": []}
            formats.append(current)
            continue
        match = _SIZE_LINE_RE.match(line)
        if match and current is not None:
            current["sizes"].append({"width": int(match.group(1)), "height": int(match.group(2))})
    return formats


def acquire_failed(text):
    return bool(_ACQUIRE_FAILED_RE.search(text))


def _size_range(groups):
    if groups[0] is None:
        return None
    values = [int(value) if value is not None else 1 for value in groups]
    keys = ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")
    return dict(zip(keys, values))


def parse_gst_properties(text):
    properties, in_properties = set(), False
    for line in text.splitlines():
        if line.startswith("Element Properties:"):
            in_properties = True
            continue
        if in_properties and line and not line[0].isspace():
            break
        match = _GST_PROPERTY_RE.match(line)
        if in_properties and match:
            properties.add(match.group(1))
    return properties


def parse_device_caps(text):
    """The node's own capabilities from `v4l2-ctl --info`; the driver-wide Capabilities list covers every node."""
    caps, in_caps = [], False
    for line in text.splitlines():
        key, sep, _ = line.partition(":")
        if sep:
            in_caps = key.strip() == "Device Caps" and not caps
        elif in_caps and line.strip():
            caps.append(line.strip())
    return caps


def parse_v4l2_formats(text):
    formats, current, size = [], None, None
    for line in text.splitlines():
        match = _V4L2_FORMAT_RE.match(line)
        if match:
            current = {"format": match.group(1), "description": match.group(2), "range": None, "sizes": []}
            formats.append(current)
            size = None
            continue
        if current is None:
            continue
        match = _V4L2_DISCRETE_SIZE_RE.match(line)
        if match:
            size = {"width": int(match.group(1)), "height": int(match.group(2)), "fps": [], "fps_range": None}
            current["sizes"].append(size)
            continue
        match = _V4L2_RANGE_SIZE_RE.match(line)
        if match:
            current["range"] = _size_range(match.groups())
            size = None
            continue
        match = _V4L2_DISCRETE_INTERVAL_RE.match(line)
        if match and size is not None:
            size["fps"].append(float(match.group(1)))
            continue
        match = _V4L2_RANGE_INTERVAL_RE.match(line)
        if match and size is not None:
            size["fps_range"] = [float(match.group(1)), float(match.group(2))]
    return formats


def parse_fuser_pids(text):
    return sorted({int(pid) for pid in re.findall(r"\d+", text)})


def _command(pid):
    return _read(os.path.join(PROC_ROOT, str(pid), "comm")) or "?"


def _users(pids):
    return [{"pid": pid, "command": _command(pid)} for pid in sorted(pids)]


def availability_method(tools):
    if os.geteuid() == 0:
        return "proc-root"
    if tools.get("sudo") and tools.get("fuser"):
        code, _, _ = run([tools["sudo"], "-n", "true"])
        if code == 0:
            return "sudo-fuser"
    return "proc-user" if os.path.isdir(PROC_ROOT) else "none"


def scan_proc():
    """Map each /dev path held open to the pids holding it, for every process we may inspect."""
    held = {}
    own = os.getpid()
    for pid in _names(PROC_ROOT, r"\d+"):
        if int(pid) == own:
            continue
        fd_dir = os.path.join(PROC_ROOT, pid, "fd")
        try:
            fds = os.listdir(fd_dir)
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(os.path.join(fd_dir, fd))
            except OSError:
                continue
            if target.startswith("/dev/"):
                held.setdefault(target, set()).add(int(pid))
    return held


def user_checker(method, tools):
    """Return nodes -> list of users, or None when the check could not run."""
    if method in ("proc-root", "proc-user"):
        held = scan_proc()
        return lambda nodes: _users({pid for node in nodes for pid in held.get(node, ())})
    if method == "sudo-fuser":

        def check(nodes):
            code, out, err = run([tools["sudo"], "-n", tools["fuser"]] + list(nodes))
            if code is None or "sudo:" in err:
                return None
            return _users(parse_fuser_pids(out))

        return check
    return lambda nodes: None


def discover_media(tools, failures):
    devices = []
    for name in _names(DEV_ROOT, r"media\d+"):
        path = "/dev/" + name
        device = {"path": path, "driver": None, "model": None, "bus_info": None, "csi": None}
        device.update(sensors=[], nodes=[path])
        if tools.get("media-ctl"):
            code, out, err = run([tools["media-ctl"], "-d", path, "-p"])
            if code == 0:
                graph = parse_media_ctl(out)
                if graph["driver"] == "uvcvideo" or (graph["bus_info"] or "").startswith("usb-"):
                    continue
                device.update(driver=graph["driver"], model=graph["model"], bus_info=graph["bus_info"])
                for entity in graph["entities"]:
                    if "subtype Sensor" in entity["type"]:
                        device["sensors"].append({"name": entity["name"], "node": entity["node"]})
                    elif ".csi" in entity["name"] and device["csi"] is None:
                        device["csi"] = entity["name"]
                    if entity["node"]:
                        device["nodes"].append(entity["node"])
            else:
                failures.append(_failure("media-ctl", code, err))
        devices.append(device)
    return devices


def _failure(tool, code, err):
    reason = "out_of_time" if err == OUT_OF_TIME else "timeout" if code is None else "failed"
    return {"tool": tool, "reason": reason, "detail": _tail(err)}


def list_libcamera(tools, failures):
    if not tools.get("cam"):
        return None
    code, out, err = run([tools["cam"], "-l"])
    listing = parse_cam_list(err + "\n" + out)
    listing["listed"] = code == 0
    if code != 0:
        failures.append(_failure("cam", code, err))
    return listing


def probe_libcamerasrc(tools, failures):
    if not tools.get("gst-inspect-1.0"):
        return None
    code, out, err = run([tools["gst-inspect-1.0"], "libcamerasrc"], SLOW_COMMAND_TIMEOUT)
    if code is None:
        failures.append(_failure("gst-inspect-1.0", code, err))
        return None
    properties = parse_gst_properties(out)
    return {
        "present": code == 0,
        "external_buffer_mode": "external-buffer-mode" in properties,
        "buffer_count": "buffer-count" in properties,
    }


def collect_mipi(tools, media, listing, check_users):
    sensors = {sensor["name"]: device for device in media for sensor in device["sensors"]}
    entries = []
    for camera in (listing or {}).get("cameras", []):
        if camera["id"] in sensors or not _USB_CAMERA_ID_RE.search(camera["id"]):
            entries.append(dict(camera, source="libcamera"))
    listed = {entry["id"] for entry in entries}
    entries += [{"id": name, "model": None, "source": "media-graph"} for name in sensors if name not in listed]
    rates = (listing or {}).get("rates", {})

    cameras = []
    for entry in entries:
        device = sensors.get(entry["id"])
        users = check_users(device["nodes"]) if device else None
        camera = {
            "id": entry["id"],
            "model": entry.get("model"),
            "source": entry["source"],
            "media_device": device["path"] if device else None,
            "users": users,
            "acquire": None,
            "detail": None,
            "formats": [],
            "max_fps": rates.get(entry["id"]),
        }
        if entry["source"] == "libcamera":
            if users:
                camera["acquire"] = "skipped"
            else:
                _read_modes(tools, camera)
        cameras.append(camera)
    return cameras


def _read_modes(tools, camera):
    # cam -I acquires the camera exclusively but never starts streaming.
    code, out, err = run([tools["cam"], "-c", camera["id"], "-I"], SLOW_COMMAND_TIMEOUT)
    text = err + "\n" + out
    if code is None:
        camera["acquire"] = "out_of_time" if err == OUT_OF_TIME else "timeout"
    elif acquire_failed(text):
        camera["acquire"] = "busy"
    elif code != 0:
        camera["acquire"] = "failed"
        camera["detail"] = _tail(err or out)
    else:
        camera["acquire"] = "ok"
        camera["formats"] = parse_cam_info(text)
        camera["max_fps"] = parse_rate_limits(text).get(camera["id"], camera["max_fps"])


def _by_id_links():
    directory = os.path.join(DEV_ROOT, "v4l", "by-id")
    links = {}
    for name in _names(directory, r".+"):
        try:
            target = os.readlink(os.path.join(directory, name))
        except OSError:
            continue
        node = os.path.normpath(os.path.join("/dev/v4l/by-id", target))
        links.setdefault(node, "/dev/v4l/by-id/" + name)
    return links


def _usb_device_dir(class_dir):
    root = os.path.realpath(SYSFS_ROOT)
    path = os.path.realpath(os.path.join(class_dir, "device"))
    while path.startswith(root + os.sep):
        if os.path.isfile(os.path.join(path, "idVendor")):
            return path
        path = os.path.dirname(path)
    return None


def _usb_identity(usb_dir):
    def attr(name):
        return _read(os.path.join(usb_dir, name)) or None

    speed = attr("speed")
    try:
        speed_mbps = int(float(speed)) if speed else None
    except ValueError:
        speed_mbps = None
    return {
        "vendor_id": attr("idVendor"),
        "product_id": attr("idProduct"),
        "manufacturer": attr("manufacturer"),
        "product": attr("product"),
        "serial": attr("serial"),
        "bus_path": os.path.basename(usb_dir),
        "speed_mbps": speed_mbps,
    }


def collect_usb(tools, check_users):
    by_id = _by_id_links()
    class_root = os.path.join(SYSFS_ROOT, "class", "video4linux")
    cameras = []
    for name in _names(class_root, r".+"):
        class_dir = os.path.join(class_root, name)
        usb_dir = _usb_device_dir(class_dir)
        if usb_dir is None or _read(os.path.join(class_dir, "index")) != "0":
            continue
        node = "/dev/" + name
        camera = {
            "node": node,
            "by_id": by_id.get(node),
            "name": _read(os.path.join(class_dir, "name")),
            "usb": _usb_identity(usb_dir),
            "formats": None,
            "detail": None,
        }
        v4l2 = tools.get("v4l2-ctl")
        if v4l2:
            code, out, _ = run([v4l2, "-d", node, "--info"])
            if code == 0 and not any(cap.startswith("Video Capture") for cap in parse_device_caps(out)):
                continue
            code, out, err = run([v4l2, "-d", node, "--list-formats-ext"])
            if code == 0:
                camera["formats"] = parse_v4l2_formats(out)
            else:
                camera["detail"] = _tail(err) or "v4l2-ctl --list-formats-ext failed"
        camera["users"] = check_users([node])
        cameras.append(camera)
    return cameras


def read_isp_sizes(tools):
    """Discrete sizes every ISP output node lists, or the reason they could not be read."""
    result = {"nodes": [], "sizes": None, "differs": False, "reason": None, "node": None, "detail": None}
    if not tools.get("v4l2-ctl"):
        result["reason"] = "tool_missing"
        return result
    class_root = os.path.join(SYSFS_ROOT, "class", "video4linux")
    common = None
    for name in _names(class_root, r".+"):
        if _read(os.path.join(class_root, name, "name")) != ISP_OUTPUT_NAME:
            continue
        node = "/dev/" + name
        code, out, err = run([tools["v4l2-ctl"], "-d", node, "--info", "--list-formats-ext"])
        if code != 0:
            reason = "out_of_time" if err == OUT_OF_TIME else "timeout" if code is None else "failed"
            result.update(reason=reason, node=node, detail=_tail(err or out))
            return result
        if ISP_OUTPUT_CARD not in _V4L2_CARD_RE.findall(out):
            continue
        sizes = {(size["width"], size["height"]) for fmt in parse_v4l2_formats(out) for size in fmt["sizes"]}
        if not sizes:
            result.update(reason="unparseable", node=node)
            return result
        result["nodes"].append(node)
        result["differs"] = result["differs"] or (common is not None and sizes != common)
        common = sizes if common is None else common & sizes
    if common is None:
        result["reason"] = "no_nodes"
    elif not common:
        result["reason"] = "no_common_sizes"
    else:
        result["sizes"] = [{"width": w, "height": h} for w, h in sorted(common)]
    return result


def collect():
    global _deadline
    _deadline = time.monotonic() + BUDGET_SEC
    tools = {name: which(name) for name in TOOLS}
    failures = []
    method = availability_method(tools)
    # Scan for other users before cam -I runs so the probe never sees its own acquire.
    check_users = user_checker(method, tools)
    media = discover_media(tools, failures)
    listing = list_libcamera(tools, failures)
    mipi = collect_mipi(tools, media, listing, check_users)
    return {
        "schema": SCHEMA,
        "python": platform.python_version(),
        "euid": os.geteuid(),
        "tools": {name: bool(path) for name, path in tools.items()},
        "libcamerasrc": probe_libcamerasrc(tools, failures),
        "availability_method": method,
        "media_devices": media,
        "libcamera": listing,
        "mipi": mipi,
        # Only needed to gate libcamera's modes, so skipped when no camera reported any.
        "isp": read_isp_sizes(tools) if any(camera["formats"] for camera in mipi) else None,
        "usb": collect_usb(tools, check_users),
        "failures": failures,
    }


if __name__ == "__main__":
    print(json.dumps(collect()))
