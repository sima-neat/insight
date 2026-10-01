import errno
import json
import math
import os
import socket
import struct
import tempfile
import threading
import unittest
import unittest.mock as mock
from pathlib import Path

from flask import Flask

from neat_insight import board
from neat_insight.board.errors import BoardError
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import CommandCancelled, ExecResult
from neat_insight.peripherals import peripherals_bp
from neat_insight.peripherals import export
from neat_insight.peripherals import mictest
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
        "provider": "daemon.camera.libcamera",
        "camera": {
            "camera_name": "platform/cam0",
            "backend": "libcamera",
            "modes": [
                {"format": "NV12", "width": 1920, "height": 1080, "framerate_num": 30, "framerate_den": 1, "supported": True, "reason": ""},
                {"format": "NV12", "width": 1280, "height": 720, "framerate_num": 30, "framerate_den": 1, "supported": False, "reason": "ISP output size is unsupported"},
            ],
        },
    }], **extra)


def microphone_device(device_id="microphone:alsa:stable-1", **extra):
    return {
        "id": device_id,
        "type": "microphone",
        "provider": "daemon.microphone.alsa",
        "microphone": {
            "name": "Yeti Nano",
            "backend": "alsa",
            "connection": "usb",
            "capture_target": {
                "card_id": "Nano",
                "device": 0,
                "selector": "plughw:CARD=Nano,DEV=0",
            },
            "identity": {
                "stable_key": "usb:1-3.2:1.0:pcm0c",
                "card_id": "Nano",
                "card_name": "Yeti Nano",
            },
            "modes": [{
                "interface": 1,
                "altset": 1,
                "format": "S24_3LE",
                "channels": 2,
                "sample_bits": 24,
                "rates_hz": [32000, 44100, 48000],
                "channel_map": ["FL", "FR"],
            }],
            "availability": {
                "state": "available",
                "subdevices": 1,
                "subdevices_available": 1,
            },
            **extra,
        },
    }


def microphone_catalog(**extra):
    return catalog(devices=[microphone_device()], **extra)


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

    def test_microphone_schema_keeps_current_capture_routing_and_stable_identity(self):
        expected = microphone_catalog()
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(expected))):
            actual = PeripheralClient(FakeSession()).catalog()
        microphone = actual["devices"][0]["microphone"]
        self.assertEqual(microphone["identity"]["stable_key"], "usb:1-3.2:1.0:pcm0c")
        self.assertEqual(microphone["capture_target"]["selector"], "plughw:CARD=Nano,DEV=0")

    def test_malformed_known_microphone_details_are_rejected(self):
        for mutate in (
            lambda mic: mic.update(modes=None),
            lambda mic: mic["identity"].pop("stable_key"),
            lambda mic: mic["modes"][0].update(rates_hz=[], rate_range_hz=None),
            lambda mic: mic["availability"].update(state="busy-ish"),
            lambda mic: mic.update(issues=[None]),
        ):
            response = microphone_catalog()
            mutate(response["devices"][0]["microphone"])
            with self.subTest(response=response), mock.patch.object(
                socket_client, "request", return_value=(200, json.dumps(response))
            ):
                with self.assertRaises(BoardError) as ctx:
                    PeripheralClient(FakeSession()).catalog()
                self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_partial_microphone_details_do_not_hide_other_devices(self):
        response = microphone_catalog()
        microphone = response["devices"][0]["microphone"]
        microphone["capture_target"].pop("selector")
        microphone["capture_target"]["card_id"] = ""
        microphone["modes"] = [{"format": "S16_LE"}]
        microphone["issues"] = [{
            "code": "peripherals.capabilities_unavailable",
            "reason": "Read-only capture formats are unavailable.",
        }]
        response["devices"].append(camera_catalog()["devices"][0])
        with mock.patch.object(socket_client, "request", return_value=(200, json.dumps(response))):
            actual = PeripheralClient(FakeSession()).catalog()
        self.assertEqual([device["type"] for device in actual["devices"]], ["microphone", "camera"])

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
        self.assertIn("Install the Core peripheral daemon", ctx.exception.hint)

    def test_refresh_waits_for_the_daemon_target_scan(self):
        replies = [
            (200, json.dumps(catalog(scan_sequence=3))),
            (202, json.dumps({"accepted": True, "target_scan_sequence": 5})),
            (200, json.dumps(catalog(scan_sequence=4))),
            (200, json.dumps(catalog(scan_sequence=5))),
        ]
        with mock.patch.object(socket_client, "request", side_effect=replies) as request, mock.patch(
            "neat_insight.peripherals.client.time.sleep"
        ):
            result = PeripheralClient(FakeSession()).refresh()
        self.assertEqual(result["scan_sequence"], 5)
        self.assertEqual([call.args[:2] for call in request.call_args_list], [("GET", "/v1/catalog"), ("POST", "/v1/refresh"), ("GET", "/v1/catalog"), ("GET", "/v1/catalog")])

    def test_refresh_rejects_a_daemon_restart_before_completing_the_target(self):
        before = catalog(scan_sequence=3)
        restarted = catalog(scan_sequence=5)
        restarted["instance_id"] = "daemon-2"
        replies = [
            (200, json.dumps(before)),
            (202, json.dumps({"accepted": True, "target_scan_sequence": 5})),
            (200, json.dumps(restarted)),
        ]
        with mock.patch.object(socket_client, "request", side_effect=replies):
            with self.assertRaises(BoardError) as ctx:
                PeripheralClient(FakeSession()).refresh()
        self.assertEqual(ctx.exception.code, "stale_snapshot")
        self.assertEqual(ctx.exception.extra["expected_instance_id"], before["instance_id"])
        self.assertEqual(ctx.exception.extra["observed_instance_id"], "daemon-2")

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


