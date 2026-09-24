import contextlib
import io
import json
import os
import shlex
import socket
import socketserver
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult
from neat_insight.sentinel import api, install, metrics, runs, socket_client, state
from neat_insight.sentinel.api import sentinel_bp
from neat_insight.sentinel.client import SentinelClient
from neat_insight.sentinel.errors import SentinelError

HEALTH = {
    "schema": 1,
    "version": "main:80ab7de4da31",
    "cached_samples": 240,
    "metric_count": 3,
    "errors": [],
    "latest_sample_at": "2026-09-22T20:55:41.487425986Z",
    "updated_at": "2026-09-22T20:55:41.487582472Z",
    "active_trace": None,
}
DEFINITIONS = {
    "schema": 1,
    "metrics": [
        {
            "key": "rtsn_0",
            "label": "MLA RTSN-0",
            "short": "MLA-0",
            "unit": "C",
            "group": "MLA",
            "description": "On-die RTSN at the MLA Q0 site.",
            "warn": 70.0,
            "critical": 85.0,
        },
        {
            "key": "power_current_watts",
            "label": "Current board power",
            "short": "Current",
            "unit": "W",
            "group": "Power",
            "description": "Latest valid total PMBus POUT reading.",
            "warn": None,
            "critical": None,
        },
        {
            "key": "linux_mem_used_pct",
            "label": "Linux memory used",
            "short": "Mem%",
            "unit": "%",
            "group": "Memory",
            "description": "Linux memory usage.",
            "warn": 80.0,
            "critical": 90.0,
        },
    ],
}


def sample(timestamp: str, **values) -> dict:
    merged = {"rtsn_0": 72.0, "power_current_watts": None, "linux_mem_used_pct": 95.0, "cvu_clock_mhz": 800.0}
    merged.update(values)
    return {
        "schema": 1,
        "version": HEALTH["version"],
        "updated_at": timestamp,
        "sample": {"timestamp": timestamp, "values": merged},
    }


SAMPLE = sample("2026-09-22T20:55:47Z")
STATUS_FIELDS = ("active", "yes", "yes", "/usr/bin/sima-cli")


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
        # None deletes the run from the /v1/runs answer, as the CLI would; an ExecResult
        # is returned as the CLI's answer and deletes nothing.
        self.delete_result = None

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
        if "neat install sentinel" in script:
            return self.install_result
        return ExecResult(0, "@@".join(self.status_fields).encode(), b"")

    def _api_call(self, argv):
        method, path = argv[2], argv[3]
        answer = self.api.get((method, path))
        if answer is None:
            answer = (404, {"error": "unknown route '{}'".format(path)})
        status, body = answer
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

    @property
    def deletes(self):
        return [argv for argv, _, _ in self.calls if argv[0] == "sh" and "runs delete" in argv[2]]

    @property
    def api_paths(self):
        return [(argv[2], argv[3]) for argv, _, _ in self.calls if argv[0] == "python3"]

    @property
    def scripts(self):
        return [argv[2] for argv, _, _ in self.calls if argv[0] == "sh"]


class FakeSession:
    def __init__(self, transport, generation=1, fingerprint="fp-1", mode="ssh"):
        self.transport = transport
        self.generation = generation
        self.fingerprint = fingerprint
        self.target = SimpleNamespace(mode=mode, source="manual", label="sima@192.168.2.2")
        self.identity_calls = 0

    def identity(self):
        self.identity_calls += 1
        return {
            "hostname": "modalix",
            "machine": "modalix",
            "build_version": "2.1.3",
            "fingerprint": self.fingerprint,
        }


class FakeManager:
    def __init__(self, session=None):
        self.current = session
        self.error = None

    def session(self):
        if self.error:
            raise self.error
        return self.current


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


