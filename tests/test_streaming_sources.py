import json
import os
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module
from neat_insight import mediamtx
from neat_insight import mediasrc
from neat_insight.mediamtx import PathInfo


class FakeMediamtx:
    def __init__(self):
        self.paths = {}
        self.available = True
        self.kicked = []
        self.pull_sources = {}
        self.cleared = []
        self.fail_patch = False
        self.fail_after_apply = False

    def snapshot(self):
        return dict(self.paths) if self.available else None

    def external_info(self, path):
        return {"protocol": path.protocol, "address": path.address, "since": path.since,
                "codec_supported": path.codec in {"h264", "h265", "mjpeg"},
                "width": None, "height": None, "fps": None, "bitrate_bps": None}

    def pull_info(self, path):
        return {"since": path.since if path.ready else None, "codec_supported": path.ready and path.codec in {"h264", "h265", "mjpeg"},
                "width": 1280 if path.ready else None, "height": 720 if path.ready else None,
                "fps": 25 if path.ready else None, "bitrate_bps": 2_000_000 if path.ready else None}

    def kick(self, source_type, session_id):
        self.kicked.append((source_type, session_id))
        self.paths = {name: p for name, p in self.paths.items() if p.source_id != session_id}

    def set_pull_source(self, name, url):
        if self.fail_patch:
            raise mediamtx.MediamtxError("connection refused")
        self.pull_sources[name] = url
        self.paths[name] = pulled_path(int(name[3:]), ready=False)
        if self.fail_after_apply:
            raise mediamtx.MediamtxError("timed out")  # mediamtx applied the PATCH but answered too late

    def clear_pull_source(self, name):
        if self.fail_patch:
            raise mediamtx.MediamtxError("connection refused")
        self.cleared.append(name)
        self.pull_sources.pop(name, None)
        self.paths.pop(name, None)


def pulled_path(index, ready=True, codec="h264"):
    return PathInfo(name=f"src{index}", ready=ready, since="2026-09-24T15:16:24Z" if ready else None,
                    source_type="rtspSource", source_id="", protocol="rtspSource", address=None, query="",
                    codec=codec if ready else "none", bytes_received=10 if ready else 0, readers=[])


def external_path(index, codec="h264", protocol="rtsp", source_type="rtspSession", readers=None):
    return PathInfo(name=f"src{index}", ready=True, since="2026-09-16T13:09:59Z", source_type=source_type,
                    source_id=f"ext-{index}", protocol=protocol, address="172.19.0.1", query="",
                    codec=codec, bytes_received=10, readers=readers or [])


def insight_path(index, readers=None):
    return PathInfo(name=f"src{index}", ready=True, since="2026-09-16T13:00:00Z", source_type="rtspSession",
                    source_id=f"own-{index}", protocol="rtsp", address="127.0.0.1", query=mediamtx.PUBLISHER_TAG,
                    codec="h264", bytes_received=10, readers=readers or [])


