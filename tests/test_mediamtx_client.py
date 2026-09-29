import json
import logging
import threading
import time
import unittest
import unittest.mock as mock

from neat_insight import mediamtx

# Shapes captured from mediamtx v1.12.1 /v3 API on 2026-09-16.
PATHS = [
    {"name": "src1", "confName": "src1", "source": {"type": "rtspSession", "id": "pub-1"}, "ready": True,
     "readyTime": "2026-09-16T13:09:59.424615217Z", "tracks": ["H264"], "bytesReceived": 1_000_000, "bytesSent": 0,
     "readers": [{"type": "rtspSession", "id": "read-1"}, {"type": "rtspSession", "id": "probe-1"}, {"type": "rtspSession", "id": "prev-1"}]},
    {"name": "src2", "confName": "src2", "source": {"type": "rtspSession", "id": "pub-2"}, "ready": True,
     "readyTime": "2026-09-16T13:10:00.000000000Z", "tracks": ["H264"], "bytesReceived": 468_305, "bytesSent": 0, "readers": []},
    {"name": "src3", "confName": "src3", "source": {"type": "srtConn", "id": "pub-3"}, "ready": True,
     "readyTime": "2026-09-16T13:11:00.000000000Z", "tracks": ["H264"], "bytesReceived": 5_000, "bytesSent": 0, "readers": []},
    {"name": "src4", "confName": "src4", "source": {"type": "webRTCSession", "id": "pub-4"}, "ready": True,
     "readyTime": "2026-09-16T13:12:00.000000000Z", "tracks": ["VP8", "Opus"], "bytesReceived": 5_000, "bytesSent": 0, "readers": []},
    {"name": "src5", "confName": "src5", "source": None, "ready": False, "readyTime": None, "tracks": [], "bytesReceived": 0, "bytesSent": 0, "readers": []},
    {"name": "src6", "confName": "src6", "source": {"type": "rtspSession", "id": "pub-6"}, "ready": True,
     "readyTime": "2026-09-16T13:13:00.000000000Z", "tracks": ["Opus"], "bytesReceived": 100, "bytesSent": 0, "readers": []},
]
SESSIONS = {
    "rtspsessions": [
        {"id": "pub-1", "remoteAddr": "127.0.0.1:40968", "state": "publish", "path": "src1", "query": mediamtx.PUBLISHER_TAG, "transport": "TCP"},
        {"id": "read-1", "remoteAddr": "172.19.0.1:49878", "state": "read", "path": "src1", "query": "", "transport": "TCP"},
        {"id": "probe-1", "remoteAddr": "127.0.0.1:50001", "state": "read", "path": "src1", "query": "reader=insight-probe", "transport": "TCP"},
        {"id": "prev-1", "remoteAddr": "127.0.0.1:50002", "state": "read", "path": "src1", "query": "reader=insight-preview", "transport": "TCP"},
        {"id": "pub-2", "remoteAddr": "172.19.0.1:47168", "state": "publish", "path": "src2", "query": "", "transport": "TCP"},
        {"id": "pub-6", "remoteAddr": "172.19.0.1:47170", "state": "publish", "path": "src6", "query": "", "transport": "TCP"},
    ],
    "rtspssessions": [],
    "webrtcsessions": [{"id": "pub-4", "remoteAddr": "172.19.0.5:51000", "state": "publish", "path": "src4", "query": ""}],
    "srtconns": [{"id": "pub-3", "remoteAddr": "10.0.0.5:59399", "state": "publish", "path": "src3", "query": ""}],
    "rtmpconns": [],
    "rtmpsconns": [],
}


