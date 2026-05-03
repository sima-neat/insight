import argparse
import atexit
import json
import logging
import os
import platform
import shutil
import signal
import socket
import threading
from datetime import datetime
from pathlib import Path

import paramiko
import psutil
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from PIL import Image
from pymediainfo import MediaInfo
from werkzeug.utils import secure_filename

if __name__ == "__main__" and (not globals().get("__package__")):
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from neat_insight.app_manager import AppManager
from neat_insight.mediasrc import start_media_stream, stop_media_stream
from neat_insight.process_manager import ProcessManager
from neat_insight.profiler import NeatMetricsBroker, PeriodicZmqPublisher
from neat_insight.remote_devkit import (
    get_remote_devkit_ip,
    get_remote_metrics,
    is_remote_devkit_configured,
    is_remote_devkit_connected,
    run_remote_gst_pipeline,
    stop_remote_process,
)
from neat_insight.remotefs import read_remote_file
from neat_insight.utils import (
    board_type,
    check_and_generate_mkcert_certificate,
    cleanup_processes,
    get_certificate_access_url,
    init_environment,
    is_sima_board,
    parse_build_info,
    start_processes,
    tail_lines,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("werkzeug")
log.setLevel(logging.ERROR)

env = init_environment()
MEDIA_DIR = env["MEDIA_DIR"]
MEDIA_SRC_DATA_FILE = env["MEDIA_SRC_DATA_FILE"]
DEFAULT_SOURCE_COUNT = env["DEFAULT_SOURCE_COUNT"]
MPK_APPS_ROOT = env["MPK_SRC_PATH"]
CFG_PATH = env["NEAT_INSIGHT_DATA"] / "cfg.json"


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
app_manager = AppManager(MPK_APPS_ROOT)
process_manager = ProcessManager()
process_manager.start()
neat_metrics_broker = NeatMetricsBroker()
neat_metrics_broker.start()
sys_metrics_publisher = None
sys_metrics_lock = threading.Lock()
current_started_app_name = None

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
ALLOWED_LOGS = {"EV74": "simaai_EV74.log", "syslog": "syslog"}
LOG_DIR = "/var/log"


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


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


def collect_system_metrics():
    global current_started_app_name
    if is_remote_devkit_configured():
        if is_remote_devkit_connected():
            return get_remote_metrics(current_started_app_name)
        return {
            "cpu_load": "",
            "memory": {},
            "mla_allocated_bytes": 0,
            "disk": {},
            "pipeline_status": {},
            "temperature_celsius_avg": 0,
            "REMOTE": True,
        }

    cpu_percent_total = psutil.cpu_percent(interval=0.1)
    mem = psutil.virtual_memory()
    memory_usage = {"total": mem.total, "used": mem.used, "percent": mem.percent}

    try:
        target_path = Path("/data") if is_sima_board() else Path.home()
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

    return {
        "cpu_load": cpu_percent_total,
        "memory": memory_usage,
        "mla_allocated_bytes": 0,
        "disk": disk_usage,
        "pipeline_status": process_manager.get_status(),
        "temperature_celsius_avg": avg_temp,
        "REMOTE": False,
    }


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


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "neat-insight", "time": datetime.utcnow().isoformat() + "Z"}


@app.get("/api/apps")
def list_apps():
    app_manager.refresh_apps()
    return {"apps": app_manager.get_available_apps()}


@app.post("/api/pipeline/start/<app_name>")
def start_pipeline(app_name):
    manifest = app_manager.get_app_config(app_name)
    if not manifest:
        return _json_error(f"App '{app_name}' not found", 404)

    debug_level = "0"
    if request.is_json:
        debug_level = str(request.json.get("gst_debug", "0"))
    if debug_level not in {"0", "1", "2", "3", "4", "5"}:
        return _json_error(f"Invalid gst_debug level: {debug_level}")

    app_block = next((a for a in manifest.get("applications", []) if a.get("name") == app_name), None)
    if not app_block:
        return _json_error(f"No application block with name '{app_name}'", 400)

    pipeline_def = (app_block.get("pipelines") or [{}])[0]
    gst_command = pipeline_def.get("gst", "").strip()
    if not gst_command:
        return _json_error("No 'gst' command defined in pipeline.", 400)

    config = app_block.get("configuration", {})
    env_vars = {}
    for line in config.get("environment", []):
        if "=" in line:
            key, value = line.split("=", 1)
            env_vars[key.strip()] = value.strip().strip('"').strip("'")
    for opt in config.get("gst", {}).get("options", []):
        if "--gst-plugin-path" in opt:
            env_vars["GST_PLUGIN_PATH"] = opt.split("=")[-1].strip('"\'')
    env_vars["GST_DEBUG"] = debug_level

    if is_remote_devkit_configured():
        success, error = run_remote_gst_pipeline(app_name, gst_command, env_vars)
        if not success:
            return _json_error(error, 500)
    else:
        full_env = os.environ.copy()
        full_env.update(env_vars)
        process_manager.submit_command(gst_command, full_env)

    global current_started_app_name
    current_started_app_name = app_name
    return {"status": "started", "app": app_name, "gst_debug": debug_level}


