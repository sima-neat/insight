import argparse
import atexit
import base64
import hashlib
import ipaddress
import json
import logging
import os
import platform
import queue
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

import psutil
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from PIL import Image
from werkzeug.utils import secure_filename

if __name__ == "__main__" and (not globals().get("__package__")):
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from neat_insight.mediasrc import (
    DEFAULT_CODEC,
    DEFAULT_TRANSPORT,
    http_mjpeg_command,
    http_snapshot_command,
    media_stream_identity,
    media_stream_is_running,
    normalize_codec,
    normalize_transport,
    start_media_stream,
    stop_media_stream,
)
from neat_insight.profiler import NeatMetricsBroker, PeriodicZmqPublisher
from neat_insight.remote_devkit import (
    get_remote_metrics,
    is_remote_devkit_configured,
    is_remote_devkit_connected,
)
from neat_insight.remotefs import read_remote_file
from neat_insight.utils import (
    board_type,
    check_and_generate_mkcert_certificate,
    cleanup_processes,
    ensure_webssh_started,
    get_certificate_access_url,
    get_devkit_sync_devkit_ip,
    get_lan_ip,
    get_webssh_port,
    init_environment,
    is_webssh_running,
    is_sima_board,
    parse_build_info,
    start_processes,
    tail_lines,
    webssh_is_available,
)
from neat_insight.workspace import workspace_bp

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

env = init_environment()
MEDIA_DIR = env["MEDIA_DIR"]
MEDIA_SRC_DATA_FILE = env["MEDIA_SRC_DATA_FILE"]
DEFAULT_SOURCE_COUNT = env["DEFAULT_SOURCE_COUNT"]
OPTIMIZABLE_VIDEO_EXTENSIONS = {".mp4"}
STREAMABLE_MEDIA_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".mjpeg", ".mjpg", ".jpg", ".jpeg"}
PASSTHROUGH_UPLOAD_CODECS = {"h265", "mjpeg"}
UNKNOWN_CODEC = "unknown"
OPTIMIZED_VIDEO_BITRATE = "2M"
OPTIMIZED_VIDEO_GOP = "30"
MEDIA_CATALOG_INDEX_URL = os.getenv(
    "NEAT_INSIGHT_MEDIA_CATALOG_INDEX_URL",
    "https://artifacts.neat.sima.ai/media-assets/index.json",
)
MEDIA_CATALOG_BASE_URL = os.getenv(
    "NEAT_INSIGHT_MEDIA_CATALOG_BASE_URL",
    "https://artifacts.neat.sima.ai/media-assets/",
)
YOUTUBE_IMPORT_TARGETS = {
    "1080p30": {"height": 1080, "fps": 30, "bitrate": "6M"},
    "720p30": {"height": 720, "fps": 30, "bitrate": "3M"},
    "480p30": {"height": 480, "fps": 30, "bitrate": "1500k"},
}
YOUTUBE_MAX_CLIP_SECONDS = 5 * 60
YOUTUBE_DEFAULT_CLIP_SECONDS = YOUTUBE_MAX_CLIP_SECONDS
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
VIEWER_CHANNEL_COUNT = 80
DEFAULT_VIDEO_UI_PORT = 8081

app = Flask(__name__)
app.register_blueprint(workspace_bp)
neat_metrics_broker = NeatMetricsBroker()
neat_metrics_broker.start()
sys_metrics_publisher = None
sys_metrics_lock = threading.Lock()
server_ssl_context = None
DEFAULT_DEVKIT_SSH_USERNAME = "sima"
DEFAULT_DEVKIT_SSH_PASSWORD = "edgeai"

