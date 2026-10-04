import contextlib
import io
import json
import os
import shlex
import signal
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from datetime import datetime, timezone
from http.client import HTTPException, IncompleteRead
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

from flask import Flask

from neat_insight.board import BoardError, ExecResult, board_bp
from neat_insight.sentinel import api, cache_history, install, metrics, runs, socket_client, state
from neat_insight.sentinel import client as sentinel_client
from neat_insight.sentinel.api import sentinel_bp
from neat_insight.sentinel.client import SentinelClient
from neat_insight.sentinel.errors import SentinelError

HEALTH = {"schema": 1, "version": "main:80ab7de4da31", "cached_samples": 240, "metric_count": 3, "errors": [],
          "latest_sample_at": "2026-09-22T20:55:41.487425986Z", "updated_at": "2026-09-22T20:55:41.487582472Z", "active_trace": None}
DEFINITIONS = {
    "schema": 1,
    "metrics": [
        {"key": "rtsn_0", "label": "MLA RTSN-0", "short": "MLA-0", "unit": "C", "group": "MLA",
         "description": "On-die RTSN at the MLA Q0 site.", "warn": 70.0, "critical": 85.0},
        {"key": "power_current_watts", "label": "Current board power", "short": "Current", "unit": "W", "group": "Power",
         "description": "Latest valid total PMBus POUT reading.", "warn": None, "critical": None},
        {"key": "linux_mem_used_pct", "label": "Linux memory used", "short": "Mem%", "unit": "%", "group": "Memory",
         "description": "Linux memory usage.", "warn": 80.0, "critical": 90.0},
    ],
}
STATUS_FIELDS = ("active", "yes", "yes", "/usr/bin/sima-cli")
DOWN = ["inactive", "no", "no", "/usr/bin/sima-cli"]


def sample(timestamp: str, **values) -> dict:
    merged = {"rtsn_0": 72.0, "power_current_watts": None, "linux_mem_used_pct": 95.0, "cvu_clock_mhz": 800.0, **values}
    return {"schema": 1, "version": HEALTH["version"], "updated_at": timestamp, "sample": {"timestamp": timestamp, "values": merged}}


def export_table(samples):
    keys = sorted(samples[0]["values"])
    table = {"timestamps": [s["timestamp"] for s in samples], "keys": keys, "rows": [[s["values"][k] for k in keys] for s in samples]}
    return ExecResult(0, json.dumps(table).encode(), b"")


SAMPLE = sample("2026-09-22T20:55:47Z")


class FakeSentinel:
    """A board transport that answers the daemon status script and Sentinel API calls."""

    def __init__(self, status_fields=STATUS_FIELDS):
        self.status_fields = list(status_fields)
        self.install_result = ExecResult(0, b"Sentinel installed", b"")
        self.api = {
            ("GET", "/v1/health"): (200, HEALTH),
            ("GET", "/v1/metrics"): (200, DEFINITIONS),
            ("GET", "/v1/samples/latest"): (200, SAMPLE),
            ("GET", "/v1/traces/active"): (200, {"schema": 1, "trace": None, "summary": None}),
            ("GET", "/v1/runs"): (200, {"schema": 1, "runs": []}),
        }
        self.calls = []
        self.exec_error = None
        # None deletes the run from /v1/runs, as the CLI would; an ExecResult is the CLI's answer and deletes nothing.
        self.delete_result = None
        self.export_result = ExecResult(0, json.dumps({"timestamps": [], "keys": [], "rows": []}).encode(), b"")

    def answer(self, method, path, status, body):
        self.api[(method, path)] = (status, body)

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append((argv, timeout, stdin))
        if self.exec_error is not None:
            raise self.exec_error
        if argv[0] == "python3":
            return self._api_call(argv)
        script = argv[2]
        if "runs delete" in script:
            return self._delete(argv[4])
        if '"$cli" export' in script:
            return self.export_result
        if "neat install sentinel" in script:
            return self.install_result
        return ExecResult(0, "@@".join(self.status_fields).encode(), b"")

    def _api_call(self, argv):
        method, path = argv[2], argv[3]
        status, body = self.api.get((method, path)) or (404, {"error": "unknown route '{}'".format(path)})
        text = body if isinstance(body, str) else json.dumps(body)
        return ExecResult(0, json.dumps({"status": status, "text": text}).encode(), b"")

    def _delete(self, target):
        if self.delete_result is not None:
            return self.delete_result
        status, body = self.api[("GET", "/v1/runs")]
        kept = [run for run in body["runs"] if target not in (run.get("id"), run.get("name"))]
        if len(kept) == len(body["runs"]):
            return ExecResult(0, b"", "Error: unknown completed run '{}'\n".format(target).encode())
        self.api[("GET", "/v1/runs")] = (status, dict(body, runs=kept))
        return ExecResult(0, "Deleted run {}\n".format(target).encode(), b"")

    def heal_after_install(self, after=STATUS_FIELDS):
        """Make the installer bring the daemon up, as a successful install does."""
        exec_once = self.exec

        def run(argv, *, timeout, stdin=None):
            result = exec_once(argv, timeout=timeout, stdin=stdin)
            if argv[0] == "sh" and "neat install sentinel" in argv[2]:
                self.status_fields = list(after)
            return result
        self.exec = run

    def _scripts_with(self, text):
        return [argv for argv, _, _ in self.calls if argv[0] == "sh" and text in argv[2]]

    deletes = property(lambda self: self._scripts_with("runs delete"))
    exports = property(lambda self: self._scripts_with('"$cli" export'))
    scripts = property(lambda self: [argv[2] for argv in self._scripts_with("")])
    api_paths = property(lambda self: [(argv[2], argv[3]) for argv, _, _ in self.calls if argv[0] == "python3"])


class FakeSession:
    def __init__(self, transport, generation=1, fingerprint="fp-1", mode="ssh"):
        self.transport = transport
        self.generation = generation
        self.fingerprint = fingerprint
        self.target = SimpleNamespace(mode=mode, source="manual", label="sima@192.168.2.2")
        self.identity_calls = 0

    def identity(self):
        self.identity_calls += 1
        return {"hostname": "modalix", "machine": "modalix", "build_version": "2.1.3", "fingerprint": self.fingerprint}


class FakeManager:
    def __init__(self, session=None):
        self.current = session
        self.error = None

    def session(self):
        if self.error:
            raise self.error
        return self.current