@app.post("/api/pipeline/stop")
def stop_pipeline():
    if is_remote_devkit_configured():
        if not is_remote_devkit_connected():
            return _json_error("Remote devkit not connected", 503)
        if not current_started_app_name:
            return _json_error("No remote app is currently started")
        result = stop_remote_process(current_started_app_name)
        if "error" in result:
            return _json_error(result["error"], 500)
        return {"status": "remote stopped", "pids": result.get("stopped_pids", [])}

    process_manager.submit_command("STOP", None)
    return {"status": "local stopped"}


@app.get("/api/pipeline/logs")
def pipeline_logs():
    app_name = request.args.get("folder", "")
    log_path = f"/tmp/{app_name}.log"

    if is_remote_devkit_configured():
        if not is_remote_devkit_connected():
            return Response("[ERROR] Remote devkit not connected\n", mimetype="text/plain")
        try:
            content = read_remote_file(log_path)
            return Response(content or b"", mimetype="text/plain")
        except Exception as exc:
            return Response(f"[ERROR] Failed to read remote log: {exc}\n", mimetype="text/plain")

    @stream_with_context
    def generate_local():
        for line in process_manager.stream_logs():
            yield line

    return Response(generate_local(), mimetype="text/plain")


@app.get("/api/logs/<logname>")
def get_log(logname):
    if logname not in ALLOWED_LOGS:
        return _json_error("Log not found", 404)

    log_path = os.path.join(LOG_DIR, ALLOWED_LOGS[logname])
    if not os.path.isfile(log_path):
        return _json_error(f"{logname} log not found", 404)
    return Response(tail_lines(log_path, 10000, 256 * 1024), mimetype="text/plain")


@app.get("/api/metrics")
def metrics():
    return collect_system_metrics()


