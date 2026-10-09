"""Pulling an existing RTSP/RTSPS stream into a source slot (issue #127).

URL rules, the RTSP DESCRIBE probe and the in-memory pull registry. Nothing here touches
disk: a pull is session-only and its credentials live only in memory.
"""
import base64
import hashlib
import re
import secrets
import socket
import ssl
import threading
import urllib.parse
from dataclasses import dataclass
from typing import Optional

SUPPORTED_SCHEMES = ("rtsp", "rtsps")
DEFAULT_PORTS = {"rtsp": 554, "rtsps": 322}  # RFC 7826
INVALID_PORT_MESSAGE = "The port in the stream URL is invalid"
UNSUPPORTED_SCHEME_MESSAGE = "Only rtsp:// and rtsps:// stream URLs are supported"


@dataclass(frozen=True)
class PullTarget:
    url: str      # full URL, credentials embedded; never leaves the process
    scheme: str   # "rtsp" | "rtsps"
    host: str     # "host:port", port always present; safe to show and log
    path: str     # "/path?name=***", query values masked; safe to show


def _port(parsed) -> int:
    """The URL's port, or the scheme's default; raises ValueError for a malformed or out-of-range port."""
    return parsed.port or DEFAULT_PORTS[parsed.scheme.lower()]


def _host_with_port(parsed) -> str:
    port = _port(parsed)
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
    try:
        host = _host_with_port(parsed)
    except ValueError:
        raise ValueError(INVALID_PORT_MESSAGE) from None
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
        path += "?" + _masked_query(parsed.query)
    final = urllib.parse.urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))
    return PullTarget(url=final, scheme=scheme, host=host, path=path)


def _masked_query(query: str) -> str:
    """Keep the parameter names, mask every value: some cameras take a token in the query."""
    parts = []
    for part in query.split("&"):
        name, sep, _value = part.partition("=")
        parts.append(f"{name}=***" if sep else "***")
    return "&".join(parts)


PROBE_TIMEOUT_SECONDS = 2.0
AUTH_REJECTED_MESSAGE = "The camera rejected the username or password"
AUTH_REQUIRED_MESSAGE = "The camera requires a username and password"


@dataclass(frozen=True)
class ProbeResult:
    status: str               # "ok" | "unreachable" | "auth_failed"
    error: Optional[str] = None


