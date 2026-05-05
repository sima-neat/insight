import argparse
import atexit
import base64
import json
import logging
import os
import platform
import shutil
import signal
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import psutil
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from PIL import Image
from pymediainfo import MediaInfo
from werkzeug.utils import secure_filename

if __name__ == "__main__" and (not globals().get("__package__")):
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from neat_insight.mediasrc import start_media_stream, stop_media_stream
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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

env = init_environment()
MEDIA_DIR = env["MEDIA_DIR"]
MEDIA_SRC_DATA_FILE = env["MEDIA_SRC_DATA_FILE"]
DEFAULT_SOURCE_COUNT = env["DEFAULT_SOURCE_COUNT"]
OPTIMIZABLE_VIDEO_EXTENSIONS = {".mp4"}
OPTIMIZED_VIDEO_BITRATE = "2M"
OPTIMIZED_VIDEO_FPS = "30"
OPTIMIZED_VIDEO_GOP = "30"


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

app = Flask(__name__)
neat_metrics_broker = NeatMetricsBroker()
neat_metrics_broker.start()
sys_metrics_publisher = None
sys_metrics_lock = threading.Lock()
server_ssl_context = None
DEFAULT_DEVKIT_SSH_USERNAME = "sima"
DEFAULT_DEVKIT_SSH_PASSWORD = "edgeai"

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
ALLOWED_LOGS = {"EV74": "simaai_EV74.log", "syslog": "syslog"}
LOG_DIR = "/var/log"


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _request_host_name() -> str:
    host = request.host.split(":", 1)[0]
    return host or "127.0.0.1"


def _build_devkit_shell_payload():
    devkit_ip = get_devkit_sync_devkit_ip()
    configured = bool(devkit_ip)
    webssh_port = get_webssh_port()
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
        launch_url = f"https://{_request_host_name()}:{webssh_port}/?{params}"

    return {
        "configured": configured,
        "devkit_ip": devkit_ip or None,
        "button_label": f"DevKit: {devkit_ip}" if configured else None,
        "available": webssh_is_available(),
        "running": is_webssh_running(),
        "webssh_port": webssh_port,
        "default_username": DEFAULT_DEVKIT_SSH_USERNAME,
        "credentials_prefilled": True,
        "launch_url": launch_url,
    }


def load_sources():
    if not MEDIA_SRC_DATA_FILE.exists():
        reset_sources()
    try:
        with open(MEDIA_SRC_DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_sources(sources):
    with open(MEDIA_SRC_DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(sources, f, indent=2)


def reset_sources():
    sources = [{"index": i + 1, "file": "", "state": "stopped"} for i in range(DEFAULT_SOURCE_COUNT)]
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


# API: enumerate uploaded media as a folder tree for the Media Library UI.
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
    """Return booleans indicating whether ffmpeg and gst-launch-1.0 are available on PATH."""
    return {"ffmpeg": shutil.which("ffmpeg") is not None, "gstreamer": shutil.which("gst-launch-1.0") is not None}


def _relative_media_label(path: Path) -> str:
    try:
        return str(path.relative_to(MEDIA_DIR))
    except ValueError:
        return path.name


def _video_duration_seconds(path: Path) -> Optional[float]:
    try:
        parsed = MediaInfo.parse(str(path))
        video_track = next((t for t in parsed.tracks if t.track_type == "Video"), None)
        duration_ms = getattr(video_track, "duration", None)
        if duration_ms:
            return float(duration_ms) / 1000.0
    except Exception as exc:
        logging.debug("Failed to parse video duration for %s: %s", path, exc)
    return None


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
        "-r",
        OPTIMIZED_VIDEO_FPS,
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
    yield f"Optimized {label}: H.264 baseline, {OPTIMIZED_VIDEO_FPS} fps, GOP {OPTIMIZED_VIDEO_GOP}, B-frames disabled.\n"


def _optimize_media_files(root: Path):
    videos = _iter_optimizable_videos(root)
    if not videos:
        yield "No MP4 files found to optimize.\n"
        return

    for index, video_path in enumerate(videos, start=1):
        yield f"Preparing file {index}/{len(videos)}: {_relative_media_label(video_path)}\n"
        yield from _optimize_video_file(video_path)


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
            parsed = MediaInfo.parse(str(abs_path))
            video_track = next((t for t in parsed.tracks if t.track_type == "Video"), None)
            if video_track:
                info.update(
                    {
                        "type": "video",
                        "codec": video_track.codec_id or video_track.format,
                        "width": video_track.width,
                        "height": video_track.height,
                        "duration_ms": video_track.duration,
                        "frame_rate": video_track.frame_rate,
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


# API: list media files that can be assigned to RTSP media sources.
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


# API: read current RTSP media-source slot assignments.
@app.get("/api/mediasrc")
def get_sources():
    """Return persisted media-source objects, including index, assigned file path, and playback state."""
    return jsonify(load_sources())


# API: assign or clear a media file for one RTSP source slot.
@app.post("/api/mediasrc/assign")
def assign_source():
    """Accept JSON {'index': int, 'file': str}; update a source assignment and restart it if already playing."""
    data = request.get_json() or {}
    index = data.get("index")
    file_name = data.get("file") or ""
    if index is None:
        return _json_error("Missing index")

    sources = load_sources()
    for src in sources:
        if src["index"] == index:
            was_playing = src.get("state") == "playing"
            if was_playing:
                stop_media_stream(index)
            src["file"] = file_name
            if was_playing and file_name:
                file_path = MEDIA_DIR / file_name
                ok, err = start_media_stream(index, str(file_path))
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
            ok, err = start_media_stream(index, str(MEDIA_DIR / filename))
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
        if src.get("state") == "playing":
            already_running.append(source_index)
            continue
        ok, err = start_media_stream(source_index, str(MEDIA_DIR / src["file"]))
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
    """Accept query args mode and src; return the HTTPS vf viewer URL on port 8081 for the request host."""
    mode = request.args.get("mode", "light")
    default_src = ",".join(str(i) for i in range(VIEWER_CHANNEL_COUNT))
    src = request.args.get("src", default_src)
    host_ip = request.host.split(":")[0]
    return {"url": f"https://{host_ip}:8081/static/viewer.html?mode={mode}&src={src}"}


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
