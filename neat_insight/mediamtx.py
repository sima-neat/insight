import json
import logging
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

API_BASE_URL = "http://127.0.0.1:9997/v3"
RTSP_BASE_URL = "rtsp://127.0.0.1:8554"
PUBLISHER_TAG = "publisher=insight"
PROBE_READER_TAG = "reader=insight-probe"
PREVIEW_READER_TAG = "reader=insight-preview"
SUPPORTED_CODECS = {"h264", "h265", "mjpeg"}
REQUEST_TIMEOUT_SECONDS = 0.5
SNAPSHOT_TTL_SECONDS = 1.0
UNAVAILABLE_BACKOFF_SECONDS = 10.0
PROBE_TIMEOUT_SECONDS = 5
PAGE_SIZE = 1000

# path source.type -> (session list/kick endpoint, protocol label)
SESSION_KINDS = {
    "rtspSession": ("rtspsessions", "rtsp"),
    "rtspsSession": ("rtspssessions", "rtsps"),
    "webRTCSession": ("webrtcsessions", "webrtc"),
    "srtConn": ("srtconns", "srt"),
    "rtmpConn": ("rtmpconns", "rtmp"),
    "rtmpsConn": ("rtmpsconns", "rtmps"),
}
VIDEO_TRACK_CODECS = {
    "H264": "h264",
    "H265": "h265",
    "M-JPEG": "mjpeg",
    "VP8": "vp8",
    "VP9": "vp9",
    "AV1": "av1",
    "MPEG-4 Video": "mpeg4",
    "MPEG-1/2 Video": "mpeg2",
}


class MediamtxError(Exception):
    pass


class MediamtxNotFound(MediamtxError):
    pass


@dataclass
class PathInfo:
    name: str
    ready: bool = False
    since: Optional[str] = None
    source_type: Optional[str] = None
    source_id: Optional[str] = None
    protocol: Optional[str] = None
    address: Optional[str] = None
    query: str = ""
    codec: str = "none"
    bytes_received: int = 0
    readers: list = field(default_factory=list)

    @property
    def owned_by_insight(self) -> bool:
        return PUBLISHER_TAG in self.query

    @property
    def external(self) -> bool:
        return self.ready and self.source_id is not None and not self.owned_by_insight


def track_codec(tracks) -> str:
    for track in tracks or []:
        codec = VIDEO_TRACK_CODECS.get(track)
        if codec:
            return codec
    return "none"


def _strip_port(remote_addr: Optional[str]) -> Optional[str]:
    if not remote_addr:
        return None
    host, sep, port = remote_addr.rpartition(":")
    return host.strip("[]") if sep and port.isdigit() else remote_addr


def _reader_entry(session: Optional[dict], protocol: str) -> Optional[dict]:
    if session is None:
        return None
    query = session.get("query") or ""
    if PROBE_READER_TAG in query:
        return None
    entry = {"protocol": protocol, "address": _strip_port(session.get("remoteAddr"))}
    if PREVIEW_READER_TAG in query:
        entry["label"] = "insight preview"
    return entry


def build_snapshot(paths_items, sessions_by_endpoint) -> dict:
    sessions = {}
    for source_type, (endpoint, protocol) in SESSION_KINDS.items():
        for item in sessions_by_endpoint.get(endpoint) or []:
            sessions[(source_type, item.get("id"))] = (item, protocol)

    snapshot = {}
    for item in paths_items:
        source = item.get("source") or {}
        source_type, source_id = source.get("type"), source.get("id")
        session, protocol = sessions.get((source_type, source_id), (None, None))
        readers = []
        for reader in item.get("readers") or []:
            reader_session, reader_protocol = sessions.get((reader.get("type"), reader.get("id")), (None, None))
            entry = _reader_entry(reader_session, reader_protocol or reader.get("type"))
            if entry:
                readers.append(entry)
        snapshot[item["name"]] = PathInfo(
            name=item["name"],
            ready=bool(item.get("ready")),
            since=item.get("readyTime"),
            source_type=source_type,
            source_id=source_id,
            protocol=protocol or source_type,
            address=_strip_port(session.get("remoteAddr")) if session else None,
            query=(session or {}).get("query") or "",
            codec=track_codec(item.get("tracks")),
            bytes_received=int(item.get("bytesReceived") or 0),
            readers=readers,
        )
    return snapshot


def _parse_fps(value) -> Optional[float]:
    try:
        num, den = str(value).split("/")
        fps = int(num) / int(den)
    except (AttributeError, ValueError, ZeroDivisionError):
        return None
    if fps <= 0:
        return None
    return int(fps) if fps == int(fps) else round(fps, 2)


def _default_request(method: str, url: str):
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _default_probe(rtsp_url: str) -> Optional[dict]:
    cmd = [
        "ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", rtsp_url,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=PROBE_TIMEOUT_SECONDS, check=False)
        stream = json.loads(result.stdout)["streams"][0]
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError, KeyError, IndexError):
        return None
    return {"width": stream.get("width"), "height": stream.get("height"), "fps": _parse_fps(stream.get("avg_frame_rate"))}


