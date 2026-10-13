import contextlib
import copy
import errno
import json
import os
import socket
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from http.client import RemoteDisconnected

from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import ExecResult
from neat_insight.peripherals import client as client_module
from neat_insight.sentinel import socket_client
from neat_insight.peripherals.client import PeripheralClient
from test_peripherals import contract_catalog


OBSERVED_AT = "2026-10-05T01:48:33.635147447Z"


def catalog(observed_at=OBSERVED_AT, **extra):
    return {
        "revision": 1791164913635,
        "observed_at": observed_at,
        "devices": [{"id": "future:stable-id", "type": "future_sensor", "backend": "future", "vendor_field": 7}],
        "errors": [],
        **extra,
    }


def camera_catalog(**extra):
    """Sentinel's published contract example (its first device is the IMX477 MIPI camera)."""
    return {**contract_catalog(), **extra}


def answering(response, status=200):
    """Sentinel's socket answers every request with `response`: a document as JSON, or text as is."""
    body = response if isinstance(response, str) else json.dumps(response)
    return mock.patch.object(socket_client, "request", return_value=(status, body))


def ssh_session(result):
    """A board reached over SSH whose socket helper answers with `result`."""
    transport = mock.Mock()
    transport.exec.return_value = result
    return FakeSession("ssh", transport), transport


