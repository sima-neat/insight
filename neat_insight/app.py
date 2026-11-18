import argparse
import atexit
import base64
import concurrent.futures
import ipaddress
import json
import logging
import os
import platform
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

import psutil
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from werkzeug.middleware.proxy_fix import ProxyFix

if __name__ == "__main__" and (not globals().get("__package__")):
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from neat_insight import board
from neat_insight.api_docs import api_docs_bp
from neat_insight.genai_relay import genai_bp
from neat_insight.board.target import sdk_env_target
from neat_insight.peripherals import peripherals_bp
from neat_insight.profiler import NeatMetricsBroker, PeriodicZmqPublisher
from neat_insight.sentinel import sentinel_bp
from neat_insight.remote_devkit import (
    get_remote_metrics,
    is_remote_devkit_configured,
    is_remote_devkit_connected,
)
from neat_insight.runtime_config import (
    legacy_runtime_network_config,
    load_runtime_network_config,
)
from neat_insight.remotefs import read_remote_file
from neat_insight import preview
from neat_insight.utils import (
    board_type,
    check_and_generate_mkcert_certificate,
    cleanup_processes,
    ensure_webssh_started,
    free_webssh_port,
    get_certificate_access_url,
    get_lan_ip,
    get_webssh_port,
    init_environment,
    is_webssh_running,
    is_sima_board,
    parse_build_info,
    tail_lines,
    webssh_is_available,
)
from neat_insight.workspace import workspace_bp

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

env = init_environment()
MEDIA_DIR = env["MEDIA_DIR"]
YOUTUBE_IMPORT_TARGETS = {
    "1080p30": {"height": 1080, "fps": 30, "bitrate": "6M"},
    "720p30": {"height": 720, "fps": 30, "bitrate": "3M"},
    "480p30": {"height": 480, "fps": 30, "bitrate": "1500k"},
}
YOUTUBE_MAX_CLIP_SECONDS = 5 * 60
YOUTUBE_DEFAULT_CLIP_SECONDS = YOUTUBE_MAX_CLIP_SECONDS
YOUTUBE_DOWNLOAD_MEDIA_EXTENSIONS = {".mp4", ".m4v", ".mkv", ".mov", ".webm"}
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "youtu.be",
}
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_SHARE_TIME_RE = re.compile(
    r"^(?:(?P<hours>\d+)h)?(?:(?P<minutes>\d+)m)?(?:(?P<seconds>\d+)s?)?$"
)


def _resolve_frontend_dist() -> Path:
    override = os.getenv("NEAT_INSIGHT_FRONTEND_DIST")
    candidates = []
    if override:
        candidates.append(Path(override))

    module_root = Path(__file__).resolve().parent
    candidates.extend(
        [
            module_root.parent / "frontend" / "dist",  # source tree layout
            module_root / "frontend_dist",  # bundled in wheel/package
            Path.cwd() / "frontend" / "dist",  # repo-root launch fallback
        ]
    )

    for candidate in candidates:
        if (candidate / "index.html").exists():
            return candidate

    # Keep the original default location for error messages/logging.
    return module_root.parent / "frontend" / "dist"


FRONTEND_DIST = _resolve_frontend_dist()

app = Flask(__name__)
app.register_blueprint(api_docs_bp)
app.register_blueprint(workspace_bp)
app.register_blueprint(genai_bp)
board.init_app(app, env["NEAT_INSIGHT_DATA"], on_board=is_sima_board())
app.register_blueprint(peripherals_bp)
app.register_blueprint(sentinel_bp)
neat_metrics_broker = NeatMetricsBroker()
neat_metrics_broker.start()
sys_metrics_publisher = None
sys_metrics_lock = threading.Lock()
server_ssl_context = None
runtime_network_config = legacy_runtime_network_config()
DEFAULT_DEVKIT_SSH_USERNAME = "sima"
DEFAULT_DEVKIT_SSH_PASSWORD = "edgeai"

ALLOWED_LOGS = {"EV74": "simaai_EV74.log", "syslog": "syslog"}
LOG_DIR = "/var/log"


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _request_host_name() -> str:
    host = request.host.strip()
    if host.startswith("["):
        end = host.find("]")
        if end > 0:
            return host[1:end]
    elif host.count(":") == 1:
        name, maybe_port = host.rsplit(":", 1)
        if maybe_port.isdigit():
            host = name
    return host or "127.0.0.1"


def _bracket_ipv6(host):
    """Wrap an IPv6 literal in brackets so it can carry a :port suffix."""
    try:
        if ipaddress.ip_address(host).version == 6:
            return f"[{host}]"
    except ValueError:
        logging.debug("Host '%s' is not an IP literal; using host value as-is", host)
    return host


def _format_browser_https_url(host, port, path="", query=""):
    if not host or not port:
        return None
    host = _bracket_ipv6(host)

    url = f"https://{host}:{port}{path}"
    return f"{url}?{query}" if query else url


