"""Bounded stdlib client for the board-local SiMa Sentinel API socket."""
import calendar
import errno
import json
import re
import socket
import sys
import time
from http.client import HTTPConnection, HTTPException, IncompleteRead

SOCKET_PATH = "/run/simaai-sentinel/api.sock"
TIMEOUT_SEC = 10.0
REFRESH_TIMEOUT_SEC = 45.0
REFRESH_POLL_SEC = 0.2
MAX_BODY_BYTES = 4 * 1024 * 1024

MISSING = "missing"
REFUSED = "refused"
DENIED = "denied"
TIMED_OUT = "timed_out"
FAILED = "failed"
TOO_LARGE = "too_large"
PROTOCOL = "protocol"
REFRESH_TIMED_OUT = "refresh_timed_out"
# RFC 3339 in UTC, as Sentinel serializes `observed_at`, with up to nanosecond precision.
_OBSERVED_AT = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z")


class ResponseTooLarge(Exception):
    def __init__(self, limit):
        super().__init__("The Sentinel response is larger than {} bytes.".format(limit))


class RefreshTimedOut(Exception):
    pass


class _DeadlineSocket(socket.socket):
    """Unix socket whose every blocking operation shares one wall-clock deadline.

    A plain socket timeout bounds each call, so a peer that trickles bytes could
    hold a request open indefinitely; re-arming with the remaining time bounds
    connect, send, headers and body together.
    """

    deadline = 0.0

    def _arm(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout("timed out")
        self.settimeout(remaining)

    def connect(self, address):
        self._arm()
        return super().connect(address)

    def sendall(self, *args, **kwargs):
        self._arm()
        return super().sendall(*args, **kwargs)

    def send(self, *args, **kwargs):
        self._arm()
        return super().send(*args, **kwargs)

    def recv(self, *args, **kwargs):
        self._arm()
        return super().recv(*args, **kwargs)

    def recv_into(self, *args, **kwargs):
        self._arm()
        return super().recv_into(*args, **kwargs)


class _UnixHTTPConnection(HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.path = path
        self.deadline = time.monotonic() + timeout

    def connect(self):
        sock = _DeadlineSocket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.deadline = self.deadline
        try:
            sock.connect(self.path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def socket_failure(exc):
    code = getattr(exc, "errno", None)
    if isinstance(exc, socket.timeout) or code == errno.ETIMEDOUT:
        return TIMED_OUT
    if code in (errno.ENOENT, errno.ENOTDIR):
        return MISSING
    if code in (errno.ECONNREFUSED, errno.ECONNRESET, errno.EPIPE):
        return REFUSED
    if code in (errno.EACCES, errno.EPERM):
        return DENIED
    return FAILED


def request(method, path, body=None, socket_path=SOCKET_PATH, timeout=TIMEOUT_SEC):
    connection = _UnixHTTPConnection(socket_path, timeout)
    try:
        headers = {"Host": "localhost", "Accept": "application/json"}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(payload))
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        declared = response.getheader("Content-Length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise ResponseTooLarge(MAX_BODY_BYTES)
        data = response.read(MAX_BODY_BYTES + 1)
        if len(data) > MAX_BODY_BYTES:
            raise ResponseTooLarge(MAX_BODY_BYTES)
        if declared and declared.isdigit() and len(data) != int(declared):
            raise IncompleteRead(data, int(declared) - len(data))
        return response.status, data.decode("utf-8", errors="replace")
    finally:
        connection.close()


def observed_ns(catalog):
    """The catalog's `observed_at` in nanoseconds since the epoch, or None before the first scan.

    ValueError when it is neither null nor RFC 3339 UTC.
    """
    value = catalog.get("observed_at", "") if isinstance(catalog, dict) else ""
    if value is None:
        return None
    match = _OBSERVED_AT.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("observed_at is not an RFC 3339 UTC time: {!r}".format(value))
    seconds = calendar.timegm(time.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S"))
    return seconds * 1000000000 + int((match.group(2) or "").ljust(9, "0"))


def refresh(socket_path=SOCKET_PATH, timeout=REFRESH_TIMEOUT_SEC):
    """Request a rescan, then return the first catalog whose scan started at or after the request.

    It runs where Sentinel runs, so the request time and `observed_at` come from the same clock.
    Any answer that is not a pending catalog is returned as is for the caller to report.
    """
    deadline = time.monotonic() + timeout
    requested = time.time_ns()
    status, text = request("POST", "/v1/peripherals/refresh", socket_path=socket_path, timeout=min(TIMEOUT_SEC, timeout))
    if status != 202:
        return status, text
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RefreshTimedOut()
        status, text = request("GET", "/v1/peripherals", socket_path=socket_path, timeout=min(TIMEOUT_SEC, remaining))
        try:
            observed = observed_ns(json.loads(text)) if status == 200 else requested
        except ValueError:
            return status, text
        if observed is not None and observed >= requested:
            return status, text
        time.sleep(min(REFRESH_POLL_SEC, max(deadline - time.monotonic(), 0)))


def main(argv):
    """``python3 - METHOD PATH [BODY] [SOCKET] [TIMEOUT]`` prints one JSON envelope.

    METHOD ``REFRESH`` runs refresh() and ignores PATH and BODY.
    """
    method, path = argv[0], argv[1]
    body = json.loads(argv[2]) if len(argv) > 2 and argv[2] else None
    socket_path = argv[3] if len(argv) > 3 and argv[3] else SOCKET_PATH
    timeout = float(argv[4]) if len(argv) > 4 and argv[4] else TIMEOUT_SEC
    try:
        if method == "REFRESH":
            status, response = refresh(socket_path=socket_path, timeout=timeout)
        else:
            status, response = request(method, path, body, socket_path=socket_path, timeout=timeout)
    except RefreshTimedOut:
        sys.stdout.write(json.dumps({"failure": REFRESH_TIMED_OUT, "detail": ""}))
        return 3
    except (OSError, socket.timeout) as exc:
        sys.stdout.write(json.dumps({"failure": socket_failure(exc), "detail": "{}: {}".format(socket_path, exc)}))
        return 3
    except HTTPException as exc:
        sys.stdout.write(json.dumps({"failure": PROTOCOL, "detail": str(exc)}))
        return 4
    except ResponseTooLarge as exc:
        sys.stdout.write(json.dumps({"failure": TOO_LARGE, "detail": str(exc)}))
        return 4
    sys.stdout.write(json.dumps({"status": status, "text": response}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