class MediamtxClient:
    def __init__(self, base_url: str = API_BASE_URL, request: Optional[Callable] = None,
                 probe: Optional[Callable] = None, clock: Callable[[], float] = time.monotonic,
                 probe_async: bool = True):
        self._base_url = base_url.rstrip("/")
        self._request = request or _default_request
        self._probe = probe or _default_probe
        self._clock = clock
        self._probe_async = probe_async
        self._lock = threading.Lock()
        self._snapshot: Optional[dict] = None
        self._snapshot_at: Optional[float] = None
        self._unavailable_until = 0.0
        self._warned = False
        self._probes: dict = {}   # session id -> dict | None | pending-token (object())
        self._bytes: dict = {}    # session id -> (bytes_received, monotonic seconds)
        self._bitrate: dict = {}  # session id -> bits per second

    def _get_items(self, endpoint: str) -> list:
        status, body = self._request("GET", f"{self._base_url}/{endpoint}?itemsPerPage={PAGE_SIZE}")
        if status != 200:
            raise MediamtxError(f"{endpoint} returned {status}")
        return json.loads(body)["items"]

    def snapshot(self) -> Optional[dict]:
        # The lock protects cache state (_snapshot*/_unavailable_until/_warned) only;
        # the HTTP calls below run unlocked so a slow/hung API doesn't block other callers.
        now = self._clock()
        with self._lock:
            if self._snapshot_at is not None and now - self._snapshot_at < SNAPSHOT_TTL_SECONDS:
                return self._snapshot
            if now < self._unavailable_until:
                return None
        try:
            paths = self._get_items("paths/list")
            sessions = {endpoint: self._get_items(f"{endpoint}/list") for endpoint, _ in SESSION_KINDS.values()}
        except (MediamtxError, OSError, ValueError, KeyError) as exc:
            warn = False
            with self._lock:
                self._snapshot, self._snapshot_at = None, None
                self._unavailable_until = now + UNAVAILABLE_BACKOFF_SECONDS
                if not self._warned:
                    self._warned = True
                    warn = True
            if warn:
                logging.warning("mediamtx API unavailable (%s); external stream detection is off", exc)
            return None
        with self._lock:
            self._warned = False
            self._snapshot, self._snapshot_at = build_snapshot(paths, sessions), now
            self._update_rates(now)
            return self._snapshot

    def _update_rates(self, now: float) -> None:
        live = {}
        for path in self._snapshot.values():
            if path.source_id:
                live[path.source_id] = path.bytes_received
        for session_id, received in live.items():
            previous = self._bytes.get(session_id)
            if previous and now > previous[1]:
                self._bitrate[session_id] = (received - previous[0]) * 8 / (now - previous[1])
            self._bytes[session_id] = (received, now)
        for cache in (self._bytes, self._bitrate, self._probes):
            for session_id in list(cache):
                if session_id not in live:
                    del cache[session_id]

    def external_info(self, path: PathInfo) -> dict:
        session_id = path.source_id
        token = None
        with self._lock:
            if session_id not in self._probes:
                token = object()  # per-attempt token: only this attempt may write its result back
                self._probes[session_id] = token
            bitrate = self._bitrate.get(session_id)
        if token is not None:
            if self._probe_async:
                threading.Thread(target=self._run_probe, args=(session_id, path.name, token), daemon=True).start()
            else:
                self._run_probe(session_id, path.name, token)
        with self._lock:
            probe = self._probes.get(session_id)
        dims = probe if isinstance(probe, dict) else {}
        return {
            "protocol": path.protocol,
            "address": path.address,
            "since": path.since,
            "codec_supported": path.codec in SUPPORTED_CODECS,
            "width": dims.get("width"),
            "height": dims.get("height"),
            "fps": dims.get("fps"),
            "bitrate_bps": None if bitrate is None else int(bitrate),
        }

    def _run_probe(self, session_id: str, path_name: str, token: object) -> None:
        result = self._probe(f"{RTSP_BASE_URL}/{path_name}?{PROBE_READER_TAG}")
        with self._lock:
            # Only write back if this attempt's token is still the current one for the
            # session: if the session was evicted and reissued while probing, or a newer
            # probe attempt started, a stale in-flight result must not overwrite it.
            if self._probes.get(session_id) is token:
                self._probes[session_id] = result

    def kick(self, source_type: str, session_id: str) -> None:
        kind = SESSION_KINDS.get(source_type)
        if not kind:
            raise MediamtxError(f"unsupported publisher type {source_type}")
        with self._lock:
            self._snapshot_at = None
        try:
            status, _ = self._request("POST", f"{self._base_url}/{kind[0]}/kick/{session_id}")
        except OSError as exc:
            raise MediamtxError(str(exc)) from exc
        if status == 404:
            raise MediamtxNotFound(session_id)
        if status != 200:
            raise MediamtxError(f"kick returned {status}")
