"""Reach the Sentinel daemon's unix-socket API from the selected board."""
import json
from pathlib import Path

from neat_insight.board import BoardError
from neat_insight.sentinel import socket_client
from neat_insight.sentinel.errors import UPSTREAM_CODES, SentinelError

SCHEMA = 1
CLIENT_PATH = Path(socket_client.__file__)
EXEC_TIMEOUT_SEC = socket_client.TIMEOUT_SEC + 15.0
DETAIL_LIMIT = 2000
STATUS_HINT = "Check `systemctl status simaai-sentinel` on the board."

_FAILURE_ERRORS = {
    socket_client.MISSING: (
        "sentinel_missing",
        "Sentinel's API socket {socket} does not exist on {label}.",
        "Install Sentinel on the board with `sima-cli neat install sentinel`, then retry.",
    ),
    socket_client.REFUSED: (
        "sentinel_missing",
        "Nothing is listening on Sentinel's API socket {socket} on {label}.",
        "Start it on the board with `sudo systemctl start simaai-sentinel`, then retry.",
    ),
    socket_client.DENIED: (
        "sentinel_denied",
        "Sentinel's API socket {socket} on {label} cannot be opened by this user.",
        "Check the socket's permissions on the board.",
    ),
    socket_client.FAILED: (
        "sentinel_failed",
        "Sentinel's API socket {socket} on {label} could not be used.",
        STATUS_HINT,
    ),
}
_UPSTREAM_HINTS = {
    "invalid_request": "Correct the request and try again.",
    "not_found": "List runs and use a name or id Sentinel reports.",
    "trace_conflict": "Only one trace can be active. Stop the active trace, or use a different name.",
    "request_too_large": "Send a smaller request.",
}


class SentinelClient:
    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

    def get(self, path: str) -> dict:
        return self.call("GET", path)

    def post(self, path: str, body=None) -> dict:
        return self.call("POST", path, body)

    def call(self, method: str, path: str, body=None) -> dict:
        if self.session.target.mode == "local":
            status, text = self._call_local(method, path, body)
        else:
            status, text = self._call_remote(method, path, body)
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if not 200 <= status < 300:
            detail = parsed.get("error") if isinstance(parsed, dict) else None
            detail = (detail or text or "").strip()[:DETAIL_LIMIT]
            code = UPSTREAM_CODES.get(status, "sentinel_failed")
            raise SentinelError(
                code,
                detail or "Sentinel rejected the request with HTTP {}.".format(status),
                hint=_UPSTREAM_HINTS.get(code, STATUS_HINT),
                sentinel_status=status,
            )
        if not isinstance(parsed, dict):
            raise SentinelError(
                "sentinel_failed",
                "Sentinel returned a response Insight cannot read.",
                hint=STATUS_HINT,
                detail=text[:DETAIL_LIMIT],
            )
        if parsed.get("schema") != SCHEMA:
            raise SentinelError(
                "sentinel_schema",
                "Sentinel on the board speaks API schema {} and Insight understands schema {}.".format(
                    parsed.get("schema"), SCHEMA
                ),
                hint="Update Insight and Sentinel to matching versions.",
            )
        return parsed

    def _call_local(self, method: str, path: str, body):
        try:
            return socket_client.request(method, path, body, socket_path=self.socket_path)
        except socket_client.ResponseTooLarge as exc:
            raise self._too_large(str(exc)) from exc
        except OSError as exc:
            raise self._socket_error(socket_client.socket_failure(exc), str(exc)) from exc

    def _call_remote(self, method: str, path: str, body):
        argv = ["python3", "-", method, path, json.dumps(body) if body is not None else "", self.socket_path]
        result = self.session.transport.exec(argv, timeout=EXEC_TIMEOUT_SEC, stdin=CLIENT_PATH.read_bytes())
        if result.exit_code == 127:
            raise BoardError(
                "tool_missing",
                "python3 was not found on the board, so Sentinel's socket cannot be reached.",
                hint="Install python3 (3.8 or newer) on the board, then retry.",
                tool="python3",
            )
        try:
            envelope = json.loads(result.stdout.decode("utf-8", errors="replace"))
        except ValueError:
            envelope = None
        if not isinstance(envelope, dict) or ("status" not in envelope and "failure" not in envelope):
            raise SentinelError(
                "sentinel_failed",
                "The Sentinel API client did not run on the board (python3 exited {}).".format(result.exit_code),
                hint="Check that python3 on the board is 3.8 or newer; its error output is in detail.",
                detail=result.stderr.decode("utf-8", errors="replace").strip()[:DETAIL_LIMIT],
            )
        if envelope.get("failure") == socket_client.TOO_LARGE:
            raise self._too_large(envelope.get("detail", ""))
        if "failure" in envelope:
            raise self._socket_error(envelope["failure"], envelope.get("detail", ""))
        return int(envelope["status"]), envelope.get("text", "")

    def _too_large(self, detail: str) -> SentinelError:
        limit = socket_client.MAX_BODY_BYTES
        return SentinelError(
            "response_too_large",
            "Sentinel's answer on {} is larger than the {} MiB Insight reads from the board, so it was not read.".format(
                self.session.target.label, limit // (1024 * 1024)
            ),
            hint="Open or compare shorter runs, or record shorter traces.",
            detail=detail[:DETAIL_LIMIT],
            limit_bytes=limit,
        )

    def _socket_error(self, failure: str, detail: str) -> SentinelError:
        code, message, hint = _FAILURE_ERRORS.get(failure, _FAILURE_ERRORS[socket_client.FAILED])
        return SentinelError(
            code,
            message.format(socket=self.socket_path, label=self.session.target.label),
            hint=hint,
            detail=detail[:DETAIL_LIMIT],
        )