class SnapshotParsingTests(unittest.TestCase):
    def setUp(self):
        self.snap = mediamtx.build_snapshot(PATHS, SESSIONS)

    def test_untagged_rtsp_publisher_is_external(self):
        src2 = self.snap["src2"]
        self.assertTrue(src2.external)
        self.assertEqual((src2.protocol, src2.address, src2.codec), ("rtsp", "172.19.0.1", "h264"))
        self.assertEqual(src2.since, "2026-09-16T13:10:00.000000000Z")
        self.assertEqual(src2.source_id, "pub-2")

    def test_insight_tagged_publisher_is_not_external(self):
        self.assertTrue(self.snap["src1"].ready)
        self.assertTrue(self.snap["src1"].owned_by_insight)
        self.assertFalse(self.snap["src1"].external)

    def test_lookalike_publisher_tags_stay_external(self):
        # The tag carries a per-process secret and is matched exactly: neither the bare
        # public prefix nor a query that merely contains it may pass for Insight's own.
        for query in ("publisher=insight", "xpublisher=insightful", f"x{mediamtx.PUBLISHER_TAG}", f"{mediamtx.PUBLISHER_TAG}x"):
            sessions = {**SESSIONS, "rtspsessions": [{"id": "pub-2", "remoteAddr": "10.0.0.9:4000", "query": query}]}
            with self.subTest(query=query):
                self.assertTrue(mediamtx.build_snapshot(PATHS, sessions)["src2"].external)

    def test_idle_path_is_neither_ready_nor_external(self):
        self.assertFalse(self.snap["src5"].ready)
        self.assertFalse(self.snap["src5"].external)
        self.assertEqual(self.snap["src5"].readers, [])

    def test_readers_hide_probe_and_label_preview(self):
        self.assertEqual(self.snap["src1"].readers, [
            {"protocol": "rtsp", "address": "172.19.0.1"},
            {"protocol": "rtsp", "address": "127.0.0.1", "label": "insight preview"},
        ])

    def test_srt_and_webrtc_publishers_map_protocol(self):
        self.assertEqual((self.snap["src3"].protocol, self.snap["src3"].address), ("srt", "10.0.0.5"))
        self.assertEqual((self.snap["src4"].protocol, self.snap["src4"].codec), ("webrtc", "vp8"))

    def test_audio_only_path_has_codec_none(self):
        self.assertEqual(self.snap["src6"].codec, "none")

    def test_track_codec_mapping(self):
        self.assertEqual(mediamtx.track_codec(["Opus", "H265"]), "h265")
        self.assertEqual(mediamtx.track_codec(["M-JPEG"]), "mjpeg")
        self.assertEqual(mediamtx.track_codec(["AV1"]), "av1")
        self.assertEqual(mediamtx.track_codec([]), "none")

    def test_unknown_source_type_is_external_with_raw_protocol(self):
        paths = [dict(PATHS[1], source={"type": "futureConn", "id": "x"})]
        snap = mediamtx.build_snapshot(paths, SESSIONS)
        self.assertTrue(snap["src2"].external)
        self.assertEqual(snap["src2"].protocol, "futureConn")
        self.assertIsNone(snap["src2"].address)


class ApiCredentialTests(unittest.TestCase):
    def test_default_request_authenticates_as_the_api_user(self):
        import base64
        from http.server import BaseHTTPRequestHandler, HTTPServer
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.handle_request, daemon=True).start()
        status, _ = mediamtx._default_request("GET", f"http://127.0.0.1:{server.server_address[1]}/v3/paths/list")
        self.assertEqual(status, 200)
        expected = base64.b64encode(f"{mediamtx.API_USER}:{mediamtx.API_PASSWORD}".encode()).decode()
        self.assertEqual(seen, [f"Basic {expected}"])

    def test_render_config_swaps_the_placeholder_for_the_password(self):
        rendered = mediamtx.render_config(f"user: insight\npass: {mediamtx.API_PASSWORD_PLACEHOLDER}\n", "s3cret")
        self.assertEqual(rendered, 'user: insight\npass: "s3cret"\n')

    def test_rendered_password_is_a_quoted_yaml_string(self):
        # A bare `pass: null` would read as no password at all, opening the API; the
        # allowed character set needs no escaping inside double quotes.
        for password in ("null", "NULL", "true", "yes", "off", "0123"):
            with self.subTest(password=password):
                rendered = mediamtx.render_config(f"pass: {mediamtx.API_PASSWORD_PLACEHOLDER}\n", password)
                self.assertEqual(rendered, f'pass: "{password}"\n')

    def test_render_config_refuses_a_config_without_the_placeholder(self):
        # Launching such a config would leave the API on mediamtx's passwordless default.
        with self.assertRaises(mediamtx.MediamtxError):
            mediamtx.render_config("api: yes\n", "s3cret")

    def test_render_config_turns_the_api_off(self):
        rendered = mediamtx.render_config(f"api: yes\npass: {mediamtx.API_PASSWORD_PLACEHOLDER}\n", "s3cret", api_enabled=False)
        self.assertEqual(rendered, 'api: no\npass: "s3cret"\n')


