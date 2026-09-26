"""Reach the Sentinel daemon's API on the selected board.

Sentinel listens on a unix socket only (`docs/api.md`: never forward it or add a TCP
listener), so Insight reaches it from the board itself: in-process when Insight runs on
the board, and otherwise by streaming :mod:`neat_insight.sentinel.socket_client` to
``python3 -`` over the board transport. Both paths return the daemon's HTTP status, so
400, 404, 409 and 413 keep their meaning.
"""
import json
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from neat_insight.board import BoardError
from neat_insight.sentinel import socket_client
from neat_insight.sentinel.errors import UPSTREAM_CODES, SentinelError

SCHEMA = 1
CLIENT_PATH = Path(socket_client.__file__)
# The daemon answers from its cache; the margin covers SSH startup, not daemon work.
EXEC_TIMEOUT_SEC = socket_client.TIMEOUT_SEC + 15.0
DETAIL_LIMIT = 2000

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
    socket_client.FAILED: (
        "sentinel_failed",
        "Sentinel's API socket {socket} on {label} could not be used.",
        "Check `systemctl status simaai-sentinel` on the board.",
    ),
}


class Response:
    """One Sentinel API answer: the daemon's HTTP status and its parsed JSON body."""

    def __init__(self, status: int, body, text: str):
        self.status = status
        self.body = body
        self.text = text

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


class SentinelClient:
    """Talks to one board's Sentinel daemon over its unix socket."""

    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

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
        return self.checked(self.call("GET", path))

    def post(self, path: str, body) -> dict:
        return self.checked(self.call("POST", path, body))

    def call(self, method: str, path: str, body=None) -> Response:
        """Make one request from the board and return its status and body, whatever the status."""
        if self.session.target.mode == "local":
            status, text = self._call_local(method, path, body)
        else:
            status, text = self._call_remote(method, path, body)
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        return Response(status, parsed, text)

    def checked(self, response: Response) -> dict:
        """Return the body of a successful, schema-1 response, or raise the failure it describes."""
        if not response.ok:
            raise self._upstream_error(response)
        if not isinstance(response.body, dict):
            raise SentinelError(
                "sentinel_failed",
                "Sentinel returned a response Insight cannot read.",
                hint="Check `systemctl status simaai-sentinel` on the board; its API should answer JSON.",
                detail=response.text[:DETAIL_LIMIT],
            )
        schema = response.body.get("schema")
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
        return response.body

    def _upstream_error(self, response: Response) -> SentinelError:
        detail = response.body.get("error") if isinstance(response.body, dict) else None
        detail = (detail or response.text or "").strip()[:DETAIL_LIMIT]
        code = UPSTREAM_CODES.get(response.status, "sentinel_failed")
        hints = {
            "invalid_request": "Correct the request and try again.",
            "not_found": "List runs and use a name or id Sentinel reports.",
            "trace_conflict": "Only one trace can be active. Stop the active trace, or use a different name.",
            "request_too_large": "Send a smaller request.",
        }
        return SentinelError(
            code,
            detail or "Sentinel rejected the request with HTTP {}.".format(response.status),
            hint=hints.get(code, "Check `systemctl status simaai-sentinel` and the daemon's log on the board."),
            sentinel_status=response.status,
        )

    def _call_local(self, method: str, path: str, body):
        try:
            return socket_client.request(method, path, body, socket_path=self.socket_path)
        except socket_client.ResponseTooLarge as exc:
            raise self._too_large(exc.limit, str(exc)) from exc
        except OSError as exc:
            raise self._socket_error(socket_client.socket_failure(exc), str(exc)) from exc

    def _call_remote(self, method: str, path: str, body):
        argv = ["python3", "-", method, path, json.dumps(body) if body is not None else "", self.socket_path]
        result = self.session.transport.exec(argv, timeout=EXEC_TIMEOUT_SEC, stdin=CLIENT_PATH.read_bytes())
        stderr = result.stderr.decode("utf-8", errors="replace").strip()[:DETAIL_LIMIT]
        if result.exit_code == 127:
            raise BoardError(
                "tool_missing",
                "python3 was not found on the board, so Sentinel's socket cannot be reached.",
                hint="Install python3 (3.8 or newer) on the board, then retry.",
                tool="python3",
            )
        envelope = self._envelope(result.stdout, result.exit_code, stderr)
        if envelope.get("failure") == socket_client.TOO_LARGE:
            raise self._too_large(envelope.get("limit"), envelope.get("detail", ""))
        if "failure" in envelope:
            raise self._socket_error(envelope["failure"], envelope.get("detail", ""))
        return int(envelope["status"]), envelope.get("text", "")

    def _envelope(self, stdout: bytes, exit_code: int, stderr: str) -> dict:
        try:
            envelope = json.loads(stdout.decode("utf-8", errors="replace"))
        except ValueError:
            envelope = None
        if not isinstance(envelope, dict) or ("status" not in envelope and "failure" not in envelope):
            raise SentinelError(
                "sentinel_failed",
                "The Sentinel API client did not run on the board (python3 exited {}).".format(exit_code),
                hint="Check that python3 on the board is 3.8 or newer; its error output is in detail.",
                detail=stderr,
            )
        return envelope

    def _too_large(self, limit, detail: str) -> SentinelError:
        limit = limit if isinstance(limit, int) and limit > 0 else socket_client.MAX_BODY_BYTES
        return SentinelError(
            "response_too_large",
            "Sentinel's answer on {} is larger than the {} Insight reads from the board, so it was not read.".format(
                self.session.target.label, _size(limit)
            ),
            hint="A saved run carries every sample it recorded; open or compare shorter runs, or record "
            "shorter traces.",
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


def _size(count: int) -> str:
    for unit, scale in (("MiB", 1024 * 1024), ("KiB", 1024)):
        if count >= scale and count % scale == 0:
            return "{} {}".format(count // scale, unit)
    return "{} bytes".format(count)
