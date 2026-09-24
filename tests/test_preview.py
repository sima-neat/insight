import json
import threading
import time
import tempfile
import unittest
import unittest.mock as mock
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult
from neat_insight.peripherals import api, cameras, preview
from neat_insight.peripherals.api import peripherals_bp

FIXTURES = Path(__file__).parent / "fixtures" / "peripherals"
IMX477 = "imx477 5-001a"
CAMERA_ID = "mipi:" + IMX477
MODE = {"format": "NV12", "width": 1920, "height": 1080, "fps": 30}


def camera_item(**overrides) -> dict:
    item = {
        "id": CAMERA_ID,
        "kind": "camera",
        "connection": "mipi",
        "name": IMX477,
        "model": "imx477",
        "device": {"camera_name": IMX477, "camera_name_source": "libcamera"},
        "availability": {"state": "available", "users": [], "reason": None},
        "support": {"tier": "verified", "reason": "", "links": []},
        "modes_source": "live",
        "formats": [
            {
                "format": "NV12",
                "label": "NV12",
                "exportable": True,
                "support": {"tier": "verified", "reason": "", "links": []},
                "range": None,
                "sizes": [{"width": 1920, "height": 1080, "fps": [{"value": 30, "tier": "verified"}]}],
            }
        ],
        "default_selection": dict(MODE),
        "notes": [],
        "errors": [],
    }
    item.update(overrides)
    return item


class FakeTransport:
    """Records commands, answers the worker's start check with a pid, and keeps a worker alive."""

    def __init__(self, pid="4242", worker_alive=True, ssh_client=b"192.168.2.1 51234 22\n", saved_log=b""):
        self.calls = []
        self.pid = pid
        self.saved_log = saved_log
        self.worker_alive = worker_alive
        self.ssh_client = ssh_client

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append((list(argv), stdin))
        script = argv[-1] if argv else ""
        if "echo $SSH_CLIENT" in script:
            return ExecResult(0, self.ssh_client, b"")
        if "echo alive" in script:
            return ExecResult(0, b"alive\n" if self.worker_alive else b"", b"")
        if "pipeline.pid" in script and script.startswith("sleep"):
            if self.pid is None:
                return ExecResult(0, self.saved_log, b"")
            return ExecResult(0, f"{self.pid}\n".encode(), b"")
        return ExecResult(0, b"", b"")

    def commands(self):
        return ["\n".join(argv) for argv, _ in self.calls]


class FailingStopTransport(FakeTransport):
    def exec(self, argv, *, timeout, stdin=None):
        if argv and "kill $pid" in argv[-1]:
            raise BoardError("unreachable", "The board disconnected while stopping.")
        return super().exec(argv, timeout=timeout, stdin=stdin)


def fake_session(generation=1, mode="ssh", transport=None):
    transport = transport or FakeTransport()
    target = SimpleNamespace(mode=mode, label="sima@192.168.2.2", source="sdk-env")
    return SimpleNamespace(generation=generation, target=target, transport=transport,
                           identity=lambda: {"hostname": "modalix", "fingerprint": "fp-1",
                                             "machine": "modalix", "build_version": "2.1.3"})