def _shell_target():
    """The board the shell should open on: the one Insight is using, not a separate env var.

    Falls back to DEVKIT_SYNC_DEVKIT_IP so a board that was never selected still has a shell.
    """
    try:
        target = board.get_board_manager().target()
    except Exception:  # noqa: BLE001 - the shell must not depend on board resolution succeeding
        target = None
    if target is not None and target.mode == "ssh" and target.host:
        # The bundled password is only a promise the SDK makes for its paired default DevKit.
        # Manual targets and SDK targets with an overridden account use the service account's
        # SSH key and may have unrelated passwords, so never send the DevKit credential to them.
        ssh_user = target.user or DEFAULT_DEVKIT_SSH_USERNAME
        return (
            target.host,
            target.port or 22,
            ssh_user,
            target.source == "sdk-env" and ssh_user == DEFAULT_DEVKIT_SSH_USERNAME,
        )
    paired = sdk_env_target()
    if not paired:
        return None, 22, DEFAULT_DEVKIT_SSH_USERNAME, False
    ssh_user = paired["user"]
    return paired["host"], paired["port"], ssh_user, ssh_user == DEFAULT_DEVKIT_SSH_USERNAME


def _build_devkit_shell_payload():
    devkit_ip, ssh_port, ssh_user, credentials_prefilled = _shell_target()
    configured = bool(devkit_ip)
    webssh_port = get_webssh_port()
    webssh_host_port = _resolve_webssh_host_port()
    launch_url = None

    if configured and credentials_prefilled:
        password_b64 = base64.b64encode(DEFAULT_DEVKIT_SSH_PASSWORD.encode("utf-8")).decode("ascii")
        params = urllib.parse.urlencode(
            {
                "hostname": devkit_ip,
                "port": ssh_port,
                "username": ssh_user,
                "password": password_b64,
                "title": f"DevKit {devkit_ip}",
            }
        )
        launch_url = _format_browser_https_url(_request_host_name(), webssh_host_port, "/", params)

    return {
        "configured": configured,
        "devkit_ip": devkit_ip or None,
        "button_label": f"DevKit: {devkit_ip}" if configured else None,
        "available": webssh_is_available(),
        "running": is_webssh_running(),
        "webssh_port": webssh_port,
        "webssh_host_port": webssh_host_port,
        "default_username": DEFAULT_DEVKIT_SSH_USERNAME,
        "credentials_prefilled": credentials_prefilled,
        "launch_supported": configured and credentials_prefilled,
        "launch_url": launch_url,
    }


def _with_metrics_compat(metrics_payload):
    metrics_payload.setdefault("pipeline_status", {})
    return metrics_payload


class LocalCpuReader:
    """The host's CPU use in percent since the previous reading, without blocking.

    psutil.cpu_percent(interval=None) answers from the CPU times it saw at the previous call, and
    the first call of a process returns a meaningless 0.0, so the reader makes that call once on
    creation. Two things would still make the reading wrong:

    - psutil keeps that "previous call" per calling thread, and a thread's first call answers 0.0.
      Flask answers every request on its own thread, so all calls go through one worker thread of
      the reader's own and share a single baseline.
    - The `sys` publisher (every 2 s) and the requests share the reader, so a reading is "since
      whoever read last". A call within `min_interval_sec` of the previous one repeats its value
      instead of measuring a window of a few milliseconds, which psutil warns is inaccurate.
    """

    def __init__(self, min_interval_sec=0.5, clock=time.monotonic):
        self._min_interval_sec = min_interval_sec
        self._clock = clock
        self._lock = threading.Lock()
        self._worker = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="cpu-reader")
        self._read_at = None
        self._value = None
        self._call_psutil()

    def _call_psutil(self):
        return self._worker.submit(lambda: psutil.cpu_percent(interval=None)).result()

    def read(self):
        with self._lock:
            now = self._clock()
            if self._read_at is None or now - self._read_at >= self._min_interval_sec:
                self._value = self._call_psutil()
                self._read_at = now
            return self._value


_local_cpu = LocalCpuReader()


def collect_system_metrics():
    if is_remote_devkit_configured():
        if is_remote_devkit_connected():
            return _with_metrics_compat(get_remote_metrics())
        return _with_metrics_compat({
            "cpu_load": "",
            "memory": {},
            "mla_allocated_bytes": 0,
            "disk": {},
            "temperature_celsius_avg": 0,
            "REMOTE": True,
        })

    cpu_percent_total = _local_cpu.read()
    mem = psutil.virtual_memory()
    memory_usage = {"total": mem.total, "used": mem.used, "percent": mem.percent}

    try:
        target_path = env["NEAT_INSIGHT_DATA"] if is_sima_board() else Path.home()
        disk = psutil.disk_usage(str(target_path))
        disk_usage = {
            "mount": str(target_path),
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        }
    except Exception:
        disk_usage = None

    avg_temp = None
    if is_sima_board() and board_type() == "davinci":
        try:
            with open("/sys/kernel/temperature_profile", "r", encoding="utf-8") as f:
                temps = []
                for line in f:
                    if "Temperature" in line and " C" in line:
                        t = int(line.split("is")[-1].replace("C", "").strip())
                        temps.append(t)
                if temps:
                    avg_temp = sum(temps) / len(temps)
        except Exception:
            avg_temp = None

    return _with_metrics_compat({
        "cpu_load": cpu_percent_total,
        "memory": memory_usage,
        "mla_allocated_bytes": 0,
        "disk": disk_usage,
        "temperature_celsius_avg": avg_temp,
        "REMOTE": False,
    })


