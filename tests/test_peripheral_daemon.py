import copy
import errno
import json
import os
import socket
import tempfile
import threading
import unittest
import unittest.mock as mock


from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import ExecResult
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


def microphone_catalog():
    """Sentinel's `daemon.audio.alsa` records: Yeti Nano (stereo 24-bit), a mono 16-bit range, a bare codec."""
    def device(device_id, connection, modes, **identity):
        return {"id": device_id, "type": "microphone", "provider": "daemon.audio.alsa", "microphone": {
            "name": "Yeti Nano", "backend": "alsa", "connection": connection,
            "capture_target": {"card_id": "Nano", "device": 0, "selector": "plughw:CARD=Nano,DEV=0"},
            "identity": {"stable_key": f"sysfs:{device_id}", "card_index": 2, "pcm_node": "/dev/snd/pcmC2D0c", **identity},
            "modes": modes,
            "availability": {"state": "available", "subdevices": 1, "subdevices_available": 1},
        }}

    return catalog(devices=[
        device("microphone:alsa:yeti", "usb", [{"interface": 1, "altset": 1, "format": "S24_3LE", "channels": 2,
                                               "sample_bits": 24, "rates_hz": [32000, 44100, 48000], "channel_map": ["FL", "FR"]}],
               usb={"vendor_id": "b58e", "product_id": "0005", "bus_path": "1-3.2"}, card_id="Nano", by_id="/dev/snd/by-id/x"),
        device("microphone:alsa:mono", "usb", [{"format": "S16_LE", "channels": 1, "sample_bits": 16,
                                               "rate_range_hz": {"min": 8000, "max": 48000}}]),
        device("microphone:alsa:codec", "platform", [{"format": "S16_LE"}]),
    ])


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

    def test_malformed_frame_intervals_are_rejected_before_the_snapshot_reads_them(self):
        def with_intervals(value):
            response = camera_catalog()
            response["devices"][0]["camera"]["modes"][0]["frame_intervals"] = value
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
            response["devices"][0]["camera"]["modes"][0]["frame_intervals"] = [
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
        usb = {"id": "camera:v4l2:1", "type": "camera", "provider": "daemon.camera.v4l2", "camera": {
            "backend": "v4l2", "connection": "usb", "device_path": "/dev/video0", "modes": [],
            "identity": {"vendor_id": "046d", "speed": "480"},
        }}

        def mipi(**fields):
            response = camera_catalog()
            response["devices"][0]["camera"].update(modes=[], **fields)
            return response

        def usb_camera(**fields):
            device = copy.deepcopy(usb)
            device["camera"].update(fields)
            return catalog(devices=[device])

        malformed = {
            "USB identity": usb_camera(identity="bad"),
            "USB identity list": usb_camera(identity=["046d"]),
            "MIPI isp": mipi(isp="unavailable"),
            "availability": mipi(availability=["unknown"]),
            "support rules": camera_catalog(support="applied"),
            "support rules state": camera_catalog(support={"state": ["applied"]}),
        }
        for name, response in malformed.items():
            with self.subTest(name), mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual((ctx.exception.code, ctx.exception.status), ("peripheral_response", 502))
        for response in (usb_camera(), usb_camera(identity=None), mipi(isp={"state": "unavailable", "reason": "x"}),
                         mipi(availability=None), camera_catalog(support={"state": "applied"})):
            with self.subTest(valid=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                self.assertEqual(PeripheralClient(FakeSession()).catalog(), response)

    def test_microphone_records_are_validated_before_the_snapshot_reads_them(self):
        valid = microphone_catalog()
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(valid))):
            self.assertEqual(PeripheralClient(FakeSession()).catalog(), valid)
        malformed = {
            "modes": lambda mic: mic.update(modes=None),
            "stable key": lambda mic: mic["identity"].pop("stable_key"),
            "connection": lambda mic: mic.update(connection="bluetooth"),
            "PCM device": lambda mic: mic["capture_target"].update(device=-1),
            "selector": lambda mic: mic["capture_target"].update(selector=7),
            "card index": lambda mic: mic["identity"].update(card_index="2"),
            "USB identity": lambda mic: mic["identity"].update(usb="1-3.2"),
            "empty rates": lambda mic: mic["modes"][0].update(rates_hz=[]),
            "rates and range": lambda mic: mic["modes"][0].update(rate_range_hz={"min": 8000, "max": 48000}),
            "inverted range": lambda mic: mic.update(modes=[{"format": "S16_LE", "rate_range_hz": {"min": 9, "max": 8}}]),
            "channels": lambda mic: mic["modes"][0].update(channels=0),
            "channel map": lambda mic: mic["modes"][0].update(channel_map="FL FR"),
            "availability": lambda mic: mic["availability"].update(state="busy-ish"),
            "counts": lambda mic: mic["availability"].update(subdevices=True),
            "issues": lambda mic: mic.update(issues=[None]),
        }
        for name, mutate in malformed.items():
            response = microphone_catalog()
            mutate(response["devices"][0]["microphone"])
            with self.subTest(name), mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
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