class StaticBoard:
    """A session whose transport answers every command with one result, or raises it."""

    def __init__(self, result):
        self.transport = self
        self.result = result

    def exec(self, argv, *, timeout, stdin=None):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Handler(BaseHTTPRequestHandler):
    """Serves the canned answers of the unix-socket server below."""

    protocol_version = "HTTP/1.1"

    def address_string(self):  # client_address is empty for a unix socket
        return "local"

    def log_message(self, *args):
        pass

    def _respond(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.requests.append((self.command, self.path, body.decode() or None))
        status, payload = self.server.answers.get(self.path, (404, {"error": "unknown route"}))
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if self.server.omit_length:  # a body delimited by the connection closing, with no size up front
            self.send_header("Connection", "close")
            self.close_connection = True
        else:
            self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = _respond
    do_POST = _respond


class _UnixHTTPServer(socketserver.ThreadingUnixStreamServer):
    allow_reuse_address = True

    def __init__(self, path):
        socketserver.ThreadingUnixStreamServer.__init__(self, path, _Handler)
        self.answers = {"/v1/health": (200, HEALTH), "/v1/runs/nope": (404, {"error": "unknown run 'nope'"})}
        self.requests = []
        self.omit_length = False


class SocketClientTests(unittest.TestCase):
    """The on-board client: real HTTP over a real unix socket, no network."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, "api.sock")
        self.server = _UnixHTTPServer(self.path)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)

    def main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = socket_client.main(list(argv))
        return code, json.loads(out.getvalue())

    def long_run(self, limit=4096):
        """A run whose JSON is larger than `limit`, which the client is patched down to."""
        self.addCleanup(setattr, socket_client, "MAX_BODY_BYTES", socket_client.MAX_BODY_BYTES)
        socket_client.MAX_BODY_BYTES = limit
        samples = [{"timestamp": "2026-09-23T15:27:%02dZ" % (i % 60), "values": {"rtsn_0": 40.5}} for i in range(limit // 50 + 1)]
        self.server.answers["/v1/runs/long"] = (200, {"schema": 1, "metadata": {"name": "long"}, "samples": samples})
        self.assertGreater(len(json.dumps(self.server.answers["/v1/runs/long"][1])), limit)

    def test_get_and_post_keep_the_daemon_status_and_body_over_the_unix_socket(self):
        status, text = socket_client.request("GET", "/v1/health", socket_path=self.path)
        self.assertEqual((status, json.loads(text)), (200, HEALTH))
        self.server.answers["/v1/traces"] = (409, {"error": "a trace is already active"})
        status, text = socket_client.request("POST", "/v1/traces", {"name": "a"}, socket_path=self.path)
        self.assertEqual((status, json.loads(text)), (409, {"error": "a trace is already active"}))
        self.assertEqual(self.server.requests[-1], ("POST", "/v1/traces", '{"name": "a"}'))

    def test_an_on_board_client_reads_the_socket_without_the_transport(self):
        transport = FakeSentinel()
        client = SentinelClient(FakeSession(transport, mode="local"), socket_path=self.path)
        self.assertEqual(client.health(), HEALTH)
        self.assertEqual(transport.calls, [])
        with self.assertRaises(SentinelError) as raised:
            client.run("nope")
        self.assertEqual((raised.exception.code, raised.exception.status), ("not_found", 404))

    def test_a_missing_socket_is_classified_and_main_reports_it_instead_of_a_traceback(self):
        with self.assertRaises(OSError) as raised:
            socket_client.request("GET", "/v1/health", socket_path=self.path + ".gone")
        self.assertEqual(socket_client.socket_failure(raised.exception), socket_client.MISSING)
        code, envelope = self.main("GET", "/v1/health", "", self.path + ".gone")
        self.assertEqual((code, envelope["failure"]), (3, socket_client.MISSING))
        self.assertIn(self.path + ".gone", envelope["detail"])
        # One envelope per call when the daemon answers.
        code, envelope = self.main("GET", "/v1/health", "", self.path)
        self.assertEqual((code, envelope["status"], json.loads(envelope["text"])), (0, 200, HEALTH))

    def test_a_body_over_the_limit_is_refused_by_name_never_truncated_and_one_at_it_is_read_whole(self):
        self.long_run()
        for omit_length in (False, True):
            with self.subTest(declared_length=not omit_length):
                self.server.omit_length = omit_length
                with self.assertRaises(socket_client.ResponseTooLarge) as raised:
                    socket_client.request("GET", "/v1/runs/long", socket_path=self.path)
                self.assertIn("4096", str(raised.exception))
                socket_client.MAX_BODY_BYTES = len(json.dumps(HEALTH))
                self.assertEqual(socket_client.request("GET", "/v1/health", socket_path=self.path), (200, json.dumps(HEALTH)))
                socket_client.MAX_BODY_BYTES = 4096
        # main reports a body over the limit as its own failure.
        self.server.omit_length = False
        code, envelope = self.main("GET", "/v1/runs/long", "", self.path)
        self.assertEqual((code, envelope["failure"]), (4, socket_client.TOO_LARGE))
        self.assertIn("4096", envelope["detail"])
        self.assertNotIn("text", envelope)

    def test_an_on_board_client_names_a_body_over_the_limit(self):
        # The cap is the client's own (Peripherals reads less), so it is patched on the client.
        limit = 1024 * 1024
        self.long_run(limit)
        client = SentinelClient(FakeSession(FakeSentinel(), mode="local"), socket_path=self.path)
        with mock.patch.object(SentinelClient, "max_body_bytes", limit), self.assertRaises(SentinelError) as raised:
            client.run("long")
        self.assertEqual((raised.exception.code, raised.exception.status), ("response_too_large", 502))
        self.assertIn("1 MiB", raised.exception.message)
        self.assertEqual(raised.exception.extra["limit_bytes"], limit)

    def test_a_local_http_protocol_failure_is_a_structured_sentinel_error(self):
        session = FakeSession(FakeSentinel(), mode="local")
        for failure in (IncompleteRead(b"{}", 98), HTTPException("malformed status line")):
            with self.subTest(failure=failure), mock.patch.object(socket_client, "request", side_effect=failure):
                with self.assertRaises(SentinelError) as raised:
                    SentinelClient(session).health()
                self.assertEqual((raised.exception.code, raised.exception.status), ("sentinel_failed", 502))
                self.assertIn(str(failure), raised.exception.extra["detail"])

    def test_the_limit_leaves_room_for_the_envelope_under_the_board_output_cap(self):
        # Over SSH the body travels JSON-escaped inside the envelope, and the transport refuses more than
        # MAX_OUTPUT_BYTES. A run at the limit, shaped like the DevKit's (59 metrics a sample), must still fit.
        from neat_insight.board import transport
        self.assertGreaterEqual(socket_client.MAX_BODY_BYTES, 12 * 1024 * 1024)
        live = json.loads((Path(__file__).parents[1] / "frontend/src/stats/fixtures/metrics-live.json").read_text())
        keys = [metric["key"] for group in live["groups"] for metric in group["metrics"]]
        one = json.dumps({"timestamp": "2026-09-23T15:27:13.270295197Z", "values": {k: 8.812681752827412 for k in keys}})
        count = socket_client.MAX_BODY_BYTES // (len(one) + 2)
        text = json.dumps({"schema": 1, "metadata": {}, "samples": [json.loads(one)] * count})
        self.assertLessEqual(len(text), socket_client.MAX_BODY_BYTES)
        self.assertLess(len(json.dumps({"status": 200, "text": text})), transport.MAX_OUTPUT_BYTES)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)
        self.client = SentinelClient(self.session)

    def raised(self, call=None, error=SentinelError):
        with self.assertRaises(error) as raised:
            (call or self.client.health)()
        return raised.exception

    def test_a_remote_call_streams_the_client_to_python3_on_the_board_with_its_body_as_an_argument(self):
        self.assertEqual(self.client.health(), HEALTH)
        argv, timeout, stdin = self.transport.calls[0]
        self.assertEqual(argv, ["python3", "-", "GET", "/v1/health", "", socket_client.SOCKET_PATH,
                                str(sentinel_client.TIMEOUT_SEC), str(socket_client.MAX_BODY_BYTES)])
        self.assertEqual(stdin, Path(socket_client.__file__).read_bytes())
        self.assertGreater(timeout, socket_client.TIMEOUT_SEC)
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"name": "baseline"}})
        self.client.start_trace("baseline", note="before", tags=["compiler-v1"])
        argv = self.transport.calls[-1][0]
        self.assertEqual(argv[:4], ["python3", "-", "POST", "/v1/traces"])
        self.assertEqual(json.loads(argv[4]), {"name": "baseline", "note": "before", "tags": ["compiler-v1"]})
        self.assertEqual(argv[5], socket_client.SOCKET_PATH)

    def test_compare_encodes_the_run_list_and_raw_flag_and_a_run_name_with_a_slash_is_escaped(self):
        self.transport.answer("GET", "/v1/compare?runs=a,b&raw=1", 200, {"schema": 1, "runs": []})
        self.client.compare(["a", "b"], raw=True)
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/compare?runs=a,b&raw=1"))
        self.transport.answer("GET", "/v1/runs/a%2Fb", 200, {"schema": 1, "run": {}})
        self.client.run("a/b")
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/runs/a%2Fb"))

    def test_another_schema_is_refused_rather_than_misread_and_local_boards_use_the_socket(self):
        self.transport.answer("GET", "/v1/health", 200, dict(HEALTH, schema=2))
        error = self.raised()
        self.assertEqual((error.code, error.status, error.to_dict()["schema"]), ("sentinel_schema", 502, 2))
        # Local boards use the socket directly, never the transport.
        transport = FakeSentinel()
        client = SentinelClient(FakeSession(transport, mode="local"), socket_path="/nonexistent/api.sock")
        self.assertEqual(self.raised(client.health).code, "sentinel_missing")
        self.assertEqual(transport.calls, [])

    def test_daemon_statuses_survive_with_their_meaning(self):
        cases = {400: ("invalid_request", 400), 404: ("not_found", 404), 409: ("trace_conflict", 409),
                 413: ("request_too_large", 413), 500: ("sentinel_failed", 502)}
        for status, expected in cases.items():
            with self.subTest(status=status):
                self.transport.answer("GET", "/v1/health", status, {"error": "no"})
                error = self.raised()
                self.assertEqual((error.code, error.status), expected)
                self.assertEqual((error.to_dict()["error"], error.to_dict()["sentinel_status"]), ("no", status))

    def test_socket_failures_name_the_cause_and_the_fix(self):
        cases = {
            socket_client.MISSING: ("sentinel_missing", "sima-cli neat install sentinel"),
            socket_client.REFUSED: ("sentinel_missing", "systemctl start"),
            socket_client.DENIED: ("sentinel_denied", "0666"),
            socket_client.TIMED_OUT: ("timeout", "systemctl status"),
            socket_client.FAILED: ("sentinel_failed", "systemctl status"),
        }
        for failure, (code, hint) in cases.items():
            with self.subTest(failure=failure):
                envelope = json.dumps({"failure": failure, "detail": "boom"}).encode()
                self.transport.exec = lambda *a, **k: ExecResult(3, envelope, b"")
                error = self.raised()
                self.assertEqual(error.code, code)
                if failure == socket_client.TIMED_OUT:
                    self.assertEqual(error.status, 504)
                self.assertIn(hint, error.hint)
                self.assertIn(socket_client.SOCKET_PATH, error.message)

    def test_board_side_and_connection_failures_are_named(self):
        # A body over the limit on the board is named with the limit.
        envelope = json.dumps({"failure": "too_large", "detail": "boom", "limit": 12 * 1024 * 1024}).encode()
        self.transport.exec = lambda *a, **k: ExecResult(4, envelope, b"")
        error = self.raised(lambda: self.client.run("long"))
        self.assertEqual((error.code, error.status, error.to_dict()["limit_bytes"]), ("response_too_large", 502, 12 * 1024 * 1024))
        self.assertIn("12 MiB", error.message)
        # A board without python3 reports the missing tool.
        self.transport.exec = lambda *a, **k: ExecResult(127, b"", b"python3: command not found")
        error = self.raised(error=BoardError)
        self.assertEqual((error.code, error.to_dict()["tool"]), ("tool_missing", "python3"))
        # Unreadable output keeps the board's error text.
        self.transport.exec = lambda *a, **k: ExecResult(1, b"not json", b"Traceback: SyntaxError")
        error = self.raised()
        self.assertEqual(error.code, "sentinel_failed")
        self.assertIn("SyntaxError", error.to_dict()["detail"])
        # Connection failures pass through untouched.
        del self.transport.exec
        self.transport.exec_error = BoardError("unreachable", "no route")
        error = self.raised(error=BoardError)
        self.assertEqual((error.code, error.status), ("unreachable", 502))


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)

    def state(self, *fields):
        self.transport.status_fields = list(fields)
        return install.status(self.session)

    def install_error(self):
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        return raised.exception

    def test_status_reads_the_service_socket_unit_and_cli(self):
        # The fake board reports no invocation or running time, so neither is claimed.
        self.assertEqual(self.state(*STATUS_FIELDS), {
            "installed": True, "healthy": True, "service": "active", "socket": True, "socket_path": socket_client.SOCKET_PATH,
            "sima_cli": "/usr/bin/sima-cli", "instance_id": None, "started_at": None,
        })
        for part in ("systemctl is-active simaai-sentinel", "ActiveEnterTimestampMonotonic", "InvocationID",
                     socket_client.SOCKET_PATH, ".sima-cli/.venv/bin/sima-cli"):
            self.assertIn(part, self.transport.scripts[0])

    def test_describe_names_a_stopped_or_missing_daemon_and_a_healthy_install_is_never_reinstalled(self):
        stopped = self.state("inactive", "no", "yes", "")
        self.assertEqual((stopped["installed"], stopped["healthy"], stopped["sima_cli"]), (True, False, None))
        problem = install.describe(stopped)
        self.assertEqual((problem["code"], problem["error"]), ("sentinel_stopped", "The simaai-sentinel service is installed but inactive."))
        self.assertIn("systemctl start simaai-sentinel", problem["hint"])
        missing = self.state("inactive", "no", "no", "")
        self.assertFalse(missing["installed"])
        problem = install.describe(missing)
        self.assertEqual(problem["code"], "sentinel_missing")
        self.assertIn("sima-cli neat install sentinel", problem["hint"])
        self.assertIsNone(install.describe(self.state(*STATUS_FIELDS)))
        # A healthy install is never reinstalled: only the status script runs.
        before = len(self.transport.scripts)
        error = self.install_error()
        self.assertEqual((error.code, error.status), ("already_installed", 409))
        self.assertEqual(len(self.transport.scripts), before + 1)
        self.assertNotIn("neat install sentinel", self.transport.scripts[-1])

    def test_install_runs_sima_cli_on_the_board_without_an_ip(self):
        cli = "/home/sima/.sima-cli/.venv/bin/sima-cli"
        self.transport.status_fields = ["inactive", "no", "no", cli]
        self.transport.heal_after_install(["active", "yes", "yes", cli])
        result = install.install(self.session)
        script = self.transport.scripts[1]
        for part in ("SIMA_INSTALL_CONTEXT=1", "SIMA_CLI_CHECK_FOR_UPDATE=0", "'{}'".format(cli), "neat install sentinel -d", "mktemp -d", "sudo -n"):
            self.assertIn(part, script)
        self.assertNotIn("--ip", script)
        self.assertEqual((result["status"]["healthy"], result["log"]), (True, "Sentinel installed"))

    def test_a_failed_install_says_why_and_how_to_fix_it(self):
        self.transport.status_fields = ["inactive", "no", "no", ""]
        error = self.install_error()
        self.assertEqual(error.to_dict()["tool"], "sima-cli")
        self.assertIn(install.MANUAL_COMMAND, error.hint)
        self.transport.status_fields = DOWN
        self.transport.install_result = ExecResult(77, b"", b"sudo: a password is required")
        error = self.install_error()
        self.assertEqual(error.code, "sentinel_denied")
        self.assertIn(install.MANUAL_COMMAND, error.hint)
        # A failed installer keeps its output.
        self.transport.install_result = ExecResult(1, b"downloading", b"vulcan: not found")
        error = self.install_error()
        self.assertEqual(error.code, "sentinel_failed")
        self.assertIn("vulcan: not found", error.to_dict()["detail"])
        # An installer that leaves the daemon down is reported.
        self.transport.install_result = ExecResult(0, b"Sentinel installed", b"")
        self.assertIn("is inactive", self.install_error().message)

    def test_concurrent_installs_run_the_installer_once(self):
        self.transport.status_fields = DOWN
        installing, release, installers, outcomes = threading.Event(), threading.Event(), [], []

        def slow_installer(argv, *, timeout, stdin=None):
            if argv[0] == "sh" and "neat install sentinel" in argv[2]:
                installers.append(argv)
                installing.set()
                release.wait(5)
                self.transport.status_fields = list(STATUS_FIELDS)
            return FakeSentinel.exec(self.transport, argv, timeout=timeout, stdin=stdin)

        def run():
            try:
                outcomes.append(install.install(self.session)["status"]["healthy"])
            except SentinelError as exc:
                outcomes.append(exc.code)
        self.transport.exec = slow_installer
        first, second = threading.Thread(target=run), threading.Thread(target=run)
        first.start()
        self.assertTrue(installing.wait(5))
        second.start()
        second.join(0.3)
        release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(len(installers), 1)
        self.assertEqual(sorted(map(str, outcomes)), ["True", "already_installed"])

    def test_the_daemon_run_is_named_and_dated_by_systemd_only_while_active(self):
        def status(*fields):
            return install.status(StaticBoard(ExecResult(0, "@@".join(fields).encode(), b"")))
        before = datetime.now(timezone.utc)
        started = datetime.fromisoformat(status("active", "yes", "yes", "/usr/bin/sima-cli", "inv-1\n", "895\n")["started_at"])
        self.assertAlmostEqual((before - started).total_seconds(), 895, delta=2)
        self.assertIsNone(status("inactive", "no", "yes", "", "", "")["started_at"])
        self.assertIsNone(status("active", "yes", "yes", "")["started_at"], "an older status script has four fields")
        self.assertIsNone(status("active", "yes", "yes", "", "inv-1", "soon")["started_at"])
        self.assertEqual(status("active", "yes", "yes", "", "inv-2\n", "7\n")["instance_id"], "inv-2")
        self.assertIsNone(status("inactive", "no", "yes", "", "inv-2\n", "")["instance_id"])
        self.assertIsNone(status("active", "yes", "yes", "", "", "7")["instance_id"])


_FAKE_SUDO = """#!/bin/sh
echo "$*" >> "$FAKE_SUDO_LOG"
[ -n "$FAKE_SUDO_DENY" ] && exit 1
[ "$1" = -n ] && shift
if [ "$1" = rm ]; then
  for target; do :; done
  # Root is not stopped by directory permissions and this user is: the fake lends them.
  [ -d "$target" ] && chmod -R u+w "$target"
fi
exec "$@"
"""

# Called as `sima-cli neat install sentinel -d DIR`; like the real one under sudo it leaves a tree this user cannot remove.
_FAKE_SIMA_CLI = """#!/bin/sh
dir=$5
printf '%s' "$dir" > "$FAKE_MARKER"
mkdir -p "$dir/vulcan/sentinel"
echo artifact > "$dir/vulcan/sentinel/sentinel.deb"
chmod 555 "$dir/vulcan/sentinel" "$dir/vulcan"
if [ -n "$FAKE_INSTALL_WAIT" ]; then
  touch "$FAKE_MARKER.ready"
  sleep 30
fi
exit "${FAKE_INSTALL_EXIT:-0}"
"""


class InstallScriptTests(unittest.TestCase):
    """The generated installer script, run for real by sh and bash with a fake sudo and sima-cli."""

    SHELLS = ("sh", "bash")

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        for name, text in (("sudo", _FAKE_SUDO), ("sima-cli", _FAKE_SIMA_CLI)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.marker, self.sudo_log = root / "install-dir", root / "sudo.log"

    def run_script(self, shell, stop=None, **env):
        argv = install.install_command(str(self.bin / "sima-cli"))
        self.assertEqual(argv[:2], ["sh", "-c"])
        ready = Path(str(self.marker) + ".ready")
        for path in (self.marker, ready, self.sudo_log):
            if path.exists():
                path.unlink()
        environ = dict(os.environ, PATH="{}:{}".format(self.bin, os.environ.get("PATH", "")),
                       FAKE_SUDO_LOG=str(self.sudo_log), FAKE_MARKER=str(self.marker), **env)
        process = subprocess.Popen([shell] + argv[1:], env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        if stop is not None:
            deadline = time.monotonic() + 10
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(ready.exists(), "the installer never started")
            # What a closed SSH channel, a timeout or ^C delivers: the whole process group.
            os.killpg(process.pid, stop)
        _, stderr = process.communicate(timeout=30)
        if self.marker.exists():
            # Whatever the script leaves behind is removed by force, even when a test fails.
            left = self.marker.read_text()
            self.addCleanup(subprocess.run, ["sh", "-c", 'chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"', "sh", left])
        return process.returncode, stderr.decode()

    def install_dir(self):
        """Where the script unpacked the installer's download."""
        path = Path(self.marker.read_text())
        self.assertTrue(path.name.startswith("sentinel-install."))
        return path

    def test_the_installer_runs_its_exit_status_is_kept_and_the_root_owned_download_is_removed(self):
        for shell in self.SHELLS:
            for exit_code in ("0", "3"):
                with self.subTest(shell=shell, exit=exit_code):
                    code, stderr = self.run_script(shell, FAKE_INSTALL_EXIT=exit_code)
                    self.assertEqual((code, stderr), (int(exit_code), ""))
                    log = self.sudo_log.read_text()
                    self.assertIn("neat install sentinel -d", log)
                    self.assertIn("-n rm -rf -- /tmp/sentinel-install.", log)
                    self.assertFalse(self.install_dir().exists())

    def test_the_root_owned_download_is_removed_when_the_install_is_interrupted(self):
        for shell in self.SHELLS:
            for stop, status in ((signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
                with self.subTest(shell=shell, signal=stop.name):
                    code, stderr = self.run_script(shell, stop=stop, FAKE_INSTALL_WAIT="1")
                    self.assertEqual(code, status, stderr)
                    self.assertFalse(self.install_dir().exists())

    def test_a_board_whose_sudo_needs_a_password_stops_before_anything_runs(self):
        for shell in self.SHELLS:
            with self.subTest(shell=shell):
                code, stderr = self.run_script(shell, FAKE_SUDO_DENY="1")
                self.assertEqual((code, stderr.strip()), (77, "sudo: a password is required"))
                self.assertFalse(self.marker.exists())


class MetricViewTests(unittest.TestCase):
    def test_values_are_labelled_grouped_ranked_and_ordered_and_history_is_aligned_per_metric(self):
        built = metrics.build(DEFINITIONS, SAMPLE, [], 0)
        by_key = {m["key"]: m for group in built["groups"] for m in group["metrics"]}
        self.assertEqual((by_key["rtsn_0"]["label"], by_key["rtsn_0"]["unit"], by_key["rtsn_0"]["status"]), ("MLA RTSN-0", "C", "warn"))
        self.assertEqual(by_key["linux_mem_used_pct"]["status"], "critical")
        self.assertEqual([group["name"] for group in built["groups"]], ["MLA", "Memory", "Other", "Power"])
        self.assertEqual(built["sampled_at"], SAMPLE["sample"]["timestamp"])
        self.assertEqual(built["counts"], {"total": 4, "unavailable": 1, "warn": 1, "critical": 1})
        self.assertEqual(built["order"], ["rtsn_0", "power_current_watts", "linux_mem_used_pct", "cvu_clock_mhz"])
        # An unavailable metric stays null and is never zero; a value without a definition is still shown.
        self.assertEqual((by_key["power_current_watts"]["value"], by_key["power_current_watts"]["status"]), (None, "unavailable"))
        extra = by_key["cvu_clock_mhz"]
        self.assertEqual((extra["group"], extra["label"], extra["unit"]), ("Other", "Cvu clock mhz", None))
        # Highlights lead with headline metrics and the hottest sensor.
        self.assertEqual(built["highlights"], ["power_current_watts", "linux_mem_used_pct", "rtsn_0"])
        # History is off unless asked for, and aligned per metric.
        history = [sample("t1", rtsn_0=60.0)["sample"], sample("t2", rtsn_0=61.0)["sample"]]
        self.assertEqual(metrics.build(DEFINITIONS, SAMPLE, history, 0)["history"]["timestamps"], [])
        series = metrics.build(DEFINITIONS, SAMPLE, history, 1)["history"]
        self.assertEqual((series["timestamps"], series["series"]["rtsn_0"], series["series"]["power_current_watts"]), (["t2"], [61.0], [None]))


class BoardCacheTests(unittest.TestCase):
    KEY = (1, "fp-1")

    def setUp(self):
        self.cache = state.BoardCache(history_limit=3)

    def stamps(self, samples, tail=None):
        return [s["timestamp"][-tail:] if tail else s["timestamp"] for s in samples]

    def test_a_new_daemon_run_starts_the_history_again_and_reseeds_it(self):
        self.cache.observe_daemon(self.KEY, "inv-1")
        self.cache.record(self.KEY, "definitions", DEFINITIONS, 60)
        self.cache.add_sample(self.KEY, {"timestamp": "2026-09-23T17:54:21Z", "values": {"load": 1}})
        self.cache.seed(self.KEY, [{"timestamp": "2026-09-23T17:54:20Z", "values": {"load": 0}}])
        self.cache.observe_daemon(self.KEY, "inv-1")
        self.assertFalse(self.cache.needs_seed(self.KEY))
        self.assertEqual(len(self.cache.history(self.KEY)), 2)
        self.cache.observe_daemon(self.KEY, "inv-2")
        self.assertTrue(self.cache.needs_seed(self.KEY))
        self.assertIsNone(self.cache.get(self.KEY, "definitions"))
        after = self.cache.add_sample(self.KEY, {"timestamp": "2026-09-23T17:54:22Z", "values": {"load": 2}})
        self.assertEqual(after, [{"timestamp": "2026-09-23T17:54:22Z", "values": {"load": 2}}])

    def test_values_and_history_are_keyed_by_generation_and_fingerprint_and_expire(self):
        second = (1, "fp-2")
        self.cache.record(self.KEY, "definitions", DEFINITIONS, 60)
        self.cache.add_sample(self.KEY, {"timestamp": "t1", "values": {}})
        self.assertIsNone(self.cache.get(second, "definitions"))
        self.assertEqual(self.cache.history(second), [])
        self.assertEqual(self.cache.add_sample(second, {"timestamp": "t2", "values": {}}), [{"timestamp": "t2", "values": {}}])
        self.assertIsNone(self.cache.get(self.KEY, "definitions"))
        self.cache.record(self.KEY, "daemon", {"healthy": True}, 60)
        self.assertEqual(self.cache.get(self.KEY, "daemon"), {"healthy": True})
        self.cache.record(self.KEY, "daemon", {"healthy": True}, -1)
        self.assertIsNone(self.cache.get(self.KEY, "daemon"))

    def test_the_daemons_samples_go_before_the_polled_ones_once_per_board_bounded_like_the_history(self):
        cache = state.BoardCache(history_limit=5)
        cache.add_sample(self.KEY, {"timestamp": "2026-09-22T20:55:50Z", "values": {}})
        self.assertTrue(cache.needs_seed(self.KEY))
        # The already-polled 50Z is not taken twice, and an unreadable timestamp is dropped.
        seeded = cache.seed(self.KEY, [{"timestamp": "2026-09-22T20:55:{}Z".format(s), "values": {}} for s in ("44", "46", "48", "50")]
                            + [{"timestamp": "not a time", "values": {}}])
        self.assertEqual(self.stamps(seeded, 3), ["44Z", "46Z", "48Z", "50Z"])
        self.assertFalse(cache.needs_seed(self.KEY))
        self.assertTrue(cache.needs_seed((2, "fp-1")), "another board is seeded again")
        samples = [{"timestamp": f"2026-09-22T20:55:{second:02d}Z", "values": {}} for second in range(0, 20, 2)]
        self.assertEqual(self.stamps(state.BoardCache(history_limit=3).seed(self.KEY, samples), 3), ["14Z", "16Z", "18Z"])

    def test_a_seed_that_does_not_join_the_polled_history_is_dropped(self):
        cache = state.BoardCache(history_limit=5, history_gap_sec=60)
        cache.add_sample(self.KEY, {"timestamp": "2026-09-22T21:00:00Z", "values": {}})
        seeded = cache.seed(self.KEY, [{"timestamp": "2026-09-22T20:50:00Z", "values": {}}])
        self.assertEqual(self.stamps(seeded), ["2026-09-22T21:00:00Z"])
        self.assertFalse(cache.needs_seed(self.KEY), "a failed or unusable seed is not retried on every poll")

    def test_a_break_in_the_polling_starts_the_history_again(self):
        # Verbatim from the sandbox on 2026-09-23: closed at 17:54 and reopened at 19:39, the gap drew as one sparkline step.
        for stamp in ("2026-09-23T17:54:19.918200185Z", "2026-09-23T17:54:21.908397571Z"):
            self.cache.add_sample(self.KEY, {"timestamp": stamp, "values": {"cpu_usage_pct": 1.0}})
        after = self.cache.add_sample(self.KEY, {"timestamp": "2026-09-23T19:39:58.301197766Z", "values": {"cpu_usage_pct": 2.0}})
        self.assertEqual(self.stamps(after), ["2026-09-23T19:39:58.301197766Z"])
        # Sentinel's own cadence, and Insight's slowest backed-off poll, are not a break.
        for stamp in ("2026-09-23T19:40:00.301197766Z", "2026-09-23T19:40:30.301197766Z"):
            self.cache.add_sample(self.KEY, {"timestamp": stamp, "values": {}})
        self.assertEqual(len(self.cache.history(self.KEY)), 3)
        # A board clock correction starts another history epoch.
        corrected = self.cache.add_sample(self.KEY, {"timestamp": "2026-09-23T18:00:00Z", "values": {}})
        self.assertEqual(self.stamps(corrected), ["2026-09-23T18:00:00Z"])

    def test_a_confirmed_backward_clock_correction_starts_the_history_again(self):
        self.cache.add_sample(self.KEY, {"timestamp": "2026-09-23T19:40:30Z", "values": {}})
        corrected = {"timestamp": "2026-09-23T19:40:00Z", "values": {}}
        self.assertEqual(self.cache.add_sample(self.KEY, corrected), [corrected])
        self.assertFalse(self.cache.needs_seed(self.KEY))
        later = {"timestamp": "2026-09-23T19:41:02Z", "values": {}}
        self.assertEqual(self.cache.add_sample(self.KEY, later), [later])
        self.assertTrue(self.cache.needs_seed(self.KEY))
        mixed = [
            {"timestamp": "2026-09-23T19:40:28Z", "values": {"epoch": "old"}},
            {"timestamp": "2026-09-23T19:40:30Z", "values": {"epoch": "old"}},
            corrected,
            {"timestamp": "2026-09-23T19:40:02Z", "values": {"epoch": "new"}},
        ]
        seeded = self.cache.seed(self.KEY, mixed)
        self.assertNotIn("old", [sample.get("values", {}).get("epoch") for sample in seeded])
        self.assertEqual(self.stamps(seeded), ["2026-09-23T19:40:00Z", "2026-09-23T19:40:02Z", "2026-09-23T19:41:02Z"])

    def test_history_is_bounded_ignores_a_repeated_sample_and_keeps_unreadable_timestamps(self):
        for stamp in ("2026-09-23T19:40:00Z", "not-a-timestamp", "2026-09-23T19:40:02Z"):
            self.cache.add_sample(self.KEY, {"timestamp": stamp, "values": {}})
        self.assertEqual(len(self.cache.history(self.KEY)), 3)
        for unreadable in ("not-a-timestamp", None, ""):
            self.assertIsNone(state.moment(unreadable))
        # Nanoseconds are truncated to the microseconds a datetime carries, never rounded.
        self.assertEqual(state.moment("2026-09-23T19:39:58.301197766Z").microsecond, 301197)
        # History is bounded and ignores a repeated sample.
        other = (2, "fp-1")
        for index in list(range(5)) + [4]:
            self.cache.add_sample(other, {"timestamp": "t{}".format(index), "values": {}})
        self.assertEqual(self.stamps(self.cache.history(other)), ["t2", "t3", "t4"])

    def test_identity_is_read_once_per_window_and_again_for_another_board(self):
        transport = FakeSentinel()
        session, other = FakeSession(transport), FakeSession(transport, generation=2, fingerprint="fp-2")
        self.cache.identity(session)
        self.cache.identity(session)
        self.assertEqual(session.identity_calls, 1)
        self.cache.identity(session, ttl=0)
        self.assertEqual(session.identity_calls, 2)
        self.cache.identity(other)
        self.cache.identity(other)
        self.assertEqual(other.identity_calls, 1)


class _ApiCase(unittest.TestCase):
    """The Sentinel blueprint on a Flask test client, against a fake board."""

    def setUp(self):
        cache = mock.patch.object(api, "cache", state.BoardCache())
        cache.start()
        self.addCleanup(cache.stop)
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)
        self.manager = FakeManager(self.session)
        app = Flask(__name__)
        app.register_blueprint(board_bp)
        app.register_blueprint(sentinel_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def call(self, method, path, **kwargs):
        response = getattr(self.client, method)(path, **kwargs)
        self.addCleanup(response.close)
        return response

    def get(self, path):
        return self.call("get", path)

    def post(self, path, **kwargs):
        return self.call("post", path, **kwargs)

    def delete(self, path):
        return self.call("delete", path)

    def refused(self, response, status, code):
        body = response.get_json()
        self.assertEqual((response.status_code, body["code"]), (status, code))
        return body

    def refused_for_another_board(self, method, path, error=None, hint=None, **kwargs):
        """The page showed board A; the selected board is now generation 1, not 7: refused before anything runs."""
        body = self.refused(self.call(method, path + "?generation=7", **kwargs), 409, "stale_snapshot")
        self.assertEqual(body["expected_generation"], 7)
        if error:
            self.assertIn(error, body["error"])
        malformed = self.refused(self.call(method, path + "?generation=latest", **kwargs), 400, "invalid_request")
        if hint:
            self.assertIn(hint, malformed["hint"])
        self.assertEqual(self.transport.calls, [])


class SentinelApiTests(_ApiCase):
    def test_availability_reports_the_daemon_and_the_board(self):
        response = self.get("/api/sentinel")
        body = response.get_json()
        self.assertEqual((response.status_code, response.headers["Cache-Control"]), (200, "no-store"))
        self.assertTrue(body["available"])
        self.assertEqual(body["status"], {"state": "ready", "error": None})
        self.assertEqual((body["version"], body["schema"], body["generation"]), (HEALTH["version"], 1, 1))
        self.assertEqual((body["board"]["fingerprint"], body["board"]["label"]), ("fp-1", "sima@192.168.2.2"))
        self.assertEqual(body["daemon"]["service"], "active")
        self.assertEqual(body["health"]["cached_samples"], HEALTH["cached_samples"])
        self.assertNotIn("schema", body["health"])

    def test_a_missing_or_failing_daemon_is_reported_as_a_state_without_an_error_status(self):
        self.transport.status_fields = ["inactive", "no", "no", ""]
        body = self.get("/api/sentinel").get_json()
        self.assertFalse(body["available"])
        self.assertEqual(body["status"]["state"], "missing")
        self.assertEqual((body["status"]["error"]["code"], body["status"]["error"]["error"]), ("sentinel_missing", "Sentinel is not installed on this board."))
        self.assertIn("sima-cli neat install sentinel", body["status"]["error"]["hint"])
        self.assertIsNone(body["health"])
        self.assertEqual(self.transport.api_paths, [])
        self.transport.status_fields = list(STATUS_FIELDS)
        self.transport.answer("GET", "/v1/health", 200, dict(HEALTH, schema=7))
        api.cache = state.BoardCache()
        body = self.get("/api/sentinel").get_json()
        self.assertEqual((body["status"]["state"], body["status"]["error"]["code"], body["available"]), ("error", "sentinel_schema", False))

    def test_board_errors_pass_through_with_their_status(self):
        self.manager.error = BoardError("no_target", "No board is selected.", hint="Select one.")
        self.refused(self.get("/api/sentinel"), 409, "no_target")
        self.manager.error = None
        self.transport.exec_error = BoardError("timeout", "too slow")
        self.refused(self.get("/api/sentinel/metrics"), 504, "timeout")

    def test_metrics_join_definitions_with_the_latest_sample_fetched_once_per_window(self):
        body = self.get("/api/sentinel/metrics").get_json()
        by_key = {m["key"]: m for group in body["groups"] for m in group["metrics"]}
        self.assertEqual((by_key["rtsn_0"]["value"], by_key["power_current_watts"]["value"]), (72.0, None))
        self.assertEqual((body["board"]["fingerprint"], body["history"]["timestamps"]), ("fp-1", []))
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T20:55:49Z"))
        body = self.get("/api/sentinel/metrics?history=5").get_json()
        self.assertEqual(self.transport.api_paths.count(("GET", "/v1/metrics")), 1)
        self.assertEqual(body["history"]["timestamps"], ["2026-09-22T20:55:47Z", "2026-09-22T20:55:49Z"])
        self.assertEqual(body["history"]["series"]["rtsn_0"], [72.0, 72.0])

    def test_the_first_metrics_read_seeds_history_from_the_daemons_cache(self):
        seed = [sample(f"2026-09-22T20:55:{second}Z", rtsn_0=60.0 + i)["sample"] for i, second in enumerate(("41", "43", "45"))]
        self.transport.export_result = export_table(seed)
        body = self.get("/api/sentinel/metrics?history=64").get_json()
        self.assertEqual(body["history"]["timestamps"][-4:], [s["timestamp"] for s in seed] + ["2026-09-22T20:55:47Z"])
        self.assertEqual(body["history"]["series"]["rtsn_0"], [60.0, 61.0, 62.0, 72.0])
        self.assertEqual(self.transport.exports[0][3:], ["sh", "240"])
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T20:55:49Z"))
        self.get("/api/sentinel/metrics?history=64")
        self.assertEqual(len(self.transport.exports), 1, "the cache is read once per board, not per poll")

    def test_a_gap_in_polling_reads_the_daemons_cache_again(self):
        self.get("/api/sentinel/metrics?history=240")
        self.assertEqual(len(self.transport.exports), 1)
        # Nobody polled for ten minutes; the daemon kept its own window meanwhile.
        seed = [sample(f"2026-09-22T21:05:{second}Z")["sample"] for second in ("40", "42", "44")]
        self.transport.export_result = export_table(seed)
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T21:05:46Z"))
        body = self.get("/api/sentinel/metrics?history=240").get_json()
        self.assertEqual(len(self.transport.exports), 2)
        self.assertEqual(body["history"]["timestamps"], [s["timestamp"] for s in seed] + ["2026-09-22T21:05:46Z"])

    def test_metrics_still_answer_when_the_cache_cannot_be_read(self):
        for result in (ExecResult(127, b"", b"python3: not found"), ExecResult(0, b"not json", b""), ExecResult(0, b"{}", b""), ExecResult(0, b"[]", b"")):
            with self.subTest(result=result):
                api.cache = state.BoardCache()
                self.transport.export_result = result
                response = self.get("/api/sentinel/metrics?history=64")
                self.assertEqual((response.status_code, response.get_json()["history"]["timestamps"]), (200, ["2026-09-22T20:55:47Z"]))

    def test_history_never_spans_a_daemon_restart(self):
        self.transport.status_fields = ["active", "yes", "yes", "/usr/bin/sima-cli", "inv-1", "60"]
        self.get("/api/sentinel/metrics")
        # Restarted within the status cache's lifetime: each read still asks systemd afresh.
        self.transport.status_fields = ["active", "yes", "yes", "/usr/bin/sima-cli", "inv-2", "1"]
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T20:55:49Z"))
        body = self.get("/api/sentinel/metrics?history=5").get_json()
        self.assertEqual(body["history"]["timestamps"], ["2026-09-22T20:55:49Z"])
        self.assertEqual(len(self.transport.exports), 2, "the new daemon's own window is read again")

    def test_telemetry_retries_when_the_daemon_restarts_mid_read(self):
        statuses = [
            {"instance_id": "inv-1"},
            {"instance_id": "inv-2"},
            {"instance_id": "inv-2"},
            {"instance_id": "inv-2"},
        ]
        with mock.patch.object(api.install, "status", side_effect=statuses), mock.patch.object(
            api.cache_history, "read", return_value=[]
        ):
            response = self.get("/api/sentinel/metrics?history=5")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(self.transport.api_paths.count(("GET", "/v1/samples/latest")), 2)
        self.assertEqual(self.transport.api_paths.count(("GET", "/v1/metrics")), 2)

    def test_telemetry_reads_hold_the_metrics_lock(self):
        held = []

        def latest(client):
            held.append(api._METRICS_LOCK.locked())
            return client.get("/v1/samples/latest")

        with mock.patch.object(api.SentinelClient, "latest", latest):
            self.get("/api/sentinel/metrics")
        self.assertEqual(held, [True])

    def test_telemetry_recovers_after_the_board_clock_moves_backward(self):
        key = (1, "fp-1")
        api.cache.observe_daemon(key, "inv-1")
        api.cache.add_sample(key, sample("2026-09-22T20:56:19Z")["sample"])
        api.cache.seed(key, [])
        corrected = sample("2026-09-22T20:55:49Z")
        with mock.patch.object(api.install, "status", return_value={"instance_id": "inv-1"}), mock.patch.object(
            api.SentinelClient, "latest", return_value=corrected
        ), mock.patch.object(api.cache_history, "read", return_value=[]) as read_history:
            response = self.get("/api/sentinel/metrics?history=5")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["history"]["timestamps"], ["2026-09-22T20:55:49Z"])
        read_history.assert_not_called()

    def test_history_never_mixes_two_boards(self):
        self.get("/api/sentinel/metrics")
        self.manager.current = FakeSession(self.transport, generation=2, fingerprint="fp-2")
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T21:00:00Z"))
        body = self.get("/api/sentinel/metrics?history=5").get_json()
        self.assertEqual((body["history"]["timestamps"], body["board"]["fingerprint"]), (["2026-09-22T21:00:00Z"], "fp-2"))

    def test_invalid_requests_never_reach_the_board(self):
        self.refused(self.get("/api/sentinel/metrics?history=lots"), 400, "invalid_request")
        for body in ({}, {"name": ""}, {"name": "a", "tags": "x"}, {"name": "a", "note": 3}, []):
            with self.subTest(body=body):
                self.refused(self.post("/api/sentinel/traces", json=body), 400, "invalid_request")
        # /api/sentinel/compare splits its runs on commas, so a run named "before,after" could never be compared.
        for name in ("before,after", "a, b", ","):
            with self.subTest(name=name):
                self.assertIn("comma", self.refused(self.post("/api/sentinel/traces", json={"name": name}), 400, "invalid_request")["error"])
        self.assertIn("baseline", self.refused(self.get("/api/sentinel/compare?runs=baseline"), 400, "invalid_request")["hint"])
        self.assertEqual(self.transport.calls, [])

    def test_traces_report_start_stop_and_conflict_through_the_daemon(self):
        active = {"trace": {"name": "baseline"}, "summary": {"samples": 12}}
        self.transport.answer("GET", "/v1/traces/active", 200, dict(active, schema=1))
        self.assertEqual(self.get("/api/sentinel/traces").get_json()["sentinel"], active)
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"name": "baseline"}})
        response = self.post("/api/sentinel/traces", json={"name": " baseline ", "note": "n", "tags": ["t"]})
        self.assertEqual((response.status_code, response.get_json()["sentinel"]), (200, {"trace": {"name": "baseline"}}))
        self.assertEqual(json.loads(self.transport.calls[-1][0][4]), {"name": "baseline", "note": "n", "tags": ["t"]})
        self.transport.answer("POST", "/v1/traces/stop", 200, {"schema": 1, "run": {"id": "r1"}})
        self.assertEqual(self.post("/api/sentinel/traces/stop").get_json()["sentinel"], {"run": {"id": "r1"}})
        self.assertEqual(self.transport.api_paths[-1], ("POST", "/v1/traces/stop"))
        # A conflicting trace keeps the daemon's conflict.
        self.transport.answer("POST", "/v1/traces", 409, {"error": "a trace is already active"})
        body = self.refused(self.post("/api/sentinel/traces", json={"name": "baseline"}), 409, "trace_conflict")
        self.assertEqual(body["error"], "a trace is already active")
        self.assertIn("Stop the active trace", body["hint"])

    def test_stopping_a_trace_read_from_another_board_is_refused_before_anything_runs(self):
        self.refused_for_another_board("post", "/api/sentinel/traces/stop", "no trace was stopped", "the active trace")
        self.transport.answer("POST", "/v1/traces/stop", 200, {"schema": 1, "run": {"id": "r1"}})
        self.assertEqual(self.post("/api/sentinel/traces/stop?generation=1").status_code, 200)
        self.assertEqual(self.transport.api_paths[-1], ("POST", "/v1/traces/stop"))

    def test_install_offered_for_another_board_is_refused_before_anything_runs(self):
        self.refused_for_another_board("post", "/api/sentinel/install", "nothing was installed", "the Sentinel state")
        # The displayed board is still the selected one: the request reaches the installer.
        self.assertEqual(self.post("/api/sentinel/install?generation=1").get_json()["code"], "already_installed")

    def test_a_trace_started_from_another_boards_form_is_refused_before_anything_runs(self):
        self.refused_for_another_board("post", "/api/sentinel/traces", "no trace was started", json={"name": "baseline"})
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"id": "t1"}})
        self.assertEqual(self.post("/api/sentinel/traces?generation=1", json={"name": "baseline"}).status_code, 200)
        self.assertEqual(self.transport.api_paths[-1], ("POST", "/v1/traces"))

    def test_stop_refuses_a_trace_that_replaced_the_one_on_screen(self):
        # Another client stopped trace-a and started trace-b on the same board: the generation is unchanged.
        self.transport.answer("GET", "/v1/traces/active", 200, {"schema": 1, "trace": {"id": "trace-b"}, "summary": None})
        for path in ("/api/sentinel/traces/stop?generation=1&trace_id=trace-a", "/api/sentinel/traces/stop?trace_id=trace-a"):
            body = self.refused(self.post(path), 409, "trace_conflict")
            self.assertEqual((body["expected_trace_id"], body["active_trace_id"]), ("trace-a", "trace-b"))
        self.transport.answer("GET", "/v1/traces/active", 200, {"schema": 1, "trace": None, "summary": None})
        self.assertEqual(self.post("/api/sentinel/traces/stop?trace_id=trace-a").get_json()["code"], "trace_conflict")
        self.assertNotIn(("POST", "/v1/traces/stop"), self.transport.api_paths)
        self.refused(self.post("/api/sentinel/traces/stop?trace_id=%20"), 400, "invalid_request")

    def test_stop_checks_the_displayed_trace_and_stops_it_under_the_trace_lock(self):
        held = []
        self.transport.answer("GET", "/v1/traces/active", 200, {"schema": 1, "trace": {"id": "trace-a"}, "summary": None})
        self.transport.answer("POST", "/v1/traces/stop", 200, {"schema": 1, "run": {"id": "trace-a"}})
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"id": "trace-b"}})
        answer = self.transport._api_call

        def locked_call(argv):
            held.append((argv[2], argv[3], api._TRACE_LOCK.locked()))
            return answer(argv)
        with mock.patch.object(self.transport, "_api_call", side_effect=locked_call):
            self.assertEqual(self.post("/api/sentinel/traces/stop?generation=1&trace_id=trace-a").status_code, 200)
            self.assertEqual(self.post("/api/sentinel/traces", json={"name": "next"}).status_code, 200)
        self.assertEqual(held, [("GET", "/v1/traces/active", True), ("POST", "/v1/traces/stop", True), ("POST", "/v1/traces", True)])

    def test_a_failure_names_the_board_generation_that_answered(self):
        self.session.generation = 4
        self.transport.answer("POST", "/v1/traces/stop", 409, {"error": "no active trace"})
        body = self.post("/api/sentinel/traces/stop").get_json()
        self.assertEqual((body["code"], body["generation"]), ("trace_conflict", 4))
        stale = self.post("/api/sentinel/traces/stop?generation=3").get_json()
        self.assertEqual((stale["code"], stale["expected_generation"], stale["generation"]), ("stale_snapshot", 3, 4))
        # Refused before the board is known: there is no generation to name.
        self.assertNotIn("generation", self.post("/api/sentinel/traces", json={"name": "a,b"}).get_json())

    def test_runs_are_listed_read_by_name_and_compared_in_order(self):
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [{"id": "r1", "name": "baseline"}]})
        self.transport.answer("GET", "/v1/runs/baseline", 200, {"schema": 1, "run": {"id": "r1"}})
        self.assertEqual(self.get("/api/sentinel/runs").get_json()["sentinel"]["runs"][0]["name"], "baseline")
        self.assertEqual(self.get("/api/sentinel/runs/baseline").get_json()["sentinel"]["run"], {"id": "r1"})
        self.refused(self.get("/api/sentinel/runs/nope"), 404, "not_found")
        self.transport.answer("GET", "/v1/compare?runs=baseline,optimized", 200, {"schema": 1, "runs": ["a"]})
        self.assertEqual(self.get("/api/sentinel/compare?runs=baseline, optimized").get_json()["sentinel"], {"runs": ["a"]})
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/compare?runs=baseline,optimized"))

    def test_install_refuses_to_restart_a_healthy_daemon_and_reports_a_new_ones_state_and_log(self):
        self.assertIn("trace in flight", self.refused(self.post("/api/sentinel/install"), 409, "already_installed")["hint"])
        api.cache = state.BoardCache()
        self.transport.status_fields = DOWN
        self.transport.heal_after_install()
        body = self.post("/api/sentinel/install").get_json()
        self.assertEqual((body["daemon"]["healthy"], body["log"]), (True, "Sentinel installed"))
        self.assertTrue(self.get("/api/sentinel").get_json()["available"])