def ensure_sys_metrics_publisher_started():
    global sys_metrics_publisher
    if sys_metrics_publisher is not None:
        return
    with sys_metrics_lock:
        if sys_metrics_publisher is not None:
            return
        publish_hook = None
        if not neat_metrics_broker.endpoint_uses_bind():
            publish_hook = lambda payload, ts: neat_metrics_broker.publish_local_event("sys", payload, ts)
        sys_metrics_publisher = PeriodicZmqPublisher(
            payload_fn=collect_system_metrics,
            topic="sys",
            interval_sec=float(os.getenv("SYS_METRICS_INTERVAL_SEC", "2.0")),
            publish_hook=publish_hook,
        )
        sys_metrics_publisher.start()


# API: readiness probe for the neat-insight backend.
@app.get("/api/health")
def health():
    """Return service identity, health status, and a UTC timestamp for smoke tests and readiness checks."""
    return {
        "status": "ok",
        "service": "neat-insight",
        "time": datetime.utcnow().isoformat() + "Z",
        "network": {
            "browser_ice_address": runtime_network_config.browser_ice_address,
            "browser_ice_address_source": runtime_network_config.browser_ice_address_source,
            "public_origin": runtime_network_config.public_origin,
        },
    }


# API: retrieve recent board or service log lines by a whitelisted log name.
@app.get("/api/logs/<logname>")
def get_log(logname):
    """Return up to the latest 10,000 lines for EV74 or syslog as text/plain, or 404 for unknown logs."""
    if logname not in ALLOWED_LOGS:
        return _json_error("Log not found", 404)

    log_path = os.path.join(LOG_DIR, ALLOWED_LOGS[logname])
    if not os.path.isfile(log_path):
        return _json_error(f"{logname} log not found", 404)
    return Response(tail_lines(log_path, 10000, 256 * 1024), mimetype="text/plain")


# API: snapshot current host/devkit metrics.
@app.get("/api/metrics")
def metrics():
    """Return CPU, memory, disk, temperature, MLA, remote, and pipeline-status compatible metrics."""
    return collect_system_metrics()


# API: stream neat metrics events to the browser over server-sent events.
@app.get("/api/neat-metrics")
def stream_neat_metrics():
    """Open a text/event-stream response that emits JSON metrics events from the local metrics broker."""
    ensure_sys_metrics_publisher_started()

    def event_stream():
        for event in neat_metrics_broker.subscribe():
            yield f"data: {json.dumps(event)}\n\n"

    response = Response(stream_with_context(event_stream()), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


# The Viewer's routes (/api/channels, the offer, /api/ingest/stats, /api/viewer-url) are the new
# server's (server/internal/channels), which replaced vf. So are the streaming sources (src1 to
# src48), the media library with its previews and catalog imports, and MediaMTX
# (server/internal/slots, library, relay, mediamtx); only the YouTube import below is still here.


# API: report whether optional media inspection/streaming tools are installed.
@app.get("/api/system/tools")
def system_tools():
    """Return booleans indicating whether media helper tools are available on PATH."""
    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "gstreamer": shutil.which("gst-launch-1.0") is not None,
    }


def _missing_neat_sysinfo_payload():
    """System Info's answer when the neat command is not installed.

    It has the shape of a `neat --json` answer with every unknown value null or empty, so a client reads it the
    same way, and `missing` names what could not be read. Nothing here is guessed: a version shown for software
    that is not there would send someone looking for it.
    """
    return {
        "schema": "sima.neat.status.v1",
        "components": {},
        "environment": {
            "label": None,
            "mode": None,
            "sdkVersion": None,
            "devkitBuildVersion": None,
            "sysroot": None,
        },
        "exposedPorts": [],
        "insight": {"serviceState": None, "venv": None, "webUiUrl": None},
        "updateCheck": {"offline": None, "status": None},
        "missing": ["neat"],
    }


def _coerce_port_value(value):
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _port_protocol(name_parts, value):
    protocol = value.get("protocol")
    if protocol:
        return str(protocol)
    if name_parts and str(name_parts[-1]).lower() in {"tcp", "udp"}:
        return str(name_parts[-1]).lower()
    return ""


def _collect_port_map_rows(name_parts, value, rows):
    if not isinstance(value, dict):
        return

    name = ".".join(name_parts)
    protocol = _port_protocol(name_parts, value)
    if "host" in value:
        rows.append(
            {
                "hostPortEnd": None,
                "hostPortStart": _coerce_port_value(value.get("host")),
                "name": name,
                "protocol": protocol,
            }
        )
        return

    if "hostStart" in value or "hostEnd" in value:
        rows.append(
            {
                "hostPortEnd": _coerce_port_value(value.get("hostEnd")),
                "hostPortStart": _coerce_port_value(value.get("hostStart")),
                "name": name,
                "protocol": protocol,
            }
        )
        return

    for key, child in value.items():
        _collect_port_map_rows([*name_parts, str(key)], child, rows)


def _sysinfo_port_map_candidates():
    paths = []
    configured = os.getenv("NEAT_PORT_MAP_FILE", "").strip()
    if configured:
        paths.append(Path(configured))

    paths.extend(
        [
            Path.home() / ".insight-config" / "neat-port-map.json",
            Path("/workspace/.insight-config/neat-port-map.json"),
            Path("/workspace/insight-config/neat-port-map.json"),
            Path("/insight-config/neat-port-map.json"),
        ]
    )

    for parent in (Path("/home"), Path("/Users")):
        try:
            paths.extend(user_dir / ".insight-config" / "neat-port-map.json" for user_dir in parent.iterdir() if user_dir.is_dir())
        except OSError as exc:
            logging.debug("Skipping port map search under %s: %s", parent, exc)

    seen = set()
    for path in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        yield path


