import json
import os
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from http.client import HTTPException, IncompleteRead
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

from flask import Flask

from neat_insight.board import BoardError, ExecResult, transport
from neat_insight.sentinel import api, client, install, metrics, runs, socket_client, state
from neat_insight.sentinel.api import sentinel_bp
from neat_insight.sentinel.errors import SentinelError

RUN_A = {"id": "20260924T175231.958Z-baseline", "name": "baseline"}
RUN_B = {"id": "20260924T174111.540Z-optimized", "name": "optimized"}


class FakeTransport:
    """Answers Sentinel API calls from `api`, and `runs delete` by removing the run from the list."""

    def __init__(self):
        self.api = {("GET", "/v1/runs"): {"schema": 1, "runs": [RUN_A, RUN_B]}}
        self.calls = []

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv)
        if argv[0] == "python3":
            body = self.api.get((argv[2], argv[3]), {"schema": 1})
            return ExecResult(0, json.dumps({"status": 200, "text": json.dumps(body)}).encode(), b"")
        listing = self.api[("GET", "/v1/runs")]
        field = "id" if any(run["id"] == argv[4] for run in listing["runs"]) else "name"
        listing["runs"] = [run for run in listing["runs"] if run[field] != argv[4]]
        return ExecResult(0, b"", b"")

    @property
    def deletes(self):
        return [argv for argv in self.calls if argv[0] == "sh"]


class ApiTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(api, "cache", state.BoardCache())
        patch.start()
        self.addCleanup(patch.stop)
        self.transport = FakeTransport()
        session = SimpleNamespace(
            transport=self.transport,
            generation=1,
            target=SimpleNamespace(mode="ssh", source="manual", label="sima@192.168.2.2"),
            identity=lambda: {"fingerprint": "fp-1"},
            require_current=lambda: None,
        )
        self.session = session
        app = Flask(__name__)
        app.register_blueprint(sentinel_bp)
        app.extensions["neat_board"] = SimpleNamespace(session=lambda: session)
        self.client = app.test_client()

    def delete(self, ref):
        return self.client.delete("/api/sentinel/runs/" + quote(ref, safe="") + "?generation=1")

    def test_a_hostile_run_name_never_reaches_a_shell(self):
        hostile = "x'; rm -rf / #$(reboot)`id` && \"$HOME\" | tee /tmp/p; *"
        self.assertEqual(self.delete(hostile).status_code, 404)
        self.assertEqual(self.transport.deletes, [])

        evil = {"id": "$(reboot);'`id`\nreboot", "name": hostile}
        self.transport.api[("GET", "/v1/runs")]["runs"] = [evil, RUN_B]
        self.assertEqual(self.delete(hostile).status_code, 200)
        argv = self.transport.deletes[0]
        self.assertEqual(argv, ["sh", "-c", runs.DELETE_SCRIPT, "sh", evil["id"]])
        self.assertEqual(shlex.split(shlex.join(argv)), argv)

    def test_option_like_and_ambiguous_runs_are_refused_before_anything_runs(self):
        for listed, ref, status in (
            ([{"id": "--all", "name": "sneaky"}], "sneaky", 400),
            ([RUN_A, dict(RUN_B, name="baseline")], "baseline", 404),
        ):
            with self.subTest(ref=ref):
                self.transport.api[("GET", "/v1/runs")]["runs"] = listed
                self.assertEqual(self.delete(ref).status_code, status)
                self.assertEqual(self.transport.deletes, [])

    def test_another_runs_name_may_equal_the_deleted_id(self):
        collision = {"id": "another-id", "name": RUN_A["id"]}
        self.transport.api[("GET", "/v1/runs")]["runs"] = [RUN_A, collision]
        response = self.delete(RUN_A["id"])
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["sentinel"]["runs"], [collision])

    def test_requests_for_another_board_or_without_one_are_refused_before_anything_runs(self):
        cases = (
            ("post", "/api/sentinel/install", None, 400, "invalid_request"),
            ("post", "/api/sentinel/install?generation=7", None, 409, "stale_snapshot"),
            ("post", "/api/sentinel/traces", {"name": "baseline"}, 400, "invalid_request"),
            ("post", "/api/sentinel/traces?generation=7", {"name": "baseline"}, 409, "stale_snapshot"),
            ("post", "/api/sentinel/traces?generation=1", {"name": "before,after"}, 400, "invalid_request"),
            ("post", "/api/sentinel/traces/stop", None, 400, "invalid_request"),
            ("post", "/api/sentinel/traces/stop?generation=1", {"id": ""}, 400, "invalid_request"),
            ("post", "/api/sentinel/traces/stop?generation=7", {"id": RUN_A["id"]}, 409, "stale_snapshot"),
            ("delete", "/api/sentinel/runs/baseline", None, 400, "invalid_request"),
            ("delete", "/api/sentinel/runs/baseline?generation=7", None, 409, "stale_snapshot"),
        )
        for method, path, body, status, code in cases:
            with self.subTest(path=path):
                response = getattr(self.client, method)(path, json=body)
                self.assertEqual((response.status_code, response.get_json()["code"]), (status, code))
        self.assertEqual(self.transport.calls, [])

    def test_stop_refuses_a_replacement_trace_before_issuing_the_daemon_stop(self):
        self.transport.api[("GET", "/v1/traces/active")] = {"schema": 1, "trace": RUN_B}
        response = self.client.post(
            "/api/sentinel/traces/stop?generation=1",
            json={"id": RUN_A["id"]},
        )
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "trace_conflict"))
        self.assertEqual([call[2:4] for call in self.transport.calls], [["GET", "/v1/traces/active"]])

    def test_stop_revalidates_the_stable_id_immediately_before_stopping(self):
        self.transport.api[("GET", "/v1/traces/active")] = {"schema": 1, "trace": RUN_A}
        self.transport.api[("POST", "/v1/traces/stop")] = {"schema": 1, "run": RUN_A}
        response = self.client.post(
            "/api/sentinel/traces/stop?generation=1",
            json={"id": RUN_A["id"]},
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(
            [call[2:4] for call in self.transport.calls],
            [["GET", "/v1/traces/active"], ["POST", "/v1/traces/stop"]],
        )
        self.assertEqual(self.transport.calls[1][4], "", "the daemon stop contract takes no request body")

    def test_a_response_is_refused_when_the_board_changes_while_it_is_read(self):
        self.session.require_current = mock.Mock(
            side_effect=BoardError(
                "stale_snapshot",
                "The selected board changed while this request was running.",
                expected_generation=1,
                current_generation=2,
            )
        )
        response = self.client.get("/api/sentinel/runs")
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.transport.calls[0][0], "python3")

    def test_metrics_discard_same_board_history_after_a_daemon_restart(self):
        key = (self.session.generation, "fp-1")
        self.transport.api[("GET", "/v1/metrics")] = {"schema": 1, "metrics": [{"key": "load"}]}
        self.transport.api[("GET", "/v1/samples/latest")] = {
            "schema": 1,
            "sample": {"timestamp": "2026-09-23T17:54:21Z", "values": {"load": 1}},
        }
        api.cache.record(key, "daemon", {"instance_id": "daemon-1"}, 60)
        with mock.patch.object(api.cache_history, "read", return_value=[]):
            first = self.client.get("/api/sentinel/metrics?history=240")
            self.assertEqual(first.status_code, 200, first.get_json())

            api.cache.record(key, "daemon", {"instance_id": "daemon-2"}, 60)
            self.transport.api[("GET", "/v1/samples/latest")]["sample"] = {
                "timestamp": "2026-09-23T17:54:22Z",
                "values": {"load": 2},
            }
            restarted = self.client.get("/api/sentinel/metrics?history=240")

        self.assertEqual(restarted.status_code, 200, restarted.get_json())
        self.assertEqual(restarted.get_json()["history"]["timestamps"], ["2026-09-23T17:54:22Z"])


