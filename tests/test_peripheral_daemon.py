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
from neat_insight.peripherals import export
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


def camera_catalog(**extra):
    return catalog(devices=[{
        "id": "camera:platform/cam0",
        "type": "camera",
        "provider": "daemon.camera.mipi",
        "camera": {
            "camera_name": "platform/cam0",
            "backend": "mipi",
            "modes": [
                {"format": "NV12", "width": 1920, "height": 1080, "framerate_num": 30, "framerate_den": 1, "supported": True, "reason": ""},
                {"format": "NV12", "width": 1280, "height": 720, "framerate_num": 30, "framerate_den": 1, "supported": False, "reason": "ISP output size is unsupported"},
            ],
        },
    }], **extra)


def export_request(**extra):
    return {
        "board_generation": 1,
        "instance_id": "daemon-1",
        "revision": 2,
        "device_id": "camera:platform/cam0",
        "format": "NV12",
        "width": 1920,
        "height": 1080,
        "framerate_num": 30,
        "framerate_den": 1,
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

    def test_malformed_known_camera_details_are_rejected(self):
        for mutate in (
            lambda camera: camera.update(modes=None),
            lambda camera: camera["modes"].append(None),
            lambda camera: camera["modes"][0].pop("framerate_den"),
            lambda camera: camera["modes"][0].update(size_range={"min_width": 1}),
        ):
            response = camera_catalog()
            mutate(response["devices"][0]["camera"])
            with self.subTest(response=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_catalog_rejects_duplicate_identities_and_malformed_provider_issues(self):
        duplicate = camera_catalog()
        duplicate["devices"].append(dict(duplicate["devices"][0]))
        malformed_issue = camera_catalog(issues=[{"provider": "camera"}])
        for response in (duplicate, malformed_issue):
            with self.subTest(response=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_missing_socket_fails_clearly_without_fallback(self):
        missing = FileNotFoundError(errno.ENOENT, "missing")
        with mock.patch.object(socket_client, "request", side_effect=missing):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_missing", 503))
        self.assertIn("/run/simaai-sentinel/api.sock", ctx.exception.message)
        self.assertIn("sima-cli neat install sentinel", ctx.exception.hint)

    def test_sentinel_without_peripheral_catalog_asks_for_an_update(self):
        body = json.dumps({"error": "unknown Sentinel API endpoint"})
        with mock.patch.object(socket_client, "request", return_value=(404, body)):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual(ctx.exception.code, "peripheral_version")
        self.assertIn("sima-cli neat install sentinel", ctx.exception.hint)

    def test_refresh_waits_for_the_daemon_target_scan(self):
        replies = [
            (200, json.dumps(catalog(scan_sequence=3))),
            (200, json.dumps({"accepted": True, "target_scan_sequence": 5})),
            (200, json.dumps(catalog(scan_sequence=4))),
            (200, json.dumps(catalog(scan_sequence=5))),
        ]
        with mock.patch.object(socket_client, "request", side_effect=replies) as request, mock.patch(
            "neat_insight.peripherals.client.time.sleep"
        ):
            result = PeripheralClient(FakeSession()).refresh()
        self.assertEqual(result["scan_sequence"], 5)
        self.assertEqual([call.args[:2] for call in request.call_args_list], [("GET", "/v1/peripherals"), ("POST", "/v1/peripherals/refresh"), ("GET", "/v1/peripherals"), ("GET", "/v1/peripherals")])

    def test_refresh_rejects_a_daemon_restart_before_completing_the_target(self):
        before = catalog(scan_sequence=3)
        restarted = catalog(scan_sequence=5)
        restarted["instance_id"] = "daemon-2"
        replies = [
            (200, json.dumps(before)),
            (200, json.dumps({"accepted": True, "target_scan_sequence": 5})),
            (200, json.dumps(restarted)),
        ]
        with mock.patch.object(socket_client, "request", side_effect=replies):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).refresh()
        self.assertEqual(ctx.exception.code, "stale_snapshot")
        self.assertEqual(ctx.exception.extra["expected_instance_id"], before["instance_id"])
        self.assertEqual(ctx.exception.extra["observed_instance_id"], "daemon-2")

    def test_since_revision_returns_only_an_unchanged_reply_for_the_held_catalog(self):
        unchanged = {"schema_version": 1, "instance_id": "daemon-1", "revision": 2, "scan_sequence": 9, "unchanged": True}
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(unchanged))) as request:
            self.assertEqual(PeripheralClient(FakeSession()).catalog(2, "daemon-1"), unchanged)
        self.assertEqual(request.call_args.args[1], "/v1/peripherals?since_revision=2&instance_id=daemon-1")
        for other in ({"instance_id": "daemon-2"}, {"revision": 3}):
            with self.subTest(other=other), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps({**unchanged, **other}))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog(2, "daemon-1")
                self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_since_revision_and_instance_id_must_be_paired(self):
        for args in ((2, None), (None, "daemon-1"), (2, "")):
            with self.subTest(args=args), mock.patch.object(socket_client, "request") as request:
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog(*args)
                self.assertEqual(ctx.exception.code, "invalid_request")
                request.assert_not_called()

    def test_remote_access_runs_only_the_stdlib_socket_helper(self):
        response = catalog()
        envelope = json.dumps({"status": 200, "text": json.dumps(response)}).encode()
        transport = mock.Mock()
        transport.exec.return_value = ExecResult(0, envelope, b"")
        session = FakeSession("ssh", transport)
        self.assertEqual(PeripheralClient(session).catalog(), response)
        argv = transport.exec.call_args.args[0]
        self.assertEqual(argv[:4], ["python3", "-", "GET", "/v1/peripherals"])
        self.assertIn(b"AF_UNIX", transport.exec.call_args.kwargs["stdin"])

    def test_remote_helper_malformed_envelope_is_normalized(self):
        transport = mock.Mock()
        transport.exec.return_value = ExecResult(0, b'{"status":"not-a-status","text":3}', b"")
        with self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession("ssh", transport)).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))