def _iter_neat_port_maps():
    for path in _sysinfo_port_map_candidates():
        # The candidate list walks /home and /Users, so most of these belong to
        # other users and stat() raises rather than returning False. Startup
        # reads the port map, so an unreadable neighbour must not be fatal.
        try:
            if not path.is_file():
                continue
        except OSError as exc:
            logging.debug("Skipping unreadable port map candidate %s: %s", path, exc)
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logging.debug("Failed to read neat port map %s: %s", path, exc)
            continue

        if isinstance(data, dict):
            if data:
                yield data
            continue
        logging.warning("Ignoring neat port map %s because its root is not an object", path)


def _read_exposed_ports_from_port_map():
    for data in _iter_neat_port_maps():
        rows = []
        for key, value in data.items():
            _collect_port_map_rows([str(key)], value, rows)
        if rows:
            return rows
    return []


def _valid_port(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    if 1 <= port <= 65535:
        return port
    return None


def _find_exposed_port(ports, name, protocol=None):
    if not isinstance(ports, list):
        return None

    for port in ports:
        if not isinstance(port, dict):
            continue

        row_name = str(port.get("name") or "")
        if row_name != name and not row_name.startswith(f"{name}."):
            continue

        if protocol:
            row_protocol = str(port.get("protocol") or "").lower()
            if row_protocol and row_protocol != protocol.lower():
                continue

        resolved = _valid_port(port.get("hostPortStart"))
        if resolved:
            return resolved

    return None


def _resolve_webssh_host_port():
    return _find_exposed_port(_read_exposed_ports_from_port_map(), "webSSH", "tcp") or get_webssh_port()


def _format_sysinfo_web_ui_url(host, port):
    return _format_browser_https_url(host, port)


def _enrich_sysinfo_payload(payload):
    if not isinstance(payload, dict):
        return payload

    ports = payload.get("exposedPorts") if isinstance(payload.get("exposedPorts"), list) else []
    if not ports:
        ports = _read_exposed_ports_from_port_map()
        if ports:
            payload["exposedPorts"] = ports

    insight = payload.get("insight")
    if not isinstance(insight, dict):
        insight = {}
        payload["insight"] = insight

    if not insight.get("webUiUrl"):
        main_ui_port = _find_exposed_port(ports, "mainUI", "tcp")
        host = os.getenv("CONTAINER_HOST_IP", "").strip() or _request_host_name()
        web_ui_url = _format_sysinfo_web_ui_url(host, main_ui_port)
        if web_ui_url:
            insight["webUiUrl"] = web_ui_url

    return payload


@app.get("/api/sysinfo")
def sysinfo():
    """Return the structured system status reported by the neat command-line tool."""
    def sysinfo_json(payload, status: int = 200):
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response, status

    def sysinfo_error(message: str, status: int = 400):
        return sysinfo_json({"error": message}, status)

    try:
        result = subprocess.run(
            ["neat", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except FileNotFoundError:
        logging.warning("The neat command is not available on PATH; System Info reports it as missing.")
        return sysinfo_json(_enrich_sysinfo_payload(_missing_neat_sysinfo_payload()))
    except subprocess.TimeoutExpired:
        return sysinfo_error("The neat command timed out while collecting system information.", 504)
    except OSError as exc:
        return sysinfo_error(f"Failed to run neat: {exc}", 500)

    output = result.stdout.strip()
    if result.returncode != 0:
        detail = result.stderr.strip() or output or f"neat exited with status {result.returncode}"
        return sysinfo_error(detail, 502)

    try:
        return sysinfo_json(_enrich_sysinfo_payload(json.loads(output)))
    except json.JSONDecodeError as exc:
        return sysinfo_error(f"neat returned invalid JSON: {exc}", 502)


def _relative_media_label(path: Path) -> str:
    try:
        return str(path.relative_to(MEDIA_DIR))
    except ValueError:
        return path.name


def _ffprobe_json(path: Path) -> Optional[dict[str, Any]]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is not installed; install FFmpeg and ensure ffprobe is on PATH.")

    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=10)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"ffprobe failed for {_relative_media_label(path)}: {detail or result.returncode}")

    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON for {_relative_media_label(path)}: {exc}") from exc

    streams = data.get("streams") if isinstance(data, dict) else None
    if not isinstance(streams, list) or not streams:
        return None
    stream = streams[0]
    if not isinstance(stream, dict):
        return None
    return {"stream": stream, "format": data.get("format") if isinstance(data.get("format"), dict) else {}}


def _probe_video_info(path: Path) -> Optional[dict[str, Any]]:
    try:
        return _ffprobe_json(path)
    except Exception as exc:
        logging.debug("Failed to probe video info for %s: %s", path, exc)
    return None


def _duration_to_seconds(value: Any) -> Optional[float]:
    if value in (None, "", "N/A"):
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def _video_duration_seconds(path: Path) -> Optional[float]:
    info = _probe_video_info(path)
    if not info:
        return None
    stream = info["stream"]
    container = info["format"]
    return _duration_to_seconds(stream.get("duration")) or _duration_to_seconds(container.get("duration"))


def _parse_ffmpeg_progress_seconds(key: str, value: str) -> Optional[float]:
    if key in {"out_time_us", "out_time_ms"}:
        try:
            return max(0.0, float(value) / 1_000_000.0)
        except ValueError:
            return None
    if key != "out_time":
        return None
    try:
        hours, minutes, seconds = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except (ValueError, TypeError):
        return None


def _format_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "--:--"
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _ensure_media_target_path(path: Path) -> Path:
    media_root = MEDIA_DIR.resolve()
    resolved = path.resolve(strict=False)
    if not resolved.is_relative_to(media_root):
        raise ValueError("Invalid media target path")
    return path


def _unique_media_path(rel_path: Path) -> Path:
    candidate = _ensure_media_target_path(MEDIA_DIR / rel_path)
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for index in range(2, 1000):
        next_candidate = _ensure_media_target_path(candidate.with_name(f"{stem}_{index}{suffix}"))
        if not next_candidate.exists():
            return next_candidate
    raise RuntimeError(f"Could not choose a unique filename for {rel_path}")


def _yt_dlp_command() -> list[str]:
    """Prefer the installed Python module, but support an external yt-dlp binary for dev setups."""
    try:
        import yt_dlp  # noqa: F401

        return [sys.executable, "-m", "yt_dlp"]
    except ImportError:
        executable = shutil.which("yt-dlp")
        if executable:
            return [executable]
    raise RuntimeError("yt-dlp is not installed. Install yt-dlp in the Insight environment and try again.")


def _parse_youtube_url(url: str) -> urllib.parse.ParseResult:
    raw_url = str(url or "").strip()
    if raw_url and "://" not in raw_url:
        raw_url = f"https://{raw_url}"
    parsed = urllib.parse.urlparse(raw_url)
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    if host not in YOUTUBE_HOSTS:
        raise ValueError("Enter a YouTube URL.")
    return parsed


def _youtube_video_id(url: str) -> str:
    parsed = _parse_youtube_url(url)
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    candidate = ""
    if host == "youtu.be":
        candidate = parsed.path.strip("/").split("/")[0]
    elif parsed.path in {"", "/"}:
        candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
    elif parsed.path == "/watch":
        candidate = urllib.parse.parse_qs(parsed.query).get("v", [""])[0]
    elif parsed.path.startswith("/shorts/"):
        parts = [part for part in parsed.path.split("/") if part]
        candidate = parts[1] if len(parts) > 1 else ""
    elif parsed.path.startswith("/embed/"):
        parts = [part for part in parsed.path.split("/") if part]
        candidate = parts[1] if len(parts) > 1 else ""
    elif parsed.path.startswith("/live/"):
        parts = [part for part in parsed.path.split("/") if part]
        candidate = parts[1] if len(parts) > 1 else ""

    if not YOUTUBE_ID_RE.match(candidate):
        raise ValueError("Could not find a valid YouTube video id in the URL.")
    return candidate


def _parse_youtube_share_time_seconds(value: Any) -> Optional[int]:
    text = str(value or "").strip().lower()
    if not text:
        return None
    try:
        return _parse_youtube_time_seconds(text)
    except ValueError:
        pass

    match = YOUTUBE_SHARE_TIME_RE.match(text)
    if not match:
        return None
    hours = int(match.group("hours") or 0)
    minutes = int(match.group("minutes") or 0)
    seconds = int(match.group("seconds") or 0)
    return hours * 3600 + minutes * 60 + seconds


def _youtube_share_start_seconds(url: str) -> Optional[int]:
    parsed = _parse_youtube_url(url)
    params = urllib.parse.parse_qs(parsed.query)
    if parsed.fragment:
        for key, value in urllib.parse.parse_qs(parsed.fragment).items():
            params.setdefault(key, value)

    for key in ("t", "start"):
        for value in params.get(key, []):
            seconds = _parse_youtube_share_time_seconds(value)
            if seconds is not None:
                return seconds
    return None


def _youtube_preview_payload(url: str) -> dict[str, Any]:
    video_id = _youtube_video_id(url)
    start_seconds = _youtube_share_start_seconds(url)
    normalized_url = f"https://www.youtube.com/watch?v={video_id}"
    embed_url = f"https://www.youtube.com/embed/{video_id}"
    payload = {
        "video_id": video_id,
        "normalized_url": normalized_url,
        "embed_url": embed_url,
        "thumbnail_url": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
    }
    if start_seconds is not None:
        payload["clip_start"] = start_seconds
        payload["embed_url"] = f"{embed_url}?start={start_seconds}"
    return payload


def _youtube_metadata_payload(url: str) -> dict[str, Any]:
    preview = _youtube_preview_payload(url)
    yt_dlp = _yt_dlp_command()
    cmd = [
        *yt_dlp,
        "--ignore-config",
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        preview["normalized_url"],
    ]
    try:
        result = subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=25,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out while validating YouTube video availability.") from exc

    if result.returncode != 0:
        details = (result.stderr or result.stdout or "").strip().splitlines()
        message = details[-1].strip() if details else f"yt-dlp exited with status {result.returncode}"
        raise RuntimeError(f"YouTube video is not available for import: {message}")

    try:
        metadata = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Could not parse YouTube metadata response.") from exc

    live_status = str(metadata.get("live_status") or "").lower()
    if metadata.get("is_live") or live_status in {"is_live", "is_upcoming"}:
        raise RuntimeError(
            "Active YouTube live streams are not supported for import yet. "
            "Use a regular video URL or wait until the live stream archive is available."
        )

    payload = dict(preview)
    payload.update(
        {
            "title": metadata.get("title") or "",
            "duration": metadata.get("duration"),
            "is_live": bool(metadata.get("is_live")),
            "live_status": live_status,
        }
    )
    if metadata.get("thumbnail"):
        payload["thumbnail_url"] = metadata["thumbnail"]
    return payload


def _youtube_target_profile(value: str) -> dict[str, Any]:
    target = str(value or "").strip()
    if target not in YOUTUBE_IMPORT_TARGETS:
        raise ValueError(f"Unsupported YouTube import target: {target or '<empty>'}")
    return {"name": target, **YOUTUBE_IMPORT_TARGETS[target]}


def _parse_youtube_time_seconds(value: Any, default: int = 0) -> int:
    if value in {None, ""}:
        return default
    if isinstance(value, (int, float)):
        seconds = int(value)
    else:
        text = str(value).strip()
        if not text:
            return default
        if ":" in text:
            parts = text.split(":")
            if len(parts) > 3:
                raise ValueError("Use seconds, MM:SS, or HH:MM:SS for YouTube clip time.")
            try:
                numbers = [int(part) for part in parts]
            except ValueError as exc:
                raise ValueError("Use seconds, MM:SS, or HH:MM:SS for YouTube clip time.") from exc
            seconds = 0
            for number in numbers:
                if number < 0:
                    raise ValueError("YouTube clip time cannot be negative.")
                seconds = seconds * 60 + number
        else:
            try:
                seconds = int(float(text))
            except ValueError as exc:
                raise ValueError("Use seconds, MM:SS, or HH:MM:SS for YouTube clip time.") from exc
    if seconds < 0:
        raise ValueError("YouTube clip time cannot be negative.")
    return seconds


def _youtube_clip_range(start_value: Any, duration_value: Any) -> dict[str, Any]:
    start_seconds = _parse_youtube_time_seconds(start_value, 0)
    duration_seconds = _parse_youtube_time_seconds(duration_value, YOUTUBE_DEFAULT_CLIP_SECONDS)
    if duration_seconds <= 0:
        raise ValueError("YouTube clip duration must be greater than 0 seconds.")
    duration_seconds = min(duration_seconds, YOUTUBE_MAX_CLIP_SECONDS)
    end_seconds = start_seconds + duration_seconds
    return {
        "start": start_seconds,
        "duration": duration_seconds,
        "end": end_seconds,
        "section": f"*{_format_duration(start_seconds)}-{_format_duration(end_seconds)}",
    }


def _terminate_process(process: Optional[subprocess.Popen], timeout: float = 3.0) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=timeout)


