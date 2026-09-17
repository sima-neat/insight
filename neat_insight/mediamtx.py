import base64
import http.client
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

API_PORT = 9997
API_BASE_URL = f"http://127.0.0.1:{API_PORT}/v3"
# mediamtx would otherwise let any loopback client drive the API without credentials, and
# its CORS policy extends that to any web page open on this host. The password is per run;
# set the env var to reach a mediamtx that was started separately with a known password.
API_USER = "insight"
API_PASSWORD_ENV = "NEAT_INSIGHT_MEDIAMTX_API_PASS"
# The password is written into mediamtx.yml as a plain scalar, so it stays in the character
# set of the generated default (secrets.token_urlsafe).
API_PASSWORD_PATTERN = re.compile(r"[A-Za-z0-9_-]+\Z")


def _configured_password() -> str:
    value = os.environ.get(API_PASSWORD_ENV)
    if not value:
        return secrets.token_urlsafe(24)
    if not API_PASSWORD_PATTERN.match(value):
        raise RuntimeError(
            f"{API_PASSWORD_ENV} may only contain letters, digits, '_' and '-'. "
            "Unset it to have Insight generate a password for this run."
        )
    return value


API_PASSWORD = _configured_password()
# Unusable hash shipped in mediamtx.yml; render_config swaps in the real password at launch.
API_PASSWORD_PLACEHOLDER = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
API_ENABLED_SETTING = "api: yes"
API_DISABLED_SETTING = "api: no"
RTSP_BASE_URL = "rtsp://127.0.0.1:8554"
# Per-process secret: only mediamtx's loopback API shows a publisher's query, so another
# publisher cannot learn the value and pass for Insight's own stream.
PUBLISHER_KEY = "publisher"
PUBLISHER_VALUE = f"insight-{secrets.token_hex(8)}"
PUBLISHER_TAG = f"{PUBLISHER_KEY}={PUBLISHER_VALUE}"
PROBE_READER_TAG = "reader=insight-probe"
PREVIEW_READER_TAG = "reader=insight-preview"
SUPPORTED_CODECS = {"h264", "h265", "mjpeg"}
REQUEST_TIMEOUT_SECONDS = 0.5
SNAPSHOT_TTL_SECONDS = 1.0
UNAVAILABLE_BACKOFF_SECONDS = 10.0
INITIAL_BACKOFF_SECONDS = 1.0
STALE_GRACE_SECONDS = 5.0
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
        return urllib.parse.parse_qs(self.query).get(PUBLISHER_KEY) == [PUBLISHER_VALUE]

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


def render_config(text: str, password: str, api_enabled: bool = True) -> str:
    if API_PASSWORD_PLACEHOLDER not in text:
        raise MediamtxError("mediamtx config has no API password placeholder")
    rendered = text.replace(API_PASSWORD_PLACEHOLDER, password)
    if api_enabled:
        return rendered
    if API_ENABLED_SETTING not in rendered:
        raise MediamtxError("mediamtx config does not enable the API")
    return rendered.replace(API_ENABLED_SETTING, API_DISABLED_SETTING, 1)


def _default_request(method: str, url: str):
    credentials = base64.b64encode(f"{API_USER}:{API_PASSWORD}".encode()).decode()
    req = urllib.request.Request(url, method=method, headers={"Authorization": f"Basic {credentials}"})
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
        self._ever_succeeded = False
        self._failing_since: Optional[float] = None
        self._generation = 0  # bumped by kick(); a fetch spanning a bump is pre-kick data
        self._probes: dict = {}   # session id -> dict | None | pending-token (object())
        self._bytes: dict = {}    # session id -> (bytes_received, monotonic seconds)
        self._bitrate: dict = {}  # session id -> bits per second

    def _get_items(self, endpoint: str, missing_ok: bool = False) -> list:
        status, body = self._request("GET", f"{self._base_url}/{endpoint}?itemsPerPage={PAGE_SIZE}")
        if status == 404 and missing_ok:
            # mediamtx serves a session list only for enabled protocols; 404 means disabled.
            return []
        if status != 200:
            raise MediamtxError(f"{endpoint} returned {status}")
        return json.loads(body)["items"]

    def snapshot(self) -> Optional[dict]:
        # The lock protects cache state only; the HTTP calls run unlocked so a slow/hung
        # API doesn't block other callers.
        now = self._clock()
        with self._lock:
            fresh = self._snapshot_at is not None and now - self._snapshot_at < SNAPSHOT_TTL_SECONDS
            if fresh or now < self._unavailable_until:
                return self._snapshot
        # A fetch that overlaps a kick may hold pre-kick data: fetch once more instead.
        for _ in range(2):
            with self._lock:
                generation = self._generation
            try:
                paths = self._get_items("paths/list")
                sessions = {endpoint: self._get_items(f"{endpoint}/list", missing_ok=True) for endpoint, _ in SESSION_KINDS.values()}
                built = build_snapshot(paths, sessions)
            except Exception as exc:  # any unusable answer means "API unavailable", never a 500
                return self._fetch_failed(now, exc)
            with self._lock:
                if generation != self._generation:
                    continue
                self._warned = False
                self._ever_succeeded = True
                self._failing_since = None
                self._unavailable_until = 0.0
                # Concurrent fetches can finish out of order; never replace newer data.
                if self._snapshot_at is None or now >= self._snapshot_at:
                    self._snapshot, self._snapshot_at = built, now
                    self._update_rates(now)
                return self._snapshot
        return built

    def _fetch_failed(self, now: float, exc: Exception) -> Optional[dict]:
        warn = False
        with self._lock:
            if self._failing_since is None:
                self._failing_since = now
            # One slow call must not switch detection off: keep the last good snapshot and
            # retry soon, until the API has been failing for the whole grace period.
            within_grace = self._snapshot is not None and now - self._failing_since < STALE_GRACE_SECONDS
            if within_grace:
                self._unavailable_until = now + INITIAL_BACKOFF_SECONDS
            else:
                self._snapshot, self._snapshot_at = None, None
                # Retry quickly until the API has answered once: at startup mediamtx may
                # still be coming up, and a 10 s wait would blank several polls.
                backoff = UNAVAILABLE_BACKOFF_SECONDS if self._ever_succeeded else INITIAL_BACKOFF_SECONDS
                self._unavailable_until = now + backoff
                if not self._warned:
                    self._warned = True
                    warn = True
            result = self._snapshot
        if warn:
            logging.warning("mediamtx API unavailable (%s); external stream detection is off", exc)
        return result

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
        self._invalidate()
        try:
            status, _ = self._request("POST", f"{self._base_url}/{kind[0]}/kick/{session_id}")
        except (OSError, http.client.HTTPException) as exc:
            raise MediamtxError(str(exc)) from exc
        finally:
            self._invalidate()
        if status == 404:
            raise MediamtxNotFound(session_id)
        if status != 200:
            raise MediamtxError(f"kick returned {status}")

    def _invalidate(self) -> None:
        with self._lock:
            self._snapshot_at = None
            self._generation += 1
