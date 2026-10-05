import contextlib
import copy
import errno
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from pathlib import Path

from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import ExecResult
from neat_insight.peripherals.client import PeripheralClient
from neat_insight.sentinel import socket_client


OBSERVED_AT = "2026-10-05T01:48:33.635147447Z"


def catalog(observed_at=OBSERVED_AT, **extra):
    return {
        "revision": 1791164913635,
        "observed_at": observed_at,
        "devices": [
            {
                "id": "future:stable-id",
                "type": "future_sensor",
                "backend": "future",
                "vendor_field": 7,
            }
        ],
        "errors": [],
        **extra,
    }


def camera_catalog(**extra):
    return catalog(devices=[{
        "id": "camera:platform/cam0",
        "type": "camera",
        "backend": "mipi",
        "camera_name": "platform/cam0",
        "modes": [
            {"format": "NV12", "width": 1920, "height": 1080, "isp_output": True},
            {"format": "NV12", "width": 1280, "height": 720, "isp_output": True},
        ],
    }], **extra)


def at(seconds):
    """A catalog observed `seconds` after 2026-10-05T01:48:33Z, and that instant in epoch nanoseconds."""
    return catalog(observed_at=f"2026-10-05T01:48:{33 + seconds:02d}Z"), (1791164913 + seconds) * 10**9


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

    def test_malformed_catalog_is_rejected(self):
        for name, response in {
            "revision": catalog(revision=-1),
            "boolean revision": catalog(revision=True),
            "observed_at": catalog(observed_at="yesterday"),
            "observed_at without zone": catalog(observed_at="2026-10-05T01:48:33"),
            "missing observed_at": {key: value for key, value in catalog().items() if key != "observed_at"},
            "errors": catalog(errors=None),
            "error record": catalog(errors=[{"provider": "camera.v4l2", "code": "io.open"}]),
            "devices": catalog(devices={}),
        }.items():
            with self.subTest(name), mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))
        before_first_scan = catalog(observed_at=None, devices=[])
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(before_first_scan))):
            self.assertEqual(PeripheralClient(FakeSession()).catalog(), before_first_scan)

    def test_provider_errors_are_kept_for_the_snapshot(self):
        errors = [{"provider": "camera.mipi", "code": "io.open", "reason": "could not open /dev/media0"},
                  {"provider": "hotplug", "code": "hotplug.unavailable", "reason": "uevents are unavailable"}]
        response = camera_catalog(errors=errors)
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
            self.assertEqual(PeripheralClient(FakeSession()).catalog()["errors"], errors)

    def test_discovery_disabled_is_reported_with_sentinels_reason(self):
        body = json.dumps({"error": "peripheral discovery is not running: disabled with --no-peripherals, or failed"})
        for method in ("catalog", "refresh"):
            with self.subTest(method), mock.patch.object(socket_client, "request", return_value=(503, body)):
                with self.assertRaises(BoardError) as ctx:
                    getattr(PeripheralClient(FakeSession()), method)()
                self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_unavailable", 503))
                self.assertIn("--no-peripherals", ctx.exception.message)
                self.assertEqual(ctx.exception.extra["daemon_status"], 503)

    def test_malformed_device_is_rejected_without_hiding_daemon_detail(self):
        response = catalog()
        response["devices"][0].pop("type")
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).catalog()
        self.assertEqual(ctx.exception.code, "peripheral_response")
        self.assertIn("future:stable-id", ctx.exception.extra["detail"])

    def test_malformed_known_camera_details_are_rejected(self):
        for mutate in (
            lambda camera: camera.update(modes=None),
            lambda camera: camera["modes"].append(None),
            lambda camera: camera["modes"][0].pop("format"),
            lambda camera: camera["modes"][0].update(size_range={"min_width": 1}),
            lambda camera: camera.pop("backend"),
            lambda camera: camera.update(identity="bad"),
            lambda camera: camera.update(availability=[]),
            lambda camera: camera.update(isp="bad"),
        ):
            response = camera_catalog()
            mutate(response["devices"][0])
            with self.subTest(response=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_malformed_frame_intervals_are_rejected_before_the_snapshot_reads_them(self):
        def with_intervals(value):
            response = camera_catalog()
            response["devices"][0]["modes"][0]["frame_intervals"] = value
            return response

        interval = {"numerator": 1, "denominator": 30, "type": "discrete"}
        fraction = {"numerator": 1, "denominator": 30}
        stepwise = {"type": "stepwise", "minimum": fraction, "maximum": {"numerator": 1, "denominator": 5}, "step": fraction}
        zeroed = [dict(interval, numerator=0), dict(interval, denominator=0)] + [
            dict(stepwise, **{key: dict(fraction, **{part: 0})})
            for key in ("minimum", "maximum", "step") for part in ("numerator", "denominator")
        ] + [dict(stepwise, step=None), dict(stepwise, step={"numerator": 0.0, "denominator": 30}),
             {"type": "continuous", "minimum": fraction, "maximum": {"numerator": 0, "denominator": 5}}]
        for value in ([None], 5, {}, [{"width": 1920, "height": 1080, "intervals": 5}],
                      [{"width": 1920, "height": 1080, "intervals": [None]}], [{"width": 1920, "height": 1080}],
                      *([{"width": 1920, "height": 1080, "intervals": [bad]}] for bad in zeroed)):
            with self.subTest(frame_intervals=value), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(with_intervals(value)))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")
        valid = with_intervals([{"width": 1920, "height": 1080, "intervals": [interval, stepwise]}])
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(valid))):
            self.assertEqual(PeripheralClient(FakeSession()).catalog(), valid)

    def test_frame_intervals_of_an_unknown_kind_are_rejected(self):
        def with_interval(interval):
            response = camera_catalog()
            response["devices"][0]["modes"][0]["frame_intervals"] = [
                {"width": 1920, "height": 1080, "intervals": [interval]}
            ]
            return response

        fraction = {"numerator": 1, "denominator": 30}
        continuous = {"type": "continuous", "minimum": fraction, "maximum": {"numerator": 1, "denominator": 5}}
        for kind in (None, "", "Discrete", "range", 1, ["stepwise"]):
            interval = {key: value for key, value in dict(continuous, type=kind).items() if value is not None}
            with self.subTest(type=kind), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(with_interval(interval)))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")
        valid = with_interval(continuous)
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(valid))):
            self.assertEqual(PeripheralClient(FakeSession()).catalog(), valid)

    def test_non_object_fields_the_snapshot_reads_are_rejected(self):
        usb = {"id": "camera:v4l2:1", "type": "camera", "backend": "v4l2", "device_path": "/dev/video0", "modes": [],
               "identity": {"vendor_id": "046d", "speed": "480"}}

        def mipi(**fields):
            response = camera_catalog()
            response["devices"][0].update(modes=[], **fields)
            return response

        def usb_camera(**fields):
            device = copy.deepcopy(usb)
            device.update(fields)
            return catalog(devices=[device])

        malformed = {
            "USB identity": usb_camera(identity="bad"),
            "USB identity list": usb_camera(identity=["046d"]),
            "USB device path": usb_camera(device_path={}),
            "USB stable path": usb_camera(by_id_path=[]),
            "camera model": usb_camera(model=7),
            "MIPI isp": mipi(isp="unavailable"),
            "availability": mipi(availability=["unknown"]),
        }
        for key in (
            "stable_key", "topology", "interface", "vendor_id", "product_id",
            "serial", "manufacturer", "speed",
        ):
            malformed[f"USB identity {key}"] = usb_camera(identity={key: {}})
        malformed["USB identity node_index"] = usb_camera(identity={"node_index": -1})
        for name, response in malformed.items():
            with self.subTest(name), mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))
        for response in (usb_camera(), usb_camera(identity={"node_index": 0}),
                         usb_camera(identity=None, by_id_path=None),
                         mipi(isp={"state": "unavailable", "reason": "x"}),
                         mipi(availability=None)):
            with self.subTest(valid=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                self.assertEqual(PeripheralClient(FakeSession()).catalog(), response)

    def test_catalog_rejects_duplicate_identities_and_malformed_provider_errors(self):
        duplicate = camera_catalog()
        duplicate["devices"].append(dict(duplicate["devices"][0]))
        malformed_error = camera_catalog(errors=[{"provider": "camera"}])
        for response in (duplicate, malformed_error):
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

    def test_local_refresh_runs_the_board_side_wait_and_validates_its_catalog(self):
        with mock.patch.object(socket_client, "refresh", return_value=(200, json.dumps(camera_catalog()))) as refresh:
            self.assertEqual(PeripheralClient(FakeSession(), socket_path="/tmp/s.sock").refresh(), camera_catalog())
        refresh.assert_called_once_with(
            socket_path="/tmp/s.sock", timeout=socket_client.REFRESH_TIMEOUT_SEC, max_bytes=PeripheralClient.max_body_bytes
        )
        with mock.patch.object(socket_client, "refresh", side_effect=socket_client.RefreshTimedOut()):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).refresh()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("timeout", 504))
        self.assertIn("did not finish it within 45 seconds", ctx.exception.message)

    def test_remote_refresh_waits_on_the_board_in_one_bounded_command(self):
        transport = mock.Mock()
        transport.exec.return_value = ExecResult(0, json.dumps({"status": 200, "text": json.dumps(catalog())}).encode(), b"")
        self.assertEqual(PeripheralClient(FakeSession("ssh", transport)).refresh(), catalog())
        argv = transport.exec.call_args.args[0]
        self.assertEqual(argv[:3], ["python3", "-", "REFRESH"])
        self.assertEqual(float(argv[-2]), socket_client.REFRESH_TIMEOUT_SEC)
        self.assertEqual(transport.exec.call_args.kwargs["timeout"], socket_client.REFRESH_TIMEOUT_SEC + 15.0)

        transport.exec.return_value = ExecResult(3, json.dumps({"failure": socket_client.REFRESH_TIMED_OUT, "detail": ""}).encode(), b"")
        with self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession("ssh", transport)).refresh()
        self.assertEqual(ctx.exception.code, "timeout")
        self.assertIn("did not finish it within 45 seconds", ctx.exception.message)

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


