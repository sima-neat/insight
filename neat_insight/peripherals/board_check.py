"""Read-only peripheral check, executed on the board as ``python3 - REQUEST``.

Stdlib only and Python 3.8 compatible. SiMa Sentinel discovers the cameras and
microphones; this adds what Sentinel does not report and the Peripherals page
shows: which processes hold each device's nodes, how many of a microphone's capture
substreams are open now, which sound servers run, and which camera modes Neat
Core's CameraInput supports. It never opens a camera or a sound device. REQUEST is
JSON ``{"cameras": {id: [device nodes]}, "microphones": {id: [capture PCM node]},
"support": bool}``; a media device brings every node of its media graph, and
``support`` asks PyNeat for Neat Core's verdicts. It prints one JSON document.
"""
import json
import os
import re
import shutil
import subprocess
import sys

PROC_ROOT = "/proc"
COMMAND_TIMEOUT = 10
CORE_TIMEOUT = 20
PYNEAT_PYTHON = os.path.join(os.environ.get("PYNEAT_VENV_DIR") or os.path.expanduser("~/pyneat"), "bin", "python")
# Run by PyNeat's python: Neat Core's verdict on each camera mode, as one JSON document.
CORE_PROBE = r"""
import json
try:
    import pyneat
except ImportError as exc:
    print(json.dumps({"state": "not_installed", "reason": str(exc)}))
    raise SystemExit
if not hasattr(pyneat, "peripherals"):
    print(json.dumps({"state": "outdated", "reason": "This PyNeat has no peripherals module."}))
    raise SystemExit
try:
    catalog = pyneat.peripherals.list()
except Exception as exc:
    print(json.dumps({"state": "failed", "reason": str(exc)}))
    raise SystemExit
cameras = {}
for device in catalog:
    if device.camera is not None:
        cameras[device.id] = [{
            "format": mode.format, "width": mode.width, "height": mode.height,
            "size_range": {key: getattr(mode.size_range, key) for key in (
                "min_width", "min_height", "max_width", "max_height")} if mode.size_range else None,
            "framerate_num": mode.framerate_num, "framerate_den": mode.framerate_den,
            "supported": mode.supported, "reason": mode.reason,
        } for mode in device.camera.modes]
print(json.dumps({"state": "ok", "cameras": cameras}))
"""
TOOLS = ("media-ctl", "fuser", "sudo")
SEARCH_PATH = os.pathsep.join(
    [os.environ.get("PATH") or "/usr/bin:/bin", "/usr/local/bin", "/usr/sbin", "/sbin"]
)
COMMAND_ENV = dict(os.environ, PATH=SEARCH_PATH, LC_ALL="C")
_MEDIA_RE = re.compile(r"/dev/media[0-9]+")
_PCM_RE = re.compile(r"/dev/snd/pcmC([0-9]+)D([0-9]+)c")
# Process names (/proc/<pid>/comm) of sound servers that usually own the capture devices.
SOUND_SERVERS = ("pulseaudio", "pipewire", "pipewire-pulse")


def which(name):
    return shutil.which(name, path=SEARCH_PATH)


def run(argv, timeout=COMMAND_TIMEOUT):
    """Run argv without a shell; return (exit code, stdout, stderr), exit code None on timeout."""
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
    return "\n".join(text.strip().splitlines()[-lines:])


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return None


def _failure(tool, code, err):
    return {"tool": tool, "reason": "timeout" if code is None else "failed", "detail": _tail(err)}


def media_graph_nodes(text):
    """The device nodes `media-ctl -p` lists for the entities of one media device."""
    prefix = "device node name "
    return [line.strip()[len(prefix):].strip() for line in text.splitlines() if line.strip().startswith(prefix)]


def parse_fuser_pids(text):
    return sorted({int(pid) for pid in re.findall(r"\d+", text)})


def _users(pids):
    return [{"pid": pid, "command": _read(os.path.join(PROC_ROOT, str(pid), "comm")) or "?"} for pid in sorted(pids)]


def availability_method(tools):
    if os.geteuid() == 0:
        return "proc-root"
    if tools.get("sudo") and tools.get("fuser"):
        code, _, _ = run([tools["sudo"], "-n", "true"])
        if code == 0:
            return "sudo-fuser"
    return "proc-user" if os.path.isdir(PROC_ROOT) else "none"