def _read_response(sock) -> tuple[int, str, dict]:
    """Return (status, reason, headers); header names are lower-case and every value is kept in a list."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
        if len(data) > 65536:
            raise ConnectionError("closed")
    head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    lines = head.split("\r\n")
    parts = lines[0].split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("RTSP/"):
        raise ConnectionError("closed")
    headers: dict = {}
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if sep:
            headers.setdefault(name.strip().lower(), []).append(value.strip())
    return int(parts[1]), (parts[2] if len(parts) > 2 else ""), headers


_CHALLENGE_PARAM = re.compile(r'([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]*)')


def _parse_challenge(value: str) -> tuple[str, dict]:
    scheme, _, rest = value.strip().partition(" ")
    params = {}
    for key, val in _CHALLENGE_PARAM.findall(rest):
        if val.startswith('"'):
            val = val[1:-1]
        params[key.lower()] = val
    return scheme.lower(), params


def _qops(params: dict) -> list:
    return [q.strip().lower() for q in params.get("qop", "").split(",") if q.strip()]


def _digest_is_answerable(params: dict) -> bool:
    """MD5 Digest (the default algorithm), either without qop or offering qop=auth."""
    qops = _qops(params)
    return params.get("algorithm", "md5").lower() == "md5" and (not qops or "auth" in qops)


def _digest_authorization(params: dict, username: str, password: str, uri: str) -> str:
    realm, nonce = params.get("realm", ""), params.get("nonce", "")
    ha1 = hashlib.md5(f"{username}:{realm}:{password}".encode()).hexdigest()
    ha2 = hashlib.md5(f"DESCRIBE:{uri}".encode()).hexdigest()
    fields = [f'username="{username}"', f'realm="{realm}"', f'nonce="{nonce}"', f'uri="{uri}"']
    if "auth" in _qops(params):
        cnonce, nc = secrets.token_hex(8), "00000001"
        response = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
        fields += ['qop=auth', f"nc={nc}", f'cnonce="{cnonce}"']
    else:
        response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
    fields.append(f'response="{response}"')
    if "algorithm" in params:
        fields.append("algorithm=MD5")
    if params.get("opaque"):
        fields.append(f'opaque="{params["opaque"]}"')
    return "Digest " + ", ".join(fields)


def _authorization(challenges: list, username: str, password: str, uri: str) -> Optional[str]:
    """Answer the best challenge this probe can compute: MD5 Digest first, then Basic; None if none fits."""
    parsed = [_parse_challenge(value) for value in challenges]
    for scheme, params in parsed:
        if scheme == "digest" and _digest_is_answerable(params):
            return _digest_authorization(params, username, password, uri)
    for scheme, _params in parsed:
        if scheme == "basic":
            token = base64.b64encode(f"{username}:{password}".encode()).decode()
            return f"Basic {token}"
    return None


def _describe(sock, uri: str, cseq: int, authorization: Optional[str]) -> tuple[int, str, dict]:
    lines = [f"DESCRIBE {uri} RTSP/1.0", f"CSeq: {cseq}", "Accept: application/sdp", "User-Agent: neat-insight"]
    if authorization:
        lines.append(f"Authorization: {authorization}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    return _read_response(sock)


def probe_rtsp(url: str, timeout: float = PROBE_TIMEOUT_SECONDS) -> ProbeResult:
    """Classify a camera URL with one DESCRIBE round trip; never raises and never logs the URL."""
    parsed = urllib.parse.urlsplit(url)
    username = urllib.parse.unquote(parsed.username or "")
    password = urllib.parse.unquote(parsed.password or "")
    hostport = parsed.netloc.rpartition("@")[2]
    uri = urllib.parse.urlunsplit((parsed.scheme, hostport, parsed.path or "/", parsed.query, ""))
    try:
        port = _port(parsed)
    except ValueError:
        return ProbeResult("unreachable", INVALID_PORT_MESSAGE)
    try:
        sock = socket.create_connection((parsed.hostname, port), timeout=timeout)
    except socket.gaierror:
        return ProbeResult("unreachable", f"Could not resolve {parsed.hostname}")
    except ConnectionRefusedError:
        return ProbeResult("unreachable", "Connection refused")
    except socket.timeout:
        return ProbeResult("unreachable", f"Timed out after {timeout:g} s")
    except OSError as exc:
        return ProbeResult("unreachable", exc.strerror or str(exc))
    except ValueError:  # UnicodeError from an overlong or non-encodable host name
        return ProbeResult("unreachable", "Invalid host name in the stream URL")
    try:
        sock.settimeout(timeout)
        if parsed.scheme == "rtsps":
            try:
                # wrap_socket() detaches the raw fd from `sock` and returns a new socket
                # object holding it; rebind so the finally below closes whichever is live.
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
            except ssl.SSLCertVerificationError:
                return ProbeResult("unreachable", "Certificate is not trusted (TLS)")
            except (ssl.SSLError, OSError):
                return ProbeResult("unreachable", "TLS handshake failed")
        status, reason, headers = _describe(sock, uri, 1, None)
        if status == 401 and "www-authenticate" in headers:
            if not username:
                return ProbeResult("auth_failed", AUTH_REQUIRED_MESSAGE)
            authorization = _authorization(headers["www-authenticate"], username, password, uri)
            if authorization is None:
                # A challenge this probe cannot compute (SHA-256, auth-int, another scheme):
                # mediamtx may still answer it, so let the pull go ahead and mediamtx decide.
                return ProbeResult("ok")
            status, reason, headers = _describe(sock, uri, 2, authorization)
        if 200 <= status < 300:
            return ProbeResult("ok")
        if status in (401, 403):
            return ProbeResult("auth_failed", AUTH_REJECTED_MESSAGE)
        return ProbeResult("unreachable", f"Camera answered {status} {reason}".rstrip())
    except socket.timeout:
        return ProbeResult("unreachable", f"Timed out after {timeout:g} s")
    except (ConnectionError, OSError, ValueError):
        return ProbeResult("unreachable", "The camera closed the connection")
    finally:
        sock.close()


PROBE_INTERVAL_SECONDS = 10.0


def status_from_probe(result: ProbeResult) -> str:
    return "connecting" if result.status == "ok" else result.status


@dataclass
class PullRecord:
    index: int
    url: str            # full URL with credentials; never leaves the process
    scheme: str
    host: str
    path: str
    started_at: float
    status: str = "connecting"      # "connecting" | "unreachable" | "auth_failed"; "live" is derived from mediamtx
    error: Optional[str] = None
    probed_at: float = 0.0
    probing: bool = False


class PullRegistry:
    def __init__(self):
        self._lock = threading.Lock()
        self._records: dict[int, PullRecord] = {}

    def get(self, index: int) -> Optional[PullRecord]:
        with self._lock:
            return self._records.get(index)

    def put(self, record: PullRecord) -> None:
        with self._lock:
            self._records[record.index] = record

    def remove(self, index: int) -> Optional[PullRecord]:
        with self._lock:
            return self._records.pop(index, None)

    def all(self) -> list:
        with self._lock:
            return list(self._records.values())

    def indexes(self) -> list:
        with self._lock:
            return sorted(self._records)

    def due_for_probe(self, now: float, interval: float = PROBE_INTERVAL_SECONDS) -> list:
        due = []
        with self._lock:
            for record in self._records.values():
                if record.probing or record.status == "auth_failed" or now - record.probed_at < interval:
                    continue
                record.probing = True
                due.append(record)
        return due

    def apply_probe(self, record: PullRecord, result: ProbeResult, now: float) -> bool:
        with self._lock:
            if self._records.get(record.index) is not record:
                return False
            record.status = status_from_probe(result)
            record.error = result.error
            record.probed_at = now
            record.probing = False
            return True