class RefreshTests(unittest.TestCase):
    """socket_client.refresh, which runs on the board next to Sentinel."""

    def run_refresh(self, replies, requested_ns, monotonic=None):
        with contextlib.ExitStack() as stack:
            request = stack.enter_context(mock.patch.object(socket_client, "request", side_effect=replies))
            stack.enter_context(mock.patch.object(socket_client.time, "time_ns", return_value=requested_ns))
            stack.enter_context(mock.patch.object(socket_client.time, "sleep"))
            if monotonic is not None:
                stack.enter_context(mock.patch.object(socket_client.time, "monotonic", side_effect=monotonic))
            result = socket_client.refresh(socket_path="/tmp/s.sock", timeout=45)
        return result, [call.args[:2] for call in request.call_args_list]

    def test_waits_until_a_scan_started_at_or_after_the_request(self):
        before, _ = at(0)
        after, requested = at(2)
        replies = [(202, '{"accepted":true}'), (200, json.dumps(catalog(observed_at=None))),
                   (200, json.dumps(before)), (200, json.dumps(after))]
        result, calls = self.run_refresh(replies, requested)
        self.assertEqual(result, (200, json.dumps(after)))
        self.assertEqual(calls, [("POST", "/v1/peripherals/refresh")] + [("GET", "/v1/peripherals")] * 3)

    def test_sub_second_precision_decides_whether_the_scan_is_new(self):
        observed = catalog(observed_at="2026-10-05T01:48:33.5Z")
        requested = 1791164913 * 10**9 + 500_000_001
        newer = catalog(observed_at="2026-10-05T01:48:33.500000001Z")
        result, _ = self.run_refresh([(202, "{}"), (200, json.dumps(observed)), (200, json.dumps(newer))], requested)
        self.assertEqual(result[1], json.dumps(newer))

    def test_errors_and_unreadable_catalogs_return_at_once_for_the_caller_to_report(self):
        _, requested = at(0)
        for replies in (
            [(503, '{"error":"peripheral discovery is not running"}')],
            [(202, "{}"), (503, '{"error":"stopped"}')],
            [(202, "{}"), (200, json.dumps(catalog(observed_at="soon")))],
            [(202, "{}"), (200, "not json")],
        ):
            with self.subTest(replies=replies):
                result, _ = self.run_refresh(replies, requested)
                self.assertEqual(result, replies[-1])

    def test_a_scan_that_never_finishes_times_out(self):
        before, _ = at(0)
        _, requested = at(1)
        with self.assertRaises(socket_client.RefreshTimedOut):
            self.run_refresh([(202, "{}"), (200, json.dumps(before))], requested, monotonic=(0.0, 1.0, 1.0, 46.0))

    def test_runs_as_a_program_and_reports_a_refresh_timeout(self):
        with mock.patch.object(socket_client, "refresh", side_effect=socket_client.RefreshTimedOut()), \
                mock.patch.object(socket_client.sys, "stdout") as stdout:
            self.assertEqual(socket_client.main(["REFRESH", "", "", "/tmp/s.sock", "45"]), 3)
        self.assertEqual(json.loads(stdout.write.call_args.args[0])["failure"], socket_client.REFRESH_TIMED_OUT)


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

    def test_refresh_program_waits_for_a_scan_newer_than_its_request_over_a_real_socket(self):
        """Run the helper as the board runs it; the fake Sentinel finishes its scan on the second read."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "api.sock")
            ready = threading.Event()
            seen = []

            def serve():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                    server.bind(path)
                    server.listen(4)
                    ready.set()
                    for answer in range(3):
                        connection, _ = server.accept()
                        with connection:
                            seen.append(connection.recv(4096).split(b" ", 2)[:2])
                            if answer == 0:
                                status, body = b"202 Accepted", b'{"accepted":true}'
                            else:
                                observed = "2001-01-01T00:00:00Z" if answer == 1 else time.strftime(
                                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1))
                                status, body = b"200 OK", json.dumps(catalog(observed_at=observed)).encode()
                            connection.sendall(b"HTTP/1.1 " + status + b"\r\nContent-Length: "
                                               + str(len(body)).encode() + b"\r\n\r\n" + body)

            worker = threading.Thread(target=serve)
            worker.start()
            self.assertTrue(ready.wait(2))
            done = subprocess.run(
                [sys.executable, "-", "REFRESH", "", "", path, "10"],
                input=Path(socket_client.__file__).read_bytes(), capture_output=True, timeout=30,
            )
            worker.join(5)
        self.assertEqual(done.returncode, 0, done.stderr)
        envelope = json.loads(done.stdout)
        self.assertEqual(envelope["status"], 200)
        self.assertNotEqual(json.loads(envelope["text"])["observed_at"], "2001-01-01T00:00:00Z")
        self.assertEqual(seen, [[b"POST", b"/v1/peripherals/refresh"], [b"GET", b"/v1/peripherals"], [b"GET", b"/v1/peripherals"]])

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

    def test_trickled_response_is_bounded_by_one_wall_clock_deadline(self):
        # Each byte arrives well inside the per-operation timeout, so only a total deadline stops it.
        cases = {
            "headers": (b"HTTP/1.1 200 OK\r\n", b"X-Slow: " + b"a" * 400),
            "body": (b"HTTP/1.1 200 OK\r\nContent-Length: 400\r\n\r\n", b"a" * 400),
        }
        for name, (prefix, trickle) in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
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
                            try:
                                connection.sendall(prefix)
                                for index in range(len(trickle)):
                                    connection.sendall(trickle[index : index + 1])
                                    time.sleep(0.05)
                            except OSError:
                                pass

                worker = threading.Thread(target=serve)
                worker.start()
                self.assertTrue(ready.wait(2))
                started = time.monotonic()
                with self.assertRaises(OSError) as ctx:
                    socket_client.request("GET", "/v1/peripherals", socket_path=path, timeout=0.3)
                elapsed = time.monotonic() - started
                worker.join(30)
                self.assertEqual(socket_client.socket_failure(ctx.exception), socket_client.TIMED_OUT)
                self.assertLess(elapsed, 0.8)


if __name__ == "__main__":
    unittest.main()