@contextlib.contextmanager
def sentinel_socket(reply):
    """A Unix socket that takes one request and answers it with `reply(connection)`; yields its path and the
    requests it received."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "api.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        server.listen(1)
        received = []

        def serve():
            with server:
                connection, _ = server.accept()
                with connection:
                    received.append(connection.recv(4096))
                    reply(connection)

        worker = threading.Thread(target=serve)
        worker.start()
        try:
            yield path, received
        finally:
            worker.join(30)


class FakeSession:
    def __init__(self, mode="local", transport=None, generation=7):
        self.target = BoardTarget(mode, "test", "board" if mode == "ssh" else None, 22, "sima")
        self.transport = transport
        self.generation = generation
        self.current_checks = 0
        self.stale = False

    def require_current(self):
        self.current_checks += 1
        if self.stale:
            raise BoardError("stale_snapshot", "The selected board changed while this request was running.")


class PeripheralClientTests(unittest.TestCase):
    def assert_rejected(self, response, code="peripheral_response", status=None, http_status=200, method="catalog"):
        with answering(response, http_status), self.assertRaises(BoardError) as ctx:
            getattr(PeripheralClient(FakeSession()), method)()
        self.assertEqual(ctx.exception.code, code)
        if status is not None:
            self.assertEqual(ctx.exception.status, status)
        return ctx.exception

    def assert_accepted(self, response):
        with answering(response):
            self.assertEqual(PeripheralClient(FakeSession()).catalog(), response)

    def test_sentinels_contract_example_is_accepted_unchanged(self):
        example = contract_catalog()
        self.assert_accepted(example)
        self.assertEqual({d["type"] for d in example["devices"]}, {"camera", "microphone"})

    def test_catalog_preserves_unknown_devices_and_optional_fields(self):
        expected = catalog(new_optional={"value": 1})
        session = FakeSession()
        with answering(expected):
            self.assertEqual(PeripheralClient(session).catalog(), expected)
        self.assertEqual(session.current_checks, 1)

    def test_malformed_catalog_is_rejected(self):
        for name, response in {
            "revision": catalog(revision=-1),
            "boolean revision": catalog(revision=True),
            "revision beyond a browser's integers": catalog(revision=2**53),
            "observed_at": catalog(observed_at="yesterday"),
            "observed_at without zone": catalog(observed_at="2026-10-05T01:48:33"),
            "missing observed_at": {key: value for key, value in catalog().items() if key != "observed_at"},
            "errors": catalog(errors=None),
            "error record": catalog(errors=[{"provider": "camera.v4l2", "code": "io.open"}]),
            "devices": catalog(devices={}),
        }.items():
            with self.subTest(name):
                self.assert_rejected(response, status=502)
        self.assert_accepted(catalog(revision=2**52 - 1))
        self.assert_accepted(catalog(observed_at=None, devices=[]))  # before Sentinel's first scan

    def test_board_block_is_kept_with_malformed_fields_and_entries_dropped(self):
        overlay = "modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo"
        good = {
            "model": "SiMa.ai Modalix SoM 16Gig Board",
            "overlays": ["pcie-8rc.dtbo", overlay],
            "configured_cameras": [{
                "compatible": "sony,imx477", "dt_node": "/i2cmux@0/i2c@0/imx477@1a", "i2c_device": "5-001a",
                "data_lanes": 2, "camera_id": "camera:imx477 5-001a",
            }],
            "supported_sensors": [{"compatible": "sony,imx477", "overlays": [overlay]}],
        }
        malformed = {
            "model": 7,
            "overlays": [overlay, 3, "", "x" * 300],
            "configured_cameras": [
                {"compatible": "sony,imx477", "i2c_device": ["5-001a"], "data_lanes": True, "camera_id": None},
                {"i2c_device": "5-001a"},
                "imx477",
            ],
            "supported_sensors": {"compatible": "sony,imx477"},
        }
        cleaned = {"overlays": [overlay], "configured_cameras": [{"compatible": "sony,imx477"}], "supported_sensors": []}
        many = {"supported_sensors": [{"compatible": f"vendor,s{i}", "overlays": [7]} for i in range(300)]}
        for name, block, expected in (
            ("good", good, good),
            ("malformed", malformed, cleaned),
            # A list Sentinel could not read is absent, not empty.
            ("overlays not a list", {"overlays": "a.dtbo"}, {"configured_cameras": [], "supported_sensors": []}),
            ("bounded", many, {"configured_cameras": [],
                               "supported_sensors": [{"compatible": f"vendor,s{i}", "overlays": []}
                                                     for i in range(client_module.SUPPORTED_SENSORS_LIMIT)]}),
        ):
            with self.subTest(name), answering(camera_catalog(board=block)):
                self.assertEqual(PeripheralClient(FakeSession()).catalog()["board"], expected)
        older = {key: value for key, value in camera_catalog().items() if key != "board"}
        for name, response in (("missing", older), ("not an object", camera_catalog(board=[1]))):
            with self.subTest(name), answering(response):
                self.assertNotIn("board", PeripheralClient(FakeSession()).catalog())

    def test_provider_errors_are_kept_for_the_snapshot(self):
        errors = [{"provider": "camera.mipi", "code": "io.open", "reason": "could not open /dev/media0"},
                  {"provider": "hotplug", "code": "hotplug.unavailable", "reason": "uevents are unavailable"}]
        with answering(camera_catalog(errors=errors)):
            self.assertEqual(PeripheralClient(FakeSession()).catalog()["errors"], errors)

    def test_discovery_disabled_is_reported_with_sentinels_reason(self):
        body = json.dumps({"error": "peripheral discovery is not running: disabled with --no-peripherals, or failed"})
        for method in ("catalog", "refresh"):
            with self.subTest(method):
                error = self.assert_rejected(body, "peripheral_unavailable", 503, http_status=503, method=method)
                self.assertIn("--no-peripherals", error.message)
                self.assertEqual(error.extra["daemon_status"], 503)

    def test_malformed_device_is_rejected_without_hiding_daemon_detail(self):
        response = catalog()
        response["devices"][0].pop("type")
        self.assertIn("future:stable-id", self.assert_rejected(response).extra["detail"])

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
            # Codex 4189090657: a max_fps too large for a float overflowed in the snapshot's note (a 500).
            lambda camera: camera.update(max_fps=10**400),
            lambda camera: camera.update(max_fps=float("nan")),
            lambda camera: camera.update(max_fps=0),
            lambda camera: camera.update(max_fps="66"),
            # Codex 4189173469: sizes beyond V4L2's __u32 reached the browser as Infinity.
            lambda camera: camera["modes"][0].update(size_range={
                "min_width": 1, "min_height": 1, "max_width": 2**32, "max_height": 1, "step_width": 1, "step_height": 1,
            }),
            lambda camera: camera.update(modes=[{"format": "MJPG", "width": 2**32, "height": 1080}]),
            lambda camera: camera.update(modes=[{"format": "MJPG", "width": 1920, "height": 10**400}]),
            # Codex (635553e): a verdict field of the wrong type, e.g. available "false", fell through to
            # Insight's own rule and could list an Unsupported mode as Available.
            lambda camera: camera["modes"][0].update(available="false"),
            lambda camera: camera["modes"][0].update(isp_output="true"),
            lambda camera: camera["modes"][0].update(sensor_mode=1),
            lambda camera: camera["modes"][0].update(reason={"bad": True}),
        ):
            response = camera_catalog()
            mutate(response["devices"][0])
            with self.subTest(response=response):
                self.assert_rejected(response)

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
        # V4L2 fractions are __u32; a larger one overflowed when the snapshot converted it to a float.
        zeroed += [dict(interval, denominator=2**32), dict(stepwise, minimum={"numerator": 1, "denominator": 10**400})]
        for value in ([None], 5, {}, [{"width": 1920, "height": 1080, "intervals": 5}],
                      [{"width": 1920, "height": 1080, "intervals": [None]}], [{"width": 1920, "height": 1080}],
                      # Codex (fb0ecbf): an entry whose size the snapshot cannot match dropped all its rates.
                      [{"width": {}, "height": 1080, "intervals": [interval]}],
                      [{"width": 1920, "intervals": [interval]}],
                      [{"width": 1920, "height": 2**32, "intervals": [interval]}],
                      *([{"width": 1920, "height": 1080, "intervals": [bad]}] for bad in zeroed)):
            with self.subTest(frame_intervals=value):
                self.assert_rejected(with_intervals(value))
        self.assert_accepted(with_intervals([{"width": 1920, "height": 1080, "intervals": [interval, stepwise]}]))

    def test_frame_intervals_of_an_unknown_kind_are_rejected(self):
        def with_interval(interval):
            response = camera_catalog()
            response["devices"][0]["modes"][0]["frame_intervals"] = [{"width": 1920, "height": 1080, "intervals": [interval]}]
            return response

        fraction = {"numerator": 1, "denominator": 30}
        continuous = {"type": "continuous", "minimum": fraction, "maximum": {"numerator": 1, "denominator": 5}}
        for kind in (None, "", "Discrete", "range", 1, ["stepwise"]):
            interval = {key: value for key, value in dict(continuous, type=kind).items() if value is not None}
            with self.subTest(type=kind):
                self.assert_rejected(with_interval(interval))
        self.assert_accepted(with_interval(continuous))

    def test_non_object_fields_the_snapshot_reads_are_rejected(self):
        usb = {"id": "camera:v4l2:1", "type": "camera", "backend": "v4l2", "device_path": "/dev/video0", "modes": [],
               "identity": {"vendor_id": "046d", "speed": "480"}}

        def mipi(**fields):
            response = camera_catalog()
            response["devices"][0].update(modes=[], **fields)
            return response

        def usb_camera(**fields):
            return catalog(devices=[dict(copy.deepcopy(usb), **fields)])

        malformed = {
            "USB identity": usb_camera(identity="bad"),
            "USB identity list": usb_camera(identity=["046d"]),
            "USB device path": usb_camera(device_path={}),
            "USB stable path": usb_camera(by_id_path=[]),
            "camera model": usb_camera(model=7),
            "MIPI isp": mipi(isp="unavailable"),
            "availability": mipi(availability=["unknown"]),
            # Codex (e84c907): a non-string reason reached the snapshot, which promises a string or null.
            "availability reason": mipi(availability={"state": "unknown", "reason": {"bad": True}}),
            "availability state": mipi(availability={"state": ["unknown"]}),
            "USB identity node_index": usb_camera(identity={"node_index": -1}),
        }
        for key in ("stable_key", "topology", "interface", "vendor_id", "product_id", "serial", "manufacturer", "speed"):
            malformed[f"USB identity {key}"] = usb_camera(identity={key: {}})
        for name, response in malformed.items():
            with self.subTest(name):
                self.assert_rejected(response, status=502)
        for response in (usb_camera(), usb_camera(identity={"node_index": 0}),
                         usb_camera(identity=None, by_id_path=None),
                         mipi(isp={"state": "unavailable", "reason": "x"}),
                         mipi(availability=None), mipi(availability={"state": "unknown", "reason": None})):
            with self.subTest(valid=response):
                self.assert_accepted(response)

    def test_catalog_rejects_duplicate_identities_and_malformed_provider_errors(self):
        duplicate = camera_catalog()
        duplicate["devices"].append(dict(duplicate["devices"][0]))
        for response in (duplicate, camera_catalog(errors=[{"provider": "camera"}])):
            with self.subTest(response=response):
                self.assert_rejected(response)

    def test_missing_socket_fails_clearly_without_fallback(self):
        missing = FileNotFoundError(errno.ENOENT, "missing")
        with mock.patch.object(socket_client, "request", side_effect=missing), self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession()).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_missing", 503))
        self.assertIn("/run/simaai-sentinel/api.sock", ctx.exception.message)
        self.assertIn("sima-cli neat install sentinel", ctx.exception.hint)

    def test_sentinel_without_peripheral_catalog_asks_for_an_update(self):
        body = json.dumps({"error": "unknown Sentinel API endpoint"})
        error = self.assert_rejected(body, "peripheral_version", http_status=404)
        self.assertIn("sima-cli neat install sentinel", error.hint)

    def test_refresh_is_one_post_answered_with_the_new_catalog(self):
        example = contract_catalog()
        with answering(example) as request:
            self.assertEqual(PeripheralClient(FakeSession(), socket_path="/tmp/s.sock").refresh(), example)
        request.assert_called_once_with("POST", "/v1/peripherals/refresh", None, socket_path="/tmp/s.sock",
                                        timeout=client_module.REFRESH_TIMEOUT_SEC, max_bytes=PeripheralClient.max_body_bytes)
        # Sentinel waits up to 10 s for the scan; Insight waits longer, so Sentinel's own 504 arrives.
        self.assertGreater(client_module.REFRESH_TIMEOUT_SEC, 10)

    def test_remote_refresh_is_one_bounded_command(self):
        session, transport = ssh_session(
            ExecResult(0, json.dumps({"status": 200, "text": json.dumps(catalog())}).encode(), b""))
        self.assertEqual(PeripheralClient(session).refresh(), catalog())
        argv = transport.exec.call_args.args[0]
        self.assertEqual(argv[:4], ["python3", "-", "POST", "/v1/peripherals/refresh"])
        self.assertEqual(float(argv[-2]), client_module.REFRESH_TIMEOUT_SEC)
        self.assertEqual(transport.exec.call_args.kwargs["timeout"], client_module.REFRESH_TIMEOUT_SEC + 15.0)

    def test_a_refresh_sentinel_could_not_finish_or_queue_is_reported(self):
        for status, body, code, words in (
            (504, '{"error":"the peripheral scan did not finish within 10 seconds"}', "timeout", "within 10 seconds"),
            (429, '{"error":"8 refresh requests are already waiting; retry later"}', "peripheral_unavailable", "already waiting"),
        ):
            with self.subTest(status=status):
                error = self.assert_rejected(body, code, http_status=status, method="refresh")
                self.assertEqual(error.extra["daemon_status"], status)
                self.assertIn(words, error.message)

    def test_a_local_failure_after_the_board_changed_is_reported_as_stale(self):
        # Codex (e84c907): a local socket failure raised before the generation check, so a board switched
        # mid-request got an error about the old on-board Sentinel instead of stale_snapshot.
        for failure in (ConnectionRefusedError(errno.ECONNREFUSED, "refused"), socket.timeout("timed out"),
                        RemoteDisconnected("closed")):
            session = FakeSession()
            session.stale = True
            with self.subTest(failure=type(failure).__name__), \
                    mock.patch.object(socket_client, "request", side_effect=failure), \
                    self.assertRaises(BoardError) as ctx:
                PeripheralClient(session).refresh()
            self.assertEqual(ctx.exception.code, "stale_snapshot")

    def test_a_remote_helper_failure_after_the_board_changed_is_reported_as_stale(self):
        # Codex (635553e): helper failures decoded after the transport's own check named the old board.
        for result in (ExecResult(127, b"", b"python3: not found"), ExecResult(0, b"not json", b""),
                       ExecResult(0, b'{"failure": "refused", "detail": "x"}', b""),
                       ExecResult(0, b'{"status": "bad", "text": 3}', b"")):
            session, _ = ssh_session(result)
            session.stale = True
            with self.subTest(result=result), self.assertRaises(BoardError) as ctx:
                PeripheralClient(session).refresh()
            self.assertEqual(ctx.exception.code, "stale_snapshot")

    def test_remote_access_runs_only_the_stdlib_socket_helper(self):
        response = catalog()
        session, transport = ssh_session(ExecResult(0, json.dumps({"status": 200, "text": json.dumps(response)}).encode(), b""))
        self.assertEqual(PeripheralClient(session).catalog(), response)
        self.assertEqual(transport.exec.call_args.args[0][:4], ["python3", "-", "GET", "/v1/peripherals"])
        self.assertIn(b"AF_UNIX", transport.exec.call_args.kwargs["stdin"])

    def test_remote_helper_malformed_envelope_is_normalized(self):
        session, _ = ssh_session(ExecResult(0, b'{"status":"not-a-status","text":3}', b""))
        with self.assertRaises(BoardError) as ctx:
            PeripheralClient(session).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))


class SocketClientTests(unittest.TestCase):
    def test_real_unix_socket_request_reads_http_json(self):
        reply = b"HTTP/1.1 200 OK\r\nContent-Length: 18\r\n\r\n" + b'{"revision":12345}'
        with sentinel_socket(lambda connection: connection.sendall(reply)) as (path, received):
            status, body = socket_client.request("GET", "/v1/peripherals", socket_path=path, timeout=2)
        self.assertIn(b"GET /v1/peripherals HTTP/1.1", received[0])
        self.assertEqual((status, body), (200, '{"revision":12345}'))

    def test_truncated_http_response_is_a_stable_api_error(self):
        reply = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}"
        with sentinel_socket(lambda connection: connection.sendall(reply)) as (path, _), \
                self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession(), socket_path=path).catalog()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))
        self.assertIn("malformed or incomplete", ctx.exception.message)

    def test_a_content_length_too_long_to_parse_is_a_stable_api_error(self):
        # Codex 4189241135: int() refused a 5,000-digit Content-Length and Refresh returned a 500.
        reply = b"HTTP/1.1 200 OK\r\nContent-Length: " + b"9" * 5000 + b"\r\n\r\n{}"
        with sentinel_socket(lambda connection: connection.sendall(reply)) as (path, _), \
                self.assertRaises(BoardError) as ctx:
            PeripheralClient(FakeSession(), socket_path=path).catalog()
        self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_trickled_response_is_bounded_by_one_wall_clock_deadline(self):
        # Each byte arrives well inside the per-operation timeout, so only a total deadline stops it.
        cases = {
            "headers": (b"HTTP/1.1 200 OK\r\n", b"X-Slow: " + b"a" * 400),
            "body": (b"HTTP/1.1 200 OK\r\nContent-Length: 400\r\n\r\n", b"a" * 400),
        }
        for name, (prefix, trickle) in cases.items():
            def reply(connection):
                try:
                    connection.sendall(prefix)
                    for index in range(len(trickle)):
                        connection.sendall(trickle[index : index + 1])
                        time.sleep(0.05)
                except OSError:
                    pass

            with self.subTest(name), sentinel_socket(reply) as (path, _):
                started = time.monotonic()
                with self.assertRaises(OSError) as ctx:
                    socket_client.request("GET", "/v1/peripherals", socket_path=path, timeout=0.3)
                elapsed = time.monotonic() - started
            self.assertEqual(socket_client.socket_failure(ctx.exception), socket_client.TIMED_OUT)
            self.assertLess(elapsed, 0.8)


if __name__ == "__main__":
    unittest.main()
