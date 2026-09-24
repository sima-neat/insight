import json
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
    """Records commands and answers the worker's start check with a pid."""

    def __init__(self, pid="4242"):
        self.calls = []
        self.pid = pid

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append((list(argv), stdin))
        script = argv[-1] if argv else ""
        if "echo $SSH_CLIENT" in script:
            return ExecResult(0, b"192.168.2.1 51234 22\n", b"")
        if "pipeline.pid" in script and script.startswith("sleep"):
            return ExecResult(0, f"{self.pid}\n".encode(), b"")
        return ExecResult(0, b"", b"")

    def commands(self):
        return ["\n".join(argv) for argv, _ in self.calls]


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

    def test_expired_sessions_are_dropped_locally(self):
        session, started = self.start()
        expired = dict(started, expires_at=(datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat(timespec="seconds"))
        self.manager._session = expired
        self.assertIsNone(self.manager.current(1))
        self.manager.stop_stale()
        self.assertIsNone(self.manager.current(1))

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
        with mock.patch.object(preview, "active_channels", side_effect=[set(), set(), {3}]):
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

    def test_preview_responses_are_not_cached(self):
        self.assertEqual(self.client.get("/api/peripherals/preview").headers["Cache-Control"], "no-store")


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


if __name__ == "__main__":
    unittest.main()
