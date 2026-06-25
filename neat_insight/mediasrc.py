import logging
import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

RTSP_PUBLISH_BASE_URL = "rtsp://127.0.0.1:8554"
MAX_GOP_FRAMES = "30"
KEYFRAME_INTERVAL_SECONDS = "1"
DEFAULT_TRANSPORT = "rtsp"
DEFAULT_CODEC = "h264"
SUPPORTED_TRANSPORTS = {"rtsp", "http"}
SUPPORTED_CODECS = {"h264", "h265", "mjpeg"}


def normalize_transport(value: Optional[str]) -> str:
    transport = (value or DEFAULT_TRANSPORT).strip().lower()
    return transport if transport in SUPPORTED_TRANSPORTS else DEFAULT_TRANSPORT


def normalize_codec(value: Optional[str]) -> str:
    codec = (value or DEFAULT_CODEC).strip().lower()
    if codec in {"hevc", "h.265"}:
        codec = "h265"
    elif codec in {"jpeg", "m-jpeg", "motion-jpeg", "motion jpeg"}:
        codec = "mjpeg"
    return codec if codec in SUPPORTED_CODECS else DEFAULT_CODEC


def _codec_matches(source_codec: Optional[str], target_codec: str) -> bool:
    if not source_codec:
        return False
    return normalize_codec(source_codec) == normalize_codec(target_codec)


def _input_args(file_path: str) -> list[str]:
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts+igndts",
        "-re",
        "-stream_loop",
        "-1",
        "-i",
        file_path,
        "-map",
        "0:v:0",
        "-an",
    ]


def _mjpeg_encode_args(*, rtp_compatible: bool = False) -> list[str]:
    args = ["-c:v", "mjpeg", "-q:v", "5"]
    if rtp_compatible:
        args.extend(["-huffman", "default", "-force_duplicated_matrix", "1"])
    return args


def _codec_args(codec: str, source_codec: Optional[str]) -> list[str]:
    codec = normalize_codec(codec)
    if _codec_matches(source_codec, codec):
        return ["-c:v", "copy"]

    if codec == "h265":
        return [
            "-c:v",
            "libx265",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-x265-params",
            f"keyint={MAX_GOP_FRAMES}:min-keyint={MAX_GOP_FRAMES}:scenecut=0:repeat-headers=1",
        ]

    if codec == "mjpeg":
        return _mjpeg_encode_args()

    return [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-bf",
        "0",
        "-g",
        MAX_GOP_FRAMES,
        "-sc_threshold",
        "0",
        "-force_key_frames",
        f"expr:gte(t,n_forced*{KEYFRAME_INTERVAL_SECONDS})",
        "-x264-params",
        "repeat-headers=1:aud=1",
        "-pix_fmt",
        "yuv420p",
    ]


def rtsp_command(file_path: str, rtsp_url: str, codec: str, source_codec: Optional[str] = None) -> list[str]:
    codec = normalize_codec(codec)
    codec_args = _mjpeg_encode_args(rtp_compatible=True) if codec == "mjpeg" else _codec_args(codec, source_codec)
    return [
        *_input_args(file_path),
        *codec_args,
        "-f",
        "rtsp",
        "-rtsp_transport",
        "tcp",
        rtsp_url,
    ]


def http_mjpeg_command(file_path: str, source_codec: Optional[str] = None) -> list[str]:
    return [
        *_input_args(file_path),
        *_codec_args("mjpeg", source_codec),
        "-f",
        "mpjpeg",
        "-boundary_tag",
        "frame",
        "pipe:1",
    ]


def http_snapshot_command(file_path: str, source_codec: Optional[str] = None) -> list[str]:
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        file_path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        *_codec_args("mjpeg", source_codec),
        "-f",
        "image2pipe",
        "pipe:1",
    ]


@dataclass
class MediaStream:
    index: int
    file_path: str
    transport: str = DEFAULT_TRANSPORT
    codec: str = DEFAULT_CODEC
    source_codec: Optional[str] = None
    rtsp_url: str = ""
    process: Optional[subprocess.Popen] = None

    def start(self) -> Tuple[bool, Optional[str]]:
        if self.process and self.process.poll() is None:
            return False, "Already running"

        if not os.path.isfile(self.file_path):
            return False, f"File not found: {self.file_path}"

        self.transport = normalize_transport(self.transport)
        self.codec = normalize_codec(self.codec)
        if self.transport == "http":
            if self.codec != "mjpeg":
                return False, "HTTP streaming currently supports MJPEG only"
            return True, None

        cmd = rtsp_command(self.file_path, self.rtsp_url, self.codec, self.source_codec)

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                preexec_fn=os.setsid,
            )
            threading.Thread(target=self._drain_stderr, daemon=True).start()
            return True, None
        except FileNotFoundError:
            return False, "ffmpeg is not installed"
        except Exception as exc:
            return False, str(exc)

    def _drain_stderr(self) -> None:
        if not self.process or not self.process.stderr:
            return
        for line in self.process.stderr:
            logging.warning("media source %s ffmpeg: %s", self.index + 1, line.strip())

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


def start_media_stream(
    index: int,
    file_path: str,
    transport: str = DEFAULT_TRANSPORT,
    codec: str = DEFAULT_CODEC,
    source_codec: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
    if not file_path:
        return False, "No file assigned"

    slot = index - 1
    rtsp_url = f"{RTSP_PUBLISH_BASE_URL}/src{index}"
    transport = normalize_transport(transport)
    codec = normalize_codec(codec)

    with registry_lock:
        existing = pipeline_registry.get(slot)
        if existing and existing.process and existing.process.poll() is None:
            return False, "Already running"
        if existing and existing.transport == "http":
            return False, "Already running"

        stream = MediaStream(
            index=slot,
            file_path=file_path,
            transport=transport,
            codec=codec,
            source_codec=source_codec,
            rtsp_url=rtsp_url,
        )
        ok, err = stream.start()
        if not ok:
            return False, err

        pipeline_registry[slot] = stream
        logging.info("Started media source %s transport=%s codec=%s", index, transport, codec)
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


def media_stream_is_running(index: int) -> bool:
    slot = index - 1
    with registry_lock:
        stream = pipeline_registry.get(slot)
        if not stream:
            return False
        if stream.transport == "http":
            return True
        return bool(stream.process and stream.process.poll() is None)


def media_stream_identity(index: int) -> Optional[int]:
    slot = index - 1
    with registry_lock:
        stream = pipeline_registry.get(slot)
        return id(stream) if stream else None