RUN_A = {"id": "20260924T175231.958Z-baseline", "name": "baseline", "samples": 4}
RUN_B = {"id": "20260924T174111.540Z-optimized", "name": "optimized", "samples": 4}


class DeleteRunTests(_ApiCase):
    """DELETE /api/sentinel/runs/<run>: resolved against the daemon's list, then the CLI."""

    def setUp(self):
        super().setUp()
        self.runs(RUN_A, RUN_B)

    def runs(self, *listed):
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": list(listed)})

    def listed(self):
        return self.transport.api[("GET", "/v1/runs")][1]["runs"]

    def test_a_run_is_deleted_by_name_or_id_with_the_id_sentinel_reports(self):
        response = self.delete("/api/sentinel/runs/baseline?generation=1")
        body = response.get_json()
        self.assertEqual((response.status_code, body["deleted"], body["sentinel"]), (200, {"id": RUN_A["id"], "name": "baseline"}, {"runs": [RUN_B]}))
        self.assertEqual((body["generation"], body["board"]["fingerprint"]), (1, "fp-1"))
        self.assertEqual(self.transport.deletes, [["sh", "-c", runs.DELETE_SCRIPT, "sh", RUN_A["id"]]])
        timeout = [t for argv, t, _ in self.transport.calls if argv[0] == "sh" and "runs delete" in argv[2]][0]
        self.assertEqual(timeout, runs.DELETE_TIMEOUT_SEC)
        # The list is read before the delete to validate the ref, and after it to confirm it.
        self.assertEqual(self.transport.api_paths, [("GET", "/v1/runs"), ("GET", "/v1/runs")])
        self.assertEqual(self.listed(), [RUN_B])
        body = self.delete("/api/sentinel/runs/" + RUN_B["id"]).get_json()
        self.assertEqual((body["deleted"], self.transport.deletes[1][4]), ({"id": RUN_B["id"], "name": "optimized"}, RUN_B["id"]))
        # The script finds the CLI off a non-login PATH.
        for part in ("command -v simaai-sentinel", "/usr/local/bin/simaai-sentinel", 'exec "$cli" runs delete "$1"'):
            self.assertIn(part, runs.DELETE_SCRIPT)

    def test_a_ref_that_cannot_be_deleted_safely_is_refused_and_nothing_runs(self):
        body = self.refused(self.delete("/api/sentinel/runs/nope"), 404, "not_found")
        self.assertEqual((body["error"], body["run"]), ("unknown run 'nope'", "nope"))
        self.assertEqual(self.listed(), [RUN_A, RUN_B])
        self.runs({"id": "--all", "name": "sneaky"})
        self.refused(self.delete("/api/sentinel/runs/sneaky"), 400, "invalid_request")
        # A reference shared by two runs is refused, whether it appears in names or ids.
        self.runs(RUN_A, dict(RUN_B, name="baseline"))
        self.assertIn("unique", self.delete("/api/sentinel/runs/baseline").get_json()["hint"])
        self.runs(RUN_A, {"name": RUN_A["id"], "samples": 1})
        self.assertIn("unique", self.delete("/api/sentinel/runs/" + RUN_A["id"]).get_json()["hint"])
        self.runs(dict(RUN_A, state="recording"))
        self.assertIn("Stop the trace", self.refused(self.delete("/api/sentinel/runs/baseline"), 409, "trace_conflict")["hint"])
        self.assertEqual(self.transport.deletes, [])

    def test_a_hostile_name_never_reaches_a_shell(self):
        hostile = "x'; rm -rf / #$(reboot)`id` && \"$HOME\" | tee /tmp/p; *"
        # Not on the board: refused before anything runs.
        response = self.delete("/api/sentinel/runs/" + quote(hostile, safe=""))
        self.assertEqual((response.status_code, response.get_json()["run"]), (404, hostile))
        self.assertEqual(self.transport.deletes, [])
        # On the board, with an equally hostile id: the id travels as "$1", outside the script, and survives SSH quoting.
        evil = {"id": "$(reboot);'`id`\nreboot", "name": hostile}
        self.runs(evil, RUN_B)
        self.assertEqual(self.delete("/api/sentinel/runs/" + quote(hostile, safe="")).status_code, 200)
        argv = self.transport.deletes[0]
        self.assertEqual(argv, ["sh", "-c", runs.DELETE_SCRIPT, "sh", evil["id"]])
        self.assertNotIn(evil["id"], argv[2])
        self.assertNotIn(hostile, argv[2])
        self.assertEqual(shlex.split(shlex.join(argv)), argv)
        self.assertEqual(self.listed(), [RUN_B])

    def test_the_clis_answer_decides_the_failure_whatever_its_exit_status(self):
        stop_hint = {"hint": runs.STOP_HINT, "error": "cannot delete active run 'baseline'", "run": "baseline"}
        cases = (  # (exit, stdout, stderr), status, code, fields equal, fields containing
            ((0, b"", b"Error: cannot delete active run 'baseline'\n"), 409, "trace_conflict", stop_hint, {"detail": "cannot delete active run"}),
            ((0, b"Error: unknown completed run 'x'\n", b""), 404, "not_found", {"error": "unknown completed run 'x'"}, {}),
            ((0, b"", b"Error: disk on fire\n"), 502, "sentinel_failed", {"error": "disk on fire", "run": "baseline"}, {}),
            ((1, b"", b"Error: disk on fire\n"), 502, "sentinel_failed", {"error": "disk on fire", "run": "baseline"}, {}),
            ((2, b"usage: ...", b""), 502, "sentinel_failed", {"detail": "usage: ..."}, {"error": "exit 2"}),
            ((127, b"", b"simaai-sentinel: not found\n"), 502, "tool_missing", {"tool": "simaai-sentinel"}, {}),
            ((1, b"", b"Error: remove /var/lib/simaai-sentinel/runs/x.json: Permission denied\n"), 502, "sentinel_denied", {}, {"hint": runs.RUNS_DIR}),
            ((0, b"", b""), 502, "sentinel_failed", {}, {"error": "still lists run 'baseline'"}),
        )
        for result, status, code, equal, contains in cases:
            with self.subTest(result=result):
                self.transport.delete_result = ExecResult(*result)
                body = self.refused(self.delete("/api/sentinel/runs/baseline"), status, code)
                self.assertEqual({key: body[key] for key in equal}, equal)
                for key, part in contains.items():
                    self.assertIn(part, body[key])

    def test_an_idless_run_is_confirmed_gone_by_its_name(self):
        # A run without an id is deleted by name, and its name is what must disappear.
        self.runs({"name": "legacy", "samples": 1})
        self.transport.delete_result = ExecResult(0, b"", b"")
        self.assertIn("still lists run 'legacy'", self.refused(self.delete("/api/sentinel/runs/legacy"), 502, "sentinel_failed")["error"])

    def test_another_board_generation_is_refused_before_anything_runs(self):
        self.refused_for_another_board("delete", "/api/sentinel/runs/baseline")

    def test_an_unreachable_board_keeps_its_status(self):
        self.transport.exec_error = BoardError("timeout", "too slow")
        self.refused(self.delete("/api/sentinel/runs/baseline"), 504, "timeout")