class _SourceFixture(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.sources_file = self.root / "media_sources.json"
        self.sources_file.write_text("[]", encoding="utf-8")

        self.old_media_dir = app_module.MEDIA_DIR
        self.old_sources_file = app_module.MEDIA_SRC_DATA_FILE
        app_module.MEDIA_DIR = self.media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.sources_file
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        mediasrc.pipeline_registry.clear()
        self.mtx = FakeMediamtx()
        self._mtx_patch = mock.patch.object(app_module, "mediamtx_client", self.mtx)
        self._mtx_patch.start()
        app_module.pull_registry = app_module.pull_sources.PullRegistry()
        app_module.pull_probe_async = False
        self.probe_results = {}
        self._probe_patch = mock.patch.object(
            app_module, "probe_rtsp",
            lambda url, timeout=2.0: self.probe_results.get(url, app_module.pull_sources.ProbeResult("ok")))
        self._probe_patch.start()
        self._api_patch = mock.patch.object(mediamtx, "api_disabled_at_launch", False)
        self._api_patch.start()

    def tearDown(self):
        self._api_patch.stop()
        self._probe_patch.stop()
        self._mtx_patch.stop()
        mediasrc.pipeline_registry.clear()
        app_module.MEDIA_DIR = self.old_media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.old_sources_file
        self.tmpdir.cleanup()


class StreamingSourceTests(_SourceFixture):
    def test_load_sources_migrates_old_state_defaults(self):
        self.sources_file.write_text('[{"index": 1, "file": "sample.mp4", "state": "playing"}]', encoding="utf-8")

        sources = app_module.load_sources()

        self.assertEqual(sources[0]["transport"], "rtsp")
        self.assertEqual(sources[0]["codec"], "h264")
        self.assertEqual(sources[0]["file"], "sample.mp4")
        self.assertEqual(len(sources), 48)
        self.assertEqual(sources[-1]["index"], 48)

    def test_http_source_start_persists_mjpeg_transport(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")

        assign = self.client.post(
            "/api/mediasrc/assign",
            json={"index": 1, "file": "cam.mjpg", "transport": "http", "codec": "h264"},
        )
        self.assertEqual(assign.status_code, 200)

        start = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(start.status_code, 200)

        response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})
        source = response.get_json()[0]
        self.assertEqual(source["state"], "playing")
        self.assertEqual(source["transport"], "http")
        self.assertEqual(source["codec"], "mjpeg")
        self.assertEqual(source["allowed_transports"], ["rtsp", "http"])
        self.assertEqual(source["urls"]["http_mjpeg"], "http://localhost:9900/stream/http/src1.mjpg")

    def test_h264_source_forces_rtsp_and_h264(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            assign = self.client.post(
                "/api/mediasrc/assign",
                json={"index": 1, "file": "clip.mp4", "transport": "http", "codec": "h265"},
            )

        self.assertEqual(assign.status_code, 200)
        source = self.client.get("/api/mediasrc").get_json()[0]
        self.assertEqual(source["transport"], "rtsp")
        self.assertEqual(source["codec"], "h264")
        self.assertEqual(source["allowed_transports"], ["rtsp"])

    def test_h265_source_forces_rtsp_and_h265(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")

        with mock.patch.object(app_module, "_media_video_codec", return_value="h265"):
            assign = self.client.post(
                "/api/mediasrc/assign",
                json={"index": 1, "file": "clip.mp4", "transport": "http", "codec": "h264"},
            )

        self.assertEqual(assign.status_code, 200)
        source = self.client.get("/api/mediasrc").get_json()[0]
        self.assertEqual(source["transport"], "rtsp")
        self.assertEqual(source["codec"], "h265")
        self.assertEqual(source["allowed_transports"], ["rtsp"])

    def test_unknown_codec_does_not_fallback_to_h264(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")

        with mock.patch.object(app_module, "_media_video_codec", return_value=None):
            assign = self.client.post(
                "/api/mediasrc/assign",
                json={"index": 1, "file": "clip.mp4", "transport": "http"},
            )

        self.assertEqual(assign.status_code, 200)
        source = self.client.get("/api/mediasrc").get_json()[0]
        self.assertEqual(source["transport"], "")
        self.assertEqual(source["codec"], "unknown")
        self.assertEqual(source["allowed_transports"], [])
        self.assertEqual(source["urls"], {})

    def test_start_unknown_codec_returns_actionable_error(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        with mock.patch.object(app_module, "_media_video_codec", return_value=None):
            self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 400)
        self.assertIn("Unable to detect the media codec", response.get_json()["error"])

    def test_media_info_reports_missing_ffprobe(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")

        with mock.patch.object(app_module.shutil, "which", return_value=None):
            response = self.client.post("/api/media-info", json={"path": "clip.mp4"})

        self.assertEqual(response.status_code, 500)
        self.assertIn("ffprobe is not installed", response.get_json()["error"])

    def test_get_sources_marks_dead_rtsp_process_stopped(self):
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )
        process = mock.Mock()
        process.poll.return_value = 1
        mediasrc.pipeline_registry[0] = mediasrc.MediaStream(
            index=0,
            file_path=str(self.media_dir / "clip.mp4"),
            transport="rtsp",
            codec="h264",
            process=process,
        )

        response = self.client.get("/api/mediasrc")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()[0]["state"], "stopped")

    def test_start_bulk_restarts_dead_persisted_source(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )
        process = mock.Mock()
        process.poll.return_value = 1
        mediasrc.pipeline_registry[0] = mediasrc.MediaStream(
            index=0,
            file_path=str(self.media_dir / "clip.mp4"),
            transport="rtsp",
            codec="h264",
            process=process,
        )

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", return_value=(True, None)) as start:
                response = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["started"], [1])
        self.assertEqual(response.get_json()["already_running"], [])
        start.assert_called_once()

    def test_http_snapshot_uses_configured_source(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        self.client.post(
            "/api/mediasrc/assign",
            json={"index": 1, "file": "cam.mjpg", "transport": "http", "codec": "mjpeg"},
        )
        self.client.post("/api/mediasrc/start", json={"index": 1})

        completed = mock.Mock(returncode=0, stdout=b"\xff\xd8\xff\xd9", stderr=b"")
        with mock.patch.object(app_module.subprocess, "run", return_value=completed) as run:
            response = self.client.get("/stream/http/src1.jpg")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/jpeg")
        self.assertEqual(response.data, b"\xff\xd8\xff\xd9")
        self.assertIn("pipe:1", run.call_args.args[0])

    def test_http_mjpeg_stream_stops_when_source_is_stopped(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        self.client.post(
            "/api/mediasrc/assign",
            json={"index": 1, "file": "cam.mjpg", "transport": "http", "codec": "mjpeg"},
        )
        self.client.post("/api/mediasrc/start", json={"index": 1})

        def read_and_stop(_size):
            mediasrc.pipeline_registry.pop(0, None)
            return b"--frame\r\nstale"

        process = mock.Mock()
        process.stdout.read.side_effect = read_and_stop
        process.poll.return_value = None

        with mock.patch.object(app_module.subprocess, "Popen", return_value=process):
            response = self.client.get("/stream/http/src1.mjpg")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"")
        process.terminate.assert_called_once()

    def test_preview_command_follows_the_source_rate(self):
        cmd = mediasrc.preview_command("rtsp://127.0.0.1:8554/src2?reader=insight-preview")
        self.assertNotIn("nokey", cmd)
        self.assertEqual(cmd[cmd.index("-vf") + 1], "scale=min(640\\,iw):-2")
        self.assertNotIn("fps=", " ".join(cmd))
        self.assertIn("mpjpeg", cmd)

    def test_preview_command_skips_stream_probing_without_duplicating_frames(self):
        cmd = mediasrc.preview_command("rtsp://127.0.0.1:8554/src2?reader=insight-preview")
        input_index = cmd.index("-i")
        input_options = cmd[:input_index]
        output_options = cmd[input_index + 2:]
        self.assertEqual(input_options[input_options.index("-analyzeduration") + 1], "0")
        self.assertEqual(input_options[input_options.index("-probesize") + 1], "32")
        self.assertEqual(output_options[output_options.index("-fps_mode") + 1], "passthrough")

    def test_preview_route_validation(self):
        self.assertEqual(self.client.get("/stream/preview/src999.mjpg").status_code, 404)
        self.assertEqual(self.client.get("/stream/preview/src2.mjpg").status_code, 409)
        self.mtx.paths["src2"] = external_path(2)
        with mock.patch.object(app_module.shutil, "which", return_value=None):
            self.assertEqual(self.client.get("/stream/preview/src2.mjpg").status_code, 503)
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with mock.patch.object(app_module, "PREVIEW_MAX_STREAMS", 0):
                self.assertEqual(self.client.get("/stream/preview/src2.mjpg").status_code, 429)

    def test_preview_route_streams_and_releases_slot(self):
        self.mtx.paths["src2"] = external_path(2)
        process = mock.Mock()
        process.stdout.read.side_effect = [b"--frame\r\njpeg", b""]
        process.poll.return_value = 0
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with mock.patch.object(app_module.subprocess, "Popen", return_value=process) as popen:
                response = self.client.get("/stream/preview/src2.mjpg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "multipart/x-mixed-replace")
        self.assertIn(b"jpeg", response.data)
        self.assertIn("rtsp://127.0.0.1:8554/src2?reader=insight-preview", popen.call_args.args[0])
        self.assertEqual(app_module._preview_count, 0)

    def test_preview_route_terminates_ffmpeg_when_client_stops_reading(self):
        self.mtx.paths["src2"] = external_path(2)
        process = mock.Mock()
        process.stdout.read.side_effect = [b"--frame\r\njpeg", b""]
        process.poll.return_value = None
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with mock.patch.object(app_module.subprocess, "Popen", return_value=process):
                response = self.client.get("/stream/preview/src2.mjpg")
        _ = response.data  # drain the generator so the finally block runs
        process.terminate.assert_called_once()
        process.wait.assert_called_once()
        self.assertEqual(app_module._preview_count, 0)

    def test_preview_route_gives_up_on_a_silent_ffmpeg(self):
        # A publisher that stalls leaves ffmpeg blocked without output; the blocked read
        # never reaches a yield, so without a watchdog the slot and thread are held forever.
        import subprocess
        import sys
        import time
        self.mtx.paths["src2"] = external_path(2)
        silent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], stdout=subprocess.PIPE)
        self.addCleanup(silent.kill)
        started = time.monotonic()
        with mock.patch.object(app_module, "PREVIEW_IDLE_TIMEOUT_SECONDS", 0.3, create=True):
            with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
                with mock.patch.object(app_module.subprocess, "Popen", return_value=silent):
                    response = self.client.get("/stream/preview/src2.mjpg")
                    self.assertEqual(response.data, b"")
        self.assertLess(time.monotonic() - started, 10)
        self.assertIsNotNone(silent.poll())
        self.assertEqual(app_module._preview_count, 0)

    def test_media_preview_mjpeg_streams_selected_file(self):
        (self.media_dir / "cam.avi").write_bytes(b"not-a-real-video")
        process = mock.Mock()
        process.stdout.read.side_effect = [b"--frame\r\njpeg", b""]
        process.poll.return_value = 0

        with mock.patch.object(app_module, "_media_video_codec", return_value="mjpeg"):
            with mock.patch.object(app_module.subprocess, "Popen", return_value=process) as popen:
                response = self.client.get("/api/media-preview/mjpeg?path=cam.avi")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "multipart/x-mixed-replace")
        self.assertIn(b"jpeg", response.data)
        self.assertTrue(any(str(arg).endswith("cam.avi") for arg in popen.call_args.args[0]))

    def test_rtsp_h265_copies_matching_source_codec(self):
        cmd = mediasrc.rtsp_command("clip.mp4", "rtsp://127.0.0.1:8554/src1", "h265", "h265")

        self.assertIn("-c:v", cmd)
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")

    def test_rtsp_h264_copies_matching_source_codec(self):
        cmd = mediasrc.rtsp_command("clip.mp4", "rtsp://127.0.0.1:8554/src1", "h264", "h264")

        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")

    def test_rtsp_h264_encodes_when_source_codec_unknown(self):
        cmd = mediasrc.rtsp_command("clip.mp4", "rtsp://127.0.0.1:8554/src1", "h264", None)

        self.assertEqual(cmd[cmd.index("-c:v") + 1], "libx264")

    def test_http_mjpeg_encodes_when_source_codec_unknown(self):
        cmd = mediasrc.http_mjpeg_command("clip.mjpg", None)

        self.assertEqual(cmd[cmd.index("-c:v") + 1], "mjpeg")

    def test_http_mjpeg_copies_matching_source_codec(self):
        cmd = mediasrc.http_mjpeg_command("clip.mjpg", "mjpeg")

        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")
        self.assertIn("mpjpeg", cmd)

    def test_rtsp_mjpeg_uses_rtp_compatible_encoder(self):
        cmd = mediasrc.rtsp_command("clip.avi", "rtsp://127.0.0.1:8554/src1", "mjpeg", "mjpeg")

        self.assertEqual(cmd[cmd.index("-c:v") + 1], "mjpeg")
        self.assertIn("-huffman", cmd)
        self.assertEqual(cmd[cmd.index("-huffman") + 1], "default")
        self.assertIn("-force_duplicated_matrix", cmd)
        self.assertIn("rtsp", cmd)

    def test_media_codec_display_name_uses_mjpeg_label(self):
        self.assertEqual(app_module._media_codec_display_name("MJPG", "mjpeg"), "MJPEG")
        self.assertEqual(app_module._media_codec_display_name("hvc1", None), "H.265")

    def test_insight_publish_url_carries_publisher_tag(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        process = mock.Mock()
        process.poll.return_value = None
        process.stderr = []
        with mock.patch.object(mediasrc.subprocess, "Popen", return_value=process) as popen:
            ok, err = mediasrc.start_media_stream(1, str(self.media_dir / "clip.mp4"), "rtsp", "h264", "h264")

        self.assertTrue(ok, err)
        self.assertEqual(popen.call_args.args[0][-1], f"rtsp://127.0.0.1:8554/src1?{mediamtx.PUBLISHER_TAG}")

    def test_get_sources_reports_external_slot(self):
        self.sources_file.write_text('[{"index": 2, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h265"}]', encoding="utf-8")
        self.mtx.paths["src2"] = external_path(2, readers=[{"protocol": "rtsp", "address": "10.0.0.9"}])

        src = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"}).get_json()[1]

        self.assertEqual(src["state"], "external")
        self.assertEqual(src["file"], "clip.mp4")
        self.assertEqual((src["transport"], src["codec"], src["allowed_transports"]), ("rtsp", "h264", ["rtsp"]))
        self.assertEqual(src["urls"], {"rtsp": "rtsp://localhost:8554/src2"})
        self.assertEqual(src["external"]["protocol"], "rtsp")
        self.assertEqual(src["external"]["address"], "172.19.0.1")
        self.assertTrue(src["external"]["codec_supported"])
        self.assertEqual(src["readers"], [{"protocol": "rtsp", "address": "10.0.0.9"}])

    def test_insight_owned_live_slot_is_not_classified_external(self):
        # mediamtx may report a ready path before the publisher session (and its
        # ?publisher=insight query) resolves; our own live process wins that race.
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )
        process = mock.Mock()
        process.poll.return_value = None
        mediasrc.pipeline_registry[0] = mediasrc.MediaStream(
            index=0,
            file_path=str(self.media_dir / "clip.mp4"),
            transport="rtsp",
            codec="h264",
            process=process,
        )
        self.mtx.paths["src1"] = external_path(1)

        src = self.client.get("/api/mediasrc").get_json()[0]

        self.assertEqual(src["state"], "playing")
        self.assertNotIn("external", src)
        self.assertEqual(self.client.post("/api/mediasrc/stop", json={"index": 1}).status_code, 200)

    def test_http_slot_does_not_hide_an_external_publisher(self):
        # An HTTP/MJPEG slot streams straight to the browser and publishes nothing to
        # mediamtx, so an external publisher on that index stays visible and takeable.
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        self.client.post(
            "/api/mediasrc/assign",
            json={"index": 1, "file": "cam.mjpg", "transport": "http", "codec": "mjpeg"},
        )
        self.client.post("/api/mediasrc/start", json={"index": 1})
        self.mtx.paths["src1"] = external_path(1)

        src = self.client.get("/api/mediasrc").get_json()[0]

        self.assertEqual(src["state"], "external")
        self.assertEqual(self.client.post("/api/mediasrc/takeover", json={"index": 1}).status_code, 200)

    def _http_slot_with_external_publisher(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        self.client.post(
            "/api/mediasrc/assign",
            json={"index": 1, "file": "cam.mjpg", "transport": "http", "codec": "mjpeg"},
        )
        self.client.post("/api/mediasrc/start", json={"index": 1})
        self.mtx.paths["src1"] = external_path(1)

    def _persisted(self, index):
        return next(src for src in json.loads(self.sources_file.read_text(encoding="utf-8")) if src["index"] == index)

    def test_stop_reaches_insights_own_http_stream_under_an_external_publisher(self):
        self._http_slot_with_external_publisher()
        response = self.client.post("/api/mediasrc/stop", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(mediasrc.media_stream_is_running(1))
        self.assertEqual(self._persisted(1)["state"], "stopped")
        self.assertEqual(self.mtx.kicked, [])
        # With nothing of Insight's left on the slot, stop is a conflict again.
        self.assertEqual(self.client.post("/api/mediasrc/stop", json={"index": 1}).status_code, 409)

    def test_stop_all_records_the_own_stream_it_stopped_on_an_external_slot(self):
        self._http_slot_with_external_publisher()
        body = self.client.post("/api/mediasrc/stop-all").get_json()
        self.assertEqual(body["stopped_count"], 1)
        self.assertEqual(body["skipped_external"], [1])
        self.assertEqual(self._persisted(1)["state"], "stopped")

    def test_reset_clears_the_assignment_of_an_external_slot(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        for index in (1, 2):
            self.client.post("/api/mediasrc/assign", json={"index": index, "file": "clip.mp4", "transport": "rtsp", "codec": "h264"})
        self.mtx.paths["src2"] = external_path(2)
        self.client.post("/api/mediasrc/reset")
        self.assertEqual(self._persisted(1)["file"], "")
        self.assertEqual(self._persisted(2)["file"], "")
        # The record is cleared, the external stream is not touched.
        self.assertEqual(self.mtx.kicked, [])
        self.assertEqual(self.client.get("/api/mediasrc").get_json()[1]["state"], "external")

    def test_mutating_routes_reject_an_index_that_names_no_slot(self):
        # 2.0 and true compare equal to a slot index but miss the "src2" snapshot key,
        # which would skip the external-publisher guard.
        self.mtx.paths["src2"] = external_path(2)
        # Anything that is not an integer is a malformed request; an integer outside the
        # slot range names a source that does not exist.
        expected = {2.0: 400, True: 400, "2": 400, None: 400, 0: 404, 999: 404}
        for route in ("assign", "start", "stop", "takeover"):
            for index, status in expected.items():
                with self.subTest(route=route, index=index):
                    response = self.client.post(f"/api/mediasrc/{route}", json={"index": index, "file": ""})
                    self.assertEqual(response.status_code, status)
        self.assertEqual(self.mtx.kicked, [])

    def test_get_sources_lists_readers_for_insight_owned_slot(self):
        self.mtx.paths["src1"] = insight_path(1, readers=[{"protocol": "rtsp", "address": "10.0.0.9"}])
        sources = self.client.get("/api/mediasrc").get_json()
        self.assertEqual(sources[0]["state"], "stopped")
        self.assertNotIn("external", sources[0])
        self.assertEqual(sources[0]["readers"], [{"protocol": "rtsp", "address": "10.0.0.9"}])
        self.assertEqual(sources[1]["readers"], [])

    def test_get_sources_without_mediamtx_api_matches_legacy_shape(self):
        self.mtx.available = False
        src = self.client.get("/api/mediasrc").get_json()[0]
        self.assertEqual(src["state"], "stopped")
        self.assertEqual(src["readers"], [])
        self.assertNotIn("external", src)

    def test_external_state_is_never_persisted(self):
        self.sources_file.write_text('[{"index": 2, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self.mtx.paths["src2"] = external_path(2)

        self.client.get("/api/mediasrc")
        self.client.post("/api/mediasrc/stop-all")
        self.client.post("/api/mediasrc/auto-assign-all")

        self.assertNotIn("external", self.sources_file.read_text(encoding="utf-8"))
        self.assertNotIn("readers", self.sources_file.read_text(encoding="utf-8"))

    def test_start_assign_stop_on_external_slot_return_409(self):
        (self.media_dir / "clip.mp4").write_bytes(b"x")
        self.mtx.paths["src2"] = external_path(2)
        for route, body in (("start", {"index": 2}), ("assign", {"index": 2, "file": "clip.mp4"}), ("stop", {"index": 2})):
            with self.subTest(route=route):
                response = self.client.post(f"/api/mediasrc/{route}", json=body)
                self.assertEqual(response.status_code, 409)
                self.assertIn("Use Take over to disconnect it", response.get_json()["error"])
        self.assertNotIn("clip.mp4", self.sources_file.read_text(encoding="utf-8"))

    def test_start_bulk_skips_external_and_fills_requested_count(self):
        for name in ("a.mp4", "b.mp4", "c.mp4"):
            (self.media_dir / name).write_bytes(b"x")
        self.sources_file.write_text(json.dumps([
            {"index": 1, "file": "a.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},
            {"index": 2, "file": "b.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},
            {"index": 3, "file": "c.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},
        ]), encoding="utf-8")
        self.mtx.paths["src2"] = external_path(2)

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", return_value=(True, None)):
                data = self.client.post("/api/mediasrc/start-bulk", json={"count": 2}).get_json()

        self.assertEqual(data["started"], [1, 3])
        self.assertEqual(data["skipped_external"], [2])
        self.assertIn("src2", data["message"])

    def test_start_bulk_reports_skipped_slots_when_every_assigned_slot_is_external(self):
        (self.media_dir / "a.mp4").write_bytes(b"x")
        self.sources_file.write_text(json.dumps([
            {"index": 1, "file": "a.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},
        ]), encoding="utf-8")
        self.mtx.paths["src1"] = external_path(1)

        with mock.patch.object(app_module, "start_media_stream") as start:
            response = self.client.post("/api/mediasrc/start-bulk", json={"count": 2})

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual((data["started"], data["targeted"], data["skipped_external"]), ([], 0, [1]))
        self.assertIn("src1", data["message"])
        start.assert_not_called()

    def test_start_bulk_without_any_assigned_slot_is_a_bad_request(self):
        # An external publisher on an unassigned slot was never a candidate for Bulk
        # Start, so it neither suppresses the error nor counts as skipped.
        self.mtx.paths["src3"] = external_path(3)
        response = self.client.post("/api/mediasrc/start-bulk", json={"count": 2})
        self.assertEqual(response.status_code, 400)

    def test_start_bulk_reports_only_assigned_external_slots_as_skipped(self):
        (self.media_dir / "a.mp4").write_bytes(b"x")
        self.sources_file.write_text(json.dumps([
            {"index": 1, "file": "a.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},
        ]), encoding="utf-8")
        self.mtx.paths["src3"] = external_path(3)

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", return_value=(True, None)):
                data = self.client.post("/api/mediasrc/start-bulk", json={"count": 2}).get_json()

        self.assertEqual((data["started"], data["skipped_external"]), ([1], []))
        self.assertNotIn("src3", data["message"])

    def test_auto_assign_skips_external_slot_and_keeps_its_assignment(self):
        for name in ("a.mp4", "b.mp4"):
            (self.media_dir / name).write_bytes(b"x")
        self.sources_file.write_text('[{"index": 2, "file": "keep.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self.mtx.paths["src2"] = external_path(2)

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            data = self.client.post("/api/mediasrc/auto-assign-all").get_json()

        stored = {s["index"]: s["file"] for s in json.loads(self.sources_file.read_text(encoding="utf-8"))}
        self.assertEqual((stored[1], stored[2], stored[3]), ("a.mp4", "keep.mp4", "b.mp4"))
        self.assertEqual(data["skipped_external"], [2])

    def test_auto_assign_does_not_hand_out_a_file_kept_by_an_external_slot(self):
        for name in ("a.mp4", "b.mp4", "c.mp4"):
            (self.media_dir / name).write_bytes(b"x")
        self.sources_file.write_text('[{"index": 2, "file": "a.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self.mtx.paths["src2"] = external_path(2)

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            self.client.post("/api/mediasrc/auto-assign-all")

        stored = {s["index"]: s["file"] for s in json.loads(self.sources_file.read_text(encoding="utf-8"))}
        self.assertEqual((stored[1], stored[2], stored[3]), ("b.mp4", "a.mp4", "c.mp4"))

    def test_auto_assign_stops_insights_own_http_stream_on_an_external_slot(self):
        self._http_slot_with_external_publisher()
        (self.media_dir / "a.mp4").write_bytes(b"x")

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            self.client.post("/api/mediasrc/auto-assign-all")

        self.assertFalse(mediasrc.media_stream_is_running(1))
        self.assertEqual(self._persisted(1)["state"], "stopped")
        self.assertEqual(self._persisted(1)["file"], "cam.mjpg")

    def test_stop_all_and_reset_report_skipped_external(self):
        self.mtx.paths["src2"] = external_path(2)
        with mock.patch.object(app_module, "stop_media_stream") as stop:
            stop_all = self.client.post("/api/mediasrc/stop-all").get_json()
            reset = self.client.post("/api/mediasrc/reset").get_json()
        self.assertEqual(stop_all["skipped_external"], [2])
        self.assertEqual(reset["skipped_external"], [2])
        self.assertIn("External stream(s) left running: src2.", stop_all["message"])
        self.assertIn("External stream(s) left running: src2.", reset["message"])
        # Every slot is stopped, including the externally held one, so no Insight
        # process can be left running where the user can no longer stop it.
        self.assertIn(2, [call.args[0] for call in stop.call_args_list])
        self.assertEqual(self.mtx.kicked, [])

    def test_stop_all_stops_own_slot_whose_publisher_query_is_unresolved(self):
        # mediamtx can report our own path without the ?publisher=insight query; stop-all
        # must classify the slot before stopping the process that proves it is ours.
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )
        process = mock.Mock()
        process.poll.return_value = None
        mediasrc.pipeline_registry[0] = mediasrc.MediaStream(
            index=0,
            file_path=str(self.media_dir / "clip.mp4"),
            transport="rtsp",
            codec="h264",
            process=process,
        )
        self.mtx.paths["src1"] = external_path(1)

        stop_all = self.client.post("/api/mediasrc/stop-all").get_json()

        self.assertEqual(stop_all["skipped_external"], [])
        self.assertEqual(stop_all["stopped_count"], 1)
        stored = json.loads(self.sources_file.read_text(encoding="utf-8"))
        self.assertEqual(stored[0]["state"], "stopped")

    def test_takeover_reports_kick_failure_as_502(self):
        self.mtx.paths["src2"] = external_path(2, source_type="futureConn")

        def kick(source_type, session_id):
            raise app_module.MediamtxError("unsupported publisher type futureConn")

        self.mtx.kick = kick
        response = self.client.post("/api/mediasrc/takeover", json={"index": 2})
        self.assertEqual(response.status_code, 502)
        self.assertIn("src2", response.get_json()["error"])

    def test_takeover_kicks_external_publisher(self):
        self.mtx.paths["src2"] = external_path(2)
        response = self.client.post("/api/mediasrc/takeover", json={"index": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"success": True, "index": 2})
        self.assertEqual(self.mtx.kicked, [("rtspSession", "ext-2")])
        self.assertEqual(self.client.get("/api/mediasrc").get_json()[1]["state"], "stopped")

    def test_takeover_errors(self):
        self.assertEqual(self.client.post("/api/mediasrc/takeover", json={"index": 999}).status_code, 404)
        self.assertEqual(self.client.post("/api/mediasrc/takeover", json={"index": 2}).status_code, 409)
        self.mtx.available = False
        self.assertEqual(self.client.post("/api/mediasrc/takeover", json={"index": 2}).status_code, 502)

    def test_takeover_is_idempotent_when_publisher_already_left(self):
        self.mtx.paths["src2"] = external_path(2)
        def kick(source_type, session_id):
            self.mtx.paths.pop("src2")
            raise app_module.MediamtxNotFound(session_id)
        self.mtx.kick = kick
        self.assertEqual(self.client.post("/api/mediasrc/takeover", json={"index": 2}).status_code, 200)

    def test_takeover_reports_new_publisher(self):
        self.mtx.paths["src2"] = external_path(2)
        def kick(source_type, session_id):
            self.mtx.paths["src2"] = PathInfo(name="src2", ready=True, source_type="srtConn", source_id="other",
                                              protocol="srt", address="10.0.0.7", codec="h264")
        self.mtx.kick = kick
        response = self.client.post("/api/mediasrc/takeover", json={"index": 2})
        self.assertEqual(response.status_code, 409)
        self.assertIn("srt 10.0.0.7", response.get_json()["error"])

    def test_preview_route_serves_insight_owned_live_slot(self):
        self.mtx.paths["src2"] = insight_path(2)
        process = mock.Mock()
        process.stdout.read.side_effect = [b"--frame\r\njpeg", b""]
        process.poll.return_value = 0
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with mock.patch.object(app_module.subprocess, "Popen", return_value=process):
                response = self.client.get("/stream/preview/src2.mjpg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "multipart/x-mixed-replace")
        self.assertIn(b"jpeg", response.data)
        self.assertEqual(app_module._preview_count, 0)

    def test_preview_slot_released_when_response_closed_unstarted(self):
        self.mtx.paths["src2"] = external_path(2)
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with app_module.app.test_request_context("/stream/preview/src2.mjpg"):
                response = app_module.stream_preview_mjpeg(2)
                self.assertEqual(app_module._preview_count, 1)
                response.close()
        self.assertEqual(app_module._preview_count, 0)


CAM = "rtsp://172.18.51.40:554/h264Preview_01_main"


class PullSourceTests(_SourceFixture):
    def _pull(self, index=3, url=CAM, **extra):
        return self.client.post("/api/mediasrc/pull", json={"index": index, "url": url, **extra})

    def _slot(self, index):
        return next(s for s in self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"}).get_json() if s["index"] == index)

    def test_pull_configures_mediamtx_and_reports_connecting(self):
        response = self._pull(username="admin", password="s3cret")
        self.assertEqual(response.status_code, 200, response.get_json())
        body = response.get_json()
        self.assertEqual(body["state"], "pulled")
        self.assertEqual(body["pull"]["status"], "connecting")
        self.assertEqual((body["pull"]["scheme"], body["pull"]["host"], body["pull"]["path"]), ("rtsp", "172.18.51.40:554", "/h264Preview_01_main"))
        self.assertEqual((body["transport"], body["allowed_transports"], body["urls"]), ("rtsp", ["rtsp"], {"rtsp": "rtsp://localhost:8554/src3"}))
        self.assertEqual(self.mtx.pull_sources, {"src3": "rtsp://admin:s3cret@172.18.51.40:554/h264Preview_01_main"})
        self.assertNotIn("s3cret", json.dumps(body))
        self.assertNotIn("admin", json.dumps(body))

    def test_pulled_slot_is_live_with_stats_when_the_path_is_ready(self):
        self._pull()
        self.mtx.paths["src3"] = pulled_path(3, codec="h265")
        slot = self._slot(3)
        self.assertEqual((slot["state"], slot["codec"], slot["pull"]["status"]), ("pulled", "h265", "live"))
        self.assertEqual((slot["pull"]["width"], slot["pull"]["height"], slot["pull"]["fps"], slot["pull"]["bitrate_bps"]), (1280, 720, 25, 2_000_000))
        self.assertEqual(slot["pull"]["since"], "2026-09-24T15:16:24Z")
        self.assertIsNone(slot["pull"]["error"])
        self.assertTrue(slot["pull"]["codec_supported"])

    def test_pulled_slot_keeps_its_stored_file_and_nothing_is_persisted(self):
        self.sources_file.write_text('[{"index": 3, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        before = self.sources_file.read_text(encoding="utf-8")
        self._pull()
        slot = self._slot(3)
        self.assertEqual((slot["state"], slot["file"]), ("pulled", "clip.mp4"))
        self.assertEqual(self.sources_file.read_text(encoding="utf-8"), before)
        self.assertNotIn("172.18.51.40", self.sources_file.read_text(encoding="utf-8"))

    def test_unreachable_probe_still_configures_and_reports_unreachable(self):
        self.probe_results[CAM] = app_module.pull_sources.ProbeResult("unreachable", "Connection refused")
        response = self._pull()
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.get_json()["pull"]["status"], response.get_json()["pull"]["error"]), ("unreachable", "Connection refused"))
        self.assertIn("src3", self.mtx.pull_sources)

    def test_auth_failed_probe_rejects_and_configures_nothing(self):
        url = "rtsp://admin:bad@172.18.51.40:554/h264Preview_01_main"
        self.probe_results[url] = app_module.pull_sources.ProbeResult("auth_failed", "The camera rejected the username or password")
        response = self._pull(username="admin", password="bad")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "The camera rejected the username or password", "reason": "auth_failed"})
        self.assertEqual(self.mtx.pull_sources, {})
        self.assertIsNone(app_module.pull_registry.get(3))

    def test_bad_url_is_400(self):
        for url, fragment in (("http://cam/x.m3u8", "rtsp://"), ("rtsp:///x", "host"), ("", "rtsp://")):
            with self.subTest(url=url):
                response = self._pull(url=url)
                self.assertEqual(response.status_code, 400)
                self.assertIn(fragment, response.get_json()["error"])

    def test_index_errors(self):
        self.assertEqual(self.client.post("/api/mediasrc/pull", json={"url": CAM}).status_code, 400)
        self.assertEqual(self._pull(index=0).status_code, 404)
        self.assertEqual(self._pull(index="3").status_code, 400)

    def test_pull_into_external_slot_is_409(self):
        self.mtx.paths["src3"] = external_path(3)
        response = self._pull()
        self.assertEqual(response.status_code, 409)
        self.assertIn("external publisher", response.get_json()["error"])
        self.assertEqual(self.mtx.pull_sources, {})

    def test_pull_into_live_slot_is_409(self):
        self.sources_file.write_text('[{"index": 3, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        process = mock.Mock()
        process.poll.return_value = None
        mediasrc.pipeline_registry[2] = mediasrc.MediaStream(index=2, file_path=str(self.media_dir / "clip.mp4"), transport="rtsp", codec="h264", process=process)
        response = self._pull()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"], "src3 is streaming. Stop it first.")

    def test_pull_into_pulled_slot_is_409(self):
        self._pull()
        response = self._pull(url="rtsp://10.0.0.9/other")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"], "src3 is pulling from 172.18.51.40:554. Stop it first.")

    def test_pull_without_api_is_503(self):
        with mock.patch.object(mediamtx, "api_disabled_at_launch", True):
            response = self._pull()
        self.assertEqual(response.status_code, 503)
        self.assertIn("control API", response.get_json()["error"])

    def test_mediamtx_patch_failure_is_502(self):
        self.mtx.fail_patch = True
        response = self._pull()
        self.assertEqual(response.status_code, 502)
        self.assertIsNone(app_module.pull_registry.get(3))

    def test_patch_failure_after_mediamtx_applied_it_clears_the_source(self):
        self.mtx.fail_after_apply = True
        response = self._pull()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.mtx.cleared, ["src3"])
        self.assertEqual(self.mtx.pull_sources, {})
        self.assertIsNone(app_module.pull_registry.get(3))

    def test_background_probe_that_raises_releases_the_record(self):
        self._pull()
        record = app_module.pull_registry.get(3)
        record.probing = True

        def boom(url, timeout=2.0):
            raise RuntimeError("unexpected")

        with mock.patch.object(app_module, "probe_rtsp", boom):
            with self.assertRaises(RuntimeError):
                app_module._run_pull_probe(record)
        self.assertFalse(record.probing)

    def test_pull_bumps_generation_so_an_in_flight_start_abandons(self):
        self.sources_file.write_text('[{"index": 3, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        src = app_module.load_sources()[0]
        generation = app_module._slot_generation(3)
        self._pull()
        self.assertTrue(app_module._slot_changed_since(src, generation))

    def test_background_probe_marks_unreachable_then_recovers_to_connecting(self):
        self._pull()
        record = app_module.pull_registry.get(3)
        self.probe_results[CAM] = app_module.pull_sources.ProbeResult("unreachable", "Timed out after 2 s")
        record.probed_at = 0.0
        self.assertEqual(self._slot(3)["pull"]["status"], "unreachable")   # the list request ran the due probe
        self.assertEqual(self._slot(3)["pull"]["error"], "Timed out after 2 s")
        self.probe_results.pop(CAM)
        record.probed_at = 0.0
        self.assertEqual(self._slot(3)["pull"]["status"], "connecting")

    def test_background_probe_is_not_run_while_ready_or_within_interval(self):
        self._pull()
        calls = []
        with mock.patch.object(app_module, "probe_rtsp", lambda url, timeout=2.0: calls.append(url) or app_module.pull_sources.ProbeResult("ok")):
            self._slot(3)                          # probed_at was just set by the pull: not due
            self.assertEqual(calls, [])
            self.mtx.paths["src3"] = pulled_path(3, ready=True)
            app_module.pull_registry.get(3).probed_at = 0.0
            self._slot(3)                          # ready: never probed
            self.assertEqual(calls, [])

    def test_background_auth_failure_clears_the_source_and_sticks(self):
        self._pull()
        record = app_module.pull_registry.get(3)
        self.probe_results[CAM] = app_module.pull_sources.ProbeResult("auth_failed", "The camera rejected the username or password")
        record.probed_at = 0.0
        slot = self._slot(3)
        self.assertEqual((slot["state"], slot["pull"]["status"]), ("pulled", "auth_failed"))
        self.assertEqual(self.mtx.cleared, ["src3"])
        self.probe_results.pop(CAM)
        record.probed_at = 0.0
        self.assertEqual(self._slot(3)["pull"]["status"], "auth_failed")  # not re-probed

    def test_stop_then_pull_replaces_record(self):
        self._pull()
        self.assertEqual(self.client.post("/api/mediasrc/stop", json={"index": 3}).status_code, 200)
        self.assertEqual(self._pull(url="rtsp://10.0.0.9:554/b").status_code, 200)
        self.assertEqual(app_module.pull_registry.get(3).host, "10.0.0.9:554")

    def test_stop_releases_the_pull_and_restores_the_stored_file(self):
        self.sources_file.write_text('[{"index": 3, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self._pull()
        self.mtx.paths["src3"] = pulled_path(3)
        response = self.client.post("/api/mediasrc/stop", json={"index": 3})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.mtx.cleared, ["src3"])
        self.assertIsNone(app_module.pull_registry.get(3))
        slot = self._slot(3)
        self.assertEqual((slot["state"], slot["file"]), ("stopped", "clip.mp4"))
        self.assertNotIn("pull", slot)

    def test_stop_removes_registry_entry_even_when_mediamtx_fails(self):
        self._pull()
        self.mtx.fail_patch = True
        response = self.client.post("/api/mediasrc/stop", json={"index": 3})
        self.assertEqual(response.status_code, 502)
        self.assertIsNone(app_module.pull_registry.get(3))
        self.assertEqual(self._slot(3)["state"], "stopped")

    def test_assign_start_prepare_and_takeover_are_409_on_a_pulled_slot(self):
        self.sources_file.write_text('[{"index": 3, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self._pull()
        expected = "src3 is pulling from 172.18.51.40:554. Stop it first."
        for endpoint, payload in (("assign", {"index": 3, "file": "clip.mp4"}), ("start", {"index": 3}),
                                  ("prepare", {"index": 3}), ("takeover", {"index": 3})):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(f"/api/mediasrc/{endpoint}", json=payload)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.get_json()["error"], expected)

    def test_bulk_endpoints_skip_pulled_slots(self):
        (self.media_dir / "a.mp4").write_bytes(b"x")
        (self.media_dir / "b.mp4").write_bytes(b"x")
        self.sources_file.write_text(
            '[{"index": 1, "file": "a.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"},'
            ' {"index": 2, "file": "b.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self._pull(index=2)
        with mock.patch.object(app_module, "_collect_video_files", return_value=["a.mp4", "b.mp4"]), \
             mock.patch.object(app_module, "_start_source_slot", return_value=(True, None, 200)), \
             mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("rtsp", "h264", ["rtsp"])):
            auto = self.client.post("/api/mediasrc/auto-assign-all").get_json()
            self.assertEqual(auto["skipped_pulled"], [2])
            self.assertIn("Skipped pulled: src2.", auto["message"])
            self.assertEqual(self._slot(2)["file"], "b.mp4")      # untouched
            bulk = self.client.post("/api/mediasrc/start-bulk", json={"count": 2}).get_json()
            self.assertEqual((bulk["started"], bulk["skipped_pulled"]), ([1], [2]))
            self.assertIn("Skipped pulled: src2.", bulk["message"])
            stop_all = self.client.post("/api/mediasrc/stop-all").get_json()
            self.assertEqual(stop_all["skipped_pulled"], [2])
            self.assertIn("Pulled stream(s) left running: src2.", stop_all["message"])
            reset = self.client.post("/api/mediasrc/reset").get_json()
            self.assertEqual(reset["skipped_pulled"], [2])
        self.assertEqual(self.mtx.cleared, [])
        self.assertEqual(self._slot(2)["state"], "pulled")
        self.assertEqual(self._slot(2)["file"], "")             # reset still clears the stored record

    def test_bulk_start_with_only_a_pulled_slot_answers_in_result_shape(self):
        (self.media_dir / "b.mp4").write_bytes(b"x")
        self.sources_file.write_text('[{"index": 2, "file": "b.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]', encoding="utf-8")
        self._pull(index=2)
        bulk = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})
        self.assertEqual(bulk.status_code, 200)
        self.assertEqual((bulk.get_json()["targeted"], bulk.get_json()["skipped_pulled"]), (0, [2]))


if __name__ == "__main__":
    unittest.main()
