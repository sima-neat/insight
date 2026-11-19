import argparse
import concurrent.futures
import json
import logging
import os
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

from neat_insight.api_docs import api_docs_bp
from neat_insight.genai_relay import genai_bp
from neat_insight.profiler import NeatMetricsBroker, PeriodicZmqPublisher
from neat_insight.runtime_config import (
    legacy_runtime_network_config,
    load_runtime_network_config,
)
from neat_insight.utils import (
    board_type,
    check_and_generate_mkcert_certificate,
    get_certificate_access_url,
    init_environment,
    is_sima_board,
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
neat_metrics_broker = NeatMetricsBroker()
neat_metrics_broker.start()
sys_metrics_publisher = None
sys_metrics_lock = threading.Lock()
runtime_network_config = legacy_runtime_network_config()


def _json_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


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
    """The host's readings for the profiler's `sys` topic (System Info reads the server's
    /api/system/host)."""
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
    global runtime_network_config, sys_metrics_publisher

    parser = argparse.ArgumentParser(description="Start the neat-insight server.")
    parser.add_argument("--port", type=int, default=9900, help="Port to run the server on (default: 9900)")
    # The new server (server/) runs this backend behind it while the rewrite moves its routes over:
    # on loopback, over plain HTTP. Goes with this file at the end of the rewrite.
    parser.add_argument("--behind-proxy", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    runtime_network_config = load_runtime_network_config()

    ensure_sys_metrics_publisher_started()

    def _shutdown(signum=None, frame=None):
        if sys_metrics_publisher:
            sys_metrics_publisher.stop()
        neat_metrics_broker.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    if args.behind_proxy:
        # The browser reached the new server over HTTPS under its own host name, which the links
        # built here must name.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
        print(f"neat-insight backend on http://127.0.0.1:{args.port}, behind the new server")
        app.run(host="127.0.0.1", port=args.port)
        return

    ssl_context = check_and_generate_mkcert_certificate(args.port)
    print("\n" + "=" * 120)
    print("neat-insight server starting")
    print(f"Access: {get_certificate_access_url(args.port)}")
    print("=" * 120 + "\n")

    app.run(host="0.0.0.0", port=args.port, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