def _read_process_output(process: subprocess.Popen, out_queue: "queue.Queue[Optional[str]]") -> None:
    try:
        if process.stdout:
            for raw_line in process.stdout:
                out_queue.put(raw_line)
    finally:
        out_queue.put(None)


def _stream_youtube_import(url: str, target_name: str, clip_start: Any = 0, clip_duration: Any = YOUTUBE_DEFAULT_CLIP_SECONDS):
    try:
        preview = _youtube_metadata_payload(url)
        target = _youtube_target_profile(target_name)
        clip = _youtube_clip_range(clip_start, clip_duration)
    except (RuntimeError, ValueError) as exc:
        yield f"YouTube import failed: {exc}\n"
        return

    video_id = preview["video_id"]
    rel_path = Path("youtube") / (
        f"youtube_{video_id}_{target['name']}_"
        f"s{clip['start']}_d{clip['duration']}_h264.mp4"
    )
    target_path = _unique_media_path(rel_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_output = target_path.with_name(f".{target_path.stem}.transcode{target_path.suffix}")
    temp_output.unlink(missing_ok=True)

    yield f"Validating YouTube video: {video_id}\n"
    try:
        yt_dlp = _yt_dlp_command()
    except RuntimeError as exc:
        yield f"YouTube import failed: {exc}\n"
        return

    active_process: Optional[subprocess.Popen] = None
    try:
        with tempfile.TemporaryDirectory(prefix="neat-insight-youtube-") as temp_dir:
            temp_root = Path(temp_dir)
            download_template = temp_root / "%(id)s.%(ext)s"
            download_cmd = [
                *yt_dlp,
                "--ignore-config",
                "--newline",
                "--no-playlist",
                "-f",
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/best",
                "--merge-output-format",
                "mp4",
                "--download-sections",
                str(clip["section"]),
                "-o",
                str(download_template),
                preview["normalized_url"],
            ]

            is_live = bool(preview.get("is_live"))
            download_phase = "Capturing YouTube clip" if is_live else "Downloading YouTube video"
            yield (
                f"{download_phase}: waiting for first media data. This can take a while; please wait. "
                f"{target['name']} source, {_format_duration(int(clip['start']))}-{_format_duration(int(clip['end']))}\n"
            )
            active_process = subprocess.Popen(
                download_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            diagnostics: List[str] = []
            last_percent = -1
            download_started_at = time.monotonic()
            last_capture_report_at = download_started_at
            stdout_queue: "queue.Queue[Optional[str]]" = queue.Queue()
            stdout_thread = threading.Thread(
                target=_read_process_output,
                args=(active_process, stdout_queue),
                daemon=True,
            )
            stdout_thread.start()

            while active_process.poll() is None or not stdout_queue.empty():
                try:
                    raw_line = stdout_queue.get(timeout=0.25)
                except queue.Empty:
                    raw_line = ""

                if raw_line is None:
                    raw_line = ""

                if raw_line:
                    line = raw_line.strip()
                    if line:
                        diagnostics.append(line)
                        diagnostics = diagnostics[-12:]
                        if not is_live:
                            match = re.search(r"\[download\]\s+(\d+(?:\.\d+)?)%", line)
                            if match:
                                percent = min(99, max(0, int(float(match.group(1)))))
                                if percent > last_percent:
                                    last_percent = percent
                                    yield f"Downloading YouTube video: {percent}%\n"

                if is_live:
                    now = time.monotonic()
                    if now - last_capture_report_at >= 1.0:
                        last_capture_report_at = now
                        elapsed_wall = max(0.0, now - download_started_at)
                        percent = min(99, max(0, int((elapsed_wall / int(clip["duration"])) * 100)))
                        if percent > last_percent:
                            last_percent = percent
                            yield (
                                f"Capturing YouTube clip: {percent}% "
                                f"({_format_duration(elapsed_wall)} / {_format_duration(int(clip['duration']))})\n"
                            )

            return_code = active_process.wait()
            active_process = None
            if return_code != 0:
                details = "\n".join(diagnostics[-4:]) or f"yt-dlp exited with status {return_code}"
                yield f"YouTube import failed: {details}\n"
                return

            downloaded_files = sorted(
                path
                for path in temp_root.iterdir()
                if path.is_file() and path.suffix.lower() in YOUTUBE_DOWNLOAD_MEDIA_EXTENSIONS
            )
            if not downloaded_files:
                yield "YouTube import failed: no downloaded media file was produced.\n"
                return
            source_path = downloaded_files[0]

            if shutil.which("ffmpeg") is None:
                yield "YouTube import failed: ffmpeg is not installed.\n"
                return

            duration = _video_duration_seconds(source_path)
            ffmpeg_cmd = [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            f"scale=-2:{target['height']}:flags=lanczos,fps={target['fps']}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-profile:v",
            "baseline",
            "-pix_fmt",
            "yuv420p",
            "-x264-params",
            f"keyint={target['fps']}:min-keyint={target['fps']}:no-scenecut=1:repeat-headers=1:aud=1",
            "-b:v",
            str(target["bitrate"]),
            "-g",
            str(target["fps"]),
            "-bf",
            "0",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(temp_output),
            ]

            yield f"Preparing YouTube media: {target['name']} H.264\n"
            active_process = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )

            diagnostics = []
            last_progress_at = 0.0
            if active_process.stdout:
                for raw_line in active_process.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    if "=" not in line:
                        diagnostics.append(line)
                        diagnostics = diagnostics[-8:]
                        continue
                    key, value = line.split("=", 1)
                    elapsed = _parse_ffmpeg_progress_seconds(key, value)
                    if elapsed is None:
                        continue
                    now = time.monotonic()
                    if now - last_progress_at < 1.0:
                        continue
                    last_progress_at = now
                    if duration:
                        percent = min(99, max(0, int((elapsed / duration) * 100)))
                        yield (
                            f"Preparing YouTube media: {percent}% "
                            f"({_format_duration(elapsed)} / {_format_duration(duration)})\n"
                        )
                    else:
                        yield f"Preparing YouTube media: {_format_duration(elapsed)} processed\n"

            return_code = active_process.wait()
            active_process = None
            if return_code != 0:
                temp_output.unlink(missing_ok=True)
                details = "\n".join(diagnostics[-4:]) or f"ffmpeg exited with status {return_code}"
                yield f"YouTube import failed: {details}\n"
                return

            temp_output.replace(target_path)
            rel_saved = target_path.relative_to(MEDIA_DIR).as_posix()
            yield f"Saved YouTube media to {rel_saved}\n"
            yield "YouTube import complete.\n"
    except GeneratorExit:
        _terminate_process(active_process)
        temp_output.unlink(missing_ok=True)
        raise


@app.post("/api/import/youtube/validate")
def validate_youtube_import():
    """Validate a YouTube URL and return preview data for the import dialog."""
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        return _json_error("Missing YouTube URL")
    try:
        return jsonify(_youtube_metadata_payload(url))
    except (RuntimeError, ValueError) as exc:
        return _json_error(str(exc))


@app.post("/api/import/youtube")
def import_youtube_media():
    """Download a YouTube video into the media library while streaming import progress."""
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    target = str(data.get("target") or "").strip()
    clip_start = data.get("clip_start", 0)
    clip_duration = data.get("clip_duration", YOUTUBE_DEFAULT_CLIP_SECONDS)
    if not url:
        return _json_error("Missing YouTube URL")
    if not target:
        return _json_error("Missing YouTube import target")

    try:
        _youtube_preview_payload(url)
        _youtube_target_profile(target)
        _youtube_clip_range(clip_start, clip_duration)
    except ValueError as exc:
        return _json_error(str(exc))

    return Response(
        stream_with_context(_stream_youtube_import(url, target, clip_start, clip_duration)),
        mimetype="text/plain",
    )


# API: expose environment flags used by the frontend.
@app.get("/api/envinfo")
def envinfo():
    """Return whether this process runs on a SiMa board and whether remote devkit mode is configured."""
    return {"is_sima_board": is_sima_board(), "is_remote_devkit_configured": is_remote_devkit_configured()}


# API: expose DevKit shell discovery and launch metadata for the browser.
@app.get("/api/devkit-shell")
def devkit_shell():
    """Return whether DEVKIT_SYNC_DEVKIT_IP is configured plus the hosted webssh status and launch URL."""
    try:
        return _build_devkit_shell_payload()
    except RuntimeError as exc:
        return _json_error(str(exc), 500)


# API: start the hosted webssh service on demand and return the DevKit shell launch URL.
@app.post("/api/devkit-shell/start")
def start_devkit_shell():
    """Start webssh only when requested, then return the prefilled browser URL for the configured DevKit."""
    global server_ssl_context

    try:
        payload = _build_devkit_shell_payload()
    except RuntimeError as exc:
        return _json_error(str(exc), 500)

    if not payload["configured"]:
        return _json_error("No DevKit is selected or paired with this SDK.", 404)
    if not payload["launch_supported"]:
        return _json_error("The browser shell is available only for the SDK-paired DevKit.", 409)
    if server_ssl_context is None:
        return _json_error("Insight TLS context is not initialized.", 500)

    try:
        ensure_webssh_started(server_ssl_context)
    except RuntimeError as exc:
        return _json_error(str(exc), 502)

    payload = _build_devkit_shell_payload()
    return payload


# API: retrieve local or remote build information.
@app.get("/api/buildinfo")
def buildinfo():
    """Return parsed SiMa build metadata from the board/devkit, or host platform details when no devkit is configured."""
    build_paths = ["/etc/build", "/etc/buildinfo"]
    if is_sima_board():
        for path in build_paths:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    return parse_build_info(f.read())
            except Exception:
                continue
        return _json_error("Failed to read local build file", 500)

    if is_remote_devkit_configured():
        if is_remote_devkit_connected():
            for path in build_paths:
                try:
                    text = read_remote_file(path).decode("utf-8", errors="replace")
                    return parse_build_info(text, remote=True)
                except Exception:
                    continue
            return _json_error("Failed to read remote build file", 502)
        return _json_error("Remote device unreachable", 502)

    return {"MACHINE": platform.machine(), "SIMA_BUILD_VERSION": platform.platform()}


# API: identify the backend IP address browser-side viewers should use.
@app.get("/api/server-ip")
def server_ip():
    """Return CONTAINER_HOST_IP when set, otherwise infer the reachable local IP or fall back to 127.0.0.1."""
    return {"ip": get_lan_ip()}


preview.init_app(app)


# API: serve the built single-page application entrypoint.
@app.get("/")
def index():
    """Return frontend index.html when built, otherwise a 503 with the build command hint."""
    if FRONTEND_DIST.exists():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return "Frontend not built. Run: cd frontend && npm install && npm run build", 503


# API: serve frontend static assets or fall back to the SPA entrypoint for client-side routes.
@app.get("/<path:path>")
def spa(path):
    """Return a built frontend asset when it exists; otherwise return index.html for SPA routing."""
    if path.startswith("api/"):
        response = jsonify({"error": f"API endpoint not found: /{path}"})
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response, 404

    if FRONTEND_DIST.exists():
        file_path = FRONTEND_DIST / path
        if file_path.exists() and file_path.is_file():
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")
    return "Frontend not built.", 503


def main():
    global runtime_network_config, server_ssl_context, sys_metrics_publisher

    parser = argparse.ArgumentParser(description="Start the neat-insight server.")
    parser.add_argument("--port", type=int, default=9900, help="Port to run the server on (default: 9900)")
    # The new server (server/) runs this backend behind it while the rewrite moves its routes over:
    # on loopback, over plain HTTP, with the certificate the new server resolved, which webssh
    # serves the DevKit shell with. Goes with this file at the end of the rewrite.
    parser.add_argument("--behind-proxy", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--cert", help=argparse.SUPPRESS)
    parser.add_argument("--key", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.behind_proxy and not (args.cert and args.key):
        parser.error("--behind-proxy needs --cert and --key")

    runtime_network_config = load_runtime_network_config()

    ensure_sys_metrics_publisher_started()

    if args.behind_proxy:
        ssl_context = (args.cert, args.key)
    else:
        ssl_context = check_and_generate_mkcert_certificate(args.port)
    server_ssl_context = ssl_context
    free_webssh_port()

    def _shutdown(signum=None, frame=None):
        if sys_metrics_publisher:
            sys_metrics_publisher.stop()
        neat_metrics_broker.stop()
        cleanup_processes(signum, frame)

    # Ensure webssh is also cleaned up on non-signal exits.
    atexit.register(lambda: cleanup_processes(exit_process=False))

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    if args.behind_proxy:
        # The browser reached the new server over HTTPS under its own host name; links built
        # here (the DevKit shell's launch URL, System Info's web UI URL) must name those.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
        print(f"neat-insight backend on http://127.0.0.1:{args.port}, behind the new server")
        app.run(host="127.0.0.1", port=args.port)
        return

    print("\n" + "=" * 120)
    print("neat-insight server starting")
    print(f"Access: {get_certificate_access_url(args.port)}")
    print("=" * 120 + "\n")

    app.run(host="0.0.0.0", port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
