import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
import uuid
from types import SimpleNamespace

import paramiko
from flask import Flask

from neat_insight import board, preview as preview_pkg
from neat_insight.board import BoardError, ExecResult
from neat_insight.board import manager as manager_module
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import key_fingerprint
from neat_insight.peripherals import api as peripherals_api, cameras
from neat_insight.peripherals.api import peripherals_bp
from neat_insight.preview import api, manager as preview
from test_peripherals import C920, IMX477, NOT_INSTALLED, c920, catalog, check, core_of, imx477, mipi_mode

MODE = {"format": "NV12", "width": 1920, "height": 1080, "fps": 30}
PREVIEW = "/api/peripherals/cameras/preview"
AWAIT_VIDEO, INGEST_STATS = preview.PreviewManager._await_video, preview._ingest_stats
BOARD = {"label": "sima@board", "source": "test", "fingerprint": "fp"}


def scanned(*devices, board_facts=None, generation=1):
    """Record a scan of the given Sentinel devices and return its snapshot."""
    facts = check(support=core_of(catalog(*devices))) if board_facts is None else board_facts
    return peripherals_api.scans.record(generation, BOARD, catalog(*devices), facts, 5)


def item_of(snapshot, item_id):
    return next(item for item in snapshot["items"] if item["id"] == item_id)


class FakeTransport:
    def __init__(self, ssh_client=b"192.168.2.1 51234 22", python=b"/home/sima/pyneat/bin/python", started=b"running\n", users=None):
        self.calls, self.closed = [], False
        report = {"users": {IMX477: users or []}}
        self.replies = {"SSH_CLIENT": ssh_client + b"\n" + python + b"\n", "/dev/media0": json.dumps(report).encode(),
                        "echo alive": b"alive\n", "grep -qx running": started}

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv[-1])
        return ExecResult(0, next((out for key, out in self.replies.items() if key in argv[-1]), b""), b"")

    def close(self):
        self.closed = True

    def kills(self):
        return [call for call in self.calls if "kill $pid" in call]


def fake_session(transport=None, generation=1):
    transport = transport or FakeTransport()
    return SimpleNamespace(generation=generation, target=BoardTarget("ssh", "test", "board", 22, "sima"),
                           transport=transport, raw_transport=transport)


