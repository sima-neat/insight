import json
import threading
import unittest
import unittest.mock as mock
from types import SimpleNamespace

from flask import Flask

from neat_insight import port_map
from neat_insight.board import BoardError, ExecResult
from neat_insight.peripherals import api, preview

MODE = {"format": "NV12", "width": 1920, "height": 1080, "fps": 30}
PREVIEW = "/api/peripherals/cameras/preview"
AWAIT_VIDEO = preview.PreviewManager._await_video


def camera(**overrides):
    size = {"width": 1920, "height": 1080, "fps": [{"value": 30}]}
    item = {"id": "mipi:imx477", "name": "imx477", "connection": "mipi", "device": {"camera_name": "imx477"},
            "availability": {"state": "available"}, "default_selection": dict(MODE),
            "formats": [{"format": "NV12", "exportable": True, "sizes": [size]}]}
    return {**item, **overrides}


class FakeTransport:
    def __init__(self, ssh_client=b"192.168.2.1 51234 22\n", started=b"4242\n"):
        self.calls, self.replies = [], {"SSH_CLIENT": ssh_client, "echo alive": b"alive\n", "sleep 3": started}

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv[-1])
        return ExecResult(0, next((out for key, out in self.replies.items() if key in argv[-1]), b""), b"")


def fake_session(transport=None, generation=1):
    return SimpleNamespace(generation=generation, target=SimpleNamespace(mode="ssh"), transport=transport or FakeTransport())


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.manager = preview.PreviewManager()
        self.session = fake_session()
        for patch in (
            mock.patch.object(api, "previews", self.manager),
            mock.patch.object(preview, "active_channels", return_value=set()),
            mock.patch.object(preview, "_channel_rtp", return_value=None),
            mock.patch.object(preview, "port_map_video_range", return_value=(9000, 4)),
            mock.patch.object(preview, "video_ui_port", return_value=8081),
            mock.patch.object(preview.PreviewManager, "_await_video", lambda *args: None),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def start(self, session=None, item=None, mode=MODE):
        return self.manager.start(session or self.session, item or camera(), dict(mode))

    def kills(self, session=None):
        return [call for call in (session or self.session).transport.calls if "kill $pid" in call]

    def client(self):
        app = Flask(__name__)
        app.register_blueprint(api.peripherals_bp)
        app.extensions["neat_board"] = SimpleNamespace(session=lambda: self.session)
        return app.test_client()

    def test_a_busy_camera_is_refused_by_name_and_never_touched(self):
        busy = camera(formats=[], default_selection=None, availability={"state": "in_use", "reason": "Open in app (pid 7)."})
        with mock.patch.object(api, "_camera_or_404", return_value=busy):
            response = self.client().post(PREVIEW, json={"id": busy["id"]})
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "camera_in_use"))
        self.assertIn("app (pid 7)", response.get_json()["error"])
        self.assertEqual(self.session.transport.calls, [])

    def test_each_browser_gets_a_viewer_url_for_its_own_validated_host(self):
        client = self.client()
        with mock.patch.object(api, "_camera_or_404", return_value=camera()):
            for host in ("evil.example/x", "evil:1:2", "[not-v6]:1", "@evil"):
                response = client.post(PREVIEW, json={"id": "x"}, headers={"Host": host})
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"), host)
            self.assertEqual(self.session.transport.calls, [])
            client.post(PREVIEW, json={"id": "x"}, headers={"Host": "attacker.example"})
        url = client.get("/api/peripherals/preview", headers={"Host": "insight.local:9900"}).get_json()["session"]["viewer_url"]
        self.assertTrue(url.startswith("https://insight.local:8081/"), url)

    def test_browser_host_accepts_only_hostnames_and_ip_literals(self):
        cases = {"localhost:9900": "localhost", "10.0.0.5": "10.0.0.5", "[fd00::23]:19900": "fd00::23", "evil:99999": None,
                 "evil.example/x": None, "[1.2.3.4]:80": None, "-bad.example": None, 'evil"onload=': None, "x" * 300: None}
        for header, expected in cases.items():
            self.assertEqual(port_map.browser_host(header), expected, header)

    def test_the_address_the_board_reports_is_not_trusted_blindly(self):
        session = fake_session(FakeTransport(ssh_client=b"$(reboot) 51234 22\n"))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertEqual(ctx.exception.code, "command_failed")

    def test_unlisted_and_fractional_rates_are_refused_before_any_board_work(self):
        no_rates = camera()
        no_rates["formats"][0]["sizes"][0]["fps"] = []
        for item, fps in ((camera(), 120), (no_rates, 29.97)):
            with self.assertRaises(BoardError) as ctx:
                self.start(item=item, mode={**MODE, "fps": fps})
            self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertEqual(self.session.transport.calls, [])

    def test_a_failed_start_removes_its_saved_failure_log(self):
        session = fake_session(FakeTransport(started=b"ERROR: Pipeline doesn't want to pause\n"))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertIn("doesn't want to pause", ctx.exception.extra["detail"])
        self.assertRegex(session.transport.calls[-1], r"rm -rf /tmp/insight-preview/(\w+) /tmp/insight-preview/\1\.log")

    def test_a_preview_is_stopped_on_the_board_that_runs_it(self):
        self.start()
        other = fake_session(generation=2)
        self.start(other)
        self.assertTrue(self.kills())
        self.assertFalse(self.kills(other))

    def test_a_stop_in_flight_never_tears_down_the_session_that_replaced_it(self):
        first = self.start()
        self.manager._session = None
        second = self.start()
        self.manager._stop_current(self.session, first["id"])
        self.assertEqual(self.manager.current()["id"], second["id"])
        self.assertFalse(self.kills())

    def test_a_second_start_and_a_scan_wait_out_a_start_in_flight(self):
        entered, release, scanned = threading.Event(), threading.Event(), threading.Event()

        def scan():
            with self.manager.scan_guard(self.session):
                scanned.set()

        with mock.patch.object(preview.PreviewManager, "_start_worker", lambda *args: (entered.set(), release.wait(5))):
            starter = threading.Thread(target=self.start)
            starter.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaises(BoardError) as ctx:
                self.start()
            self.assertEqual(ctx.exception.code, "preview_active")
            scanner = threading.Thread(target=scan)
            scanner.start()
            self.assertFalse(scanned.wait(0.05))
            release.set()
            starter.join(5)
            scanner.join(5)
        self.assertTrue(scanned.is_set())
        self.assertIsNone(self.manager.current())
        self.assertTrue(self.kills())

    def test_a_board_change_stops_a_preview_renewed_by_a_heartbeat_in_flight(self):
        started = self.start()
        entered, release = threading.Event(), threading.Event()
        exec_ = self.session.transport.exec

        def blocking_exec(argv, **kwargs):
            if "echo alive" in argv[-1]:
                entered.set()
                release.wait(2)
            return exec_(argv, **kwargs)

        self.session.transport.exec = blocking_exec
        beat = threading.Thread(target=self.manager.heartbeat, args=(self.session, started["id"]))
        beat.start()
        self.assertTrue(entered.wait(1))
        self.manager._session["expires_at"] = "2000-01-01T00:00:00+00:00"
        change = threading.Thread(target=self.manager.stop_for_board_change, args=(self.session,))
        change.start()
        with self.manager._condition:
            self.assertTrue(self.manager._condition.wait_for(lambda: self.manager._scan_active, timeout=1))
        self.assertTrue(change.is_alive())
        release.set()
        beat.join(2)
        change.join(2)
        self.assertIsNone(self.manager.current())
        self.assertTrue(self.kills())

    def test_another_sender_on_the_channel_stops_the_preview_at_start_and_on_a_heartbeat(self):
        foreign = mock.patch.object(preview, "_channel_rtp", return_value={"active": True, "ssrc": 777})
        with mock.patch.object(preview, "_pick_ssrc", return_value=1234):
            started = self.start()
            with foreign, mock.patch.object(preview.PreviewManager, "_await_video", AWAIT_VIDEO), \
                    mock.patch.object(preview, "VIDEO_ARRIVAL_TIMEOUT_SEC", 0.01), mock.patch.object(preview.time, "sleep"):
                for attempt in (lambda: self.manager.heartbeat(self.session, started["id"]), self.start):
                    with self.assertRaises(BoardError) as ctx:
                        attempt()
                    self.assertEqual(ctx.exception.code, "channel_taken")
                    self.assertIsNone(self.manager.current())
        self.assertEqual(len(self.kills()), 2)


class PortLookupTests(unittest.TestCase):
    def test_vf_stats_come_from_vf_and_its_viewer_page_reads_as_unknown(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<!DOCTYPE html>"
        with mock.patch.object(preview.urllib.request, "urlopen", return_value=response) as opened:
            self.assertIsNone(preview.active_channels())
        self.assertEqual(opened.call_args.args[0], "https://127.0.0.1:8081/ingest/stats?all=1")

    def test_the_neat_json_fallback_runs_once(self):
        preview._neat_exposed_ports.cache_clear()
        self.addCleanup(preview._neat_exposed_ports.cache_clear)
        result = mock.Mock(stdout=json.dumps({"exposedPorts": [{"name": "videoUI", "hostPortStart": 18081}]}).encode())
        with mock.patch.object(preview.port_map, "read_exposed_ports", return_value=[]), \
                mock.patch.object(preview.subprocess, "run", return_value=result) as run:
            self.assertEqual([preview.video_ui_port(), preview.video_ui_port()], [18081, 18081])
        run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