class SocketClientTests(unittest.TestCase):
    """The on-board client: real HTTP over a real unix socket, no network."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "api.sock")
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

    def test_get_returns_status_and_body_over_the_unix_socket(self):
        status, text = socket_client.request("GET", "/v1/health", socket_path=self.path)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(text), HEALTH)

    def test_post_sends_a_json_body_and_keeps_the_daemon_status(self):
        self.server.answers["/v1/traces"] = (409, {"error": "a trace is already active"})
        status, text = socket_client.request("POST", "/v1/traces", {"name": "a"}, socket_path=self.path)
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(text), {"error": "a trace is already active"})
        self.assertEqual(self.server.requests[-1], ("POST", "/v1/traces", '{"name": "a"}'))

    def test_an_on_board_client_reads_the_socket_without_the_transport(self):
        transport = FakeSentinel()
        client = SentinelClient(FakeSession(transport, mode="local"), socket_path=self.path)
        self.assertEqual(client.health(), HEALTH)
        self.assertEqual(transport.calls, [])
        with self.assertRaises(SentinelError) as raised:
            client.run("nope")
        self.assertEqual((raised.exception.code, raised.exception.status), ("not_found", 404))

    def test_a_missing_socket_is_classified_as_missing(self):
        with self.assertRaises(OSError) as raised:
            socket_client.request("GET", "/v1/health", socket_path=self.path + ".gone")
        self.assertEqual(socket_client.socket_failure(raised.exception), socket_client.MISSING)

    def test_main_prints_one_envelope_per_call(self):
        code, envelope = self.main("GET", "/v1/health", "", self.path)
        self.assertEqual((code, envelope["status"]), (0, 200))
        self.assertEqual(json.loads(envelope["text"]), HEALTH)

    def test_main_reports_a_socket_failure_instead_of_a_traceback(self):
        code, envelope = self.main("GET", "/v1/health", "", self.path + ".gone")
        self.assertEqual(code, 3)
        self.assertEqual(envelope["failure"], socket_client.MISSING)
        self.assertIn(self.path + ".gone", envelope["detail"])


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)
        self.client = SentinelClient(self.session)

    def test_a_remote_call_streams_the_client_to_python3_on_the_board(self):
        self.assertEqual(self.client.health(), HEALTH)
        argv, timeout, stdin = self.transport.calls[0]
        self.assertEqual(argv, ["python3", "-", "GET", "/v1/health", "", socket_client.SOCKET_PATH])
        self.assertEqual(stdin, Path(socket_client.__file__).read_bytes())
        self.assertGreater(timeout, socket_client.TIMEOUT_SEC)

    def test_a_post_passes_its_body_as_an_argument(self):
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"name": "baseline"}})
        self.client.start_trace("baseline", note="before", tags=["compiler-v1"])
        argv = self.transport.calls[-1][0]
        self.assertEqual(argv[:4], ["python3", "-", "POST", "/v1/traces"])
        self.assertEqual(json.loads(argv[4]), {"name": "baseline", "note": "before", "tags": ["compiler-v1"]})
        self.assertEqual(argv[5], socket_client.SOCKET_PATH)

    def test_compare_encodes_the_run_list_and_raw_flag(self):
        self.transport.answer("GET", "/v1/compare?runs=a,b&raw=1", 200, {"schema": 1, "runs": []})
        self.client.compare(["a", "b"], raw=True)
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/compare?runs=a,b&raw=1"))

    def test_a_run_name_with_a_slash_is_escaped(self):
        self.transport.answer("GET", "/v1/runs/a%2Fb", 200, {"schema": 1, "run": {}})
        self.client.run("a/b")
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/runs/a%2Fb"))

    def test_local_boards_use_the_socket_directly(self):
        session = FakeSession(self.transport, mode="local")
        client = SentinelClient(session, socket_path="/nonexistent/api.sock")
        with self.assertRaises(SentinelError) as raised:
            client.health()
        self.assertEqual(raised.exception.code, "sentinel_missing")
        self.assertEqual(self.transport.calls, [])

    def test_another_schema_is_refused_rather_than_misread(self):
        self.transport.answer("GET", "/v1/health", 200, dict(HEALTH, schema=2))
        with self.assertRaises(SentinelError) as raised:
            self.client.health()
        self.assertEqual((raised.exception.code, raised.exception.status), ("sentinel_schema", 502))
        self.assertEqual(raised.exception.to_dict()["schema"], 2)

    def test_daemon_statuses_survive_with_their_meaning(self):
        cases = {
            400: ("invalid_request", 400),
            404: ("not_found", 404),
            409: ("trace_conflict", 409),
            413: ("request_too_large", 413),
            500: ("sentinel_failed", 502),
        }
        for status, (code, http_status) in cases.items():
            with self.subTest(status=status):
                self.transport.answer("GET", "/v1/health", status, {"error": "no"})
                with self.assertRaises(SentinelError) as raised:
                    self.client.health()
                self.assertEqual((raised.exception.code, raised.exception.status), (code, http_status))
                self.assertEqual(raised.exception.to_dict()["error"], "no")
                self.assertEqual(raised.exception.to_dict()["sentinel_status"], status)

    def test_socket_failures_name_the_cause_and_the_fix(self):
        cases = {
            socket_client.MISSING: ("sentinel_missing", "sima-cli neat install sentinel"),
            socket_client.REFUSED: ("sentinel_missing", "systemctl start"),
            socket_client.DENIED: ("sentinel_denied", "0666"),
            socket_client.FAILED: ("sentinel_failed", "systemctl status"),
        }
        for failure, (code, hint) in cases.items():
            with self.subTest(failure=failure):
                envelope = json.dumps({"failure": failure, "detail": "boom"}).encode()
                self.transport.exec = lambda *a, **k: ExecResult(3, envelope, b"")
                with self.assertRaises(SentinelError) as raised:
                    self.client.health()
                self.assertEqual(raised.exception.code, code)
                self.assertIn(hint, raised.exception.hint)
                self.assertIn(socket_client.SOCKET_PATH, raised.exception.message)

    def test_a_board_without_python3_reports_the_missing_tool(self):
        self.transport.exec = lambda *a, **k: ExecResult(127, b"", b"python3: command not found")
        with self.assertRaises(BoardError) as raised:
            self.client.health()
        self.assertEqual((raised.exception.code, raised.exception.to_dict()["tool"]), ("tool_missing", "python3"))

    def test_unreadable_output_keeps_the_boards_error_text(self):
        self.transport.exec = lambda *a, **k: ExecResult(1, b"not json", b"Traceback: SyntaxError")
        with self.assertRaises(SentinelError) as raised:
            self.client.health()
        self.assertEqual(raised.exception.code, "sentinel_failed")
        self.assertIn("SyntaxError", raised.exception.to_dict()["detail"])

    def test_connection_failures_pass_through_untouched(self):
        self.transport.exec_error = BoardError("unreachable", "no route")
        with self.assertRaises(BoardError) as raised:
            self.client.health()
        self.assertEqual((raised.exception.code, raised.exception.status), ("unreachable", 502))


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)

    def state(self, *fields):
        self.transport.status_fields = list(fields)
        return install.status(self.session)

    def test_status_reads_the_service_socket_unit_and_cli(self):
        state = self.state(*STATUS_FIELDS)
        self.assertEqual(
            state,
            {
                "installed": True,
                "healthy": True,
                "service": "active",
                "socket": True,
                "socket_path": socket_client.SOCKET_PATH,
                "sima_cli": "/usr/bin/sima-cli",
            },
        )
        self.assertIn("systemctl is-active simaai-sentinel", self.transport.scripts[0])
        self.assertIn(socket_client.SOCKET_PATH, self.transport.scripts[0])
        self.assertIn(".sima-cli/.venv/bin/sima-cli", self.transport.scripts[0])

    def test_an_installed_but_stopped_daemon_is_not_healthy(self):
        state = self.state("inactive", "no", "yes", "")
        self.assertEqual((state["installed"], state["healthy"], state["sima_cli"]), (True, False, None))
        problem = install.describe(state)
        self.assertEqual(problem["code"], "sentinel_stopped")
        self.assertEqual(problem["error"], "The simaai-sentinel service is installed but inactive.")
        self.assertIn("systemctl start simaai-sentinel", problem["hint"])

    def test_a_board_without_the_unit_reports_a_missing_install(self):
        state = self.state("inactive", "no", "no", "")
        self.assertFalse(state["installed"])
        problem = install.describe(state)
        self.assertEqual(problem["code"], "sentinel_missing")
        self.assertIn("sima-cli neat install sentinel", problem["hint"])

    def test_describe_is_silent_when_sentinel_is_usable(self):
        self.assertIsNone(install.describe(self.state(*STATUS_FIELDS)))

    def test_a_healthy_install_is_never_reinstalled(self):
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        self.assertEqual((raised.exception.code, raised.exception.status), ("already_installed", 409))
        self.assertEqual(self.transport.scripts[1:], [])

    def test_install_runs_sima_cli_on_the_board_without_an_ip(self):
        self.transport.status_fields = ["inactive", "no", "no", "/home/sima/.sima-cli/.venv/bin/sima-cli"]
        after = ["active", "yes", "yes", "/home/sima/.sima-cli/.venv/bin/sima-cli"]

        def exec_once(argv, *, timeout, stdin=None):
            result = FakeSentinel.exec(self.transport, argv, timeout=timeout, stdin=stdin)
            if "neat install sentinel" in argv[2]:
                self.transport.status_fields = after
            return result

        self.transport.exec = exec_once
        result = install.install(self.session)
        script = self.transport.scripts[1]
        self.assertIn("SIMA_INSTALL_CONTEXT=1", script)
        self.assertIn("SIMA_CLI_CHECK_FOR_UPDATE=0", script)
        self.assertIn("'/home/sima/.sima-cli/.venv/bin/sima-cli'", script)
        self.assertIn("neat install sentinel -d", script)
        self.assertIn("mktemp -d", script)
        self.assertIn("sudo -n", script)
        self.assertNotIn("--ip", script)
        self.assertEqual((result["status"]["healthy"], result["log"]), (True, "Sentinel installed"))

    def test_install_without_sima_cli_says_where_to_get_it(self):
        self.transport.status_fields = ["inactive", "no", "no", ""]
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        self.assertEqual(raised.exception.to_dict()["tool"], "sima-cli")
        self.assertIn(install.MANUAL_COMMAND, raised.exception.hint)

    def test_install_without_passwordless_sudo_gives_the_manual_command(self):
        self.transport.status_fields = ["inactive", "no", "no", "/usr/bin/sima-cli"]
        self.transport.install_result = ExecResult(77, b"", b"sudo: a password is required")
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        self.assertEqual(raised.exception.code, "sentinel_denied")
        self.assertIn(install.MANUAL_COMMAND, raised.exception.hint)

    def test_a_failed_installer_keeps_its_output(self):
        self.transport.status_fields = ["inactive", "no", "no", "/usr/bin/sima-cli"]
        self.transport.install_result = ExecResult(1, b"downloading", b"vulcan: not found")
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        self.assertEqual(raised.exception.code, "sentinel_failed")
        self.assertIn("vulcan: not found", raised.exception.to_dict()["detail"])

    def test_an_installer_that_leaves_the_daemon_down_is_reported(self):
        self.transport.status_fields = ["inactive", "no", "no", "/usr/bin/sima-cli"]
        with self.assertRaises(SentinelError) as raised:
            install.install(self.session)
        self.assertIn("is inactive", raised.exception.message)


class MetricViewTests(unittest.TestCase):
    def build(self, latest=None, history=(), limit=0):
        return metrics.build(DEFINITIONS, latest or SAMPLE, list(history), limit)

    def test_values_are_labelled_grouped_and_ranked_against_thresholds(self):
        built = self.build()
        by_key = {m["key"]: m for group in built["groups"] for m in group["metrics"]}
        self.assertEqual(by_key["rtsn_0"]["label"], "MLA RTSN-0")
        self.assertEqual(by_key["rtsn_0"]["unit"], "C")
        self.assertEqual(by_key["rtsn_0"]["status"], "warn")
        self.assertEqual(by_key["linux_mem_used_pct"]["status"], "critical")
        self.assertEqual([group["name"] for group in built["groups"]], ["MLA", "Memory", "Other", "Power"])
        self.assertEqual(built["sampled_at"], SAMPLE["sample"]["timestamp"])
        self.assertEqual(built["counts"], {"total": 4, "unavailable": 1, "warn": 1, "critical": 1})

    def test_an_unavailable_metric_stays_null_and_is_never_zero(self):
        power = [m for g in self.build()["groups"] for m in g["metrics"] if m["key"] == "power_current_watts"][0]
        self.assertIsNone(power["value"])
        self.assertEqual(power["status"], "unavailable")

    def test_a_value_without_a_definition_is_still_shown(self):
        extra = [m for g in self.build()["groups"] for m in g["metrics"] if m["key"] == "cvu_clock_mhz"][0]
        self.assertEqual((extra["group"], extra["label"], extra["unit"]), ("Other", "Cvu clock mhz", None))

    def test_highlights_lead_with_headline_metrics_and_the_hottest_sensor(self):
        built = self.build()
        self.assertEqual(built["highlights"], ["power_current_watts", "linux_mem_used_pct", "rtsn_0"])

    def test_history_is_off_unless_asked_for_and_is_aligned_per_metric(self):
        history = [sample("t1", rtsn_0=60.0)["sample"], sample("t2", rtsn_0=61.0)["sample"]]
        self.assertEqual(self.build(history=history)["history"]["timestamps"], [])
        series = self.build(history=history, limit=1)["history"]
        self.assertEqual(series["timestamps"], ["t2"])
        self.assertEqual(series["series"]["rtsn_0"], [61.0])
        self.assertEqual(series["series"]["power_current_watts"], [None])


class BoardCacheTests(unittest.TestCase):
    def setUp(self):
        self.cache = state.BoardCache(history_limit=3)

    def test_values_and_history_are_keyed_by_generation_and_fingerprint(self):
        first, second = (1, "fp-1"), (1, "fp-2")
        self.cache.record(first, "definitions", DEFINITIONS, 60)
        self.cache.add_sample(first, {"timestamp": "t1", "values": {}})
        self.assertIsNone(self.cache.get(second, "definitions"))
        self.assertEqual(self.cache.history(second), [])
        self.assertEqual(self.cache.add_sample(second, {"timestamp": "t2", "values": {}}), [
            {"timestamp": "t2", "values": {}}
        ])
        self.assertIsNone(self.cache.get(first, "definitions"))

    def test_history_is_bounded_and_ignores_a_repeated_sample(self):
        key = (1, "fp-1")
        for index in range(5):
            self.cache.add_sample(key, {"timestamp": "t{}".format(index), "values": {}})
        self.cache.add_sample(key, {"timestamp": "t4", "values": {}})
        self.assertEqual([s["timestamp"] for s in self.cache.history(key)], ["t2", "t3", "t4"])

    def test_a_break_in_the_polling_starts_the_history_again(self):
        # Verbatim from the sandbox on 2026-09-23: the Stats page was open at 17:54, closed,
        # and reopened at 19:39. /api/sentinel/metrics?history=60 answered with all three
        # samples, so the sparklines drew a 105-minute gap as one step between neighbours.
        key = (1, "fp-1")
        for stamp in ("2026-09-23T17:54:19.918200185Z", "2026-09-23T17:54:21.908397571Z"):
            self.cache.add_sample(key, {"timestamp": stamp, "values": {"cpu_usage_pct": 1.0}})
        after = self.cache.add_sample(
            key, {"timestamp": "2026-09-23T19:39:58.301197766Z", "values": {"cpu_usage_pct": 2.0}}
        )
        self.assertEqual([s["timestamp"] for s in after], ["2026-09-23T19:39:58.301197766Z"])

        # Sentinel's own cadence, and Insight's slowest backed-off poll, are not a break.
        self.cache.add_sample(key, {"timestamp": "2026-09-23T19:40:00.301197766Z", "values": {}})
        self.cache.add_sample(key, {"timestamp": "2026-09-23T19:40:30.301197766Z", "values": {}})
        self.assertEqual(len(self.cache.history(key)), 3)

        # A board whose clock jumped backwards is just as much a break as one that jumped on.
        back = self.cache.add_sample(key, {"timestamp": "2026-09-23T18:00:00Z", "values": {}})
        self.assertEqual([s["timestamp"] for s in back], ["2026-09-23T18:00:00Z"])

    def test_a_timestamp_that_cannot_be_read_never_discards_the_history(self):
        key = (1, "fp-1")
        for stamp in ("2026-09-23T19:40:00Z", "not-a-timestamp", "2026-09-23T19:40:02Z"):
            self.cache.add_sample(key, {"timestamp": stamp, "values": {}})
        self.assertEqual(len(self.cache.history(key)), 3)
        self.assertIsNone(state.moment("not-a-timestamp"))
        self.assertIsNone(state.moment(None))
        self.assertIsNone(state.moment(""))
        # Nanoseconds are truncated to the microseconds a datetime carries, never rounded.
        self.assertEqual(state.moment("2026-09-23T19:39:58.301197766Z").microsecond, 301197)

    def test_an_expired_value_is_not_served(self):
        key = (1, "fp-1")
        self.cache.record(key, "daemon", {"healthy": True}, 60)
        self.assertEqual(self.cache.get(key, "daemon"), {"healthy": True})
        self.cache.record(key, "daemon", {"healthy": True}, -1)
        self.assertIsNone(self.cache.get(key, "daemon"))

    def test_identity_is_read_once_per_window_and_again_for_another_board(self):
        transport = FakeSentinel()
        session = FakeSession(transport)
        self.cache.identity(session)
        self.cache.identity(session)
        self.assertEqual(session.identity_calls, 1)
        self.cache.identity(session, ttl=0)
        self.assertEqual(session.identity_calls, 2)
        other = FakeSession(transport, generation=2, fingerprint="fp-2")
        self.cache.identity(other)
        self.cache.identity(other)
        self.assertEqual(other.identity_calls, 1)


class _ApiCase(unittest.TestCase):
    """The Sentinel blueprint on a Flask test client, against a fake board."""

    def setUp(self):
        cache = unittest.mock.patch.object(api, "cache", state.BoardCache())
        cache.start()
        self.addCleanup(cache.stop)
        self.transport = FakeSentinel()
        self.session = FakeSession(self.transport)
        self.manager = FakeManager(self.session)
        app = Flask(__name__)
        app.register_blueprint(sentinel_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def get(self, path):
        response = self.client.get(path)
        self.addCleanup(response.close)
        return response

    def post(self, path, **kwargs):
        response = self.client.post(path, **kwargs)
        self.addCleanup(response.close)
        return response

    def delete(self, path):
        response = self.client.delete(path)
        self.addCleanup(response.close)
        return response


class SentinelApiTests(_ApiCase):
    def test_availability_reports_the_daemon_and_the_board(self):
        response = self.get("/api/sentinel")
        body = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertTrue(body["available"])
        self.assertEqual(body["status"], {"state": "ready", "error": None})
        self.assertEqual(body["version"], HEALTH["version"])
        self.assertEqual(body["schema"], 1)
        self.assertEqual(body["board"]["fingerprint"], "fp-1")
        self.assertEqual(body["board"]["label"], "sima@192.168.2.2")
        self.assertEqual(body["generation"], 1)
        self.assertEqual(body["daemon"]["service"], "active")
        self.assertEqual(body["health"]["cached_samples"], HEALTH["cached_samples"])
        self.assertNotIn("schema", body["health"])

    def test_a_missing_daemon_is_reported_without_an_error_status(self):
        self.transport.status_fields = ["inactive", "no", "no", ""]
        body = self.get("/api/sentinel").get_json()
        self.assertFalse(body["available"])
        self.assertEqual(body["status"]["state"], "missing")
        self.assertEqual(body["status"]["error"]["code"], "sentinel_missing")
        self.assertEqual(body["status"]["error"]["error"], "Sentinel is not installed on this board.")
        self.assertIn("sima-cli neat install sentinel", body["status"]["error"]["hint"])
        self.assertIsNone(body["health"])
        self.assertEqual(self.transport.api_paths, [])

    def test_a_daemon_failure_is_reported_as_an_error_state(self):
        self.transport.answer("GET", "/v1/health", 200, dict(HEALTH, schema=7))
        body = self.get("/api/sentinel").get_json()
        self.assertEqual(body["status"]["state"], "error")
        self.assertEqual(body["status"]["error"]["code"], "sentinel_schema")
        self.assertFalse(body["available"])

    def test_no_selected_board_passes_the_board_error_through(self):
        self.manager.error = BoardError("no_target", "No board is selected.", hint="Select one.")
        response = self.get("/api/sentinel")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "no_target")

    def test_an_unreachable_board_keeps_its_status(self):
        self.transport.exec_error = BoardError("timeout", "too slow")
        response = self.get("/api/sentinel/metrics")
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.get_json()["code"], "timeout")

    def test_metrics_join_definitions_with_the_latest_sample(self):
        body = self.get("/api/sentinel/metrics").get_json()
        by_key = {m["key"]: m for group in body["groups"] for m in group["metrics"]}
        self.assertEqual(by_key["rtsn_0"]["value"], 72.0)
        self.assertIsNone(by_key["power_current_watts"]["value"])
        self.assertEqual(body["board"]["fingerprint"], "fp-1")
        self.assertEqual(body["history"]["timestamps"], [])

    def test_metric_definitions_are_fetched_once_per_window(self):
        self.get("/api/sentinel/metrics")
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T20:55:49Z"))
        body = self.get("/api/sentinel/metrics?history=5").get_json()
        self.assertEqual(self.transport.api_paths.count(("GET", "/v1/metrics")), 1)
        self.assertEqual(body["history"]["timestamps"], ["2026-09-22T20:55:47Z", "2026-09-22T20:55:49Z"])
        self.assertEqual(body["history"]["series"]["rtsn_0"], [72.0, 72.0])

    def test_history_never_mixes_two_boards(self):
        self.get("/api/sentinel/metrics")
        self.manager.current = FakeSession(self.transport, generation=2, fingerprint="fp-2")
        self.transport.answer("GET", "/v1/samples/latest", 200, sample("2026-09-22T21:00:00Z"))
        body = self.get("/api/sentinel/metrics?history=5").get_json()
        self.assertEqual(body["history"]["timestamps"], ["2026-09-22T21:00:00Z"])
        self.assertEqual(body["board"]["fingerprint"], "fp-2")

    def test_a_bad_history_window_is_refused_before_the_board_is_touched(self):
        response = self.get("/api/sentinel/metrics?history=lots")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_request")
        self.assertEqual(self.transport.calls, [])

    def test_traces_report_the_active_trace(self):
        self.transport.answer(
            "GET", "/v1/traces/active", 200, {"schema": 1, "trace": {"name": "baseline"}, "summary": {"samples": 12}}
        )
        body = self.get("/api/sentinel/traces").get_json()
        self.assertEqual(body["sentinel"], {"trace": {"name": "baseline"}, "summary": {"samples": 12}})

    def test_starting_a_trace_forwards_the_name_note_and_tags(self):
        self.transport.answer("POST", "/v1/traces", 200, {"schema": 1, "trace": {"name": "baseline"}})
        response = self.post("/api/sentinel/traces", json={"name": " baseline ", "note": "n", "tags": ["t"]})
        self.assertEqual(response.status_code, 200)
        argv = self.transport.calls[-1][0]
        self.assertEqual(json.loads(argv[4]), {"name": "baseline", "note": "n", "tags": ["t"]})
        self.assertEqual(response.get_json()["sentinel"], {"trace": {"name": "baseline"}})

    def test_an_invalid_trace_request_never_reaches_the_board(self):
        for body in ({}, {"name": ""}, {"name": "a", "tags": "x"}, {"name": "a", "note": 3}, []):
            with self.subTest(body=body):
                response = self.post("/api/sentinel/traces", json=body)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["code"], "invalid_request")
        self.assertEqual(self.transport.calls, [])

    def test_a_conflicting_trace_keeps_the_daemons_conflict(self):
        self.transport.answer("POST", "/v1/traces", 409, {"error": "a trace is already active"})
        response = self.post("/api/sentinel/traces", json={"name": "baseline"})
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual((body["code"], body["error"]), ("trace_conflict", "a trace is already active"))
        self.assertIn("Stop the active trace", body["hint"])

    def test_stopping_a_trace_returns_the_saved_run(self):
        self.transport.answer("POST", "/v1/traces/stop", 200, {"schema": 1, "run": {"id": "r1"}})
        body = self.post("/api/sentinel/traces/stop").get_json()
        self.assertEqual(body["sentinel"], {"run": {"id": "r1"}})
        self.assertEqual(self.transport.api_paths[-1], ("POST", "/v1/traces/stop"))

    def test_runs_are_listed_and_read_by_name(self):
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [{"id": "r1", "name": "baseline"}]})
        self.transport.answer("GET", "/v1/runs/baseline", 200, {"schema": 1, "run": {"id": "r1"}})
        self.assertEqual(self.get("/api/sentinel/runs").get_json()["sentinel"]["runs"][0]["name"], "baseline")
        self.assertEqual(self.get("/api/sentinel/runs/baseline").get_json()["sentinel"]["run"], {"id": "r1"})

    def test_an_unknown_run_is_a_not_found(self):
        response = self.get("/api/sentinel/runs/nope")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["code"], "not_found")

    def test_compare_needs_a_baseline_and_at_least_one_other_run(self):
        response = self.get("/api/sentinel/compare?runs=baseline")
        self.assertEqual(response.status_code, 400)
        self.assertIn("baseline", response.get_json()["hint"])
        self.assertEqual(self.transport.calls, [])

    def test_compare_forwards_the_run_list_in_order(self):
        self.transport.answer("GET", "/v1/compare?runs=baseline,optimized", 200, {"schema": 1, "runs": ["a"]})
        body = self.get("/api/sentinel/compare?runs=baseline, optimized").get_json()
        self.assertEqual(body["sentinel"], {"runs": ["a"]})
        self.assertEqual(self.transport.api_paths[-1], ("GET", "/v1/compare?runs=baseline,optimized"))

    def test_install_refuses_to_restart_a_healthy_daemon(self):
        response = self.post("/api/sentinel/install")
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual(body["code"], "already_installed")
        self.assertIn("trace in flight", body["hint"])

    def test_install_reports_the_new_daemon_state_and_log(self):
        self.transport.status_fields = ["inactive", "no", "no", "/usr/bin/sima-cli"]

        def exec_once(argv, *, timeout, stdin=None):
            result = FakeSentinel.exec(self.transport, argv, timeout=timeout, stdin=stdin)
            if argv[0] == "sh" and "neat install sentinel" in argv[2]:
                self.transport.status_fields = list(STATUS_FIELDS)
            return result

        self.transport.exec = exec_once
        body = self.post("/api/sentinel/install").get_json()
        self.assertEqual(body["daemon"]["healthy"], True)
        self.assertEqual(body["log"], "Sentinel installed")
        self.assertTrue(self.get("/api/sentinel").get_json()["available"])


RUN_A = {"id": "20260924T175231.958Z-baseline", "name": "baseline", "samples": 4}
RUN_B = {"id": "20260924T174111.540Z-optimized", "name": "optimized", "samples": 4}


class DeleteRunTests(_ApiCase):
    """DELETE /api/sentinel/runs/<run>: resolved against the daemon's list, then the CLI."""

    def setUp(self):
        super().setUp()
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [RUN_A, RUN_B]})

    def listed(self):
        return self.transport.api[("GET", "/v1/runs")][1]["runs"]

    def test_a_run_is_deleted_by_name_with_the_id_sentinel_reports(self):
        response = self.delete("/api/sentinel/runs/baseline?generation=1")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["deleted"], {"id": RUN_A["id"], "name": "baseline"})
        self.assertEqual(body["sentinel"], {"runs": [RUN_B]})
        self.assertEqual((body["generation"], body["board"]["fingerprint"]), (1, "fp-1"))
        self.assertEqual(self.transport.deletes, [["sh", "-c", runs.DELETE_SCRIPT, "sh", RUN_A["id"]]])
        timeout = [t for argv, t, _ in self.transport.calls if argv[0] == "sh" and "runs delete" in argv[2]][0]
        self.assertEqual(timeout, runs.DELETE_TIMEOUT_SEC)
        # The list is read before the delete to validate the ref, and after it to confirm it.
        self.assertEqual(self.transport.api_paths, [("GET", "/v1/runs"), ("GET", "/v1/runs")])
        self.assertEqual(self.listed(), [RUN_B])

    def test_a_run_is_deleted_by_id(self):
        body = self.delete("/api/sentinel/runs/" + RUN_B["id"]).get_json()
        self.assertEqual(body["deleted"], {"id": RUN_B["id"], "name": "optimized"})
        self.assertEqual(self.transport.deletes[0][4], RUN_B["id"])

    def test_the_script_finds_the_cli_off_a_non_login_path(self):
        script = runs.DELETE_SCRIPT
        self.assertIn("command -v simaai-sentinel", script)
        self.assertIn("/usr/local/bin/simaai-sentinel", script)
        self.assertIn('exec "$cli" runs delete "$1"', script)

    def test_an_unknown_run_is_a_not_found_and_nothing_runs(self):
        response = self.delete("/api/sentinel/runs/nope")
        self.assertEqual(response.status_code, 404)
        body = response.get_json()
        self.assertEqual((body["code"], body["error"], body["run"]), ("not_found", "unknown run 'nope'", "nope"))
        self.assertEqual(self.transport.deletes, [])
        self.assertEqual(self.listed(), [RUN_A, RUN_B])

    def test_a_hostile_name_never_reaches_a_shell(self):
        hostile = "x'; rm -rf / #$(reboot)`id` && \"$HOME\" | tee /tmp/p; *"
        # Not on the board: refused before anything runs.
        response = self.delete("/api/sentinel/runs/" + quote_path(hostile))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["run"], hostile)
        self.assertEqual(self.transport.deletes, [])

        # On the board, under that name and an equally hostile id: the id travels as "$1",
        # outside the script text, and survives the SSH transport's quoting unchanged.
        evil = {"id": "$(reboot);'`id`\nreboot", "name": hostile}
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [evil, RUN_B]})
        response = self.delete("/api/sentinel/runs/" + quote_path(hostile))
        self.assertEqual(response.status_code, 200)
        argv = self.transport.deletes[0]
        self.assertEqual(argv, ["sh", "-c", runs.DELETE_SCRIPT, "sh", evil["id"]])
        self.assertNotIn(evil["id"], argv[2])
        self.assertNotIn(hostile, argv[2])
        self.assertEqual(shlex.split(shlex.join(argv)), argv)
        self.assertEqual(self.listed(), [RUN_B])

    def test_an_id_that_would_read_as_an_option_is_refused(self):
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [{"id": "--all", "name": "sneaky"}]})
        response = self.delete("/api/sentinel/runs/sneaky")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_request")
        self.assertEqual(self.transport.deletes, [])

    def test_a_name_two_runs_share_is_refused_in_favour_of_the_id(self):
        twin = dict(RUN_B, name="baseline")
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [RUN_A, twin]})
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 404)
        self.assertIn("by its id", response.get_json()["hint"])
        self.assertEqual(self.transport.deletes, [])

    def test_a_recording_run_is_a_conflict_before_anything_runs(self):
        recording = dict(RUN_A, state="recording")
        self.transport.answer("GET", "/v1/runs", 200, {"schema": 1, "runs": [recording]})
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual(body["code"], "trace_conflict")
        self.assertIn("Stop the trace", body["hint"])
        self.assertEqual(self.transport.deletes, [])

    def test_the_clis_active_run_refusal_is_a_conflict_even_with_exit_zero(self):
        self.transport.delete_result = ExecResult(0, b"", b"Error: cannot delete active run 'baseline'\n")
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual((body["code"], body["error"]), ("trace_conflict", "cannot delete active run 'baseline'"))
        self.assertEqual(body["hint"], runs.STOP_HINT)
        self.assertIn("cannot delete active run", body["detail"])

    def test_the_clis_unknown_run_is_a_not_found(self):
        self.transport.delete_result = ExecResult(0, b"Error: unknown completed run 'x'\n", b"")
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "unknown completed run 'x'")

    def test_an_error_line_fails_the_delete_whatever_the_exit_status(self):
        for exit_code in (0, 1):
            with self.subTest(exit_code=exit_code):
                self.transport.delete_result = ExecResult(exit_code, b"", b"Error: disk on fire\n")
                response = self.delete("/api/sentinel/runs/baseline")
                self.assertEqual(response.status_code, 502)
                body = response.get_json()
                self.assertEqual((body["code"], body["error"], body["run"]), ("sentinel_failed", "disk on fire", "baseline"))

    def test_a_nonzero_exit_without_an_error_line_still_fails(self):
        self.transport.delete_result = ExecResult(2, b"usage: ...", b"")
        body = self.delete("/api/sentinel/runs/baseline").get_json()
        self.assertEqual(body["code"], "sentinel_failed")
        self.assertIn("exit 2", body["error"])
        self.assertEqual(body["detail"], "usage: ...")

    def test_a_missing_cli_names_the_tool(self):
        self.transport.delete_result = ExecResult(127, b"", b"simaai-sentinel: not found\n")
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 502)
        body = response.get_json()
        self.assertEqual((body["code"], body["tool"]), ("tool_missing", "simaai-sentinel"))

    def test_a_permission_failure_is_denied(self):
        self.transport.delete_result = ExecResult(
            1, b"", b"Error: remove /var/lib/simaai-sentinel/runs/x.json: Permission denied\n"
        )
        body = self.delete("/api/sentinel/runs/baseline").get_json()
        self.assertEqual(body["code"], "sentinel_denied")
        self.assertIn(runs.RUNS_DIR, body["hint"])

    def test_a_run_still_listed_after_a_quiet_cli_is_a_failure(self):
        self.transport.delete_result = ExecResult(0, b"", b"")
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual(response.status_code, 502)
        self.assertIn("still lists run 'baseline'", response.get_json()["error"])

    def test_another_board_generation_is_refused_before_anything_runs(self):
        response = self.delete("/api/sentinel/runs/baseline?generation=7")
        self.assertEqual(response.status_code, 409)
        body = response.get_json()
        self.assertEqual((body["code"], body["expected_generation"]), ("stale_snapshot", 7))
        self.assertEqual(self.transport.calls, [])

    def test_a_malformed_generation_is_refused_before_the_board_is_touched(self):
        response = self.delete("/api/sentinel/runs/baseline?generation=latest")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_request")
        self.assertEqual(self.transport.calls, [])

    def test_an_unreachable_board_keeps_its_status(self):
        self.transport.exec_error = BoardError("timeout", "too slow")
        response = self.delete("/api/sentinel/runs/baseline")
        self.assertEqual((response.status_code, response.get_json()["code"]), (504, "timeout"))


def quote_path(value):
    from urllib.parse import quote

    return quote(value, safe="")


if __name__ == "__main__":
    unittest.main()
