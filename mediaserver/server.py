"""Serve prerecorded RTSP and MJPEG sources from a mounted media directory."""

import html
import json
import logging
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

LOG = logging.getLogger("mediaserver")
EXTENSIONS = {".mp4", ".m4v", ".mov", ".avi", ".mkv"}
RTSP_CODECS = {"h264", "hevc", "mjpeg"}
RTSP_PORT = 8554
HTTP_PORT = 8088
MAX_FRAME_BYTES = 16 * 1024 * 1024
FRAME_TIMEOUT = 10


def probe(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,profile,width,height,avg_frame_rate,r_frame_rate,pix_fmt", "-of", "json", str(path)],
        capture_output=True, check=True, timeout=10,
    )
    return json.loads(result.stdout)["streams"][0]


def load_sources(root):
    manifest = root / "mediaserver.json"
    sources = {"rtsp": {}, "http": {}}
    probed = {}
    if manifest.exists():
        if not manifest.resolve().is_relative_to(root):
            raise ValueError("mediaserver.json must be inside the media volume")
        spec = json.loads(manifest.read_text())
        if spec.get("schema_version") != 1:
            raise ValueError("mediaserver.json requires schema_version 1")
        entries = spec["sources"]
    else:
        entries = []
        counts = {"rtsp": 0, "http": 0}
        for path in sorted(root.iterdir()):
            if path.suffix.lower() not in EXTENSIONS or not path.is_file():
                continue
            if not path.resolve().is_relative_to(root):
                LOG.warning("Ignoring media symlink outside the volume: %s", path.name)
                continue
            try:
                info = probe(path)
                codec = info["codec_name"]
                probed[path.resolve()] = info
            except (subprocess.SubprocessError, ValueError, KeyError, IndexError):
                LOG.warning("Could not probe %s", path.name)
                continue
            if codec in RTSP_CODECS:
                entries.append({"protocol": "rtsp", "id": f"src{counts['rtsp']}", "file": path.name})
                counts["rtsp"] += 1
            if path.suffix.lower() == ".avi" and codec == "mjpeg":
                entries.append({"protocol": "http", "id": f"src{counts['http']}", "file": path.name})
                counts["http"] += 1

    for entry in entries:
        protocol, source_id = entry["protocol"], entry["id"]
        if protocol not in sources or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", source_id):
            raise ValueError("Invalid source protocol or ID")
        if source_id in sources[protocol]:
            raise ValueError(f"Duplicate {protocol} source ID: {source_id}")
        path = (root / entry["file"]).resolve()
        if Path(entry["file"]).is_absolute() or not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"{protocol}/{source_id} must reference a file in the media volume")
        info = probed.get(path) or probe(path)
        allowed = RTSP_CODECS if protocol == "rtsp" else {"mjpeg"}
        if info["codec_name"] not in allowed:
            raise ValueError(f"Unsupported video codec for {protocol}/{source_id}")
        sources[protocol][source_id] = (path, info)
    return sources


def media_catalog(sources):
    ports = {"rtsp": RTSP_PORT, "http": HTTP_PORT}
    entries = []
    for transport, streams in sources.items():
        for source_id, (_, info) in streams.items():
            codec = info["codec_name"]
            entry = {
                "id": source_id,
                "transport": transport,
                "port": ports[transport],
                "codec": "h265" if codec == "hevc" else codec,
                "path": f"/{source_id}.mjpeg" if transport == "http" else f"/{source_id}",
            }
            for dimension in ("width", "height"):
                if info.get(dimension, 0) > 0:
                    entry[dimension] = info[dimension]
            for rate in (info.get("avg_frame_rate"), info.get("r_frame_rate")):
                if not rate:
                    continue
                try:
                    fps = Fraction(rate)
                except (ValueError, ZeroDivisionError):
                    continue
                if fps > 0:
                    entry["fps"] = float(fps)
                    break
            entries.append(entry)
    return {"schema_version": 1, "sources": entries}


