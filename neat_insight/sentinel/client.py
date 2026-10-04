"""Reach the Sentinel daemon's API on the selected board, for Stats and Peripherals.

Sentinel listens on a unix socket only (`docs/api.md`: never forward it or add a TCP
listener), so Insight reaches it from the board itself: in-process when Insight runs on
the board, and otherwise by streaming :mod:`neat_insight.sentinel.socket_client` to
``python3 -`` over the board transport. Both paths return the daemon's HTTP status, so
400, 404, 409 and 413 keep their meaning. Stats and Peripherals share that transport
(:class:`SentinelSocket`); each keeps its own error codes, wording and response cap.
"""
import json
from http.client import HTTPException
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from neat_insight.board import BoardError
from neat_insight.sentinel import socket_client
from neat_insight.sentinel.errors import UPSTREAM_CODES, SentinelError

CLIENT_PATH = Path(socket_client.__file__)
DETAIL_LIMIT = 2000

# Failures of the board-side client itself, beside socket_client's failure kinds.
TOOL_MISSING = "tool_missing"
NOT_RUN = "not_run"
RESPONSE = "response"


class SentinelSocket:
    """Sends one request to Sentinel: in process on the board, otherwise as ``python3 -`` over the board transport.

    Each client keeps its own error codes, messages, error type and response cap: ``socket_errors``
    maps socket_client failure kinds and ``client_errors`` the kinds above plus ``TOO_LARGE``, each
    to ``(code, message, hint)``. A failure kind missing from ``socket_errors`` reports as ``FAILED``.
    ``too_large_detail`` is the ``detail`` of an answer over the cap, which socket_client words one way only.
    """

    socket_errors: dict = {}
    client_errors: dict = {}
    too_large_detail = ""
    error_type = BoardError
    max_body_bytes = socket_client.MAX_BODY_BYTES

    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

    def request(self, method: str, path: str, body=None, timeout=socket_client.TIMEOUT_SEC):
        if self.session.target.mode == "local":
            return self._call_local(method, path, body, timeout)
        return self._call_remote(method, path, body, timeout)

    def _call_local(self, method, path, body, timeout):
        try:
            return socket_client.request(
                method, path, body, socket_path=self.socket_path, timeout=timeout, max_bytes=self.max_body_bytes
            )
        except socket_client.ResponseTooLarge as exc:
            raise self._too_large() from exc
        except HTTPException as exc:
            raise self._socket_error(socket_client.PROTOCOL, str(exc)) from exc
        except OSError as exc:
            raise self._socket_error(socket_client.socket_failure(exc), str(exc)) from exc

    def _call_remote(self, method, path, body, timeout):
        argv = [
            "python3",
            "-",
            method,
            path,
            json.dumps(body) if body is not None else "",
            self.socket_path,
            str(timeout),
            str(self.max_body_bytes),
        ]
        result = self.session.transport.exec(argv, timeout=timeout + 15.0, stdin=CLIENT_PATH.read_bytes())
        if result.exit_code == 127:
            code, message, hint = self.client_errors[TOOL_MISSING]
            raise BoardError(code, message, hint=hint, tool="python3")
        try:
            envelope = json.loads(result.stdout.decode("utf-8", errors="replace"))
        except ValueError:
            envelope = None
        if not isinstance(envelope, dict) or ("status" not in envelope and "failure" not in envelope):
            code, message, hint = self.client_errors[NOT_RUN]
            raise self.error_type(
                code,
                message.format(exit_code=result.exit_code),
                hint=hint,
                detail=result.stderr.decode("utf-8", errors="replace").strip()[:DETAIL_LIMIT],
            )
        if envelope.get("failure") == socket_client.TOO_LARGE:
            raise self._too_large()
        if "failure" in envelope:
            raise self._socket_error(envelope["failure"], envelope.get("detail", ""))
        status, text = envelope.get("status"), envelope.get("text")
        if not isinstance(status, int) or isinstance(status, bool) or not 100 <= status <= 599 or not isinstance(text, str):
            raise self._response_error(self.client_errors[RESPONSE][1], envelope)
        return status, text

    def _response_error(self, message: str, detail) -> BoardError:
        try:
            rendered = json.dumps(detail, separators=(",", ":"))
        except (TypeError, ValueError):
            rendered = str(detail)
        code, _, hint = self.client_errors[RESPONSE]
        return self.error_type(code, message, hint=hint, detail=rendered[:DETAIL_LIMIT])

    def _too_large(self) -> BoardError:
        code, message, hint = self.client_errors[socket_client.TOO_LARGE]
        return self.error_type(
            code,
            message.format(label=self.session.target.label, limit_mib=self.max_body_bytes // (1024 * 1024)),
            hint=hint,
            detail=self.too_large_detail.format(limit=self.max_body_bytes),
            limit_bytes=self.max_body_bytes,
        )

    def _socket_error(self, failure: str, detail: str) -> BoardError:
        code, message, hint = self.socket_errors.get(failure, self.socket_errors[socket_client.FAILED])
        return self.error_type(
            code,
            message.format(socket=self.socket_path, label=self.session.target.label),
            hint=hint,
            detail=detail[:DETAIL_LIMIT],
        )


SCHEMA = 1
# The daemon answers from its cache, so every call is fast; a slow one means it is wedged.
# Over SSH the board transport adds 15 s for SSH startup, not daemon work.
TIMEOUT_SEC = 20.0

INSTALL_HINT = (
    "Install Sentinel on the board with `sima-cli neat install sentinel` (or POST /api/sentinel/install), "
    "then retry."
)
START_HINT = "Start it on the board with `sudo systemctl start simaai-sentinel`, then retry."
_FAILURE_ERRORS = {
    socket_client.MISSING: (
        "sentinel_missing",
        "Sentinel's API socket {socket} does not exist on {label}.",
        INSTALL_HINT,
    ),
    socket_client.REFUSED: (
        "sentinel_missing",
        "Nothing is listening on Sentinel's API socket {socket} on {label}.",
        START_HINT,
    ),
    socket_client.DENIED: (
        "sentinel_denied",
        "Sentinel's API socket {socket} on {label} cannot be opened by this user.",
        "The socket is normally mode 0666. Check its permissions on the board, or connect as a user that may "
        "read it.",
    ),
    socket_client.TIMED_OUT: (
        "timeout",
        "Sentinel's API socket {socket} on {label} did not answer before the request timed out.",
        "Check `systemctl status simaai-sentinel` on the board.",
    ),
    socket_client.FAILED: (
        "sentinel_failed",
        "Sentinel's API socket {socket} on {label} could not be used.",
        "Check `systemctl status simaai-sentinel` on the board.",
    ),
}

_CLIENT_ERRORS = {
    TOOL_MISSING: (
        "tool_missing",
        "python3 was not found on the board, so Sentinel's socket cannot be reached.",
        "Install python3 (3.8 or newer) on the board, then retry.",
    ),
    NOT_RUN: (
        "sentinel_failed",
        "The Sentinel API client did not run on the board (python3 exited {exit_code}).",
        "Check that python3 on the board is 3.8 or newer; its error output is in detail.",
    ),
    RESPONSE: (
        "sentinel_failed",
        "The Sentinel API client returned a malformed response envelope.",
        "Check `systemctl status simaai-sentinel` on the board.",
    ),
    socket_client.TOO_LARGE: (
        "response_too_large",
        "Sentinel's answer on {label} is larger than the {limit_mib} MiB Insight reads from the board, so it was not read.",
        "A saved run carries every sample it recorded; open or compare shorter runs, or record shorter traces.",
    ),
}


class SentinelClient(SentinelSocket):
    """Talks to one board's Sentinel daemon over its unix socket."""

    socket_errors = _FAILURE_ERRORS
    client_errors = _CLIENT_ERRORS
    too_large_detail = "Sentinel's answer is larger than {limit} bytes."
    error_type = SentinelError

    # --- endpoints ---------------------------------------------------------

    def health(self) -> dict:
        return self.get("/v1/health")

    def metrics(self) -> dict:
        return self.get("/v1/metrics")

    def latest(self) -> dict:
        return self.get("/v1/samples/latest")

    def active_trace(self) -> dict:
        return self.get("/v1/traces/active")

    def start_trace(self, name: str, note: Optional[str] = None, tags: Optional[List[str]] = None) -> dict:
        body = {"name": name}
        if note:
            body["note"] = note
        if tags:
            body["tags"] = tags
        return self.post("/v1/traces", body)

    def stop_trace(self) -> dict:
        return self.post("/v1/traces/stop", None)

    def runs(self) -> dict:
        return self.get("/v1/runs")

    def run(self, run_id: str) -> dict:
        return self.get("/v1/runs/" + quote(run_id, safe=""))

    def compare(self, runs: List[str], raw: bool = False) -> dict:
        query = "?runs=" + quote(",".join(runs), safe=",") + ("&raw=1" if raw else "")
        return self.get("/v1/compare" + query)

    # --- transport ---------------------------------------------------------

    def get(self, path: str) -> dict:
        return self._json("GET", path)

    def post(self, path: str, body) -> dict:
        return self._json("POST", path, body)

    def _json(self, method: str, path: str, body=None) -> dict:
        """Make one request from the board and return the body of a successful, schema-1 response,
        or raise the failure it describes."""
        status, text = self.request(method, path, body, TIMEOUT_SEC)
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if not 200 <= status < 300:
            raise self._upstream_error(status, parsed, text, path)
        if not isinstance(parsed, dict):
            raise SentinelError(
                "sentinel_failed",
                "Sentinel returned a response Insight cannot read.",
                hint="Check `systemctl status simaai-sentinel` on the board; its API should answer JSON.",
                detail=text[:DETAIL_LIMIT],
            )
        schema = parsed.get("schema")
        if schema != SCHEMA:
            raise SentinelError(
                "sentinel_schema",
                "Sentinel on the board speaks API schema {} and Insight understands schema {}.".format(
                    schema, SCHEMA
                ),
                hint="Update Insight and Sentinel to matching versions.",
                schema=schema,
                expected_schema=SCHEMA,
            )
        return parsed

    def _upstream_error(self, status: int, parsed, text: str, path: str) -> SentinelError:
        detail = parsed.get("error") if isinstance(parsed, dict) else None
        detail = (detail or text or "").strip()[:DETAIL_LIMIT]
        code = UPSTREAM_CODES.get(status, "sentinel_failed")
        if code == "not_found" and not (path.startswith("/v1/runs/") or path.startswith("/v1/compare?")):
            code = "sentinel_schema"
        hints = {
            "invalid_request": "Correct the request and try again.",
            "not_found": "List runs and use a name or id Sentinel reports.",
            "sentinel_schema": "Update Sentinel on the board to a version that provides the Stats API.",
            "trace_conflict": "Only one trace can be active. Stop the active trace, or use a different name.",
            "request_too_large": "Send a smaller request.",
        }
        return SentinelError(
            code,
            detail or "Sentinel rejected the request with HTTP {}.".format(status),
            hint=hints.get(code, "Check `systemctl status simaai-sentinel` and the daemon's log on the board."),
            sentinel_status=status,
        )