class PreviewManagerTests(unittest.TestCase):
    def setUp(self):
        self.manager = preview.PreviewManager()
        patches = [
            mock.patch.object(preview, "active_channels", return_value=set()),
            mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)),
            mock.patch.object(preview, "video_ui_port", return_value=8081),
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args: None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def start(self, session=None, item=None, mode=None):
        session = session or fake_session()
        return session, self.manager.start(session, item or camera_item(), mode or dict(MODE), "insight.local")

    def test_start_launches_the_pipeline_and_reserves_a_channel(self):
        session, started = self.start()
        self.assertEqual((started["camera_id"], started["state"], started["channel"]), (CAMERA_ID, "live", 3))
        self.assertIn("src=3", started["viewer_url"])
        # The pane shows video only: without embed=1 the iframe carries the viewer's whole toolbar.
        self.assertIn("embed=1", started["viewer_url"])
        self.assertTrue(started["viewer_url"].startswith("https://insight.local:8081/static/viewer.html"))
        launched = "\n".join(session.transport.commands())
        self.assertIn(f"camera-name={IMX477}", launched)
        self.assertIn("neatencoder", launched)
        self.assertIn("enc-type=h264", launched)
        self.assertIn("rtph264pay", launched)
        self.assertIn("pt=96", launched)
        self.assertIn("host=192.168.2.1", launched)  # the address the board sees Insight on
        self.assertIn("port=9003", launched)  # published base + channel
        self.assertIn("setsid", launched)

    def test_local_board_sends_to_loopback(self):
        session = fake_session(mode="local")
        _, started = self.start(session=session)
        launched = "\n".join(session.transport.commands())
        self.assertIn("host=127.0.0.1", launched)
        self.assertIn(f"port={9000 + started['channel']}", launched)

    def test_channel_avoids_streams_already_arriving(self):
        with mock.patch.object(preview, "active_channels", return_value={3, 2}):
            _, started = self.start()
        self.assertEqual(started["channel"], 1)

    def test_no_free_channel_is_reported_with_a_fix(self):
        with mock.patch.object(preview, "active_channels", return_value={0, 1, 2, 3}):
            with self.assertRaises(BoardError) as ctx:
                self.start()
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("no_channel", 409))
        self.assertIn("Stop a streaming source", ctx.exception.hint)

    def test_busy_camera_is_refused_without_touching_it(self):
        item = camera_item(availability={"state": "in_use", "users": [{"pid": 7, "command": "app"}],
                                         "reason": "Open in app (pid 7)."})
        session = fake_session()
        with self.assertRaises(BoardError) as ctx:
            self.start(session=session, item=item)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("camera_in_use", 409))
        self.assertIn("app (pid 7)", ctx.exception.message)
        self.assertEqual(session.transport.calls, [])

    def test_usb_and_unlisted_modes_are_refused(self):
        with self.assertRaises(BoardError) as ctx:
            self.start(item=camera_item(connection="usb"))
        self.assertEqual(ctx.exception.status, 400)
        with self.assertRaises(BoardError) as ctx:
            self.start(mode={"format": "NV12", "width": 1280, "height": 720, "fps": 30})
        self.assertIn("core#883", ctx.exception.hint)

    def test_second_preview_is_refused_while_one_runs(self):
        session, _ = self.start()
        with self.assertRaises(BoardError) as ctx:
            self.manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("preview_active", 409))

    def test_worker_failure_reports_the_board_output_and_cleans_up(self):
        transport = FakeTransport(pid="")
        session = fake_session(transport=transport)
        with self.assertRaises(BoardError) as ctx:
            self.start(session=session)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("command_failed", 502))
        self.assertIn("rm -rf", "\n".join(transport.commands()))
        self.assertIsNone(self.manager.current(1))

    def test_heartbeat_extends_and_a_stale_id_cannot_stop_a_newer_session(self):
        session, started = self.start()
        beaten = self.manager.heartbeat(session, started["id"])
        self.assertIn(f"{preview.WORKER_DIR}/{started['id']}/heartbeat", "\n".join(session.transport.commands()))
        self.assertGreaterEqual(beaten["expires_at"], started["expires_at"])
        with self.assertRaises(BoardError) as ctx:
            self.manager.heartbeat(session, "not-a-session")
        self.assertEqual(ctx.exception.status, 404)
        with self.assertRaises(BoardError):
            self.manager.stop(session, "not-a-session")
        self.assertIsNotNone(self.manager.current(1))

    def test_stop_kills_the_pipeline_and_frees_the_session(self):
        session, started = self.start()
        stopped = self.manager.stop(session, started["id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertIsNone(self.manager.current(1))
        self.assertIn("pipeline.pid", "\n".join(session.transport.commands()))

    def test_failed_stop_keeps_ownership_so_it_can_be_retried(self):
        session = fake_session(transport=FailingStopTransport())
        _, started = self.start(session=session)
        with self.assertRaises(BoardError) as ctx:
            self.manager.stop(session, started["id"])
        self.assertEqual(ctx.exception.code, "unreachable")
        self.assertEqual(self.manager.current(1)["id"], started["id"])

    def test_expired_sessions_are_dropped_locally(self):
        session, started = self.start()
        expired = dict(started, expires_at=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(timespec="seconds"))
        self.manager._session = expired
        self.assertIsNone(self.manager.current(1))
        calls_before_heartbeat = len(session.transport.calls)
        with self.assertRaises(BoardError) as ctx:
            self.manager.heartbeat(session, started["id"])
        self.assertEqual(ctx.exception.code, "not_found")
        self.assertEqual(len(session.transport.calls), calls_before_heartbeat)
        self.manager._session = expired
        self.manager.stop_stale()
        self.assertIsNone(self.manager.current(1))

    def test_expired_session_does_not_contact_an_unreachable_board_during_replacement(self):
        session = fake_session(transport=FailingStopTransport())
        _, started = self.start(session=session)
        self.manager._session = {
            **started,
            "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(timespec="seconds"),
        }

        self.manager.stop_for_board_change(session)

        self.assertIsNone(self.manager.current(1))
        self.assertFalse([cmd for cmd in session.transport.commands() if "kill $pid" in cmd])

    def test_board_change_waits_for_in_flight_heartbeat_then_stops_renewed_session(self):
        session, started = self.start()
        heartbeat_entered = threading.Event()
        release_heartbeat = threading.Event()
        cleanup_done = threading.Event()
        heartbeat_result = []
        errors = []
        original_exec = session.transport.exec

        def blocking_exec(argv, *, timeout, stdin=None):
            if argv and "echo alive" in argv[-1]:
                heartbeat_entered.set()
                if not release_heartbeat.wait(2):
                    raise AssertionError("heartbeat test gate timed out")
            return original_exec(argv, timeout=timeout, stdin=stdin)

        session.transport.exec = blocking_exec
        def heartbeat():
            try:
                heartbeat_result.append(self.manager.heartbeat(session, started["id"]))
            except Exception as exc:  # pragma: no cover - asserted below for thread handoff
                errors.append(exc)

        def cleanup():
            try:
                self.manager.stop_for_board_change(session)
            except Exception as exc:  # pragma: no cover - asserted below for thread handoff
                errors.append(exc)
            finally:
                cleanup_done.set()

        heartbeat_thread = threading.Thread(target=heartbeat)
        heartbeat_thread.start()
        self.assertTrue(heartbeat_entered.wait(1))
        with self.manager._lock:
            self.manager._session = {
                **self.manager._session,
                "expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(timespec="seconds"),
            }
        cleanup_thread = threading.Thread(target=cleanup)
        cleanup_thread.start()
        with self.manager._condition:
            self.assertTrue(self.manager._condition.wait_for(lambda: self.manager._scan_active, timeout=1))
        self.assertFalse(cleanup_done.is_set())

        release_heartbeat.set()
        heartbeat_thread.join(2)
        cleanup_thread.join(2)

        self.assertFalse(heartbeat_thread.is_alive())
        self.assertFalse(cleanup_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(heartbeat_result[0]["state"], "live")
        self.assertIsNone(self.manager.current(1))
        self.assertTrue([cmd for cmd in session.transport.commands() if "kill $pid" in cmd])

    def test_a_session_from_another_board_is_not_reported(self):
        self.start()
        self.assertIsNone(self.manager.current(generation=2))

    def test_worker_script_expires_without_heartbeats(self):
        script = preview.WORKER_SCRIPT
        self.assertIn("stat -c %Y", script)
        self.assertIn("kill -9", script)
        self.assertIn("kill -0", script)


class PreviewVideoArrivalTests(unittest.TestCase):
    """A preview is only 'live' once vf actually receives the stream."""

    def setUp(self):
        self.manager = preview.PreviewManager()
        for patch in (
            mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)),
            mock.patch.object(preview, "video_ui_port", return_value=8081),
            mock.patch.object(preview.time, "sleep", lambda _seconds: None),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_start_returns_once_video_arrives(self):
        session = fake_session()
        with mock.patch.object(preview, "active_channels", side_effect=[set(), set(), {3}]), \
                mock.patch.object(preview, "_channel_packets", return_value=None):
            started = self.manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.assertEqual(started["channel"], 3)
        self.assertIsNotNone(self.manager.current(1))

    def test_silent_channel_stops_capture_and_explains_the_network(self):
        session = fake_session()
        with mock.patch.object(preview, "active_channels", return_value=set()):
            with self.assertRaises(BoardError) as ctx:
                self.manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("no_video", 502))
        self.assertIn("firewall", ctx.exception.hint)
        self.assertIsNone(self.manager.current(1))
        self.assertIn("pipeline.pid", "\n".join(session.transport.commands()))

    def test_a_remote_board_without_a_published_range_is_refused(self):
        with mock.patch.object(preview, "port_map_video_range", return_value=None):
            with self.assertRaises(BoardError) as ctx:
                self.manager.start(fake_session(), camera_item(), dict(MODE), "insight.local")
        self.assertEqual(ctx.exception.code, "no_channel")
        self.assertIn("neat --json", ctx.exception.hint)


class PreviewApiTests(unittest.TestCase):
    def setUp(self):
        self.transport = FakeTransport()
        self.session = fake_session(transport=self.transport)
        self.manager = SimpleNamespace(session=lambda: self.session)
        for patch in (
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args: None),
            mock.patch.object(api, "previews", preview.PreviewManager()),
            mock.patch.object(api, "scans", cameras.ScanCache()),
            mock.patch.object(preview, "active_channels", return_value=set()),
            mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        app = Flask(__name__)
        app.register_blueprint(peripherals_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def seed_scan(self):
        snapshot = cameras.empty_snapshot({"label": "sima@192.168.2.2", "fingerprint": "fp-1"}, 1)
        snapshot.update(scanned_at="2026-09-22T20:00:00+00:00", items=[camera_item()],
                        platform={"libcamerasrc": {"present": True, "external_buffer_mode": True, "buffer_count": True}})
        api.scans._entry = {"generation": 1, "fingerprint": "fp-1", "snapshot": snapshot, "modes": {}, "completed": 0.0}

    def test_preview_is_null_before_it_starts(self):
        response = self.client.get("/api/peripherals/preview")
        self.assertEqual((response.status_code, response.get_json()), (200, {"session": None}))
        self.assertEqual(self.transport.calls, [])

    def test_start_requires_a_scan_then_returns_a_session(self):
        response = self.client.post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID})
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.seed_scan()
        response = self.client.post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID})
        self.assertEqual(response.status_code, 200)
        session = response.get_json()["session"]
        self.assertEqual((session["camera_id"], session["state"]), (CAMERA_ID, "live"))
        self.assertEqual(self.client.get("/api/peripherals/preview").get_json()["session"]["id"], session["id"])

    def test_unknown_camera_and_unknown_session(self):
        self.seed_scan()
        self.assertEqual(self.client.post("/api/peripherals/cameras/preview", json={"id": "mipi:nope"}).status_code, 404)
        self.assertEqual(self.client.post("/api/peripherals/cameras/preview/zzz/heartbeat").status_code, 404)
        self.assertEqual(self.client.post("/api/peripherals/cameras/preview/zzz/stop").status_code, 404)

    def test_heartbeat_and_stop_round_trip(self):
        self.seed_scan()
        session = self.client.post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID}).get_json()["session"]
        beat = self.client.post(f"/api/peripherals/cameras/preview/{session['id']}/heartbeat")
        self.assertEqual(beat.status_code, 200)
        stop = self.client.post(f"/api/peripherals/cameras/preview/{session['id']}/stop")
        self.assertEqual((stop.status_code, stop.get_json()["session"]["state"]), (200, "stopped"))
        self.assertIsNone(self.client.get("/api/peripherals/preview").get_json()["session"])

    def test_failed_api_stop_returns_transport_error_and_keeps_the_session(self):
        self.seed_scan()
        session = self.client.post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID}).get_json()["session"]
        original_exec = self.transport.exec

        def fail_stop(argv, *, timeout, stdin=None):
            if argv and "kill $pid" in argv[-1]:
                raise BoardError("unreachable", "The board disconnected while stopping.")
            return original_exec(argv, timeout=timeout, stdin=stdin)

        self.transport.exec = fail_stop
        response = self.client.post(f"/api/peripherals/cameras/preview/{session['id']}/stop")
        self.assertEqual((response.status_code, response.get_json()["code"]), (502, "unreachable"))
        self.assertEqual(self.client.get("/api/peripherals/preview").get_json()["session"]["id"], session["id"])

    def test_heartbeat_and_stop_propagate_transport_timeouts(self):
        self.seed_scan()
        session = self.client.post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID}).get_json()["session"]

        def timeout(*_args, **_kwargs):
            raise BoardError("timeout", "The board did not answer in time.")

        self.transport.exec = timeout
        for action in ("heartbeat", "stop"):
            with self.subTest(action=action):
                response = self.client.post(f"/api/peripherals/cameras/preview/{session['id']}/{action}")
                self.assertEqual((response.status_code, response.get_json()["code"]), (504, "timeout"))

    def test_preview_responses_are_not_cached(self):
        self.assertEqual(self.client.get("/api/peripherals/preview").headers["Cache-Control"], "no-store")

    def test_ipv6_request_host_produces_a_bracketed_viewer_url(self):
        self.seed_scan()
        response = self.client.post(
            "/api/peripherals/cameras/preview",
            json={"id": CAMERA_ID},
            headers={"Host": "[fd00::23]:19900"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["session"]["viewer_url"].startswith("https://[fd00::23]:"))


class PreviewOwnershipTests(unittest.TestCase):
    """A preview belongs to the board that runs it, and to the id that started it."""

    def setUp(self):
        self.manager = preview.PreviewManager()
        patches = [
            mock.patch.object(preview, "active_channels", return_value=set()),
            mock.patch.object(preview, "_channel_packets", return_value=0),
            mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)),
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args, **kwargs: None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_preview_is_stopped_on_the_board_that_is_running_it(self):
        board_a = fake_session(generation=1)
        started = self.manager.start(board_a, camera_item(), dict(MODE), "insight.local")
        board_b = fake_session(generation=2)
        self.manager.start(board_b, camera_item(), dict(MODE), "insight.local")
        killed_on_a = [cmd for cmd in board_a.transport.commands() if started["id"] in cmd and "kill" in cmd]
        killed_on_b = [cmd for cmd in board_b.transport.commands() if started["id"] in cmd and "kill" in cmd]
        self.assertTrue(killed_on_a, "the first board should have been told to stop its own preview")
        self.assertFalse(killed_on_b, "the new board must not be asked to kill another board's session")

    def test_a_stop_in_flight_never_tears_down_the_session_that_replaced_it(self):
        """The stop reached `_stop_current` before a newer session took the slot."""
        session = fake_session()
        first = self.manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.manager._session = None  # the first session ended while the stop was in flight
        self.manager._owner = None
        second = self.manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.manager._stop_current(session, first["id"])
        self.assertEqual((self.manager.current(1) or {}).get("id"), second["id"])
        self.assertFalse([cmd for cmd in session.transport.commands()
                          if second["id"] in cmd and "kill" in cmd])

    def test_a_second_start_is_refused_while_the_first_is_still_starting(self):
        session = fake_session()
        gate = threading.Event()
        worker_entered = threading.Event()
        errors = []

        def slow_worker(*args, **kwargs):
            worker_entered.set()
            gate.wait(5)

        with mock.patch.object(preview.PreviewManager, "_start_worker", slow_worker):
            first = threading.Thread(target=lambda: self.manager.start(session, camera_item(), dict(MODE), "h"))
            first.start()
            self.assertTrue(worker_entered.wait(2))
            try:
                self.manager.start(session, camera_item(), dict(MODE), "h")
            except BoardError as exc:
                errors.append(exc)
            gate.set()
            first.join(10)
        self.assertEqual([exc.code for exc in errors], ["preview_active"])

    def test_a_scan_waits_for_an_in_flight_start_then_stops_it(self):
        session = fake_session()
        worker_gate = threading.Event()
        worker_entered = threading.Event()
        scan_entered = threading.Event()

        def slow_worker(*args, **kwargs):
            worker_entered.set()
            worker_gate.wait(5)

        with mock.patch.object(preview.PreviewManager, "_start_worker", slow_worker):
            starter = threading.Thread(target=lambda: self.manager.start(session, camera_item(), dict(MODE), "h"))
            starter.start()
            self.assertTrue(worker_entered.wait(2))

            def scan():
                with self.manager.scan_guard(session):
                    scan_entered.set()

            scanner = threading.Thread(target=scan)
            scanner.start()
            self.assertFalse(scan_entered.wait(0.05), "the probe must not enter while capture is starting")
            worker_gate.set()
            starter.join(10)
            scanner.join(10)

        self.assertTrue(scan_entered.is_set())
        self.assertIsNone(self.manager.current(1))
        self.assertIn("kill $pid", "\n".join(session.transport.commands()))