def new_manager():
    rows = [{"name": "videoUDP", "hostPortStart": 9000, "hostPortEnd": 9003}]
    return preview.PreviewManager(lambda: rows, lambda: 80, lambda host, port, path, query: f"https://{host}:{port}{path}?{query}")


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.manager = new_manager()
        self.session = fake_session()
        for patch in (
            mock.patch.object(peripherals_api, "scans", cameras.ScanCache()),
            mock.patch.object(preview, "_ingest_stats", return_value=[]),
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args: None),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        self.snapshot = scanned(imx477(), c920())
        self.imx477 = item_of(self.snapshot, IMX477)

    def start(self, session=None):
        return self.manager.start(session or self.session, self.imx477, dict(MODE))

    def client(self):
        app = Flask(__name__)
        app.register_blueprint(board.board_bp)
        app.register_blueprint(api.preview_bp)
        app.extensions["neat_board"] = SimpleNamespace(session=lambda: self.session)
        app.extensions["neat_preview"] = self.manager
        return app.test_client()

    def test_only_verified_nv12_modes_of_scanned_mipi_cameras_are_previewed(self):
        self.assertEqual(api.previewable_mode(self.imx477, dict(MODE)), MODE)
        self.assertEqual(api.previewable_mode(self.imx477, {}), MODE)
        cases = (
            (self.imx477, {**MODE, "format": "RGB3"}, "RGB3 cannot be previewed"),
            (self.imx477, {**MODE, "width": 1280, "height": 720}, "1280x720 is not a size"),
            (self.imx477, {**MODE, "fps": 60}, "Pick one of: 30."),
            (self.imx477, {**MODE, "fps": 29.97}, "whole-number frame rate"),
            (item_of(self.snapshot, C920), {**MODE, "format": "MJPG", "width": 1280, "height": 720}, "MIPI cameras only"),
        )
        for item, mode, reason in cases:
            with self.subTest(mode=mode), self.assertRaises(BoardError) as ctx:
                api.previewable_mode(item, mode)
            self.assertEqual(ctx.exception.code, "invalid_request")
            self.assertIn(reason, ctx.exception.message + (ctx.exception.hint or ""))

    def test_a_non_finite_frame_rate_is_an_invalid_request(self):
        client = self.client()
        for fps in ("1e309", "-1e309", "Infinity", "NaN"):
            with self.subTest(fps=fps):
                body = '{"id": "%s", "format": "NV12", "width": 1920, "height": 1080, "fps": %s}' % (IMX477, fps)
                response = client.post(PREVIEW, data=body, content_type="application/json", headers={"Host": "insight.local"})
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))
                self.assertIn("fps must be a positive number", response.get_json()["error"])
        self.assertEqual(self.session.transport.calls, [])
        self.assertEqual(api.previewable_mode(self.imx477, {**MODE, "fps": 30.0}), MODE)

    def test_a_rate_neat_core_did_not_verify_is_not_previewed(self):
        doc = imx477()
        doc["modes"] = [dict(mipi_mode("NV12", 1920, 1080), frame_intervals=[{"width": 1920, "height": 1080, "intervals": [
            {"type": "discrete", "numerator": 1, "denominator": 60}, {"type": "discrete", "numerator": 1, "denominator": 30}]}])]
        item = item_of(scanned(doc), IMX477)
        # Neat Core classified the fastest rate, 60 fps; 30 fps is advertised but has no verdict.
        self.assertEqual(api.previewable_mode(item, {**MODE, "fps": 60}), {**MODE, "fps": 60})
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(item, MODE)
        self.assertIn("at 30 fps cannot be previewed: Neat Core has not verified it.", ctx.exception.message)

        unknown = item_of(scanned(imx477(), board_facts=check(support={"state": "not_installed", "reason": "x"})), IMX477)
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(unknown, MODE)
        self.assertIn(f"cannot be previewed: {NOT_INSTALLED}", ctx.exception.message)

    def test_each_browser_gets_a_viewer_url_for_its_own_validated_host(self):
        client = self.client()
        body = {"id": IMX477, **MODE}
        for host in ("evil.example/x", "evil:1:2", "[not-v6]:1", "@evil", 'evil"onload='):
            response = client.post(PREVIEW, json=body, headers={"Host": host})
            self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"), host)
        self.assertEqual(self.session.transport.calls, [])
        started = client.post(PREVIEW, json=body, headers={"Host": "attacker.example"}).get_json()["session"]
        self.assertEqual(started["channel"], 3)
        url = client.get("/api/peripherals/preview", headers={"Host": "insight.local:9900"}).get_json()["session"]["viewer_url"]
        self.assertTrue(url.startswith("https://insight.local:8081/static/viewer.html?mode=light&src=3&"), url)
        launch = next(call for call in self.session.transport.calls if "setsid nohup" in call)
        self.assertIn("/home/sima/pyneat/bin/python preview.py ", launch)
        self.assertIn("'imx477 5-001a' 192.168.2.1 1920 1080 30 9000 3", launch)

    def test_the_session_has_the_shape_the_page_reads(self):
        client = self.client()
        session = client.post(PREVIEW, json={"id": IMX477, **MODE}, headers={"Host": "insight.local"}).get_json()["session"]
        self.assertEqual((session["camera_id"], session["mode"], session["generation"], session["state"]), (IMX477, MODE, 1, "live"))
        self.assertEqual(session["heartbeat_interval_ms"], preview.HEARTBEAT_INTERVAL_MS)
        self.assertRegex(session["started_at"], r"^\d{4}-\d\d-\d\dT")
        beat = client.post(f"{PREVIEW}/{session['id']}/heartbeat", headers={"Host": "insight.local"}).get_json()["session"]
        self.assertEqual((beat["id"], beat["camera_id"]), (session["id"], IMX477))
        stopped = client.post(f"{PREVIEW}/{session['id']}/stop", headers={"Host": "insight.local"}).get_json()["session"]
        self.assertEqual(stopped["state"], "stopped")
        self.assertTrue(self.session.transport.kills())
        self.assertIsNone(client.get("/api/peripherals/preview", headers={"Host": "insight.local"}).get_json()["session"])
        gone = client.post(f"{PREVIEW}/{session['id']}/stop", headers={"Host": "insight.local"})
        self.assertEqual((gone.status_code, gone.get_json()["code"]), (404, "not_found"))

    def test_a_start_needs_a_scan_of_this_board_and_a_scanned_camera(self):
        client = self.client()
        missing = client.post(PREVIEW, json={"id": "camera:nope"}, headers={"Host": "insight.local"})
        self.assertEqual((missing.status_code, missing.get_json()["code"]), (404, "not_found"))
        self.session = fake_session(generation=2)
        stale = client.post(PREVIEW, json={"id": IMX477}, headers={"Host": "insight.local"})
        self.assertEqual((stale.status_code, stale.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.session.transport.calls, [])

    def test_a_camera_the_scan_found_busy_is_refused_by_name_before_its_modes(self):
        holder = [{"pid": 77, "command": "neat-app"}]
        scanned(imx477(), board_facts=check(users={IMX477: holder}))
        response = self.client().post(PREVIEW, json={"id": IMX477, "format": "RGB3"}, headers={"Host": "insight.local"})
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "camera_in_use"))
        self.assertEqual(response.get_json()["error"], "imx477 5-001a is already in use: Open in neat-app (pid 77).")
        self.assertEqual(self.session.transport.calls, [])

    def test_nothing_is_written_to_a_board_without_pyneat_or_with_a_forged_address(self):
        for transport, code in ((FakeTransport(python=b""), "tool_missing"), (FakeTransport(ssh_client=b"$(reboot) 1 22"), "command_failed")):
            with self.assertRaises(BoardError) as ctx:
                self.start(fake_session(transport))
            self.assertEqual(ctx.exception.code, code)
            self.assertEqual(len(transport.calls), 1)

    def test_a_graph_build_that_never_finishes_is_not_taken_as_started(self):
        """The worker writes pipeline.pid before graph.build(); only the program's `running` line means started."""
        session = fake_session(FakeTransport(started=b"4242\nINFO Camera: building the graph\n"))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertEqual(ctx.exception.code, "command_failed")
        self.assertIn("building the graph", ctx.exception.extra["detail"])
        check = next(call for call in session.transport.calls if "grep -qx running" in call)
        self.assertIn("&& echo running;", check)
        self.assertNotIn("pipeline.pid", check)
        self.assertRegex(session.transport.calls[-1], r'rm -rf "\$base/(\w+)" "\$base/\1\.log"')
        self.assertIsNone(self.manager.current(1))

    def test_a_failed_start_removes_its_saved_failure_log(self):
        session = fake_session(FakeTransport(started=b"camera_not_found: imx477 5-001a\n"))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertIn("camera_not_found", ctx.exception.extra["detail"])
        self.assertRegex(session.transport.calls[-1], r'rm -rf "\$base/(\w+)" "\$base/\1\.log"')

    def test_a_camera_another_process_holds_now_is_refused_before_anything_is_launched(self):
        session = fake_session(FakeTransport(users=[{"pid": 77, "command": "neat-app"}]))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("camera_in_use", 409))
        self.assertEqual(ctx.exception.message, "imx477 5-001a is already in use: Open in neat-app (pid 77).")
        self.assertEqual(ctx.exception.hint, "Stop the application using the camera, then start the preview.")
        self.assertFalse(any("setsid nohup" in call for call in session.transport.calls))
        self.assertIsNone(self.manager.current(1))
        # The check is the read-only board_check program, asked about the camera's media device.
        request = next(call for call in session.transport.calls if "/dev/media0" in call)
        self.assertEqual(json.loads(request), {"cameras": {IMX477: ["/dev/media0"]}})

    def test_a_camera_libcamera_cannot_acquire_reads_as_in_use_and_an_unreadable_check_does_not_block(self):
        transport = FakeTransport(started=b"ERROR Camera: Failed to acquire camera imx477 5-001a\n")
        transport.replies["/dev/media0"] = b"python3: not found"
        with self.assertRaises(BoardError) as ctx:
            self.start(fake_session(transport))
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("camera_in_use", 409))
        self.assertIn("Failed to acquire camera", ctx.exception.extra["detail"])

    def test_the_sdk_port_map_falls_back_to_neat_json_without_a_port_map_file(self):
        rows = [{"name": "videoUDP", "hostPortStart": 19000, "hostPortEnd": 19003, "protocol": "udp"},
                {"name": "videoUI", "hostPortStart": 18081, "protocol": "tcp"}]
        manager = preview.PreviewManager(lambda: [], lambda: 80, lambda host, port, path, query: f"https://{host}:{port}{path}?{query}")
        with mock.patch.object(preview, "_neat_exposed_ports", return_value=rows):
            self.assertEqual(manager._udp_range(), (19000, 4))
            self.assertTrue(manager.viewer_url("insight.local", 3).startswith("https://insight.local:18081/static/viewer.html?"))
            started = manager.start(self.session, self.imx477, dict(MODE))
        self.assertEqual(started["channel"], 3)
        self.assertIn("192.168.2.1 1920 1080 30 19000 3", next(call for call in self.session.transport.calls if "setsid nohup" in call))
        with mock.patch.object(preview, "_neat_exposed_ports", return_value=[]):
            with self.assertRaises(BoardError) as ctx:
                manager._reserve_channel(self.session)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("no_channel", 409))

    def test_a_failed_neat_json_is_retried_after_a_minute_and_a_good_answer_is_kept(self):
        rows = [{"name": "videoUDP", "hostPortStart": 19000}]
        answers = [OSError("neat: not found"), SimpleNamespace(stdout=json.dumps({"exposedPorts": rows}).encode())]
        clock = [1000.0]
        with mock.patch.object(preview, "_neat_ports", None), mock.patch.object(preview, "_neat_failed_at", None), \
                mock.patch.object(preview.subprocess, "run", side_effect=answers) as run, \
                mock.patch.object(preview.time, "monotonic", side_effect=lambda: clock[0]):
            self.assertEqual(preview._neat_exposed_ports(), [])
            clock[0] += 30
            self.assertEqual(preview._neat_exposed_ports(), [], "not retried within a minute")
            clock[0] += 31
            self.assertEqual(preview._neat_exposed_ports(), rows)
            self.assertEqual(preview._neat_exposed_ports(), rows)
        self.assertEqual(run.call_count, 2)

    def test_a_second_preview_is_refused_while_one_starts_and_names_its_camera(self):
        entered, release = threading.Event(), threading.Event()
        with mock.patch.object(preview.PreviewManager, "_start_worker", lambda *args: (entered.set(), release.wait(5))):
            starter = threading.Thread(target=self.start)
            starter.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaises(BoardError) as ctx:
                self.start()
            release.set()
            starter.join(5)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("preview_active", 409))
        self.assertEqual(ctx.exception.extra["camera_id"], IMX477)

    def test_a_preview_is_stopped_on_the_board_that_runs_it(self):
        self.start()
        other = fake_session(generation=2)
        self.start(other)
        self.assertTrue(self.session.transport.kills())
        self.assertFalse(other.transport.kills())

    def test_another_sender_on_the_channel_stops_the_preview(self):
        await_video = mock.patch.object(preview.PreviewManager, "_await_video", AWAIT_VIDEO)
        with await_video, mock.patch.object(preview, "_channel_rtp", side_effect=[None, {"active": True, "ssrc": 1234}]):
            started = self.start()
        self.assertEqual(started["ssrc"], 1234)
        with mock.patch.object(preview, "_channel_rtp", return_value={"active": True, "ssrc": 777}):
            with self.assertRaises(BoardError) as ctx:
                self.manager.heartbeat(self.session, started["id"])
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("channel_taken", 409))
        self.assertIsNone(self.manager.current(1))
        busy = mock.patch.object(preview, "_channel_rtp", return_value={"active": True, "ssrc": 777})
        with await_video, busy, mock.patch.object(preview, "VIDEO_ARRIVAL_TIMEOUT_SEC", 0.01), mock.patch.object(preview.time, "sleep"):
            with self.assertRaises(BoardError) as ctx:
                self.start()
        self.assertEqual(ctx.exception.code, "channel_taken")
        self.assertEqual(len(self.session.transport.kills()), 2)

    def test_silent_channel_reports_no_video(self):
        silent = mock.patch.object(preview, "_channel_rtp", return_value={"active": False, "ssrc": None})
        with mock.patch.object(preview.PreviewManager, "_await_video", AWAIT_VIDEO), silent, \
                mock.patch.object(preview, "VIDEO_ARRIVAL_TIMEOUT_SEC", 0.01), mock.patch.object(preview.time, "sleep"):
            with self.assertRaises(BoardError) as ctx:
                self.start()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("no_video", 502))

    def test_vf_viewer_page_reads_as_unknown_never_as_all_channels_free(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<!DOCTYPE html>"
        with mock.patch.object(preview, "_ingest_stats", INGEST_STATS), \
                mock.patch.object(preview.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(BoardError) as ctx:
                self.manager._reserve_channel(self.session)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("viewer_unavailable", 502))


class BoardChangeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.transports = []
        for patch in (
            mock.patch.object(manager_module, "SshTransport", side_effect=lambda *a: self.transports.append(FakeTransport()) or self.transports[-1]),
            mock.patch.dict(os.environ, {"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2"}, clear=True),
            mock.patch.object(peripherals_api, "scans", cameras.ScanCache()),
            mock.patch.object(preview, "_ingest_stats", return_value=[]),
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args: None),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        app = Flask(__name__)
        board.init_app(app, tmp.name, on_board=False)
        app.register_blueprint(peripherals_bp)
        preview_pkg.init_app(app, exposed_ports=lambda: [{"name": "videoUDP", "hostPortStart": 9000}], channel_capacity=lambda: 80,
                             format_url=lambda *args: "https://x")
        self.app = app
        self.previews = app.extensions["neat_preview"]
        self.client = app.test_client()
        item = item_of(scanned(imx477()), IMX477)
        with app.app_context():
            self.previews.start(app.extensions["neat_board"].session(), item, dict(MODE))

    def test_selecting_another_board_stops_the_preview_before_its_connection_closes(self):
        old = self.transports[0]
        for body in ({"reset": True}, {"host": "-oProxyCommand=x"}):
            self.client.post("/api/board/select", json=body)
        self.assertEqual((old.kills(), old.closed), ([], False))
        closed_at_stop = []
        exec_ = old.exec
        old.exec = lambda argv, **kw: closed_at_stop.append(old.closed) or exec_(argv, **kw)
        self.assertEqual(self.client.post("/api/board/select", json={"host": "10.1.1.9"}).status_code, 200)
        self.assertEqual((closed_at_stop, old.closed), ([False], True))
        self.assertIsNone(self.previews._session)

    def test_a_start_cannot_slip_between_the_cleanup_and_the_board_change(self):
        """A start racing a board change must not launch capture on the board being deselected."""
        old = self.transports[0]
        in_window, release, changed, started = threading.Event(), threading.Event(), [], []
        board_manager = self.app.extensions["neat_board"]
        guard = board_manager.target_change_guard

        @contextlib.contextmanager
        def paused_guard(changes):
            with guard(changes):
                # Inside the board change: the preview is stopped, the target not yet changed.
                in_window.set()
                release.wait(5)
                yield

        def post(results, *args, **kwargs):
            results.append(self.app.test_client().post(*args, **kwargs).status_code)

        with mock.patch.object(board_manager, "target_change_guard", paused_guard):
            changer = threading.Thread(target=post, args=(changed, "/api/board/select"), kwargs={"json": {"host": "10.1.1.9"}})
            changer.start()
            self.assertTrue(in_window.wait(5))
            calls_after_cleanup = len(old.calls)
            self.assertTrue(old.kills(), "the preview was stopped before the target changes")
            starter = threading.Thread(target=post, args=(started, PREVIEW), kwargs={"json": {"id": IMX477}})
            starter.start()
            starter.join(1.0)
            release.set()
            changer.join(5)
            starter.join(5)
        self.assertEqual(changed, [200])
        self.assertEqual([call for call in old.calls[calls_after_cleanup:] if "setsid nohup" in call], [])
        self.assertEqual(started, [409])
        self.assertIsNone(self.previews._session)

    def test_a_rejected_host_key_trust_leaves_the_preview_running(self):
        for body in ({}, {"fingerprint": "SHA256:stale"}):
            with self.subTest(body=body):
                response = self.client.post("/api/board/trust-host-key", json=body)
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))
        self.assertEqual(self.transports[0].kills(), [])
        self.assertIsNotNone(self.previews._session)
        old = self.transports[0]
        old.presented_host_key, old.replace_host_key = paramiko.RSAKey.generate(1024), mock.Mock()
        response = self.client.post("/api/board/trust-host-key", json={"fingerprint": key_fingerprint(old.presented_host_key)})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(old.kills())
        self.assertIsNone(self.previews._session)

    def test_an_unreachable_old_board_does_not_block_the_board_change(self):
        self.transports[0].exec = mock.Mock(side_effect=BoardError("unreachable", "gone"))
        self.assertEqual(self.client.post("/api/board/select", json={"host": "10.1.1.9"}).status_code, 200)
        self.assertIsNone(self.previews._session)

    def test_a_refresh_stops_the_preview_before_it_scans(self):
        with mock.patch.object(peripherals_api.PeripheralClient, "refresh", return_value=catalog(imx477())), \
                mock.patch.object(manager_module.BoardSession, "identity", return_value={"fingerprint": "fp"}):
            response = self.client.post("/api/peripherals/refresh")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.previews._session)
        self.assertTrue(self.transports[0].kills())

    def test_a_refresh_that_cannot_stop_the_preview_keeps_it_and_does_not_scan(self):
        board_transport, exec_ = self.transports[0], self.transports[0].exec
        failing = [True]

        def flaky_exec(argv, **kwargs):
            if failing[0] and "kill $pid" in argv[-1]:
                raise BoardError("unreachable", "Could not connect to sima@192.168.2.2.")
            return exec_(argv, **kwargs)

        board_transport.exec = flaky_exec
        sentinel, identity = self.scan(return_value=catalog(imx477()))
        with sentinel as sentinel_refresh, identity:
            response = self.client.post("/api/peripherals/refresh")
            self.assertEqual((response.status_code, response.get_json()["code"]), (502, "unreachable"))
            self.assertIn("Stop", response.get_json()["hint"])
            sentinel_refresh.assert_not_called()
            self.assertIsNotNone(self.previews._session)
            failing[0] = False
            self.assertEqual(self.client.post("/api/peripherals/refresh").status_code, 200)
        self.assertIsNone(self.previews._session)

    def scan(self, *args, **kwargs):
        sentinel = mock.patch.object(peripherals_api.PeripheralClient, "refresh", *args, **kwargs)
        identity = mock.patch.object(manager_module.BoardSession, "identity", return_value={"fingerprint": "fp"})
        return sentinel, identity

    def test_a_refresh_waits_for_a_slow_start_to_finish_and_then_stops_it(self):
        self.previews.stop_for_board_change()
        entered, release, scanned_while_starting, results = threading.Event(), threading.Event(), [], []
        start_worker = preview.PreviewManager._start_worker

        def slow_start_worker(manager, *args):
            entered.set()
            release.wait(5)
            return start_worker(manager, *args)

        def sentinel_refresh(client):
            scanned_while_starting.append(not release.is_set())
            return catalog(imx477())

        def post(path, **kwargs):
            results.append((path, self.app.test_client().post(path, **kwargs).status_code))

        sentinel, identity = self.scan(side_effect=sentinel_refresh, autospec=True)
        # Longer than the start-wait timeout, as a slow board makes a real start.
        with sentinel, identity, mock.patch.object(preview, "START_TIMEOUT_SEC", 0.01), \
                mock.patch.object(preview.PreviewManager, "_start_worker", slow_start_worker):
            starter = threading.Thread(target=post, args=(PREVIEW,), kwargs={"json": {"id": IMX477}})
            starter.start()
            self.assertTrue(entered.wait(5))
            refresher = threading.Thread(target=post, args=("/api/peripherals/refresh",))
            refresher.start()
            refresher.join(0.5)
            release.set()
            starter.join(5)
            refresher.join(5)
        self.assertEqual(sorted(results), [("/api/peripherals/cameras/preview", 200), ("/api/peripherals/refresh", 200)])
        self.assertEqual(scanned_while_starting, [False])
        self.assertIsNone(self.previews._session)

    def test_refreshes_queued_behind_the_preview_lock_still_share_one_scan(self):
        entered, release, results = threading.Event(), threading.Event(), []

        def slow_refresh(client):
            entered.set()
            release.wait(5)
            return catalog(imx477())

        def post():
            results.append(self.app.test_client().post("/api/peripherals/refresh").get_json())

        sentinel, identity = self.scan(side_effect=slow_refresh, autospec=True)
        with sentinel as refresh, identity:
            first = threading.Thread(target=post)
            first.start()
            self.assertTrue(entered.wait(5))
            second = threading.Thread(target=post)
            second.start()
            second.join(0.3)
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(refresh.call_count, 1)
        self.assertEqual(results[0], results[1])


