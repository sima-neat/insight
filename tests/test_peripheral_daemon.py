import errno
import json
import os
import socket
import tempfile
import threading
import unittest
import unittest.mock as mock
from pathlib import Path

from flask import Flask

from neat_insight import board
from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import ExecResult
from neat_insight.peripherals import peripherals_bp
from neat_insight.peripherals.client import PeripheralClient
from neat_insight.peripherals import socket_client


def catalog(scan_sequence=3, **extra):
    return {
        "schema_version": 1,
        "instance_id": "daemon-1",
        "state": "ready",
        "ready": True,
        "stale": False,
        "revision": 2,
        "sequence": 4,
        "scan_sequence": scan_sequence,
        "last_success_at": "2026-10-01T00:00:00Z",
        "last_attempt_at": "2026-10-01T00:00:00Z",
        "error": None,
        "devices": [
            {
                "id": "future:stable-id",
                "type": "future_sensor",
                "provider": "future",
                "future_sensor": {"vendor_field": 7},
                "optional_v1_field": True,
            }
        ],
        **extra,
    }


class FakeSession:
    def __init__(self, mode="local", transport=None, generation=7):
        self.target = BoardTarget(mode, "test", "board" if mode == "ssh" else None, 22, "sima")
        self.transport = transport
        self.generation = generation
        self.current_checks = 0

    def require_current(self):
        self.current_checks += 1


class PeripheralClientTests(unittest.TestCase):
    def test_catalog_preserves_unknown_devices_and_optional_fields(self):
        expected = catalog(new_optional={"value": 1})
        session = FakeSession()
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(expected))):
            actual = PeripheralClient(session).catalog()
        self.assertEqual(actual, expected)
        self.assertEqual(session.current_checks, 1)

    def test_schema_mismatch_is_actionable(self):
        response = catalog(schema_version=2)
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_version", 502))
        self.assertIn("compatible versions", ctx.exception.hint)

    def test_malformed_device_is_rejected_without_hiding_daemon_detail(self):
        response = catalog()
        response["devices"][0].pop("future_sensor")
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual(ctx.exception.code, "peripheral_response")
        self.assertIn("future:stable-id", ctx.exception.extra["detail"])

    def test_missing_socket_fails_clearly_without_fallback(self):
        missing = FileNotFoundError(errno.ENOENT, "missing")
        with mock.patch.object(socket_client, "request", side_effect=missing):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_missing", 503))
        self.assertIn("Install the Core peripheral daemon", ctx.exception.hint)

    def test_refresh_waits_for_the_daemon_target_scan(self):
        replies = [
            (202, json.dumps({"accepted": True, "target_scan_sequence": 5})),
            (200, json.dumps(catalog(scan_sequence=4))),
            (200, json.dumps(catalog(scan_sequence=5))),
        ]
        with mock.patch.object(socket_client, "request", side_effect=replies) as request, mock.patch(
            "neat_insight.peripherals.client.time.sleep"
        ):
            result = PeripheralClient(FakeSession()).refresh()
        self.assertEqual(result["scan_sequence"], 5)
        self.assertEqual([call.args[:2] for call in request.call_args_list], [("POST", "/v1/refresh"), ("GET", "/v1/catalog"), ("GET", "/v1/catalog")])

    def test_events_are_forwarded_with_a_bounded_wait(self):
        response = {
            "schema_version": 1,
            "instance_id": "daemon-1",
            "revision": 2,
            "sequence": 5,
            "scan_sequence": 3,
            "resync_required": False,
            "shutting_down": False,
            "events": [{"sequence": 5, "revision": 2, "kind": "changed", "future": True}],
        }
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))) as request:
            actual = PeripheralClient(FakeSession()).events(4, 30000, "daemon-1")
        self.assertEqual(actual, response)
        path = request.call_args.args[1]
        self.assertIn("after_sequence=4", path)
        self.assertIn("wait_ms=30000", path)
        self.assertLessEqual(request.call_args.kwargs["timeout"], 35.0)

    def test_remote_access_runs_only_the_stdlib_socket_helper(self):
        response = catalog()
        envelope = json.dumps({"status": 200, "text": json.dumps(response)}).encode()
        transport = mock.Mock()
        transport.exec.return_value = ExecResult(0, envelope, b"")
        session = FakeSession("ssh", transport)
        self.assertEqual(PeripheralClient(session).catalog(), response)
        argv = transport.exec.call_args.args[0]
        self.assertEqual(argv[:4], ["python3", "-", "GET", "/v1/catalog"])
        self.assertIn(b"AF_UNIX", transport.exec.call_args.kwargs["stdin"])

    def test_remote_helper_malformed_envelope_is_normalized(self):
        transport = mock.Mock()
        transport.exec.return_value = ExecResult(0, b'{"status":"not-a-status","text":3}', b"")
        with self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession("ssh", transport)).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))


class PeripheralApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Flask(__name__)
        board.init_app(self.app, Path(self.tmp.name), on_board=True)
        self.app.register_blueprint(peripherals_bp)
        self.client = self.app.test_client()

    def test_catalog_adds_board_context_without_rewriting_daemon_fields(self):
        daemon_catalog = catalog()
        with mock.patch("neat_insight.peripherals.api.PeripheralClient.catalog", return_value=daemon_catalog):
            response = self.client.get("/api/peripherals")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["devices"], daemon_catalog["devices"])
        self.assertEqual(payload["instance_id"], "daemon-1")
        self.assertIsInstance(payload["board_generation"], int)
        self.assertEqual(payload["board"]["source"], "on-board")

    def test_stale_refresh_generation_never_calls_the_daemon(self):
        generation = self.app.extensions["neat_board"].session().generation
        with mock.patch("neat_insight.peripherals.api.PeripheralClient.refresh") as refresh:
            response = self.client.post("/api/peripherals/refresh", json={"board_generation": generation + 1})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "stale_snapshot")
        refresh.assert_not_called()

    def test_invalid_event_wait_is_rejected_before_daemon_access(self):
        with mock.patch("neat_insight.peripherals.api.PeripheralClient.events") as events:
            response = self.client.get("/api/peripherals/events?wait_ms=30001")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_request")
        events.assert_not_called()


class SocketClientTests(unittest.TestCase):
    def test_real_unix_socket_request_reads_http_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "api.sock")
            ready = threading.Event()

            def serve():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                    server.bind(path)
                    server.listen(1)
                    ready.set()
                    connection, _ = server.accept()
                    with connection:
                        request = connection.recv(4096)
                        self.assertIn(b"GET /v1/catalog HTTP/1.1", request)
                        body = b'{"schema_version":1}'
                        connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n" + body)

            worker = threading.Thread(target=serve)
            worker.start()
            self.assertTrue(ready.wait(2))
            status, body = socket_client.request("GET", "/v1/catalog", socket_path=path, timeout=2)
            worker.join(2)
        self.assertEqual((status, body), (200, '{"schema_version":1}'))

    def test_truncated_http_response_is_a_stable_api_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "api.sock")
            ready = threading.Event()

            def serve():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                    server.bind(path)
                    server.listen(1)
                    ready.set()
                    connection, _ = server.accept()
                    with connection:
                        connection.recv(4096)
                        connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}")

            worker = threading.Thread(target=serve)
            worker.start()
            self.assertTrue(ready.wait(2))
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession(), socket_path=path).catalog()
            worker.join(2)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))
        self.assertIn("malformed or incomplete", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