class PreviewStartFailureTests(unittest.TestCase):
    def test_a_pipeline_that_dies_at_once_still_reports_why(self):
        """The worker deletes its directory on exit, so the reason lives beside it."""
        manager = preview.PreviewManager()
        transport = FakeTransport(pid=None, saved_log=b"ERROR: Pipeline doesn't want to pause\n")
        session = fake_session(transport=transport)
        with mock.patch.object(preview, "active_channels", return_value=set()), \
                mock.patch.object(preview, "_channel_packets", return_value=0), \
                mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)):
            with self.assertRaises(BoardError) as ctx:
                manager.start(session, camera_item(), dict(MODE), "insight.local")
        self.assertEqual(ctx.exception.code, "command_failed")
        self.assertIn("doesn't want to pause", ctx.exception.extra.get("detail", ""))
        self.assertIsNone(manager.current(1))

    def test_a_failed_start_removes_the_saved_failure_log_too(self):
        """The saved tail has been read into the error; nothing else would remove it for an hour."""
        manager = preview.PreviewManager()
        transport = FakeTransport(pid=None, saved_log=b"ERROR: Pipeline doesn't want to pause\n")
        session = fake_session(transport=transport)
        with mock.patch.object(preview, "active_channels", return_value=set()), \
                mock.patch.object(preview, "_channel_packets", return_value=0), \
                mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)):
            with self.assertRaises(BoardError):
                manager.start(session, camera_item(), dict(MODE), "insight.local")
        setup = next(cmd for cmd in transport.commands() if "worker.sh" in cmd and "mkdir -p" in cmd)
        session_id = setup.split(f"{preview.WORKER_DIR}/", 1)[1].split("/", 1)[0].split()[0]
        removals = [cmd for cmd in transport.commands() if cmd.startswith("sh\n-c\nrm -rf")]
        self.assertTrue(removals, "a failed start must clean up on the board")
        self.assertIn(f"{preview.WORKER_DIR}/{session_id}.log", removals[-1])
        self.assertIn(f"{preview.WORKER_DIR}/{session_id} ", removals[-1])


