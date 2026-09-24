"""Sentinel API client, executed on the board as ``python3 -``.

Sentinel serves HTTP/JSON on the unix socket ``/run/simaai-sentinel/api.sock`` and is
never exposed over TCP, so a request can only be made from the board itself. Insight
imports this module when it runs on the board and streams it to ``python3 -`` over SSH
otherwise; both paths go through :func:`request`.

Stdlib only and Python 3.8 compatible: the board's python3 must be able to run it.
"""
import errno
import json
import socket
import sys
from http.client import HTTPConnection

SOCKET_PATH = "/run/simaai-sentinel/api.sock"
# The daemon answers from a cache, so every call is fast; a slow one means it is wedged.
TIMEOUT_SEC = 20.0
MAX_BODY_BYTES = 8 * 1024 * 1024

# What went wrong at the socket, for a message that names the cause instead of errno.
MISSING = "missing"
REFUSED = "refused"
DENIED = "denied"
FAILED = "failed"


class _UnixHTTPConnection(HTTPConnection):
    """http.client over AF_UNIX: same HTTP/1.1 parsing, a unix socket instead of TCP."""

    def __init__(self, path, timeout):
        HTTPConnection.__init__(self, "localhost", timeout=timeout)
        self.path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def socket_failure(exc):
    """Classify an OSError from the socket as missing, refused, denied, or failed."""
    code = getattr(exc, "errno", None)
    if code in (errno.ENOENT, errno.ENOTDIR):
        return MISSING
    if code in (errno.ECONNREFUSED, errno.ECONNRESET, errno.EPIPE):
        return REFUSED
    if code in (errno.EACCES, errno.EPERM):
        return DENIED
    return FAILED


def request(method, path, body=None, socket_path=SOCKET_PATH, timeout=TIMEOUT_SEC):
    """Return ``(status, text)`` for one Sentinel API call; raises OSError on socket failure."""
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
        return response.status, response.read(MAX_BODY_BYTES).decode("utf-8", errors="replace")
    finally:
        connection.close()


def main(argv):
    """``python3 - <method> <path> [<json body>] [<socket>]`` prints one envelope on stdout."""
    if len(argv) < 2:
        sys.stdout.write(json.dumps({"failure": FAILED, "detail": "usage: METHOD PATH [BODY] [SOCKET]"}))
        return 2
    method, path = argv[0], argv[1]
    body = json.loads(argv[2]) if len(argv) > 2 and argv[2] else None
    socket_path = argv[3] if len(argv) > 3 and argv[3] else SOCKET_PATH
    try:
        status, text = request(method, path, body, socket_path=socket_path)
    except socket.timeout as exc:  # noqa: B014 - distinct from OSError classification below
        detail = "{}: timed out: {}".format(socket_path, exc)
        sys.stdout.write(json.dumps({"failure": FAILED, "detail": detail}))
        return 3
    except OSError as exc:
        detail = "{}: {}".format(socket_path, exc)
        sys.stdout.write(json.dumps({"failure": socket_failure(exc), "detail": detail}))
        return 3
    sys.stdout.write(json.dumps({"status": status, "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