class PeripheralExportTests(unittest.TestCase):
    def test_export_requires_the_exact_supported_daemon_mode(self):
        result = export.render(camera_catalog(), export_request())
        rendered = {item["id"]: item["content"] for item in result["exports"]}
        self.assertEqual(list(rendered), ["python", "cpp", "json"])
        compile(rendered["python"].replace("import pyneat", ""), "export", "exec")
        self.assertIn('pyneat.nodes.output("frames")', rendered["python"])
        self.assertIn("camera.allow_cpu_fallback = True", rendered["python"])
        self.assertIn('neat::nodes::Output("frames")', rendered["cpp"])
        self.assertIn("camera.allow_cpu_fallback = true;", rendered["cpp"])
        json_options = json.loads(rendered["json"])["options"]
        self.assertEqual(json_options["camera_name"], "platform/cam0")
        self.assertIs(json_options["allow_cpu_fallback"], True)

        with self.assertRaises(BoardError) as ctx:
            export.render(camera_catalog(), export_request(width=1280, height=720))
        self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertIn("ISP output size", ctx.exception.message)

    def test_export_rejects_stale_daemon_identity_or_revision(self):
        with self.assertRaises(BoardError) as ctx:
            export.render(camera_catalog(instance_id="daemon-restarted", revision=0), export_request())
        self.assertEqual(ctx.exception.code, "stale_snapshot")
        self.assertEqual(ctx.exception.extra["current_instance_id"], "daemon-restarted")

    def test_export_requires_camera_name_and_escapes_it(self):
        hostile = 'cam"\\\n'
        payload = camera_catalog()
        payload["devices"][0]["camera"]["camera_name"] = hostile
        rendered = {item["id"]: item["content"] for item in export.render(payload, export_request())["exports"]}
        compile(rendered["python"].replace("import pyneat", ""), "export", "exec")
        self.assertNotIn(hostile, rendered["cpp"])

        payload["devices"][0]["camera"].pop("camera_name")
        with self.assertRaises(BoardError) as ctx:
            export.render(payload, export_request())
        self.assertIn("camera_name", ctx.exception.message)


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

    def test_catalog_poll_with_a_stale_board_generation_never_calls_sentinel(self):
        generation = self.app.extensions["neat_board"].session().generation
        with mock.patch("neat_insight.peripherals.api.PeripheralClient.catalog") as read:
            response = self.client.get(f"/api/peripherals?since_revision=2&instance_id=daemon-1&board_generation={generation + 1}")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "stale_snapshot")
        read.assert_not_called()

    def test_export_re_reads_catalog_and_checks_board_generation(self):
        generation = self.app.extensions["neat_board"].session().generation
        body = export_request(board_generation=generation)
        with mock.patch("neat_insight.peripherals.api.PeripheralClient.catalog", return_value=camera_catalog()) as read:
            response = self.client.post("/api/peripherals/cameras/export", json=body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["device_id"], body["device_id"])
        read.assert_called_once_with()

        with mock.patch("neat_insight.peripherals.api.PeripheralClient.catalog") as read:
            response = self.client.post("/api/peripherals/cameras/export", json={**body, "board_generation": generation + 1})
        self.assertEqual(response.status_code, 409)
        read.assert_not_called()

    def test_export_rejects_a_board_change_during_catalog_read(self):
        manager = self.app.extensions["neat_board"]
        generation = manager.session().generation

        def switch_board():
            manager.select("192.0.2.2", 22, "sima")
            return camera_catalog()

        with mock.patch("neat_insight.peripherals.api.PeripheralClient.catalog", side_effect=switch_board):
            response = self.client.post(
                "/api/peripherals/cameras/export",
                json=export_request(board_generation=generation),
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "stale_snapshot")


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
                        self.assertIn(b"GET /v1/peripherals HTTP/1.1", request)
                        body = b'{"schema_version":1}'
                        connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n" + body)

            worker = threading.Thread(target=serve)
            worker.start()
            self.assertTrue(ready.wait(2))
            status, body = socket_client.request("GET", "/v1/peripherals", socket_path=path, timeout=2)
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