class PreviewHeartbeatTests(unittest.TestCase):
    def test_a_heartbeat_that_finds_no_worker_reports_the_preview_as_gone(self):
        manager = preview.PreviewManager()
        transport = FakeTransport()
        session = fake_session(transport=transport)
        with mock.patch.object(preview, "active_channels", return_value=set()), \
                mock.patch.object(preview, "_channel_packets", return_value=0), \
                mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)), \
                mock.patch.object(preview.PreviewManager, "_await_video", lambda *a, **k: None):
            started = manager.start(session, camera_item(), dict(MODE), "insight.local")
        transport.worker_alive = False  # the board-side worker died or was cleaned up
        with self.assertRaises(BoardError) as ctx:
            manager.heartbeat(session, started["id"])
        self.assertEqual(ctx.exception.status, 404)
        self.assertIsNone(manager.current(1))


class PreviewModeValidationTests(unittest.TestCase):
    def test_an_unreported_frame_rate_is_refused_with_the_rates_that_exist(self):
        with self.assertRaises(BoardError) as ctx:
            preview._require_previewable(camera_item(), {**MODE, "fps": 120})
        self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertIn("30", ctx.exception.hint)

    def test_the_chosen_rate_is_enforced_not_merely_requested(self):
        """libcamera delivers the sensor mode's rate whatever the caps ask for, so the pipeline caps it."""
        command = " ".join(preview._pipeline(camera_item(), {**MODE, "fps": 30}, "127.0.0.1", 9003))
        self.assertIn("framerate=30/1", command)
        self.assertIn("videorate max-rate=30", command)
        # videorate sits between the camera and the encoder, or the encoder would see the surplus.
        self.assertLess(command.index("videorate"), command.index("neatencoder"))

    def test_caps_videorate_and_encoder_all_get_the_same_rate(self):
        command = " ".join(preview._pipeline(camera_item(), {**MODE, "fps": 30.0}, "127.0.0.1", 9003))
        self.assertIn("framerate=30/1", command)
        self.assertIn("max-rate=30 ", command)
        self.assertIn("enc-frame-rate=30 ", command)

    def test_a_fractional_rate_is_refused_not_given_to_the_encoder_truncated(self):
        """enc-frame-rate and max-rate are integers; 29.97 caps with a 29 fps encoder is inconsistent."""
        with self.assertRaises(BoardError) as ctx:
            preview._pipeline(camera_item(), {**MODE, "fps": 29.97}, "127.0.0.1", 9003)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("invalid_request", 400))
        self.assertIn("whole-number", ctx.exception.message)

    def test_a_fractional_rate_is_refused_before_any_board_work(self):
        """A size that lists no rates would otherwise let any rate through to the board."""
        size = {"width": 1920, "height": 1080, "fps": []}
        item = camera_item()
        item["formats"][0]["sizes"] = [size]
        manager = preview.PreviewManager()
        session = fake_session()
        with mock.patch.object(preview, "active_channels", return_value=set()), \
                mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)):
            with self.assertRaises(BoardError) as ctx:
                manager.start(session, item, {**MODE, "fps": 59.94}, "insight.local")
        self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertFalse([cmd for cmd in session.transport.commands() if "gst-launch" in cmd])

    def test_an_address_the_board_reports_is_not_trusted_blindly(self):
        manager = preview.PreviewManager()
        session = fake_session(transport=FakeTransport(ssh_client=b"$(reboot) 51234 22\n"))
        with mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)):
            with self.assertRaises(BoardError) as ctx:
                manager._insight_endpoint(session, 3)
        self.assertEqual(ctx.exception.code, "command_failed")