class ResponseLimitTests(unittest.TestCase):
    def test_local_http_protocol_failures_are_structured_sentinel_errors(self):
        session = SimpleNamespace(target=SimpleNamespace(mode="local", label="this board"))
        for failure in (IncompleteRead(b"{}", 98), HTTPException("malformed status line")):
            with self.subTest(failure=failure), mock.patch.object(socket_client, "request", side_effect=failure):
                with self.assertRaises(SentinelError) as ctx:
                    client.SentinelClient(session).get("/v1/health")
                self.assertEqual((ctx.exception.code, ctx.exception.status), ("sentinel_failed", 502))
                self.assertIn(str(failure), ctx.exception.extra["detail"])

    def test_an_answer_over_the_limit_is_refused_not_truncated(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "api.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            self.addCleanup(server.close)

            def answer():
                conn, _ = server.accept()
                conn.recv(65536)
                conn.sendall(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + b"x" * 5000)
                conn.close()

            threading.Thread(target=answer, daemon=True).start()
            with mock.patch.object(socket_client, "MAX_BODY_BYTES", 4096):
                with self.assertRaises(socket_client.ResponseTooLarge):
                    socket_client.request("GET", "/v1/runs/long", socket_path=path)

    def test_the_largest_answer_fits_the_board_output_cap_once_wrapped(self):
        sample = json.dumps({"timestamp": "2026-09-23T15:27:13.270295197Z", "values": {f"metric_{i}": 8.812681752827412 for i in range(59)}})
        count = socket_client.MAX_BODY_BYTES // (len(sample) + 2)
        text = json.dumps({"schema": 1, "metadata": {}, "samples": [json.loads(sample)] * count})
        self.assertLessEqual(len(text), socket_client.MAX_BODY_BYTES)
        self.assertLess(len(json.dumps({"status": 200, "text": text})), transport.MAX_OUTPUT_BYTES)


_FAKE_SUDO = """#!/bin/sh
echo "$*" >> "$FAKE_SUDO_LOG"
[ -n "$FAKE_SUDO_DENY" ] && exit 1
[ "$1" = -n ] && shift
if [ "$1" = rm ]; then
  for target; do :; done
  [ -d "$target" ] && chmod -R u+w "$target"
fi
exec "$@"
"""

# Like the real installer under sudo, leaves a tree in DIR that this user cannot remove alone.
_FAKE_SIMA_CLI = """#!/bin/sh
printf '%s' "$5" > "$FAKE_MARKER"
mkdir -p "$5/vulcan"
touch "$5/vulcan/sentinel.deb"
chmod 555 "$5/vulcan"
touch "$FAKE_MARKER.ready"
[ -n "$FAKE_INSTALL_WAIT" ] && sleep 30
exit 0
"""


class StatusTests(unittest.TestCase):
    def test_status_exposes_the_active_systemd_invocation(self):
        output = b"active\n@@\nyes\n@@\nyes\n@@\n/usr/bin/sima-cli\n@@\ndaemon-invocation-2\n@@\n7\n"
        board = SimpleNamespace(exec=lambda argv, timeout: ExecResult(0, output, b""))
        daemon = install.status(SimpleNamespace(transport=board))
        self.assertEqual(daemon["instance_id"], "daemon-invocation-2")
        self.assertIsNotNone(daemon["started_at"])


class InstallScriptTests(unittest.TestCase):
    """The installer script run for real by sh and bash, with a fake sudo and sima-cli."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for name, text in (("sudo", _FAKE_SUDO), ("sima-cli", _FAKE_SIMA_CLI)):
            (self.root / name).write_text(text)
            (self.root / name).chmod(0o755)
        calls = []
        board = SimpleNamespace(exec=lambda argv, timeout: calls.append(argv) or ExecResult(0, "inactive@@no@@no@@{}".format(self.root / "sima-cli").encode(), b""))
        with self.assertRaises(SentinelError):
            install.install(SimpleNamespace(transport=board))
        self.script = calls[1][2]

    def run_script(self, shell, stop=None, **env):
        marker = self.root / "marker"
        for path in (marker, self.root / "marker.ready"):
            path.unlink(missing_ok=True)
        environ = dict(os.environ, PATH=f"{self.root}:{os.environ['PATH']}", FAKE_SUDO_LOG=str(self.root / "sudo.log"), FAKE_MARKER=str(marker), **env)
        process = subprocess.Popen([shell, "-c", self.script], env=environ, stderr=subprocess.PIPE, start_new_session=True)
        if stop:
            deadline = time.monotonic() + 10
            while not (self.root / "marker.ready").exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            os.killpg(process.pid, stop)
        _, stderr = process.communicate(timeout=30)
        return process.returncode, stderr.decode(), Path(marker.read_text()) if marker.exists() else None

    def test_the_root_owned_download_is_removed_however_the_install_ends(self):
        for shell in ("sh", "bash"):
            for stop, status in ((None, 0), (signal.SIGTERM, 143), (signal.SIGHUP, 129), (signal.SIGINT, 130)):
                with self.subTest(shell=shell, signal=stop):
                    code, stderr, download = self.run_script(shell, stop, FAKE_INSTALL_WAIT="1" if stop else "")
                    self.assertEqual(code, status, stderr)
                    self.assertTrue(download.name.startswith("sentinel-install."))
                    self.assertFalse(download.exists())

    def test_sudo_that_needs_a_password_stops_before_anything_runs(self):
        code, stderr, download = self.run_script("sh", FAKE_SUDO_DENY="1")
        self.assertEqual((code, stderr.strip(), download), (77, "sudo: a password is required", None))


class HistoryTests(unittest.TestCase):
    def test_an_unmeasured_metric_stays_null_in_the_value_and_history(self):
        payload = metrics.build(
            {"metrics": [{"key": "power_current_watts", "label": "Board power"}]},
            {"sample": {"timestamp": "2026-09-23T17:54:21Z", "values": {}}},
            [{"timestamp": "2026-09-23T17:54:21Z", "values": {}}],
            history_limit=1,
        )
        metric = payload["groups"][0]["metrics"][0]
        self.assertIsNone(metric["value"])
        self.assertEqual(metric["status"], "unavailable")
        self.assertEqual(payload["history"]["series"]["power_current_watts"], [None])

    def test_a_break_in_the_polling_starts_the_history_again(self):
        cache, key = state.BoardCache(), (1, "fp-1")
        for stamp in ("2026-09-23T17:54:19.918200185Z", "2026-09-23T17:54:21.908397571Z"):
            cache.add_sample(key, {"timestamp": stamp, "values": {}})
        after = cache.add_sample(key, {"timestamp": "2026-09-23T19:39:58.301197766Z", "values": {}})
        self.assertEqual([s["timestamp"] for s in after], ["2026-09-23T19:39:58.301197766Z"])
        self.assertEqual(len(cache.add_sample(key, {"timestamp": "2026-09-23T19:40:28.3Z", "values": {}})), 2)

    def test_a_new_daemon_invocation_discards_and_reseeds_same_board_history(self):
        cache, key = state.BoardCache(), (1, "fp-1")
        cache.observe_daemon(key, "daemon-1")
        cache.add_sample(key, {"timestamp": "2026-09-23T17:54:21Z", "values": {"load": 1}})
        cache.seed(key, [{"timestamp": "2026-09-23T17:54:20Z", "values": {"load": 0}}])
        self.assertFalse(cache.needs_seed(key))

        cache.observe_daemon(key, "daemon-2")
        self.assertTrue(cache.needs_seed(key))
        after = cache.add_sample(key, {"timestamp": "2026-09-23T17:54:22Z", "values": {"load": 2}})
        self.assertEqual(after, [{"timestamp": "2026-09-23T17:54:22Z", "values": {"load": 2}}])


if __name__ == "__main__":
    unittest.main()