@app.get("/api/neat-metrics")
def stream_neat_metrics():
    ensure_sys_metrics_publisher_started()

    def event_stream():
        for event in neat_metrics_broker.subscribe():
            yield f"data: {json.dumps(event)}\n\n"

    response = Response(stream_with_context(event_stream()), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.get("/api/media-files")
def list_media_files():
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


@app.get("/api/system/tools")
def system_tools():
    return {"ffmpeg": shutil.which("ffmpeg") is not None, "gstreamer": shutil.which("gst-launch-1.0") is not None}


@app.post("/api/upload/media")
def upload_media():
    def generate():
        uploaded_file = request.files.get("file")
        if not uploaded_file or uploaded_file.filename == "":
            yield "No file provided.\n"
            return

        filename = secure_filename(uploaded_file.filename)
        file_ext = filename.lower().rsplit(".", 1)[-1]

        if file_ext in ["zip", "tar", "gz"] or filename.endswith(".tar.gz"):
            base_name = os.path.splitext(os.path.splitext(filename)[0])[0]
            target_dir = MEDIA_DIR / base_name
            target_dir.mkdir(parents=True, exist_ok=True)
            temp_path = target_dir / filename
            uploaded_file.save(temp_path)
            yield f"Saved archive to {temp_path}\n"

            try:
                if filename.endswith(".zip"):
                    import zipfile

                    with zipfile.ZipFile(temp_path, "r") as zip_ref:
                        zip_ref.extractall(target_dir)
                else:
                    import tarfile

                    with tarfile.open(temp_path, "r:*") as tar:
                        tar.extractall(path=target_dir)
                yield "Archive extracted.\n"
            except Exception as exc:
                yield f"Failed to extract archive: {exc}\n"
                return
            finally:
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
            yield "Upload complete.\n"
            return

        target_path = MEDIA_DIR / filename
        uploaded_file.save(target_path)
        # Explicitly keep original file as uploaded. No ffmpeg transcode and no B-frame stripping.
        yield f"Uploaded to {target_path}\n"

    return Response(stream_with_context(generate()), mimetype="text/plain")


@app.post("/api/delete-media")
def delete_media():
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


@app.post("/api/media-info")
def media_info():
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


@app.get("/media/<path:filename>")
def serve_media(filename):
    return send_from_directory(MEDIA_DIR, filename)


@app.get("/api/mediasrc/videos")
def list_video_files():
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


@app.get("/api/mediasrc")
def get_sources():
    return jsonify(load_sources())


@app.post("/api/mediasrc/assign")
def assign_source():
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


@app.post("/api/mediasrc/auto-assign-all")
def auto_assign_all_sources():
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


@app.post("/api/mediasrc/start")
def start_source():
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


@app.post("/api/mediasrc/start-bulk")
def start_sources_bulk():
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


@app.post("/api/mediasrc/stop")
def stop_source():
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


@app.post("/api/mediasrc/stop-all")
def stop_all_sources():
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


@app.post("/api/mediasrc/reset")
def reset_all_sources():
    sources = load_sources()
    for src in sources:
        stop_media_stream(src.get("index"))
    reset_sources()
    return {"success": True, "message": "Reset all source assignments."}


@app.get("/api/envinfo")
def envinfo():
    return {"is_sima_board": is_sima_board(), "is_remote_devkit_configured": is_remote_devkit_configured()}


@app.get("/api/buildinfo")
def buildinfo():
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


@app.get("/api/remotedevkit/cfg")
def get_remote_devkit_config():
    if not CFG_PATH.exists():
        return jsonify({"remote-devkit": {"ip": "", "port": 22, "rootPassword": ""}})
    with open(CFG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    safe_config = config.copy()
    if "remote-devkit" in safe_config and "rootPassword" in safe_config["remote-devkit"]:
        safe_config["remote-devkit"]["rootPassword"] = "••••••••"
    return jsonify(safe_config)


@app.post("/api/remotedevkit/cfg")
def save_remote_devkit_config():
    data = request.get_json() or {}
    ipaddress = (data.get("ip") or "").strip()
    password = data.get("rootPassword") or ""
    port = 22

    if ":" in ipaddress:
        host, port_text = ipaddress.split(":", 1)
        ipaddress = host
        port = int(port_text)

    if not ipaddress or (ipaddress != "127.0.0.1" and not password):
        return _json_error("Missing IP or root password")

    if ipaddress != "127.0.0.1":
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(
                hostname=ipaddress,
                port=port,
                username="root",
                password=password,
                timeout=5,
                banner_timeout=5,
                auth_timeout=5,
            )
            _, stdout, _ = ssh.exec_command("echo connected")
            result = stdout.read().decode().strip()
            ssh.close()
            if result != "connected":
                return _json_error("SSH login failed or unexpected response.", 502)
        except Exception as exc:
            return _json_error(f"SSH connection failed: {exc}", 502)

    config = {"remote-devkit": {"ip": ipaddress, "port": port, "rootPassword": password}}
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return {"message": "SSH test succeeded and configuration saved."}


@app.get("/api/server-ip")
def server_ip():
    container_ip = os.getenv("CONTAINER_HOST_IP")
    if container_ip:
        return {"ip": container_ip}

    if not is_remote_devkit_configured():
        return {"ip": "127.0.0.1"}

    try:
        remote_ip = get_remote_devkit_ip()
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((remote_ip, 22))
        local_ip = s.getsockname()[0]
        s.close()
        return {"ip": local_ip}
    except Exception:
        return {"ip": "127.0.0.1"}


@app.get("/api/viewer-url")
def viewer_url():
    mode = request.args.get("mode", "light")
    default_src = ",".join(str(i) for i in range(DEFAULT_SOURCE_COUNT))
    src = request.args.get("src", default_src)
    host_ip = request.host.split(":")[0]
    return {"url": f"https://{host_ip}:8081/static/viewer.html?mode={mode}&src={src}"}


@app.get("/")
def index():
    if FRONTEND_DIST.exists():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return "Frontend not built. Run: cd frontend && npm install && npm run build", 503


@app.get("/<path:path>")
def spa(path):
    if FRONTEND_DIST.exists():
        file_path = FRONTEND_DIST / path
        if file_path.exists() and file_path.is_file():
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")
    return "Frontend not built.", 503


def main():
    global sys_metrics_publisher

    parser = argparse.ArgumentParser(description="Start the neat-insight server.")
    parser.add_argument("--port", type=int, default=9900, help="Port to run the server on (default: 9900)")
    args = parser.parse_args()

    ensure_sys_metrics_publisher_started()
    reset_sources()

    ssl_context = check_and_generate_mkcert_certificate(args.port)
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