class BusyCameraTests(unittest.TestCase):
    """A camera another process holds reports no modes, and that must not mask the real reason."""

    def test_a_busy_camera_names_its_holder_even_with_no_known_modes(self):
        app = Flask("busy")
        app.register_blueprint(peripherals_bp)
        item = camera_item(
            formats=[],
            default_selection=None,
            availability={"state": "in_use", "users": [{"pid": 25411, "command": "gst-launch-1.0"}],
                          "reason": "Open in gst-launch-1.0 (pid 25411)."},
        )
        session = fake_session()
        with mock.patch.object(api, "get_board_manager", return_value=SimpleNamespace(session=lambda: session)), \
                mock.patch.object(api, "_camera_or_404", return_value=item):
            response = app.test_client().post("/api/peripherals/cameras/preview", json={"id": CAMERA_ID})
        body = response.get_json()
        self.assertEqual((response.status_code, body["code"]), (409, "camera_in_use"))
        self.assertIn("gst-launch-1.0 (pid 25411)", body["error"])


class ActiveChannelTests(unittest.TestCase):
    """vf answers an unknown path with the viewer page, so the URL and the parsing both have to be right."""

    def urlopen(self, body: bytes):
        response = mock.MagicMock()
        response.read.return_value = body
        response.__enter__.return_value = response
        return mock.patch.object(preview.urllib.request, "urlopen", return_value=response)

    def test_stats_come_from_the_vf_route_not_the_insight_proxy(self):
        payload = json.dumps({"channels": [{"channel": 2, "active": True}, {"channel": 0, "active": False}]}).encode()
        with self.urlopen(payload) as opened:
            self.assertEqual(preview.active_channels(8081), {2})
        self.assertEqual(opened.call_args.args[0], "https://127.0.0.1:8081/ingest/stats?all=1")

    def test_packet_counter_uses_the_real_nested_rtp_schema(self):
        payload = json.dumps({"channels": [{"channel": 3, "packets_received": 999, "rtp": {"packets_received": 41}}]}).encode()
        with self.urlopen(payload):
            self.assertEqual(preview._channel_packets(3), 41)

    def test_collision_guard_waits_for_the_reserved_channel_counter_to_rise(self):
        manager = preview.PreviewManager()
        session = {"id": "s1", "channel": 3}
        with mock.patch.object(preview, "active_channels", return_value={3}), \
                mock.patch.object(preview, "_channel_packets", side_effect=[12, 13]), \
                mock.patch.object(preview.time, "monotonic", side_effect=[0.0, 0.1, 0.2]), \
                mock.patch.object(preview.time, "sleep", return_value=None):
            manager._await_video(fake_session(), session, baseline=12)

    def test_the_viewer_page_is_not_read_as_an_idle_board(self):
        with self.urlopen(b"<!DOCTYPE html>\n<html></html>"):
            self.assertIsNone(preview.active_channels())

    def test_an_unreachable_viewer_refuses_the_preview(self):
        manager = preview.PreviewManager()
        with mock.patch.object(preview, "active_channels", return_value=None), \
                mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)):
            with self.assertRaises(BoardError) as ctx:
                manager.start(fake_session(), camera_item(), dict(MODE), "insight.local")
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("viewer_unavailable", 502))


class PortMapAndViewerUrlTests(unittest.TestCase):
    def test_canonical_nested_map_and_string_ports_are_shared_with_preview(self):
        data = {
            "schema": "sima.neat.port-map.v1",
            "videoUDP": {"hostStart": "19000", "hostEnd": "19003", "protocol": "udp"},
            "videoUI": {"tcp": {"host": "18081"}},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ports.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            with mock.patch.dict("os.environ", {"NEAT_PORT_MAP_FILE": str(path)}):
                self.assertEqual(preview.port_map_video_range(), (19000, 4))
                self.assertEqual(preview.video_ui_port(), 18081)


if __name__ == "__main__":
    unittest.main()
