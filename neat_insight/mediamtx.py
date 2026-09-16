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