ALLOWED_EXTENSIONS = STREAMABLE_MEDIA_EXTENSIONS
ALLOWED_LOGS = {"EV74": "simaai_EV74.log", "syslog": "syslog"}
LOG_DIR = "/var/log"


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _json_urlopen(url: str, timeout: float = 20.0) -> dict[str, Any]:
    request_obj = urllib.request.Request(url, headers={"User-Agent": "neat-insight/asset-catalog"})
    with urllib.request.urlopen(request_obj, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


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


def _format_browser_https_url(host, port, path="", query=""):
    if not host or not port:
        return None
    try:
        if ipaddress.ip_address(host).version == 6:
            host = f"[{host}]"
    except ValueError:
        logging.debug("Host '%s' is not an IP literal; using host value as-is", host)

    url = f"https://{host}:{port}{path}"
    return f"{url}?{query}" if query else url


def _build_devkit_shell_payload():
    devkit_ip = get_devkit_sync_devkit_ip()
    configured = bool(devkit_ip)
    webssh_port = get_webssh_port()
    webssh_host_port = _resolve_webssh_host_port()
    launch_url = None

    if configured:
        password_b64 = base64.b64encode(DEFAULT_DEVKIT_SSH_PASSWORD.encode("utf-8")).decode("ascii")
        params = urllib.parse.urlencode(
            {
                "hostname": devkit_ip,
                "port": 22,
                "username": DEFAULT_DEVKIT_SSH_USERNAME,
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
        "credentials_prefilled": True,
        "launch_url": launch_url,
    }


def _default_source(index: int):
    return {
        "index": index,
        "file": "",
        "state": "stopped",
        "transport": DEFAULT_TRANSPORT,
        "codec": DEFAULT_CODEC,
    }


def _normalize_source(src, index: Optional[int] = None):
    if not isinstance(src, dict):
        src = {}
    try:
        source_index = int(src.get("index") or index or 0)
    except (TypeError, ValueError):
        source_index = index or 0
    if source_index <= 0:
        source_index = index or 1

    state = src.get("state") if src.get("state") in {"playing", "stopped"} else "stopped"
    file_name = src.get("file") or ""
    raw_codec = src.get("codec")
    if file_name and raw_codec == UNKNOWN_CODEC:
        codec = UNKNOWN_CODEC
        transport = ""
    else:
        transport = normalize_transport(src.get("transport"))
        codec = normalize_codec(raw_codec)
    if transport == "http":
        codec = "mjpeg"

    return {
        "index": source_index,
        "file": file_name,
        "state": state,
        "transport": transport,
        "codec": codec,
    }


def load_sources():
    if not MEDIA_SRC_DATA_FILE.exists():
        reset_sources()
    try:
        with open(MEDIA_SRC_DATA_FILE, "r", encoding="utf-8") as f:
            raw_sources = json.load(f)
    except Exception:
        raw_sources = []
    if not isinstance(raw_sources, list):
        raw_sources = []

    by_index = {}
    for fallback_index, src in enumerate(raw_sources, start=1):
        normalized = _normalize_source(src, fallback_index)
        by_index[normalized["index"]] = normalized
    return [by_index.get(i, _default_source(i)) for i in range(1, DEFAULT_SOURCE_COUNT + 1)]


def save_sources(sources):
    with open(MEDIA_SRC_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(sources, f, indent=2)


def reset_sources():
    sources = [_default_source(i + 1) for i in range(DEFAULT_SOURCE_COUNT)]
    save_sources(sources)


def _safe_media_path(rel_path: str) -> Path:
    abs_path = (MEDIA_DIR / rel_path).resolve()
    if not str(abs_path).startswith(str(MEDIA_DIR.resolve())):
        raise ValueError("Invalid path")
    return abs_path


def _with_metrics_compat(metrics_payload):
    metrics_payload.setdefault("pipeline_status", {})
    return metrics_payload


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

    cpu_percent_total = psutil.cpu_percent(interval=0.1)
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
    return {"status": "ok", "service": "neat-insight", "time": datetime.utcnow().isoformat() + "Z"}


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


# API: proxy vf UDP/RTP ingest statistics for active inbound streams.
@app.get("/api/ingest/stats")
def ingest_stats():
    """Return vf ingest stats for RTP (9000+) and metadata JSON over UDP (9100+); all=1 includes inactive channels and verbose=1 adds diagnostics."""
    return _proxy_vf_stats("/ingest/stats", "vf ingest stats")


# API: proxy vf WebRTC egress statistics for browser delivery and render diagnostics.
@app.get("/api/egress/stats")
def egress_stats():
    """Return vf egress stats including RTCP/browser reports plus metadata DataChannel send counters; all=1 includes inactive peers and verbose=1 adds diagnostics."""
    return _proxy_vf_stats("/egress/stats", "vf egress stats")


def _proxy_vf_stats(path: str, label: str):
    query = urllib.parse.urlencode(
        {
            key: request.args[key]
            for key in ("all", "verbose")
            if key in request.args
        }
    )
    url = f"https://127.0.0.1:8081{path}"
    if query:
        url = f"{url}?{query}"

    try:
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(url, timeout=2.0, context=context) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return jsonify(payload)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        return _json_error(f"{label} unavailable: {exc}", 502)


# API: enumerate uploaded media as a folder tree for the Media Sources UI.
@app.get("/api/media-files")
def list_media_files():
    """Return a recursive tree of files under MEDIA_DIR, excluding hidden files and macOS archive metadata."""
    def build_tree(base_path: Path, rel_path: str = ""):
        result = []
        full_path = base_path / rel_path
        try:
            entries = [e for e in os.listdir(full_path) if not e.startswith(".") and not e.startswith("__MACOSX")]
            entries.sort(key=lambda e: (not os.path.isdir(full_path / e), e.lower()))
            for entry in entries:
                abs_entry_path = full_path / entry
                rel_entry_path = os.path.join(rel_path, entry)
                if abs_entry_path.is_dir():
                    result.append(
                        {
                            "name": "/" + entry,
                            "path": rel_entry_path,
                            "type": "folder",
                            "children": build_tree(base_path, rel_entry_path),
                        }
                    )
                else:
                    result.append({"name": entry, "path": rel_entry_path, "type": "file"})
        except Exception:
            pass
        return result

    if not MEDIA_DIR.exists():
        return jsonify([])
    return jsonify(build_tree(MEDIA_DIR))


# API: report whether optional media inspection/streaming tools are installed.
@app.get("/api/system/tools")
def system_tools():
    """Return booleans indicating whether media helper tools are available on PATH."""
    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "gstreamer": shutil.which("gst-launch-1.0") is not None,
    }


def _fake_sysinfo_payload():
    """Return representative sysinfo data for local UI testing when neat is unavailable."""
    return {
        "components": {
            "core": {
                "channel": "main",
                "channelAssumed": False,
                "latestTag": "7c0ff36",
                "latestVersion": "0.0.0+main-7c0ff36",
                "metadataUrl": "https://artifacts.sima-neat.com/core/main/7c0ff36/metadata-minimal.json",
                "name": "Neat core",
                "tag": "7c0ff36",
                "updateAvailable": False,
                "version": "0.0.0+main-7c0ff36",
            },
            "gstPlugins": {"name": "neat-gst-plugins", "version": "0.1.0-1"},
            "insight": {
                "channel": "main",
                "channelAssumed": False,
                "latestTag": "346c6e9",
                "latestVersion": "0.0.0+main.346c6e9",
                "metadataUrl": "https://apps.sima-neat.com/insight/download/main/346c6e9.json",
                "name": "neat-insight",
                "serviceState": "Running",
                "tag": "346c6e9",
                "updateAvailable": False,
                "venv": "/opt/neat-insight/venv",
                "version": "0.0.0+main.346c6e9",
            },
            "modelSdkExtension": {
                "detail": "run activate-model-sdk to activate",
                "installed": True,
                "name": "Model SDK Extension",
                "version": "2.0.0.neat+main-1ebbc39",
            },
            "pyneat": {"name": "PyNeat", "version": "0.0.0"},
            "runtime": {"name": "neat-runtime", "version": "0.1.0-1"},
        },
        "environment": {
            "devkitBuildVersion": None,
            "label": "Neat SDK",
            "mode": "elxr-sdk",
            "sdkVersion": "2.0.0_Palette_SDK_neat_feature_devkit-sync_95ba5d8",
            "sysroot": "/opt/toolchain/aarch64/modalix",
        },
        "exposedPorts": [
            {"hostPortEnd": None, "hostPortStart": 9900, "name": "mainUI", "protocol": "tcp"},
            {"hostPortEnd": 9179, "hostPortStart": 9100, "name": "metadataUDP", "protocol": "udp"},
            {"hostPortEnd": None, "hostPortStart": 8554, "name": "rtsp.tcp", "protocol": "tcp"},
            {"hostPortEnd": 9079, "hostPortStart": 9000, "name": "videoUDP", "protocol": "udp"},
            {"hostPortEnd": None, "hostPortStart": 8081, "name": "videoUI", "protocol": "tcp"},
            {"hostPortEnd": 40199, "hostPortStart": 40000, "name": "webRTC", "protocol": "udp"},
            {"hostPortEnd": None, "hostPortStart": 8022, "name": "webSSH", "protocol": "tcp"},
        ],
        "insight": {
            "serviceState": "Running",
            "venv": "/opt/neat-insight/venv",
            "webUiUrl": "https://10.0.0.22:9900",
        },
        "schema": "sima.neat.status.v1",
        "updateCheck": {"offline": False, "status": "ok"},
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


def _read_exposed_ports_from_port_map():
    for path in _sysinfo_port_map_candidates():
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logging.debug("Failed to read neat port map %s: %s", path, exc)
            continue

        rows = []
        if isinstance(data, dict):
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


def _resolve_video_ui_port():
    return _find_exposed_port(_read_exposed_ports_from_port_map(), "videoUI", "tcp") or DEFAULT_VIDEO_UI_PORT


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
        logging.warning("The neat command is not available on PATH; returning fake sysinfo data for UI testing.")
        return sysinfo_json(_fake_sysinfo_payload())
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
        "stream=codec_name,codec_tag_string,width,height,duration,r_frame_rate,avg_frame_rate",
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


def _normalize_media_codec_name(value: Optional[str]) -> Optional[str]:
    text = (value or "").strip().lower()
    if not text:
        return None
    compact = text.replace("-", "").replace("_", "").replace(" ", "")
    if any(marker in compact for marker in ("hevc", "h265", "hev1", "hvc1")):
        return "h265"
    if any(marker in compact for marker in ("avc", "h264", "avc1")):
        return "h264"
    if any(marker in compact for marker in ("mjpeg", "motionjpeg", "jpeg")):
        return "mjpeg"
    return None


def _media_video_codec(path: Path) -> Optional[str]:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg", ".mjpg", ".mjpeg"}:
        return "mjpeg"

    info = _probe_video_info(path)
    if not info:
        return None
    stream = info["stream"]
    for attr in ("codec_name", "codec_tag_string"):
        codec = _normalize_media_codec_name(stream.get(attr))
        if codec:
            return codec
    return None


def _media_codec_display_name(raw_codec: Optional[str], normalized_codec: Optional[str] = None) -> Optional[str]:
    codec = normalized_codec or _normalize_media_codec_name(raw_codec)
    if codec == "mjpeg":
        return "MJPEG"
    if codec == "h264":
        return "H.264"
    if codec == "h265":
        return "H.265"
    return raw_codec


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


def _validate_archive_members(target_dir: Path, members: List[str]) -> None:
    target_root = target_dir.resolve()
    for member in members:
        destination = (target_dir / member).resolve()
        try:
            destination.relative_to(target_root)
        except ValueError:
            raise ValueError(f"Unsafe archive path: {member}")


def _iter_optimizable_videos(root: Path) -> List[Path]:
    if root.is_file():
        candidates = [root]
    else:
        candidates = [path for path in root.rglob("*") if path.is_file()]
    return sorted(path for path in candidates if path.suffix.lower() in OPTIMIZABLE_VIDEO_EXTENSIONS)


def _optimize_video_file(path: Path):
    label = _relative_media_label(path)
    if shutil.which("ffprobe") is None:
        yield f"FFprobe is not installed; keeping original {label} because the codec cannot be detected.\n"
        return

    codec = _media_video_codec(path)
    if codec in PASSTHROUGH_UPLOAD_CODECS:
        yield f"Keeping {label} as {codec.upper()} for codec-aware streaming.\n"
        return

    if shutil.which("ffmpeg") is None:
        yield f"FFmpeg is not installed; keeping original {label}.\n"
        return

    duration = _video_duration_seconds(path)
    output_path = path.with_name(f".{path.stem}.optimized{path.suffix}")
    output_path.unlink(missing_ok=True)

    cmd = [
        "ffmpeg",
        "-y",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-an",
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
        f"keyint={OPTIMIZED_VIDEO_GOP}:min-keyint={OPTIMIZED_VIDEO_GOP}:no-scenecut=1:repeat-headers=1:aud=1",
        "-b:v",
        OPTIMIZED_VIDEO_BITRATE,
        "-g",
        OPTIMIZED_VIDEO_GOP,
        "-bf",
        "0",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(output_path),
    ]

    yield f"Optimizing {label} for low-latency RTSP playback...\n"
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    diagnostics: List[str] = []
    last_progress_at = 0.0
    if process.stdout:
        for raw_line in process.stdout:
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
                    f"Optimizing {label}: {percent}% "
                    f"({_format_duration(elapsed)} / {_format_duration(duration)})\n"
                )
            else:
                yield f"Optimizing {label}: {_format_duration(elapsed)} processed\n"

    return_code = process.wait()
    if return_code != 0:
        output_path.unlink(missing_ok=True)
        details = "\n".join(diagnostics[-4:]) or f"ffmpeg exited with status {return_code}"
        yield f"FFmpeg conversion failed for {label}: {details}\n"
        return

    output_path.replace(path)
    yield f"Optimized {label}: H.264 baseline, GOP {OPTIMIZED_VIDEO_GOP}, B-frames disabled, source frame rate preserved.\n"


def _optimize_media_files(root: Path):
    videos = _iter_optimizable_videos(root)
    if not videos:
        yield "No MP4 files found to optimize.\n"
        return

    for index, video_path in enumerate(videos, start=1):
        yield f"Preparing file {index}/{len(videos)}: {_relative_media_label(video_path)}\n"
        yield from _optimize_video_file(video_path)


def _media_catalog_index() -> dict[str, Any]:
    catalog = _json_urlopen(MEDIA_CATALOG_INDEX_URL)
    if not isinstance(catalog, dict):
        raise RuntimeError("Catalog index is not a JSON object")
    catalog.setdefault("sources", [])
    catalog.setdefault("assets", [])
    return catalog


def _catalog_source_by_id(catalog: dict[str, Any], source_id: str) -> Optional[dict[str, Any]]:
    for source in catalog.get("sources", []):
        if isinstance(source, dict) and str(source.get("id") or "") == source_id:
            return source
    return None


def _catalog_asset_by_path(catalog: dict[str, Any], asset_path: str) -> Optional[dict[str, Any]]:
    for asset in catalog.get("assets", []):
        if isinstance(asset, dict) and str(asset.get("path") or "") == asset_path:
            return asset
    return None


def _catalog_asset_url(asset_path: str) -> str:
    return urllib.parse.urljoin(MEDIA_CATALOG_BASE_URL.rstrip("/") + "/", asset_path)


def _safe_catalog_asset_path(asset_path: str) -> str:
    normalized = str(asset_path or "").strip().replace("\\", "/")
    if not normalized or normalized.startswith("/") or ".." in Path(normalized).parts:
        raise ValueError("Invalid catalog asset path")
    return normalized


def _catalog_import_filename(asset: dict[str, Any]) -> str:
    source_id = secure_filename(str(asset.get("source_id") or "catalog_asset")) or "catalog_asset"
    profile = secure_filename(str(asset.get("profile") or f"{asset.get('target_height') or 'video'}p")) or "video"
    fps = secure_filename(str(asset.get("fps") or "").strip())
    codec = secure_filename(str(asset.get("codec") or asset.get("codec_name") or "video")) or "video"
    extension = secure_filename(str(asset.get("container") or Path(str(asset.get("path") or "")).suffix.lstrip(".") or "mp4")) or "mp4"
    fps_part = f"_{fps}fps" if fps else ""
    return f"{source_id}_{profile}{fps_part}_{codec}.{extension.lower()}"


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


def _youtube_video_id(url: str) -> str:
    raw_url = str(url or "").strip()
    if raw_url and "://" not in raw_url:
        raw_url = f"https://{raw_url}"
    parsed = urllib.parse.urlparse(raw_url)
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    if host not in YOUTUBE_HOSTS:
        raise ValueError("Enter a YouTube URL.")

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


def _youtube_preview_payload(url: str) -> dict[str, str]:
    video_id = _youtube_video_id(url)
    normalized_url = f"https://www.youtube.com/watch?v={video_id}"
    return {
        "video_id": video_id,
        "normalized_url": normalized_url,
        "embed_url": f"https://www.youtube.com/embed/{video_id}",
        "thumbnail_url": f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg",
    }


def _youtube_metadata_payload(url: str) -> dict[str, Any]:
    preview = _youtube_preview_payload(url)
    yt_dlp = _yt_dlp_command()
    cmd = [
        *yt_dlp,
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

    payload = dict(preview)
    payload.update(
        {
            "title": metadata.get("title") or "",
            "duration": metadata.get("duration"),
            "is_live": bool(metadata.get("is_live")),
            "live_status": metadata.get("live_status") or "",
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

            downloaded_files = sorted(path for path in temp_root.iterdir() if path.is_file())
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


def _stream_catalog_asset_download(asset: dict[str, Any], source: dict[str, Any]):
    asset_path = _safe_catalog_asset_path(str(asset.get("path") or ""))
    asset_url = _catalog_asset_url(asset_path)
    source_id = str(asset.get("source_id") or source.get("id") or "catalog")
    rel_path = Path("catalog") / secure_filename(source_id) / _catalog_import_filename(asset)
    target_path = _unique_media_path(rel_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target_path.with_name(f".{target_path.name}.download")
    temp_path.unlink(missing_ok=True)

    expected_sha = str(asset.get("sha256") or "").strip().lower()
    expected_bytes = asset.get("bytes")
    try:
        expected_bytes_int = int(expected_bytes) if expected_bytes is not None else 0
    except (TypeError, ValueError):
        expected_bytes_int = 0

    yield f"Downloading catalog asset: {source.get('title') or source_id} {asset.get('profile')} {asset.get('codec')}\n"
    request_obj = urllib.request.Request(asset_url, headers={"User-Agent": "neat-insight/asset-catalog"})
    digest = hashlib.sha256()
    copied = 0
    last_report = 0.0
    try:
        with urllib.request.urlopen(request_obj, timeout=120) as response, temp_path.open("wb") as out:
            total_header = response.headers.get("Content-Length")
            total_bytes = int(total_header) if total_header and total_header.isdigit() else expected_bytes_int
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                copied += len(chunk)
                now = time.monotonic()
                if now - last_report >= 0.75:
                    last_report = now
                    if total_bytes:
                        percent = min(99, max(0, int((copied / total_bytes) * 100)))
                        yield f"Downloading catalog asset: {percent}% ({copied} / {total_bytes} bytes)\n"
                    else:
                        yield f"Downloading catalog asset: {copied} bytes downloaded\n"

        actual_sha = digest.hexdigest()
        if expected_sha and actual_sha != expected_sha:
            temp_path.unlink(missing_ok=True)
            yield f"Checksum mismatch for catalog asset: expected {expected_sha}, got {actual_sha}\n"
            return
        if expected_bytes_int and copied != expected_bytes_int:
            temp_path.unlink(missing_ok=True)
            yield f"Size mismatch for catalog asset: expected {expected_bytes_int} bytes, got {copied}\n"
            return

        temp_path.replace(target_path)
        rel_saved = target_path.relative_to(MEDIA_DIR).as_posix()
        yield f"Saved catalog asset to {rel_saved}\n"
        yield "Catalog import complete.\n"
    except Exception as exc:
        temp_path.unlink(missing_ok=True)
        yield f"Catalog import failed: {exc}\n"


@app.get("/api/media-catalog")
def media_catalog():
    """Return the published Insight media asset catalog with resolved asset URLs."""
    try:
        catalog = _media_catalog_index()
    except Exception as exc:
        return _json_error(f"Failed to load media catalog: {exc}", 502)

    sources = catalog.get("sources") if isinstance(catalog.get("sources"), list) else []
    assets = catalog.get("assets") if isinstance(catalog.get("assets"), list) else []
    enriched_assets = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        enriched = dict(asset)
        asset_path = str(asset.get("path") or "")
        if asset_path:
            enriched["url"] = _catalog_asset_url(asset_path)
        enriched_assets.append(enriched)

    return jsonify(
        {
            "schema": catalog.get("schema"),
            "generated_at": catalog.get("generated_at"),
            "index_url": MEDIA_CATALOG_INDEX_URL,
            "base_url": MEDIA_CATALOG_BASE_URL.rstrip("/") + "/",
            "sources": sources,
            "assets": enriched_assets,
        }
    )


@app.post("/api/import/media-catalog")
def import_media_catalog_asset():
    """Download a published catalog asset into the local media library while streaming progress."""
    data = request.get_json(silent=True) or {}
    requested_asset_path = data.get("path") or data.get("asset_path")
    if not requested_asset_path:
        return _json_error("Missing catalog asset path")

    try:
        asset_path = _safe_catalog_asset_path(str(requested_asset_path))
        catalog = _media_catalog_index()
        asset = _catalog_asset_by_path(catalog, asset_path)
        if not asset:
            return _json_error("Catalog asset not found", 404)
        source = _catalog_source_by_id(catalog, str(asset.get("source_id") or "")) or {}
    except ValueError as exc:
        return _json_error(str(exc), 403)
    except Exception as exc:
        return _json_error(f"Failed to load media catalog: {exc}", 502)

    return Response(
        stream_with_context(_stream_catalog_asset_download(asset, source)),
        mimetype="text/plain",
    )


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


# API: upload a media file or archive into the neat-insight media library.
@app.post("/api/upload/media")
def upload_media():
    """Accept multipart form field 'file' and stream plain-text progress while saving or extracting media."""
    def generate():
        uploaded_file = request.files.get("file")
        if not uploaded_file or uploaded_file.filename == "":
            yield "No file provided.\n"
            return

        filename = secure_filename(uploaded_file.filename)
        lower_filename = filename.lower()
        file_ext = lower_filename.rsplit(".", 1)[-1]

        if file_ext in ["zip", "tar", "gz"] or lower_filename.endswith(".tar.gz"):
            base_name = os.path.splitext(os.path.splitext(filename)[0])[0]
            target_dir = MEDIA_DIR / base_name
            target_dir.mkdir(parents=True, exist_ok=True)
            temp_path = target_dir / filename
            uploaded_file.save(temp_path)
            yield f"Saved archive to {temp_path}\n"

            try:
                if lower_filename.endswith(".zip"):
                    import zipfile

                    with zipfile.ZipFile(temp_path, "r") as zip_ref:
                        _validate_archive_members(target_dir, zip_ref.namelist())
                        zip_ref.extractall(target_dir)
                else:
                    import tarfile

                    with tarfile.open(temp_path, "r:*") as tar:
                        _validate_archive_members(target_dir, [member.name for member in tar.getmembers()])
                        tar.extractall(path=target_dir)
                yield "Archive extracted.\n"
            except Exception as exc:
                yield f"Failed to extract archive: {exc}\n"
                return
            finally:
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
            yield from _optimize_media_files(target_dir)
            yield "Upload complete.\n"
            return

        target_path = MEDIA_DIR / filename
        uploaded_file.save(target_path)
        yield f"Uploaded to {target_path}\n"
        yield from _optimize_media_files(target_path)
        yield "Upload complete.\n"

    return Response(stream_with_context(generate()), mimetype="text/plain")


# API: delete one media library file or directory.
@app.post("/api/delete-media")
def delete_media():
    """Accept JSON {'path': str}; safely delete the path under MEDIA_DIR and clear matching media-source assignments."""
    data = request.get_json() or {}
    requested_path = data.get("path")
    if not requested_path:
        return _json_error("Missing 'path' in request")

    try:
        full_path = _safe_media_path(requested_path)
    except ValueError:
        return _json_error("Invalid file path", 403)

    if not full_path.exists():
        return _json_error("File or directory not found", 404)

    try:
        if full_path.is_file():
            file_name = os.path.relpath(full_path, MEDIA_DIR)
            sources = load_sources()
            modified = False
            for src in sources:
                if src.get("file") == file_name:
                    stop_media_stream(src["index"])
                    src["file"] = ""
                    src["state"] = "stopped"
                    modified = True
            if modified:
                save_sources(sources)
            full_path.unlink()
        else:
            shutil.rmtree(full_path)
        return {"message": "Deleted successfully"}
    except Exception as exc:
        return _json_error(str(exc), 500)


# API: inspect one uploaded media file.
@app.post("/api/media-info")
def media_info():
    """Accept JSON {'path': str}; return file size plus image dimensions or video track metadata."""
    data = request.get_json() or {}
    rel_path = data.get("path")
    if not rel_path:
        return _json_error("Missing path")

    try:
        abs_path = _safe_media_path(rel_path)
    except ValueError:
        return _json_error("Invalid path")
    if not abs_path.is_file():
        return _json_error("Invalid path")

    info = {"filename": abs_path.name, "size_bytes": abs_path.stat().st_size}

    try:
        if abs_path.suffix.lower() in {".jpg", ".jpeg", ".png"}:
            with Image.open(abs_path) as img:
                info.update(
                    {
                        "type": "image",
                        "width": img.size[0],
                        "height": img.size[1],
                        "mode": img.mode,
                        "format": img.format,
                    }
                )
        else:
            probe = _ffprobe_json(abs_path)
            if probe:
                stream = probe["stream"]
                codec = _media_video_codec(abs_path)
                raw_codec = stream.get("codec_tag_string") or stream.get("codec_name")
                duration = _duration_to_seconds(stream.get("duration")) or _duration_to_seconds(probe["format"].get("duration"))
                info.update(
                    {
                        "type": "video",
                        "codec": _media_codec_display_name(raw_codec, codec),
                        "normalized_codec": codec,
                        "width": stream.get("width"),
                        "height": stream.get("height"),
                        "duration_ms": duration * 1000 if duration is not None else None,
                        "frame_rate": stream.get("avg_frame_rate") or stream.get("r_frame_rate"),
                    }
                )
            else:
                info["type"] = "unknown"
    except Exception as exc:
        return _json_error(str(exc), 500)

    return info


# API: serve raw uploaded media content to the browser.
@app.get("/media/<path:filename>")
def serve_media(filename):
    """Return a file from MEDIA_DIR using Flask's safe directory serving for previews and downloads."""
    return send_from_directory(MEDIA_DIR, filename)


@app.get("/api/media-preview/mjpeg")
def media_preview_mjpeg():
    """Return a multipart MJPEG preview stream for a media-library file."""
    rel_path = request.args.get("path", "")
    if not rel_path:
        return _json_error("Missing path")
    try:
        media_path = _safe_media_path(rel_path)
    except ValueError:
        return _json_error("Invalid path", 403)
    if not media_path.is_file():
        return _json_error("Source file not found", 404)
    source_codec = _media_video_codec(media_path)

    def generate():
        process = None
        try:
            process = subprocess.Popen(
                http_mjpeg_command(str(media_path), source_codec),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            while True:
                chunk = process.stdout.read(64 * 1024) if process.stdout else b""
                if not chunk:
                    break
                yield chunk
        finally:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except Exception:
                    process.kill()

    return Response(
        stream_with_context(generate()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


# API: list media files that can be assigned to streaming sources.
@app.get("/api/mediasrc/videos")
def list_video_files():
    """Return sorted relative paths for files whose extension is accepted by the media-source streamer."""
    video_files = _collect_video_files()
    return jsonify(video_files)


def _collect_video_files():
    video_files = []
    for root, _, files in os.walk(MEDIA_DIR):
        for fname in files:
            if Path(fname).suffix.lower() in ALLOWED_EXTENSIONS:
                full_path = Path(root) / fname
                rel = os.path.relpath(full_path, MEDIA_DIR).replace(os.path.sep, "/")
                video_files.append(rel)
    return sorted(video_files)


def _source_media_codec(file_name: str) -> Optional[str]:
    if not file_name:
        return None
    try:
        return _media_video_codec(_safe_media_path(file_name))
    except ValueError:
        return None


def _recommended_codec_for_file(file_name: str, fallback: str = DEFAULT_CODEC) -> str:
    if not file_name:
        return normalize_codec(fallback)
    codec = _source_media_codec(file_name)
    if codec in {"h264", "h265", "mjpeg"}:
        return codec
    return UNKNOWN_CODEC


def _allowed_transports_for_codec(codec: str) -> list[str]:
    if codec == UNKNOWN_CODEC:
        return []
    return ["rtsp", "http"] if normalize_codec(codec) == "mjpeg" else ["rtsp"]


def _codec_detection_error(file_name: str) -> str:
    return (
        f"Unable to detect the media codec for {file_name}. "
        "Install FFmpeg with ffprobe and use a supported H.264, H.265, or MJPEG source."
    )


def _derive_source_stream_settings(file_name: str, requested_transport: Optional[str] = None):
    codec = _recommended_codec_for_file(file_name, DEFAULT_CODEC)
    allowed_transports = _allowed_transports_for_codec(codec)
    if not allowed_transports:
        return "", codec, allowed_transports
    transport = normalize_transport(requested_transport)
    if transport not in allowed_transports:
        transport = allowed_transports[0]
    return transport, codec, allowed_transports


def _source_url(src, transport: Optional[str] = None):
    index = int(src.get("index") or 0)
    selected_transport = normalize_transport(transport or src.get("transport"))
    host = _request_host_name()
    if selected_transport == "http":
        return f"{request.scheme}://{request.host}/stream/http/src{index}.mjpg"
    return f"rtsp://{host}:8554/src{index}"


def _source_with_urls(src):
    enriched = dict(src)
    stored_codec = src.get("codec")
    if stored_codec in {"h264", "h265", "mjpeg", UNKNOWN_CODEC}:
        codec = stored_codec
        allowed_transports = _allowed_transports_for_codec(codec)
        transport = normalize_transport(src.get("transport")) if allowed_transports else ""
        if transport not in allowed_transports:
            transport = allowed_transports[0] if allowed_transports else ""
    else:
        transport, codec, allowed_transports = _derive_source_stream_settings(src.get("file") or "", src.get("transport"))
    enriched["transport"] = transport
    enriched["codec"] = codec
    enriched["allowed_transports"] = allowed_transports
    urls = {}
    if "rtsp" in allowed_transports:
        urls["rtsp"] = _source_url(src, "rtsp")
    if "http" in allowed_transports:
        urls["http_mjpeg"] = _source_url(src, "http")
    enriched["urls"] = urls
    return enriched


def _sync_source_runtime_states(sources):
    changed = False
    for src in sources:
        if src.get("state") != "playing":
            continue
        index = src.get("index")
        if index is None or not media_stream_is_running(index):
            src["state"] = "stopped"
            changed = True
    if changed:
        save_sources(sources)
    return sources


def _find_source(index: int):
    for src in _sync_source_runtime_states(load_sources()):
        if src.get("index") == index:
            return src
    return None


# API: read current RTSP media-source slot assignments.
@app.get("/api/mediasrc")
def get_sources():
    """Return persisted media-source objects, including index, assigned file path, and playback state."""
    sources = _sync_source_runtime_states(load_sources())
    return jsonify([_source_with_urls(src) for src in sources])


# API: assign or clear a media file for one RTSP source slot.
@app.post("/api/mediasrc/assign")
def assign_source():
    """Accept JSON {'index': int, 'file': str, 'transport': str, 'codec': str}; update and restart if already playing."""
    data = request.get_json() or {}
    index = data.get("index")
    file_name = data.get("file") or ""
    if index is None:
        return _json_error("Missing index")
    requested_transport = data.get("transport")

    sources = load_sources()
    for src in sources:
        if src["index"] == index:
            was_playing = src.get("state") == "playing" and media_stream_is_running(index)
            if was_playing:
                stop_media_stream(index)
            src["file"] = file_name
            transport, codec, _allowed_transports = _derive_source_stream_settings(file_name, requested_transport or src.get("transport"))
            src["transport"] = transport
            src["codec"] = codec
            if was_playing and file_name:
                if not _allowed_transports:
                    src["state"] = "stopped"
                    save_sources(sources)
                    return _json_error(_codec_detection_error(file_name), 400)
                file_path = MEDIA_DIR / file_name
                ok, err = start_media_stream(
                    index,
                    str(file_path),
                    src.get("transport"),
                    src.get("codec"),
                    _source_media_codec(file_name),
                )
                if not ok:
                    return _json_error(err, 500)
                src["state"] = "playing"
            elif not file_name:
                src["state"] = "stopped"
            save_sources(sources)
            return {"success": True}

    return _json_error("Source not found", 404)


# API: assign available videos to all source slots in index order.
@app.post("/api/mediasrc/auto-assign-all")
def auto_assign_all_sources():
    """Stop active sources, assign each slot a unique video when available, persist the stopped assignments."""
    sources = sorted(load_sources(), key=lambda src: src.get("index", 0))
    video_files = _collect_video_files()

    for idx, src in enumerate(sources):
        source_index = src.get("index")
        if src.get("state") == "playing":
            stop_media_stream(source_index)
        src["file"] = video_files[idx] if idx < len(video_files) else ""
        src["transport"], src["codec"], _allowed_transports = _derive_source_stream_settings(src["file"])
        src["state"] = "stopped"

    save_sources(sources)
    assigned_count = min(len(sources), len(video_files))
    return {
        "success": True,
        "assigned_count": assigned_count,
        "source_count": len(sources),
        "available_files": len(video_files),
        "message": f"Assigned {assigned_count} source(s) with unique media file(s).",
    }


# API: start streaming one assigned media source.
@app.post("/api/mediasrc/start")
def start_source():
    """Accept JSON {'index': int}; start the assigned file for that source and mark its state as playing."""
    data = request.get_json() or {}
    index = data.get("index")
    if index is None:
        return _json_error("Missing index")

    sources = load_sources()
    for src in sources:
        if src["index"] == index:
            filename = src.get("file")
            if not filename:
                return _json_error("No file assigned to source")
            transport, codec, allowed_transports = _derive_source_stream_settings(filename, src.get("transport"))
            src["transport"] = transport
            src["codec"] = codec
            if not allowed_transports:
                save_sources(sources)
                return _json_error(_codec_detection_error(filename), 400)
            ok, err = start_media_stream(
                index,
                str(MEDIA_DIR / filename),
                src.get("transport"),
                src.get("codec"),
                _source_media_codec(filename),
            )
            if not ok:
                return _json_error(err, 500)
            src["state"] = "playing"
            save_sources(sources)
            return {"success": True}

    return _json_error("Source not found", 404)


# API: start multiple assigned media sources in source-index order.
@app.post("/api/mediasrc/start-bulk")
def start_sources_bulk():
    """Accept JSON {'count': int}; start the first count assigned sources and report starts, skips, and errors."""
    data = request.get_json() or {}
    raw_count = data.get("count")
    if raw_count is None:
        return _json_error("Missing count")

    try:
        count = int(raw_count)
    except (TypeError, ValueError):
        return _json_error("Invalid count")
    if count <= 0:
        return _json_error("Count must be greater than 0")

    sources = sorted(load_sources(), key=lambda src: src.get("index", 0))
    assigned_sources = [src for src in sources if src.get("file")]
    if not assigned_sources:
        return _json_error("No assigned sources available to start")

    targets = assigned_sources[:count]
    started = []
    already_running = []
    errors = []

    for src in targets:
        source_index = src["index"]
        if src.get("state") == "playing" and media_stream_is_running(source_index):
            already_running.append(source_index)
            continue
        transport, codec, allowed_transports = _derive_source_stream_settings(src["file"], src.get("transport"))
        src["transport"] = transport
        src["codec"] = codec
        if not allowed_transports:
            errors.append({"index": source_index, "error": _codec_detection_error(src["file"])})
            continue
        ok, err = start_media_stream(
            source_index,
            str(MEDIA_DIR / src["file"]),
            src.get("transport"),
            src.get("codec"),
            _source_media_codec(src["file"]),
        )
        if ok:
            src["state"] = "playing"
            started.append(source_index)
        else:
            errors.append({"index": source_index, "error": err or "Unknown error"})

    save_sources(sources)
    started_or_running = len(started) + len(already_running)
    return {
        "success": len(errors) == 0,
        "requested": count,
        "targeted": len(targets),
        "started": started,
        "already_running": already_running,
        "errors": errors,
        "message": (
            f"Started {len(started)} source(s), {len(already_running)} already running, "
            f"{len(errors)} failed."
        ),
        "started_or_running": started_or_running,
    }


# API: stop one RTSP media source.
@app.post("/api/mediasrc/stop")
def stop_source():
    """Accept JSON {'index': int}; stop the source process and persist its state as stopped."""
    data = request.get_json() or {}
    index = data.get("index")
    if index is None:
        return _json_error("Missing index")

    sources = load_sources()
    for src in sources:
        if src["index"] == index:
            stop_media_stream(index)
            src["state"] = "stopped"
            save_sources(sources)
            return {"success": True}

    return _json_error("Source not found", 404)


# API: stop every RTSP media source.
@app.post("/api/mediasrc/stop-all")
def stop_all_sources():
    """Stop all source processes, persist every source as stopped, and return how many were previously playing."""
    sources = load_sources()
    stopped_count = 0
    for src in sources:
        source_index = src.get("index")
        if src.get("state") == "playing":
            stopped_count += 1
        stop_media_stream(source_index)
        src["state"] = "stopped"

    save_sources(sources)
    return {"success": True, "stopped_count": stopped_count, "message": f"Stopped {stopped_count} source(s)."}


# API: reset media-source assignments to their default empty state.
@app.post("/api/mediasrc/reset")
def reset_all_sources():
    """Stop all source processes, rewrite the default source assignment file, and return a success message."""
    sources = load_sources()
    for src in sources:
        stop_media_stream(src.get("index"))
    reset_sources()
    return {"success": True, "message": "Reset all source assignments."}


def _http_mjpeg_source_or_error(index: int):
    src = _find_source(index)
    if not src:
        return None, _json_error("Source not found", 404)
    if not src.get("file"):
        return None, _json_error("No file assigned to source", 404)
    if normalize_transport(src.get("transport")) != "http" or normalize_codec(src.get("codec")) != "mjpeg":
        return None, _json_error("Source is not configured for HTTP MJPEG streaming", 400)
    if src.get("state") != "playing" or not media_stream_is_running(index):
        return None, _json_error("Source is not running", 409)
    try:
        media_path = _safe_media_path(src["file"])
    except ValueError:
        return None, _json_error("Invalid source file path", 403)
    if not media_path.is_file():
        return None, _json_error("Source file not found", 404)
    return (src, media_path), None


@app.get("/stream/http/src<int:index>.mjpg")
def stream_http_mjpeg(index):
    """Return a multipart MJPEG stream for an active HTTP/MJPEG source slot."""
    resolved, error = _http_mjpeg_source_or_error(index)
    if error:
        return error
    src, media_path = resolved
    source_codec = _source_media_codec(src["file"])
    stream_identity = media_stream_identity(index)

    def generate():
        process = None
        try:
            process = subprocess.Popen(
                http_mjpeg_command(str(media_path), source_codec),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            while True:
                if media_stream_identity(index) != stream_identity or not media_stream_is_running(index):
                    break
                chunk = process.stdout.read(64 * 1024) if process.stdout else b""
                if not chunk:
                    break
                if media_stream_identity(index) != stream_identity or not media_stream_is_running(index):
                    break
                yield chunk
        finally:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except Exception:
                    process.kill()

    return Response(
        stream_with_context(generate()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


@app.get("/stream/http/src<int:index>.jpg")
def snapshot_http_mjpeg(index):
    """Return one JPEG frame for an active HTTP/MJPEG source slot."""
    resolved, error = _http_mjpeg_source_or_error(index)
    if error:
        return error
    src, media_path = resolved
    source_codec = _source_media_codec(src["file"])
    try:
        result = subprocess.run(
            http_snapshot_command(str(media_path), source_codec),
            check=False,
            capture_output=True,
            timeout=10,
        )
    except FileNotFoundError:
        return _json_error("ffmpeg is not installed", 500)
    except subprocess.TimeoutExpired:
        return _json_error("Timed out while reading source frame", 504)
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace").strip() or "Failed to read source frame"
        return _json_error(detail, 500)
    return Response(result.stdout, mimetype="image/jpeg", headers={"Cache-Control": "no-store, max-age=0"})


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
        return _json_error("DEVKIT_SYNC_DEVKIT_IP is not configured.", 404)
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


# API: build a vf viewer URL for the requested source selection.
@app.get("/api/viewer-url")
def viewer_url():
    """Accept query args mode and src; return the browser-reachable HTTPS vf viewer URL."""
    mode = request.args.get("mode", "light")
    default_src = ",".join(str(i) for i in range(VIEWER_CHANNEL_COUNT))
    src = request.args.get("src", default_src)
    host_ip = _request_host_name()
    viewer_port = _resolve_video_ui_port()
    query = urllib.parse.urlencode({"mode": mode, "src": src})
    return {"url": _format_browser_https_url(host_ip, viewer_port, "/static/viewer.html", query)}


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
    global server_ssl_context, sys_metrics_publisher

    parser = argparse.ArgumentParser(description="Start the neat-insight server.")
    parser.add_argument("--port", type=int, default=9900, help="Port to run the server on (default: 9900)")
    args = parser.parse_args()

    ensure_sys_metrics_publisher_started()
    reset_sources()

    ssl_context = check_and_generate_mkcert_certificate(args.port)
    server_ssl_context = ssl_context
    start_processes(ssl_context)

    def _shutdown(signum=None, frame=None):
        if sys_metrics_publisher:
            sys_metrics_publisher.stop()
        neat_metrics_broker.stop()
        cleanup_processes(signum, frame)

    # Ensure vf/mediamtx are also cleaned up on non-signal exits.
    atexit.register(lambda: cleanup_processes(exit_process=False))

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print("\n" + "=" * 120)
    print("neat-insight server starting")
    print(f"Access: {get_certificate_access_url(args.port)}")
    print("=" * 120 + "\n")

    app.run(host="0.0.0.0", port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
