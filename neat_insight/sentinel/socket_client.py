"""Sentinel API client run on the board, in process or as ``python3 -``; stdlib only, Python 3.8 compatible."""
import errno
import json
import socket
import sys
from http.client import HTTPConnection

SOCKET_PATH = "/run/simaai-sentinel/api.sock"
TIMEOUT_SEC = 20.0
# Leaves room for the JSON-escaped envelope under the board transport's 16 MiB output cap.
MAX_BODY_BYTES = 12 * 1024 * 1024

MISSING = "missing"
REFUSED = "refused"
DENIED = "denied"
FAILED = "failed"
TOO_LARGE = "too_large"


class ResponseTooLarge(Exception):
    def __init__(self, limit):
        self.limit = limit
        Exception.__init__(self, "Sentinel's answer is larger than {} bytes.".format(limit))


class _UnixHTTPConnection(HTTPConnection):
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
    code = getattr(exc, "errno", None)
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
        return response.status, data.decode("utf-8", errors="replace")
    finally:
        connection.close()


def main(argv):
    """``python3 - METHOD PATH [BODY] [SOCKET]`` prints one JSON envelope on stdout."""
    method, path = argv[0], argv[1]
    body = json.loads(argv[2]) if len(argv) > 2 and argv[2] else None
    socket_path = argv[3] if len(argv) > 3 and argv[3] else SOCKET_PATH
    try:
        status, text = request(method, path, body, socket_path=socket_path)
    except socket.timeout as exc:
        sys.stdout.write(json.dumps({"failure": FAILED, "detail": "{}: timed out: {}".format(socket_path, exc)}))
        return 3
    except OSError as exc:
        sys.stdout.write(json.dumps({"failure": socket_failure(exc), "detail": "{}: {}".format(socket_path, exc)}))
        return 3
    except ResponseTooLarge as exc:
        sys.stdout.write(json.dumps({"failure": TOO_LARGE, "detail": str(exc), "limit": exc.limit}))
        return 4
    sys.stdout.write(json.dumps({"status": status, "text": text}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
