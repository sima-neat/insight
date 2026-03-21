import logging
import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

BASE_PORT = 7001


@dataclass
class MediaStream:
    index: int
    file_path: str
    port: int
    process: Optional[subprocess.Popen] = None

    def start(self) -> Tuple[bool, Optional[str]]:
        if self.process and self.process.poll() is None:
            return False, "Already running"

        if not os.path.isfile(self.file_path):
            return False, f"File not found: {self.file_path}"

        cmd = [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-stream_loop",
            "-1",
            "-i",
            self.file_path,
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "mpegts",
            f"udp://127.0.0.1:{self.port}?pkt_size=1316",
        ]

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                preexec_fn=os.setsid,
            )
            return True, None
        except FileNotFoundError:
            return False, "ffmpeg is not installed"
        except Exception as exc:
            return False, str(exc)

    def stop(self) -> None:
        if not self.process:
            return
        if self.process.poll() is not None:
            self.process = None
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except Exception:
            self.process.kill()
        finally:
            self.process = None


pipeline_registry: Dict[int, MediaStream] = {}
registry_lock = threading.Lock()


def start_media_stream(index: int, file_path: str) -> Tuple[bool, Optional[str]]:
    if not file_path:
        return False, "No file assigned"

    slot = index - 1
    port = BASE_PORT + slot

    with registry_lock:
        existing = pipeline_registry.get(slot)
        if existing and existing.process and existing.process.poll() is None:
            return False, "Already running"

        stream = MediaStream(index=slot, file_path=file_path, port=port)
        ok, err = stream.start()
        if not ok:
            return False, err

        pipeline_registry[slot] = stream
        logging.info("Started media source %s on udp port %s", index, port)
        return True, None


def stop_media_stream(index: int) -> None:
    slot = index - 1
    with registry_lock:
        stream = pipeline_registry.get(slot)
        if not stream:
            return
        stream.stop()
        pipeline_registry.pop(slot, None)
        logging.info("Stopped media source %s", index)
