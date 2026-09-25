"""Pulling an existing RTSP/RTSPS stream into a source slot (issue #127).

URL rules, the RTSP DESCRIBE probe and the in-memory pull registry. Nothing here touches
disk: a pull is session-only and its credentials live only in memory.
"""
import base64
import hashlib
import secrets
import socket
import ssl
import urllib.parse
from dataclasses import dataclass
from typing import Optional

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


PROBE_TIMEOUT_SECONDS = 2.0
AUTH_REJECTED_MESSAGE = "The camera rejected the username or password"
AUTH_REQUIRED_MESSAGE = "The camera requires a username and password"


@dataclass(frozen=True)
class ProbeResult:
    status: str               # "ok" | "unreachable" | "auth_failed"
    error: Optional[str] = None


def _read_response(sock) -> tuple[int, str, dict]:
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
    headers = {}
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if sep:
            headers[name.strip().lower()] = value.strip()
    return int(parts[1]), (parts[2] if len(parts) > 2 else ""), headers


def _parse_challenge(value: str) -> tuple[str, dict]:
    scheme, _, rest = value.strip().partition(" ")
    params = {}
    for item in rest.split(","):
        key, sep, val = item.strip().partition("=")
        if sep:
            params[key.strip().lower()] = val.strip().strip('"')
    return scheme.lower(), params


def _authorization(scheme: str, params: dict, username: str, password: str, uri: str) -> Optional[str]:
    if scheme == "basic":
        token = base64.b64encode(f"{username}:{password}".encode()).decode()
        return f"Basic {token}"
    if scheme != "digest":
        return None
    realm, nonce = params.get("realm", ""), params.get("nonce", "")
    ha1 = hashlib.md5(f"{username}:{realm}:{password}".encode()).hexdigest()
    ha2 = hashlib.md5(f"DESCRIBE:{uri}".encode()).hexdigest()
    fields = [f'username="{username}"', f'realm="{realm}"', f'nonce="{nonce}"', f'uri="{uri}"']
    qop = params.get("qop", "")
    if "auth" in [q.strip() for q in qop.split(",")]:
        cnonce, nc = secrets.token_hex(8), "00000001"
        response = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
        fields += ['qop=auth', f"nc={nc}", f'cnonce="{cnonce}"']
    else:
        response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
    fields.append(f'response="{response}"')
    if params.get("opaque"):
        fields.append(f'opaque="{params["opaque"]}"')
    return "Digest " + ", ".join(fields)


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
        port = parsed.port or DEFAULT_PORT
    except ValueError:
        return ProbeResult("unreachable", "Invalid port in the stream URL")
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
    try:
        with sock:
            sock.settimeout(timeout)
            if parsed.scheme == "rtsps":
                try:
                    sock = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
                except ssl.SSLCertVerificationError:
                    return ProbeResult("unreachable", "Certificate is not trusted (TLS)")
                except (ssl.SSLError, OSError):
                    return ProbeResult("unreachable", "TLS handshake failed")
            status, reason, headers = _describe(sock, uri, 1, None)
            if status == 401 and "www-authenticate" in headers:
                if not username:
                    return ProbeResult("auth_failed", AUTH_REQUIRED_MESSAGE)
                scheme, params = _parse_challenge(headers["www-authenticate"])
                authorization = _authorization(scheme, params, username, password, uri)
                if authorization is None:
                    return ProbeResult("unreachable", f"Unsupported authentication scheme {scheme}")
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