def microphone_selection(**extra):
    return {
        "board_generation": 7,
        "instance_id": "daemon-1",
        "revision": 2,
        "device_id": "microphone:alsa:stable-1",
        "seconds": 30,
        **extra,
    }


def sine(amplitude: float, frames: int = 4800) -> bytes:
    values = [
        int(amplitude * 32767 * math.sin(2 * math.pi * 440 * index / 48000))
        for index in range(frames)
    ]
    return struct.pack("<%dh" % (2 * frames), *[value for value in values for _ in range(2)])


class MicrophoneTestTests(unittest.TestCase):
    def test_test_binding_requires_the_exact_catalog_and_safe_daemon_selector(self):
        bound = mictest.bind_microphone(microphone_catalog(), microphone_selection())
        self.assertEqual(bound["selector"], "plughw:CARD=Nano,DEV=0")
        self.assertEqual((bound["rate"], bound["channels"]), (48000, 2))

        with self.assertRaises(BoardError) as ctx:
            mictest.bind_microphone(
                microphone_catalog(instance_id="daemon-restarted", revision=1),
                microphone_selection(),
            )
        self.assertEqual(ctx.exception.code, "stale_snapshot")

        hostile = microphone_catalog()
        hostile["devices"][0]["microphone"]["capture_target"]["selector"] = "plughw:CARD=x;rm,DEV=0"
        with self.assertRaises(BoardError) as ctx:
            mictest.bind_microphone(hostile, microphone_selection())
        self.assertEqual(ctx.exception.code, "peripheral_response")

        busy = microphone_catalog()
        busy["devices"][0]["microphone"]["availability"]["state"] = "in_use"
        with self.assertRaises(BoardError) as ctx:
            mictest.bind_microphone(busy, microphone_selection())
        self.assertEqual(ctx.exception.code, "microphone_in_use")

    def test_test_binding_rejects_only_relevant_retained_last_good_data(self):
        stale_microphone = microphone_catalog(issues=[{
            "provider": "daemon.microphone.alsa",
            "code": "peripherals.discovery_failed",
            "reason": "ALSA scan failed",
            "retained_last_good": True,
        }], stale=True)
        with self.assertRaises(BoardError) as ctx:
            mictest.bind_microphone(stale_microphone, microphone_selection())
        self.assertEqual(ctx.exception.code, "stale_snapshot")

        unrelated_camera = microphone_catalog(issues=[{
            "provider": "daemon.camera.libcamera",
            "code": "peripherals.discovery_failed",
            "reason": "Camera scan failed",
            "retained_last_good": True,
        }], stale=True)
        bound = mictest.bind_microphone(unrelated_camera, microphone_selection())
        self.assertEqual(bound["selector"], "plughw:CARD=Nano,DEV=0")

        global_failure = microphone_catalog(
            stale=True,
            error={"code": "peripherals.discovery_failed", "reason": "No provider refreshed"},
        )
        with self.assertRaises(BoardError) as ctx:
            mictest.bind_microphone(global_failure, microphone_selection())
        self.assertEqual(ctx.exception.code, "stale_snapshot")

    def test_format_choice_bounds_output_and_understands_rate_ranges(self):
        microphone = microphone_device()["microphone"]
        microphone["modes"] = [{
            "interface": 1,
            "altset": 2,
            "format": "S32_LE",
            "channels": 8,
            "sample_bits": 32,
            "rate_range_hz": {"min": 8000, "max": 384000},
        }]
        chosen = mictest.choose_format(microphone)
        self.assertEqual(chosen, {"rate": 48000, "channels": 2})
        self.assertLess(
            chosen["rate"] * chosen["channels"] * 2 * mictest.MAX_SECONDS,
            16 * 1024 * 1024,
        )

    def test_level_measurement_ignores_one_open_click(self):
        click = [0] * 96000
        click[10] = 30000
        self.assertTrue(mictest.measure(struct.pack("<96000h", *click), 2)["silent"])
        self.assertFalse(mictest.measure(sine(0.5), 2)["silent"])

    def test_recording_produces_a_bounded_wav(self):
        pcm = sine(0.5)

        class CaptureTransport:
            def exec(self, _argv, *, timeout, on_stdout, cancel_event):
                self.timeout = timeout
                self.cancel_event = cancel_event
                on_stdout(pcm[:999])
                on_stdout(pcm[999:])
                return ExecResult(0, pcm, b"")

        session = FakeSession(transport=CaptureTransport(), generation=7)
        test = mictest.MicrophoneTest(
            session,
            microphone_selection(seconds=1),
            {"selector": "plughw:CARD=Nano,DEV=0", "rate": 48000, "channels": 2},
        )
        test.start()
        test.thread.join(2)
        status = test.status()
        self.assertEqual(status["state"], "ready")
        self.assertFalse(status["level"]["silent"])
        self.assertTrue(test.wav.startswith(b"RIFF"))

    def test_stop_interrupts_a_stalled_capture_without_waiting_for_output(self):
        pcm = sine(0.5)
        started = threading.Event()

        class StalledTransport:
            def exec(self, _argv, *, timeout, on_stdout, cancel_event):
                on_stdout(pcm)
                started.set()
                self.assert_cancelled = cancel_event.wait(timeout)
                raise CommandCancelled()

        transport = StalledTransport()
        test = mictest.MicrophoneTest(
            FakeSession(transport=transport, generation=7),
            microphone_selection(seconds=30),
            {"selector": "plughw:CARD=Nano,DEV=0", "rate": 48000, "channels": 2},
        )
        test.start()
        self.assertTrue(started.wait(1))
        test.request_stop()
        test.thread.join(2)
        self.assertFalse(test.thread.is_alive())
        self.assertTrue(transport.assert_cancelled)
        self.assertEqual(test.status()["state"], "ready")

    def test_tokens_isolate_concurrent_tabs(self):
        store = mictest.TestStore()
        session = FakeSession(generation=7)
        bound = {"selector": "plughw:CARD=Nano,DEV=0", "rate": 48000, "channels": 1}
        with mock.patch.object(mictest.MicrophoneTest, "start"):
            first = store.start(session, microphone_selection(device_id="microphone:one"), bound)
            second = store.start(session, microphone_selection(device_id="microphone:two"), bound)
        store.stop(first["token"], 7)
        self.assertTrue(store._tests[first["token"]].stop_requested)
        self.assertFalse(store._tests[second["token"]].stop_requested)
        with self.assertRaises(BoardError) as ctx:
            store.stop("not-an-owned-token", 7)
        self.assertEqual(ctx.exception.code, "not_found")


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

    def test_microphone_test_re_reads_and_binds_the_exact_daemon_snapshot(self):
        generation = self.app.extensions["neat_board"].session().generation
        body = microphone_selection(board_generation=generation)
        started = {"token": "owned-token", "state": "recording"}
        with mock.patch(
            "neat_insight.peripherals.api.PeripheralClient.catalog",
            return_value=microphone_catalog(),
        ) as read, mock.patch.object(mictest.tests, "start", return_value=started) as start:
            response = self.client.post("/api/peripherals/microphones/test", json=body)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json()["test"], started)
        read.assert_called_once_with()
        selection = start.call_args.args[1]
        bound = start.call_args.args[2]
        self.assertEqual(selection["device_id"], body["device_id"])
        self.assertEqual(bound["selector"], "plughw:CARD=Nano,DEV=0")

    def test_stale_microphone_selection_never_starts_arecord(self):
        generation = self.app.extensions["neat_board"].session().generation
        body = microphone_selection(board_generation=generation)
        with mock.patch(
            "neat_insight.peripherals.api.PeripheralClient.catalog",
            return_value=microphone_catalog(instance_id="daemon-restarted", revision=1),
        ), mock.patch.object(mictest.tests, "start") as start:
            response = self.client.post("/api/peripherals/microphones/test", json=body)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "stale_snapshot")
        start.assert_not_called()

    def test_microphone_status_and_stop_are_token_scoped(self):
        store = mock.Mock()
        store.status.return_value = {"token": "tab-a", "state": "recording"}
        store.stop.return_value = {"token": "tab-a", "state": "recording"}
        with mock.patch.object(mictest, "tests", store):
            status = self.client.get("/api/peripherals/microphones/test/tab-a")
            stopped = self.client.post("/api/peripherals/microphones/test/tab-a/stop")
        self.assertEqual(status.get_json()["test"]["token"], "tab-a")
        self.assertEqual(stopped.get_json()["test"]["token"], "tab-a")
        generation = self.app.extensions["neat_board"].session().generation
        store.status.assert_called_once_with("tab-a", generation)
        store.stop.assert_called_once_with("tab-a", generation)


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