def ffmpeg_input(path):
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-re",
        "-fflags", "+genpts+igndts", "-stream_loop", "-1", "-i", str(path),
        "-map", "0:v:0", "-an", "-c:v", "copy",
    ]


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class MJPEGSource:
    def __init__(self, path, shutdown):
        self.path = path
        self.shutdown = shutdown
        self.changed = threading.Condition()
        self.frame = None
        self.frame_number = 0
        self.last_frame_at = 0
        self.process = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def start(self):
        self.thread.start()

    def read_frames(self, output):
        while output.readline(1024).strip() == b"--frame":
            length = 0
            while line := output.readline(1024).strip():
                if line.lower().startswith(b"content-length:"):
                    length = int(line.split(b":", 1)[1])
            if not 0 < length <= MAX_FRAME_BYTES:
                return
            frame = output.read(length)
            if len(frame) != length or output.read(2) != b"\r\n":
                return
            with self.changed:
                self.frame = frame
                self.frame_number += 1
                self.last_frame_at = time.monotonic()
                self.changed.notify_all()

    def run(self):
        while not self.shutdown.is_set():
            with subprocess.Popen(
                [*ffmpeg_input(self.path), "-f", "mpjpeg", "-boundary_tag", "frame", "pipe:1"],
                stdout=subprocess.PIPE,
            ) as process:
                self.process = process
                try:
                    self.read_frames(process.stdout)
                except (OSError, ValueError):
                    LOG.warning("Could not read MJPEG frames from %s", self.path.name)
                finally:
                    stop_process(process)
            with self.changed:
                self.frame = None
            if not self.shutdown.wait(2):
                LOG.warning("Restarting MJPEG producer for %s", self.path.name)

    def ready(self):
        with self.changed:
            return self.frame is not None and time.monotonic() - self.last_frame_at < FRAME_TIMEOUT

    def next_frame(self, previous):
        with self.changed:
            self.changed.wait_for(
                lambda: self.frame_number != previous or self.shutdown.is_set(), FRAME_TIMEOUT,
            )
            if self.frame_number != previous and not self.shutdown.is_set():
                return self.frame_number, self.frame
            return previous, None


class MediaHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64

    def __init__(self, sources, shutdown, viewer_limit):
        self.sources = sources["http"]
        self.catalog = media_catalog(sources)
        self.players = {key: MJPEGSource(path, shutdown) for key, (path, _) in self.sources.items()}
        if viewer_limit < 1:
            raise ValueError("MEDIASERVER_HTTP_MAX_READERS must be positive")
        self.slots = threading.BoundedSemaphore(viewer_limit)
        self.connections = threading.BoundedSemaphore(viewer_limit + 8)
        self.lock = threading.Lock()
        self.viewers = 0
        self.bytes_sent = 0
        self.status = {"state": "starting"}
        super().__init__(("0.0.0.0", HTTP_PORT), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(FRAME_TIMEOUT)
        return connection, address


    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def send_json(self, value, status=200):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            status = self.server.status
            self.send_json(status, 200 if status["state"] == "ready" else 503)
        elif path == "/media-sources.json":
            self.send_json(self.server.catalog)
        elif path == "/streams.json":
            self.send_json([{
                **info,
                "id": key,
                "index": int(key[3:]) if re.fullmatch(r"src[0-9]+", key) else None,
                "name": file.name,
                "codec": info["codec_name"],
                "fps": info.get("avg_frame_rate") or info.get("r_frame_rate", ""),
                "url": f"/{key}.mjpeg",
            } for key, (file, info) in self.server.sources.items()])
        elif path in {"/", "/index.html"}:
            links = "".join(
                f'<li><a href="/{key}.mjpeg">{html.escape(file.name)}</a></li>'
                for key, (file, _) in self.server.sources.items()
            )
            body = f"<!doctype html><meta charset=utf-8><title>Media sources</title><ul>{links}</ul>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            match = re.fullmatch(r"/([A-Za-z0-9_-]+)\.mjpeg", path)
            player = self.server.players.get(match[1]) if match else None
            if player:
                self.stream(player)
            else:
                self.send_error(404)

    def stream(self, source):
        if not source.ready() or not self.server.slots.acquire(blocking=False):
            self.send_error(503)
            return
        with self.server.lock:
            self.server.viewers += 1
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            frame_number = -1
            while True:
                frame_number, frame = source.next_frame(frame_number)
                if frame is None:
                    break
                self.wfile.write(
                    f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode()
                )
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                with self.server.lock:
                    self.server.bytes_sent += len(frame)
        except OSError:
            pass
        finally:
            with self.server.lock:
                self.server.viewers -= 1
            self.server.slots.release()


def rtsp_status():
    items = []
    try:
        page = 0
        while True:
            with urlopen(f"http://127.0.0.1:9997/v3/paths/list?page={page}&itemsPerPage=100", timeout=1) as response:
                data = json.load(response)
            items.extend(data["items"])
            page += 1
            if page >= data["pageCount"]:
                return items
    except (OSError, ValueError, KeyError):
        return None


def start_reporter(profile_path):
    from paho.mqtt import client as mqtt

    profile_path = Path(profile_path)
    profile = json.loads(profile_path.read_text())
    service_id = profile["service_id"]
    environment = profile["environment"]
    for label in (service_id, environment):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", label):
            raise ValueError("Invalid IoT service ID or environment")
    client = mqtt.Client(client_id=service_id)
    client.tls_set(**{
        key: str(profile_path.parent / profile[key])
        for key in ("ca_certs", "certfile", "keyfile")
    })
    client.max_queued_messages_set(1)
    client.connect_async(profile["endpoint"], int(profile.get("port", 8883)), keepalive=60)
    client.loop_start()
    return client, f"insight/{environment}/mediaservers/{service_id}/status", service_id


def collect_status(server, rtsp_sources, started):
    paths = rtsp_status()
    ready_rtsp = sum(bool(path["ready"]) for path in paths or ())
    ready_http = sum(player.ready() for player in server.players.values())
    with server.lock:
        active_http, http_bytes = server.viewers, server.bytes_sent
    return {
        "schema_version": 1,
        "state": "ready" if (
            paths is not None and ready_rtsp == len(rtsp_sources) and ready_http == len(server.players)
        ) else "degraded",
        "version": os.environ.get("MEDIASERVER_VERSION", "dev"),
        "reported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "uptime_seconds": int(time.monotonic() - started),
        "rtsp": {
            "configured_sources": len(rtsp_sources),
            "ready_sources": ready_rtsp if paths is not None else None,
            "active_readers": sum(len(path.get("readers") or ()) for path in paths) if paths is not None else None,
            "bytes_sent": sum(path.get("bytesSent", 0) for path in paths) if paths is not None else None,
        },
        "http": {
            "configured_sources": len(server.players),
            "ready_sources": ready_http,
            "active_readers": active_http,
            "bytes_sent": http_bytes,
        },
    }


def main():
    logging.basicConfig(level=logging.INFO)
    root = Path(os.environ.get("MEDIASERVER_MEDIA_DIR", "/media")).resolve()
    sources = load_sources(root)
    if not any(sources.values()):
        raise ValueError("No supported sources found in the media volume")
    shutdown = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: shutdown.set())

    reporter = None
    profile = os.environ.get("MEDIASERVER_IOT_PROFILE")
    if profile:
        try:
            reporter = start_reporter(profile)
        except (OSError, ValueError, KeyError):
            LOG.exception("Could not initialize the IoT status reporter")

    started = time.monotonic()
    next_report = started
    publishers = {}
    server = MediaHTTPServer(sources, shutdown, int(os.environ.get("MEDIASERVER_HTTP_MAX_READERS", "64")))
    with tempfile.TemporaryDirectory() as tmpdir:
        config = Path(tmpdir) / "mediamtx.yml"
        template = Path(__file__).with_name("mediamtx.yml").read_text()
        paths = json.dumps(dict.fromkeys(sources["rtsp"], {}))
        config.write_text(f"{template}\npaths: {paths}\n")
        mtx = subprocess.Popen(["mediamtx", str(config)])
        try:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            for player in server.players.values():
                player.start()
            while not shutdown.is_set():
                if mtx.poll() is not None:
                    raise RuntimeError(f"MediaMTX exited with status {mtx.returncode}")
                for key, (path, _) in sources["rtsp"].items():
                    process = publishers.get(key)
                    if process is None or process.poll() is not None:
                        publishers[key] = subprocess.Popen([
                            *ffmpeg_input(path), "-rtsp_transport", "tcp", "-f", "rtsp",
                            f"rtsp://127.0.0.1:{RTSP_PORT}/{key}",
                        ])
                server.status = collect_status(server, sources["rtsp"], started)
                if reporter and time.monotonic() >= next_report:
                    client, topic, service_id = reporter
                    if client.is_connected():
                        client.publish(topic, json.dumps({**server.status, "service_id": service_id}), qos=1)
                    next_report = time.monotonic() + 30
                shutdown.wait(2)
        finally:
            shutdown.set()
            server.shutdown()
            server.server_close()
            for player in server.players.values():
                if player.process is not None:
                    stop_process(player.process)
                player.thread.join(timeout=3)
            for process in [*publishers.values(), mtx]:
                stop_process(process)
            if reporter:
                reporter[0].disconnect()
                reporter[0].loop_stop()


if __name__ == "__main__":
    main()
