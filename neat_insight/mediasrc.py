import json
import logging
import os
import subprocess
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

RTSP_PUBLISH_BASE_URL = "rtsp://127.0.0.1:8554"
# Loopback-only control API (webrtc/mediamtx.yml apiAddress); never published.
MEDIAMTX_API_PORT = 9997
MEDIAMTX_API_BASE_URL = f"http://127.0.0.1:{MEDIAMTX_API_PORT}"
WEBCAM_WHIP_PORT = 8889
# Key that the SDK port map uses for the WHIP listener above. The SDK may
# republish 8889 on a different host port, so the browser-facing URL is
# resolved through this name (see app._resolve_webcam_whip_port) rather than
# assuming the container-internal port is reachable.
WEBCAM_WHIP_PORT_MAP_NAME = "webrtcWhip"
# ICE media port for the WHIP listener. Insight never builds a URL from it,
# but it must be published alongside 8889 or the browser completes
# signalling and then fails to connect.
WEBCAM_WHIP_ICE_PORT = 8189
WEBCAM_WHIP_ICE_PORT_MAP_NAME = "webrtcWhipIce"
MAX_GOP_FRAMES = "30"
KEYFRAME_INTERVAL_SECONDS = "1"
DEFAULT_TRANSPORT = "rtsp"
DEFAULT_CODEC = "h264"
SUPPORTED_TRANSPORTS = {"rtsp", "http"}
SUPPORTED_CODECS = {"h264", "h265", "mjpeg"}
SOURCE_TYPE_FILE = "file"
SOURCE_TYPE_WEBCAM = "webcam"
SUPPORTED_SOURCE_TYPES = {SOURCE_TYPE_FILE, SOURCE_TYPE_WEBCAM}


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


def webcam_path_name(index: int) -> str:
    return f"src{index}"


# A 404 from MediaMTX is an answer, not a failure: the path or session is not
# there. Collapsing it into "no answer" would make callers treat a definite
# "nothing is publishing" as "cannot tell".
_MEDIAMTX_NOT_FOUND = object()


class WebcamPublisherUnconfirmed(RuntimeError):
    """Nothing is known about a slot's publisher (base for the two ways that happens)."""


class MediaServerUnreachable(WebcamPublisherUnconfirmed):
    """MediaMTX's control API could not be reached, so nothing is known.

    Raised rather than returned deliberately. Insight has no handle on a browser
    publishing a webcam, so every question about one is answered by MediaMTX;
    when it cannot answer, the honest result is "unknown", and a caller that
    quietly reads that as "nothing is publishing" marks a live camera stopped or
    erases the record needed to stop it later. Both have happened here. An
    exception makes the unknown case impossible to ignore by accident: a caller
    that does not handle it aborts before changing anything, which is the safe
    default, and the API layer turns it into a 502.
    """


def _mediamtx_request(path: str, method: str = "GET"):
    """Call the MediaMTX control API.

    Returns the decoded body, or _MEDIAMTX_NOT_FOUND when MediaMTX answered 404.
    Raises MediaServerUnreachable for anything else.
    """
    request = urllib.request.Request(f"{MEDIAMTX_API_BASE_URL}{path}", method=method)
    try:
        with urllib.request.urlopen(request, timeout=1.0) as response:
            body = response.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return _MEDIAMTX_NOT_FOUND
        raise MediaServerUnreachable(f"MediaMTX answered {exc.code} for {path}") from exc
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise MediaServerUnreachable(f"MediaMTX did not answer {path}") from exc


def webcam_is_publishing(index: int) -> bool:
    """Whether a browser is currently WHIP-publishing to this slot.

    A webcam source has no Python-managed process to poll (unlike a file
    source's ffmpeg push), so liveness comes from MediaMTX's own path state
    rather than pipeline_registry.

    Raises MediaServerUnreachable when that cannot be established.
    """
    data = _mediamtx_request(f"/v3/paths/get/{webcam_path_name(index)}")
    if data is _MEDIAMTX_NOT_FOUND:
        return False
    return bool(data.get("ready"))


def webcam_ready_paths() -> set:
    """Names of every path MediaMTX currently reports ready, from one request.

    Source listing checks every playing webcam slot. Asking about each one
    separately costs one control-API timeout per slot when MediaMTX accepts
    connections but stops answering — up to 48 seconds for a routine listing,
    during the very outage the per-slot fallback exists to tolerate. Raises
    MediaServerUnreachable.
    """
    data = _mediamtx_request("/v3/paths/list?itemsPerPage=1000")
    if data is _MEDIAMTX_NOT_FOUND:
        return set()
    return {item.get("name") for item in (data.get("items") or []) if item.get("ready")}


def webcam_publisher_session(index: int) -> Optional[str]:
    """The id of the WebRTC session currently publishing to this slot, or None.

    This is the identity a stop has to be bound to. Two browsers can hold the
    same slot in quick succession — one reassigns it, the other's connection
    drops a few seconds later — and a stop that only names the slot would act
    on whichever session is there by then. Raises MediaServerUnreachable when
    MediaMTX cannot say.
    """
    data = _mediamtx_request(f"/v3/paths/get/{webcam_path_name(index)}")
    if data is _MEDIAMTX_NOT_FOUND:
        return None
    source = data.get("source") or {}
    if source.get("type") != "webRTCSession":
        return None
    return source.get("id") or None


def kick_webcam_publisher(index: int) -> bool:
    """Drop whatever browser is publishing to this slot; True if one was.

    Stopping a file source kills an ffmpeg process Insight owns. A webcam is
    published by a browser Insight has no handle on, so the only way to make
    /api/mediasrc/stop mean the same thing for both is to have MediaMTX close
    the session. Without this, a caller in another tab — or any API client —
    gets a success response while the camera keeps streaming.

    Returns False when there was nothing to kick, and raises
    MediaServerUnreachable when that could not be established.
    """
    # The session ending between the lookup and the kick is the common case,
    # not an edge one: the owning tab closes its peer connection and deletes the
    # WHIP resource before asking Insight to stop. But another browser can take
    # the path in that same gap, so a vanished target is not "idle" until a
    # fresh lookup says so — each 404 re-reads the path and kicks whoever is
    # there now. A path that keeps changing hands is reported as unconfirmed
    # rather than guessed at.
    for _ in range(3):
        session_id = webcam_publisher_session(index)
        if not session_id:
            return False
        kicked = _mediamtx_request(f"/v3/webrtcsessions/kick/{session_id}", method="POST")
        if kicked is not _MEDIAMTX_NOT_FOUND:
            return True
    raise WebcamPublisherUnconfirmed(f"src{index}: the publisher kept changing while being stopped")
