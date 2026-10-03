"""Read-only camera check, executed on the board as ``python3 - REQUEST``.

Stdlib only and Python 3.8 compatible. SiMa Sentinel discovers the cameras; this
adds what Sentinel does not report and the Peripherals page shows: which
processes hold each camera's device nodes, and the libcamerasrc properties the
CameraInput export depends on. It never opens a camera. REQUEST is JSON
``{"cameras": {id: [device nodes]}, "libcamerasrc": bool}``; a media device
brings every node of its media graph. It prints one JSON document.
"""
import json
import os
import re
import shutil
import subprocess
import sys

PROC_ROOT = "/proc"
COMMAND_TIMEOUT = 10
# gst-inspect may rebuild the plugin registry.
SLOW_COMMAND_TIMEOUT = 15
TOOLS = ("media-ctl", "gst-inspect-1.0", "fuser", "sudo")
SEARCH_PATH = os.pathsep.join(
    [os.environ.get("PATH") or "/usr/bin:/bin", "/usr/local/bin", "/usr/sbin", "/sbin"]
)
COMMAND_ENV = dict(os.environ, PATH=SEARCH_PATH, LC_ALL="C")
_MEDIA_RE = re.compile(r"/dev/media[0-9]+")
_GST_PROPERTY_RE = re.compile(r"^  ([a-z][a-z0-9-]*)\s*:")


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
    """Map each /dev path held open to the pids holding it, for every process we may inspect."""
    held = {}
    own = os.getpid()
    try:
        pids = [name for name in os.listdir(PROC_ROOT) if name.isdigit() and int(name) != own]
    except OSError:
        return held
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
        return lambda nodes: _users({pid for node in nodes for pid in held.get(node, ())})
    if method == "sudo-fuser":

        def check(nodes):
            code, out, err = run([tools["sudo"], "-n", tools["fuser"]] + sorted(nodes))
            if code is None or "sudo:" in err:
                return None
            return _users(parse_fuser_pids(out))

        return check
    return lambda nodes: None


def camera_nodes(nodes, tools, failures):
    found = set(nodes)
    for media in [node for node in nodes if _MEDIA_RE.fullmatch(node)]:
        if not tools.get("media-ctl"):
            continue
        code, out, err = run([tools["media-ctl"], "-d", media, "-p"])
        if code == 0:
            found.update(media_graph_nodes(out))
        else:
            failures.append(_failure("media-ctl", code, err))
    found.discard("")
    return found


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


def collect(request):
    tools = {name: which(name) for name in TOOLS}
    failures = []
    method = availability_method(tools)
    check_users = user_checker(method, tools)
    users = {}
    for camera_id, nodes in (request.get("cameras") or {}).items():
        users[camera_id] = check_users(camera_nodes(nodes, tools, failures)) if nodes else None
    return {
        "tools": {name: bool(path) for name, path in tools.items() if name != "sudo"},
        "availability_method": method,
        "users": users,
        "libcamerasrc": probe_libcamerasrc(tools, failures) if request.get("libcamerasrc") else None,
        "failures": failures,
    }


if __name__ == "__main__":
    print(json.dumps(collect(json.loads(sys.argv[1]) if len(sys.argv) > 1 else {})))