def _fake_request(paths=PATHS, sessions=SESSIONS, calls=None, kicks=None, fail=False, kick_status=200):
    def request(method, url):
        if calls is not None:
            calls.append((method, url))
        if fail:
            raise OSError("connection refused")
        endpoint = url.split("/v3/", 1)[1].split("?", 1)[0]
        if method == "POST" and "/kick/" in endpoint:
            if kicks is not None:
                kicks.append(endpoint)
            return kick_status, b""
        if endpoint == "paths/list":
            return 200, json.dumps({"items": paths}).encode()
        name = endpoint.split("/")[0]
        return 200, json.dumps({"items": sessions.get(name, [])}).encode()
    return request


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class ClientTests(unittest.TestCase):
    def test_snapshot_is_cached_for_one_second(self):
        calls, clock = [], FakeClock()
        client = mediamtx.MediamtxClient(request=_fake_request(calls=calls), clock=clock)
        client.snapshot()
        first = len(calls)
        clock.now += 0.5
        client.snapshot()
        self.assertEqual(len(calls), first)
        clock.now += 0.6
        client.snapshot()
        self.assertEqual(len(calls), first * 2)

    def test_snapshot_makes_one_call_per_session_kind(self):
        calls = []
        mediamtx.MediamtxClient(request=_fake_request(calls=calls), clock=FakeClock()).snapshot()
        self.assertEqual(len(calls), 1 + len(mediamtx.SESSION_KINDS))

    def test_unavailable_api_backs_off_and_warns_once(self):
        calls, clock = [], FakeClock()
        client = mediamtx.MediamtxClient(request=_fake_request(calls=calls, fail=True), clock=clock)
        with self.assertLogs(level=logging.WARNING) as logs:
            self.assertIsNone(client.snapshot())
            clock.now += 0.5
            self.assertIsNone(client.snapshot())
        self.assertEqual(len(calls), 1)
        self.assertEqual(len([m for m in logs.output if "mediamtx" in m]), 1)
        clock.now += 10
        client.snapshot()
        self.assertEqual(len(calls), 2)

    def test_backoff_is_short_until_the_first_successful_snapshot(self):
        calls, clock = [], FakeClock()
        client = mediamtx.MediamtxClient(request=_fake_request(calls=calls, fail=True), clock=clock)
        self.assertIsNone(client.snapshot())
        clock.now += 1.5
        self.assertIsNone(client.snapshot())
        self.assertEqual(len(calls), 2)

    def _flaky_client(self):
        calls, clock, state = [], FakeClock(), {"fail": False}
        inner = _fake_request(calls=calls)

        def request(method, url):
            if state["fail"]:
                calls.append((method, url))
                raise OSError("timed out")
            return inner(method, url)

        return mediamtx.MediamtxClient(request=request, clock=clock), calls, clock, state

    def test_one_failed_refresh_keeps_the_last_snapshot(self):
        # A single slow API call must not switch external detection (and every guard
        # built on it) off: the last good snapshot stays in use and the retry is quick.
        client, calls, clock, state = self._flaky_client()
        self.assertTrue(client.snapshot()["src2"].external)
        state["fail"] = True
        clock.now += 1.5
        self.assertTrue(client.snapshot()["src2"].external)
        state["fail"] = False
        clock.now += 1.5
        before = len(calls)
        self.assertTrue(client.snapshot()["src2"].external)
        self.assertGreater(len(calls), before)

    def test_sustained_outage_drops_the_snapshot_and_backs_off_long(self):
        client, calls, clock, state = self._flaky_client()
        self.assertIsNotNone(client.snapshot())
        state["fail"] = True
        clock.now += 1.5
        self.assertIsNotNone(client.snapshot())
        clock.now += 6
        self.assertIsNone(client.snapshot())
        failed = len(calls)
        clock.now += 1.5
        self.assertIsNone(client.snapshot())
        self.assertEqual(len(calls), failed)

    def test_unusable_responses_mark_the_api_unavailable_instead_of_raising(self):
        import http.client

        def garbled(method, url):
            raise http.client.BadStatusLine("not http")

        for request in (garbled, _fake_request(paths=None), _fake_request(paths=[{"no": "name"}]), _fake_request(paths=["x"])):
            with self.subTest(request=request):
                self.assertIsNone(mediamtx.MediamtxClient(request=request, clock=FakeClock()).snapshot())

    def test_kick_reports_a_garbled_response_as_a_mediamtx_error(self):
        import http.client

        def garbled(method, url):
            raise http.client.BadStatusLine("not http")

        with self.assertRaises(mediamtx.MediamtxError):
            mediamtx.MediamtxClient(request=garbled, clock=FakeClock()).kick("rtspSession", "pub-2")

    def test_snapshot_fetched_across_a_kick_is_not_served(self):
        # A fetch that was in flight while kick() ran holds pre-kick data; caching it
        # would keep the slot "external" after a successful takeover.
        clock, state = FakeClock(), {"kicked": False, "client": None}

        def request(method, url):
            endpoint = url.split("/v3/", 1)[1].split("?", 1)[0]
            if method == "GET" and endpoint == "paths/list" and not state["kicked"]:
                state["kicked"] = True
                stale = _fake_request()(method, url)
                state["client"].kick("rtspSession", "pub-2")
                return stale
            paths = [p for p in PATHS if p["name"] != "src2"] if state["kicked"] else PATHS
            return _fake_request(paths=paths)(method, url)

        state["client"] = client = mediamtx.MediamtxClient(request=request, clock=clock)
        self.assertNotIn("src2", client.snapshot())
        self.assertNotIn("src2", client.snapshot())

    def test_bitrate_from_bytes_delta_between_snapshots(self):
        clock = FakeClock()
        first = [dict(PATHS[1], bytesReceived=1_000)]
        second = [dict(PATHS[1], bytesReceived=251_000)]
        calls = []
        state = {"paths": first}
        def request(method, url):
            return _fake_request(paths=state["paths"], calls=calls)(method, url)
        client = mediamtx.MediamtxClient(request=request, clock=clock, probe=lambda url: None, probe_async=False)
        path = client.snapshot()["src2"]
        self.assertIsNone(client.external_info(path)["bitrate_bps"])
        state["paths"] = second
        clock.now += 2
        path = client.snapshot()["src2"]
        self.assertEqual(client.external_info(path)["bitrate_bps"], 1_000_000)

    def test_probe_runs_once_per_session_and_fills_dimensions(self):
        probes = []
        def probe(url):
            probes.append(url)
            return {"width": 640, "height": 480, "fps": 30}
        client = mediamtx.MediamtxClient(request=_fake_request(), clock=FakeClock(), probe=probe, probe_async=False)
        path = client.snapshot()["src2"]
        info = client.external_info(path)
        client.external_info(path)
        self.assertEqual(probes, ["rtsp://127.0.0.1:8554/src2?reader=insight-probe"])
        self.assertEqual((info["width"], info["height"], info["fps"]), (640, 480, 30))
        self.assertTrue(info["codec_supported"])
        self.assertEqual(info["protocol"], "rtsp")

    def test_failed_probe_is_not_retried_for_same_session(self):
        probes = []
        def probe(url):
            probes.append(url)
            return None
        client = mediamtx.MediamtxClient(request=_fake_request(), clock=FakeClock(), probe=probe, probe_async=False)
        path = client.snapshot()["src2"]
        self.assertIsNone(client.external_info(path)["width"])
        client.external_info(path)
        self.assertEqual(len(probes), 1)

    def test_unsupported_codec_flagged(self):
        client = mediamtx.MediamtxClient(request=_fake_request(), clock=FakeClock(), probe=lambda url: None, probe_async=False)
        self.assertFalse(client.external_info(client.snapshot()["src4"])["codec_supported"])

    def test_cache_entries_evicted_when_session_disappears(self):
        clock = FakeClock()
        state = {"paths": PATHS}
        def request(method, url):
            return _fake_request(paths=state["paths"])(method, url)
        client = mediamtx.MediamtxClient(request=request, clock=clock, probe=lambda url: {"width": 1, "height": 1, "fps": 1}, probe_async=False)
        client.external_info(client.snapshot()["src2"])
        self.assertIn("pub-2", client._probes)
        state["paths"] = [p for p in PATHS if p["name"] != "src2"]
        clock.now += 2
        client.snapshot()
        self.assertNotIn("pub-2", client._probes)

    def test_kick_routes_by_source_type(self):
        kicks = []
        client = mediamtx.MediamtxClient(request=_fake_request(kicks=kicks), clock=FakeClock())
        client.kick("srtConn", "pub-3")
        client.kick("webRTCSession", "pub-4")
        self.assertEqual(kicks, ["srtconns/kick/pub-3", "webrtcsessions/kick/pub-4"])

    def test_kick_invalidates_snapshot_cache(self):
        calls = []
        client = mediamtx.MediamtxClient(request=_fake_request(calls=calls), clock=FakeClock())
        client.snapshot()
        before = len(calls)
        client.kick("rtspSession", "pub-2")
        client.snapshot()
        self.assertGreater(len(calls), before + 1)

    def test_kick_clears_the_back_off_of_a_failed_refresh(self):
        # Takeover re-snapshots right after the kick: a back-off from an earlier failed
        # refresh must not answer it with the publisher that was just disconnected.
        clock, state = FakeClock(), {"fail": False, "kicked": False}

        def request(method, url):
            if method == "POST":
                state["kicked"] = True
                return 200, b""
            if state["fail"]:
                raise OSError("connection refused")
            paths = [path for path in PATHS if path["name"] != "src2"] if state["kicked"] else PATHS
            return _fake_request(paths=paths)(method, url)

        client = mediamtx.MediamtxClient(request=request, clock=clock)
        self.assertIn("src2", client.snapshot())
        state["fail"] = True
        clock.now += mediamtx.SNAPSHOT_TTL_SECONDS
        self.assertIn("src2", client.snapshot())  # one failure keeps the last snapshot
        state["fail"] = False
        client.kick("rtspSession", "pub-2")
        self.assertNotIn("src2", client.snapshot())

    def test_kick_unknown_type_raises(self):
        client = mediamtx.MediamtxClient(request=_fake_request(), clock=FakeClock())
        with self.assertRaises(mediamtx.MediamtxError):
            client.kick("futureConn", "x")

    def test_kick_404_raises_not_found(self):
        client = mediamtx.MediamtxClient(request=_fake_request(kick_status=404), clock=FakeClock())
        with self.assertRaises(mediamtx.MediamtxNotFound):
            client.kick("rtspSession", "gone")

    def test_disabled_protocol_endpoints_404_do_not_break_snapshot(self):
        def request(method, url):
            endpoint = url.split("/v3/", 1)[1].split("?", 1)[0]
            if endpoint == "paths/list":
                return 200, json.dumps({"items": PATHS}).encode()
            if endpoint.split("/")[0] == "rtspsessions":
                return 200, json.dumps({"items": SESSIONS["rtspsessions"]}).encode()
            return 404, b""

        client = mediamtx.MediamtxClient(request=request, clock=FakeClock())
        snap = client.snapshot()
        self.assertIsNotNone(snap)
        self.assertTrue(snap["src2"].external)
        self.assertEqual(snap["src2"].protocol, "rtsp")

    def test_paths_list_404_marks_unavailable(self):
        def request(method, url):
            endpoint = url.split("/v3/", 1)[1].split("?", 1)[0]
            if endpoint == "paths/list":
                return 404, b""
            return 200, json.dumps({"items": []}).encode()

        client = mediamtx.MediamtxClient(request=request, clock=FakeClock())
        self.assertIsNone(client.snapshot())

    def test_parse_fps(self):
        self.assertEqual(mediamtx._parse_fps("30/1"), 30)
        self.assertEqual(mediamtx._parse_fps("30000/1001"), 29.97)
        self.assertIsNone(mediamtx._parse_fps("0/0"))
        self.assertIsNone(mediamtx._parse_fps(None))

    def test_async_probe_fills_dimensions_in_background(self):
        calls = []
        ran = threading.Event()

        def probe(url):
            calls.append(url)
            ran.set()
            return {"width": 1, "height": 2, "fps": 3}

        client = mediamtx.MediamtxClient(request=_fake_request(), clock=FakeClock(), probe=probe)
        path = client.snapshot()["src2"]
        client.external_info(path)  # kicks off the background probe; may return nulls
        self.assertTrue(ran.wait(2), "background probe did not run")
        deadline = time.monotonic() + 1
        width = None
        while time.monotonic() < deadline:
            width = client.external_info(path)["width"]
            if width == 1:
                break
            time.sleep(0.01)
        self.assertEqual(width, 1)
        self.assertEqual(len(calls), 1)

    def test_no_more_probes_run_at_once_than_the_limit(self):
        # One request can discover many external publishers; their probes must not all
        # spawn an ffprobe at the same time.
        running, peak, release = [0], [0], threading.Event()
        counter = threading.Lock()

        def probe(url):
            with counter:
                running[0] += 1
                peak[0] = max(peak[0], running[0])
            release.wait(2)
            with counter:
                running[0] -= 1
            return {"width": 1, "height": 2, "fps": 3}

        paths = [dict(PATHS[1], name=f"src{i}", source={"type": "rtspSession", "id": f"pub-{i}"}) for i in range(10, 20)]
        sessions = {**SESSIONS, "rtspsessions": [{"id": f"pub-{i}", "remoteAddr": "10.0.0.1:1", "query": ""} for i in range(10, 20)]}
        client = mediamtx.MediamtxClient(request=_fake_request(paths=paths, sessions=sessions), clock=FakeClock(), probe=probe)
        for path in client.snapshot().values():
            client.external_info(path)
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and running[0] < mediamtx.MAX_CONCURRENT_PROBES:
            time.sleep(0.01)
        time.sleep(0.05)
        release.set()
        self.assertEqual(peak[0], mediamtx.MAX_CONCURRENT_PROBES)
        self.assertLess(mediamtx.MAX_CONCURRENT_PROBES, 10)

    def test_stale_probe_result_is_ignored_after_eviction(self):
        client = mediamtx.MediamtxClient(
            request=_fake_request(), clock=FakeClock(),
            probe=lambda url: {"width": 640, "height": 480, "fps": 30}, probe_async=False,
        )
        path = client.snapshot()["src2"]
        client.external_info(path)
        stored = client._probes["pub-2"]
        self.assertEqual(stored, {"width": 640, "height": 480, "fps": 30})

        # A probe attempt whose token no longer matches the current entry (e.g. the
        # session was evicted and reissued while it was in flight) must not overwrite it.
        client._run_probe("pub-2", "src2", object())
        self.assertEqual(client._probes["pub-2"], stored)

        # An attempt using the token that is actually current does write its result back.
        current_token = object()
        client._probes["pub-2"] = current_token
        client._run_probe("pub-2", "src2", current_token)
        self.assertEqual(client._probes["pub-2"], {"width": 640, "height": 480, "fps": 30})


if __name__ == "__main__":
    unittest.main()