def scan_proc():
    """Map each /dev path held open to the pids holding it, for every process we may inspect;
    None when /proc itself cannot be listed, so no process could be checked."""
    held = {}
    own = os.getpid()
    try:
        pids = [name for name in os.listdir(PROC_ROOT) if name.isdigit() and int(name) != own]
    except OSError:
        return None
    for pid in pids:
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
        if held is None:
            return lambda nodes: None
        return lambda nodes: _users({pid for node in nodes for pid in held.get(node, ())})
    if method == "sudo-fuser":

        def check(nodes):
            code, out, err = run([tools["sudo"], "-n", tools["fuser"]] + sorted(nodes))
            if code == 0:
                return _users(parse_fuser_pids(out))
            # fuser exits 1 when no process uses a file, but also for fatal errors. Only an
            # otherwise empty exit proves that the nodes were successfully checked and idle.
            return [] if code == 1 and not out.strip() and not err.strip() else None

        return check
    return lambda nodes: None


def sound_servers():
    pids = [pid for pid in (os.listdir(PROC_ROOT) if os.path.isdir(PROC_ROOT) else ()) if pid.isdigit()]
    return sorted({name for name in (_read(os.path.join(PROC_ROOT, pid, "comm")) for pid in pids) if name in SOUND_SERVERS})


def capture_open(node):
    """How many substreams of a capture PCM are open now, from /proc/asound; None when unreadable.

    A sound server such as PulseAudio opens a new microphone for a few seconds after it is plugged in,
    and no event marks the release, so this is read live rather than taken from the last scan.
    """
    match = _PCM_RE.fullmatch(node or "")
    if not match:
        return None
    directory = os.path.join(PROC_ROOT, "asound", "card" + match.group(1), "pcm%sc" % match.group(2))
    try:
        subs = [name for name in os.listdir(directory) if re.fullmatch(r"sub[0-9]+", name)]
    except OSError:
        return None
    statuses = [_read(os.path.join(directory, sub, "status")) for sub in subs]
    if not subs or None in statuses:
        return None
    return sum(1 for status in statuses if status != "closed")


def camera_nodes(nodes, tools, failures):
    """The camera's nodes plus its media graphs' nodes, and whether every graph could be read."""
    found = set(nodes)
    complete = True
    for media in [node for node in nodes if _MEDIA_RE.fullmatch(node)]:
        if not tools.get("media-ctl"):
            complete = False
            continue
        code, out, err = run([tools["media-ctl"], "-d", media, "-p"])
        if code == 0:
            found.update(media_graph_nodes(out))
        else:
            complete = False
            failures.append(_failure("media-ctl", code, err))
    found.discard("")
    return found, complete


def core_support():
    """Neat Core's camera mode verdicts from PyNeat (its per-user venv, else this python); a state otherwise."""
    python = PYNEAT_PYTHON if os.access(PYNEAT_PYTHON, os.X_OK) else sys.executable
    code, out, err = run([python, "-c", CORE_PROBE], timeout=CORE_TIMEOUT)
    try:
        result = json.loads(out)
    except ValueError:
        result = None
    if code != 0 or not isinstance(result, dict):
        detail = "timed out after %d s" % CORE_TIMEOUT if code is None else _tail(err) or "no output"
        return {"state": "failed", "reason": detail}
    return result


def collect(request):
    tools = {name: which(name) for name in TOOLS}
    failures = []
    method = availability_method(tools)
    check_users = user_checker(method, tools)
    users, opened = {}, {}
    for device_id, nodes in (request.get("microphones") or {}).items():
        opened[device_id] = capture_open(nodes[0]) if nodes else None
        # Every open of a capture PCM attaches a substream, so with none open nobody holds it.
        users[device_id] = [] if opened[device_id] == 0 else check_users(nodes) if nodes else None
    cameras = request.get("cameras") or {}
    for device_id, nodes in cameras.items():
        if not nodes:
            users[device_id] = None
            continue
        found, complete = camera_nodes(nodes, tools, failures)
        held = check_users(found)
        # Nobody holding the nodes that could be read proves nothing when the graph's video and
        # subdevice nodes could not be listed: report the camera as unchecked, not free.
        users[device_id] = held if held or complete else None
    result = {
        "tools": {name: bool(path) for name, path in tools.items() if name != "sudo"},
        "availability_method": method,
        "users": users,
        "failures": failures,
        "support": core_support() if cameras and request.get("support") else None,
    }
    if "microphones" in request:
        result["capture_open"] = opened
        result["sound_servers"] = sound_servers()
    return result


if __name__ == "__main__":
    print(json.dumps(collect(json.loads(sys.argv[1]) if len(sys.argv) > 1 else {})))
