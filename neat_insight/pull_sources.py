"""Pulling an existing RTSP/RTSPS stream into a source slot (issue #127).

URL rules, the RTSP DESCRIBE probe and the in-memory pull registry. Nothing here touches
disk: a pull is session-only and its credentials live only in memory.
"""
import urllib.parse
from dataclasses import dataclass

SUPPORTED_SCHEMES = ("rtsp", "rtsps")
DEFAULT_PORT = 554
UNSUPPORTED_SCHEME_MESSAGE = "Only rtsp:// and rtsps:// stream URLs are supported"


@dataclass(frozen=True)
class PullTarget:
    url: str      # full URL, credentials embedded; never leaves the process
    scheme: str   # "rtsp" | "rtsps"
    host: str     # "host:port", port always present; safe to show and log
    path: str     # "/path?query"; safe to show


def _host_with_port(parsed) -> str:
    try:
        port = parsed.port or DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    hostname = parsed.hostname or ""
    if ":" in hostname:
        hostname = f"[{hostname}]"
    return f"{hostname}:{port}"


def normalize_pull_url(url: str, username: str = "", password: str = "") -> PullTarget:
    """Validate a pull URL and embed form credentials; raises ValueError with a user-facing message."""
    raw = (url or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in SUPPORTED_SCHEMES:
        raise ValueError(UNSUPPORTED_SCHEME_MESSAGE)
    if not parsed.hostname:
        raise ValueError("The stream URL needs a host, for example rtsp://192.168.1.10:554/stream1")
    username = (username or "").strip()
    password = password or ""
    if username:
        userinfo = urllib.parse.quote(username, safe="")
        if password:
            userinfo += ":" + urllib.parse.quote(password, safe="")
    else:
        userinfo = parsed.netloc.rpartition("@")[0]  # keep credentials typed into the URL as-is
    hostport = parsed.netloc.rpartition("@")[2]
    netloc = f"{userinfo}@{hostport}" if userinfo else hostport
    path = parsed.path or ""
    if parsed.query:
        path += "?" + parsed.query
    final = urllib.parse.urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))
    return PullTarget(url=final, scheme=scheme, host=_host_with_port(parsed), path=path)