class BoardScriptTests(unittest.TestCase):
    """The board-side shell scripts, run for real with `sh` in a temporary home (no SSH)."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = tmp.name
        self.base = os.path.join(self.home, ".cache", "insight-preview")
        self.env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": self.home, "SSH_CLIENT": "192.168.2.1 51234 22"}
        self.sid = uuid.uuid4().hex

    def sh(self, script, stdin=b"", **env):
        done = subprocess.run(["sh", "-c", script], input=stdin, capture_output=True, timeout=60, env={**self.env, **env})
        return done.stdout.decode()

    def launch(self, program: str, ttl: int = 45):
        """Upload the worker and a stand-in program, then launch it as the preview does."""
        self.sh(preview._upload_script(self.sid, "worker.sh"), preview.WORKER_SCRIPT.encode())
        self.sh(preview._upload_script(self.sid, "preview.py"), program.encode())
        with mock.patch.object(preview, "SESSION_TTL_SEC", ttl):
            self.sh(preview._launch_script(self.sid, [sys.executable, "preview.py"]))
        self.addCleanup(lambda: self.sh(preview._stop_script(self.sid)))

    def pid(self) -> int:
        deadline = time.monotonic() + 10
        path = os.path.join(self.base, self.sid, "pipeline.pid")
        while not os.path.exists(path) and time.monotonic() < deadline:
            time.sleep(0.05)
        with open(path) as handle:
            return int(handle.read())

    def wait_gone(self, pid: int, timeout: float = 20) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            # A killed child the worker has not reaped yet still answers kill -0.
            with open(f"/proc/{pid}/stat") as handle:
                if handle.read().split(") ")[1].startswith("Z"):
                    return True
            time.sleep(0.1)
        return False

    def test_the_work_directory_is_private_to_the_user(self):
        self.sh(preview._upload_script(self.sid, "worker.sh"), b"x")
        self.assertEqual(os.stat(self.base).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(self.base, self.sid)).st_mode & 0o777, 0o700)
        self.assertFalse(preview.WORK_DIR.startswith("/tmp"))
        cache = os.path.join(self.home, "xdg-cache")
        self.sh(preview._upload_script(self.sid, "worker.sh"), b"x", XDG_CACHE_HOME=cache)
        self.assertTrue(os.path.isfile(os.path.join(cache, "insight-preview", self.sid, "worker.sh")))

    def test_the_worker_runs_the_program_and_the_check_waits_for_its_running_line(self):
        self.launch("import time\ntime.sleep(0.5)\nprint('running', flush=True)\ntime.sleep(60)\n")
        pid = self.pid()
        self.assertEqual(self.sh(preview._check_script(self.sid)).splitlines()[0], "running")
        self.assertIn("alive", self.sh(preview._heartbeat_script(self.sid)))
        self.sh(preview._stop_script(self.sid))
        self.assertTrue(self.wait_gone(pid))
        self.assertFalse(os.path.exists(os.path.join(self.base, self.sid)))
        self.assertNotIn("alive", self.sh(preview._heartbeat_script(self.sid)))

    def test_the_worker_stops_the_program_once_heartbeats_lapse(self):
        self.launch("import time\nprint('running', flush=True)\ntime.sleep(60)\n", ttl=1)
        pid = self.pid()
        self.assertTrue(self.wait_gone(pid), "the lease ended the program")
        deadline = time.monotonic() + 10
        while os.path.exists(os.path.join(self.base, self.sid)) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(os.path.exists(os.path.join(self.base, self.sid)))

    def test_a_program_that_fails_before_running_reports_its_error(self):
        self.launch("import sys\nprint('camera_not_found: imx477 5-001a', file=sys.stderr)\nsys.exit(1)\n")
        output = self.sh(preview._check_script(self.sid))
        self.assertNotEqual(output.splitlines()[0] if output else "", "running")
        self.assertIn("camera_not_found", output)

    def test_prepare_finds_pyneat_only_in_the_users_venv(self):
        venv = os.path.join(self.home, "pyneat")
        self.assertEqual(self.sh(preview.PREPARE_SCRIPT).splitlines(), ["192.168.2.1 51234 22"])
        os.makedirs(os.path.join(venv, "bin"))
        os.makedirs(os.path.join(venv, "lib", "python3.11", "site-packages", "pyneat-0.4.0.dist-info"))
        python = os.path.join(venv, "bin", "python")
        with open(python, "w") as handle:
            handle.write("#!/bin/sh\n")
        os.chmod(python, 0o755)
        self.assertEqual(self.sh(preview.PREPARE_SCRIPT).splitlines(), ["192.168.2.1 51234 22", python])
        other = os.path.join(self.home, "elsewhere")
        self.assertEqual(self.sh(preview.PREPARE_SCRIPT, PYNEAT_VENV_DIR=other).splitlines(), ["192.168.2.1 51234 22"])

if __name__ == "__main__":
    unittest.main()