class SeedScriptTests(unittest.TestCase):
    """The cache-trimming script, run for real by sh with a fake simaai-sentinel that prints an export."""

    def test_the_newest_samples_come_back_oldest_first_and_rounded(self):
        with tempfile.TemporaryDirectory() as root:
            export = {"schema": 1, "metrics": [], "samples": [
                {"timestamp": f"2026-09-25T00:00:{second:02d}Z", "values": {"rtsn_0": 60.123456789 + second, "n": None}} for second in range(70)
            ]}
            cli = Path(root) / "simaai-sentinel"
            cli.write_text("#!/bin/sh\n[ \"$1\" = export ] && cat " + shlex.quote(str(Path(root) / "export.json")) + "\n")
            cli.chmod(0o755)
            (Path(root) / "export.json").write_text(json.dumps(export))
            env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}")
            out = subprocess.run(["sh", "-c", cache_history.SEED_SCRIPT, "sh", "64"], capture_output=True, env=env, check=True)
        table = json.loads(out.stdout)
        self.assertEqual(table["keys"], ["n", "rtsn_0"], "each key once")
        self.assertEqual(len(table["rows"]), 64)
        self.assertEqual((table["timestamps"][0], table["timestamps"][-1]), ("2026-09-25T00:00:06Z", "2026-09-25T00:00:69Z"))
        self.assertEqual(table["rows"][0], [None, 66.1235])

    def test_read_takes_only_well_formed_samples(self):
        table = {"timestamps": ["2026-09-25T00:00:00Z", 5, "2026-09-25T00:00:04Z"], "keys": ["rtsn_0", "cpu"], "rows": [[60.0, 12.5], [61.0, 13.0], [62.0]]}
        self.assertEqual(cache_history.read(StaticBoard(ExecResult(0, json.dumps(table).encode(), b""))),
                         [{"timestamp": "2026-09-25T00:00:00Z", "values": {"rtsn_0": 60.0, "cpu": 12.5}}],
                         "a row with a bad timestamp or the wrong width is dropped")
        mismatched = json.dumps(dict(table, rows=table["rows"][:2])).encode()
        for result in (ExecResult(0, mismatched, b""), BoardError("unreachable", "gone"), ExecResult(1, b"[]", b"boom")):
            self.assertEqual(cache_history.read(StaticBoard(result)), [])


if __name__ == "__main__":
    unittest.main()
