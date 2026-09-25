import io
import json
import os
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module
from neat_insight import mediasrc


class StreamingSourceTests(unittest.TestCase):
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
        # No MediaMTX in tests. By default it reports no publisher anywhere, so
        # the post-release replacement checks pass; tests that need a publisher,
        # a replacement or an outage patch these again inside the test.
        for name, value in (("webcam_publisher_session", None), ("webcam_publisher_sessions", {})):
            patcher = mock.patch.object(app_module, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        mediasrc.pipeline_registry.clear()
        app_module.MEDIA_DIR = self.old_media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.old_sources_file
        self.tmpdir.cleanup()

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
            with mock.patch.object(app_module, "start_media_stream", return_value=(True, None, 101)) as start:
                response = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["started"], [1])
        self.assertEqual(response.get_json()["already_running"], [])
        start.assert_called_once()

    def test_start_bulk_does_not_undo_what_another_tab_wrote_meanwhile(self):
        """Starting streams takes time; a concurrent assignment must survive the final save."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        (self.media_dir / "other.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )

        def start_and_race(*args, **kwargs):
            # While ffmpeg is "starting", another tab assigns src4.
            current = app_module.load_sources()
            current[3]["file"] = "other.mp4"
            app_module.save_sources(current)
            return True, None, 101

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", side_effect=start_and_race):
                response = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})

        self.assertEqual(response.get_json()["started"], [1])
        after = app_module.load_sources()
        self.assertEqual(after[0]["state"], "playing")
        self.assertEqual(after[3]["file"], "other.mp4", "the other tab's assignment survived")

    def test_start_bulk_abandons_a_slot_that_became_a_webcam_meanwhile(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )

        def start_and_convert(*args, **kwargs):
            current = app_module.load_sources()
            current[0].update({"type": "webcam", "file": ""})
            app_module.save_sources(current)
            return True, None, 101

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", side_effect=start_and_convert):
                with mock.patch.object(app_module, "stop_media_stream_if") as stop_stream:
                    response = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})

        body = response.get_json()
        self.assertEqual(body["started"], [], "not reported as started")
        self.assertEqual([e["index"] for e in body["errors"]], [1])
        stop_stream.assert_called_once()
        self.assertEqual(stop_stream.call_args[0][0], 1, "only the stream this request started is stopped")
        self.assertEqual(app_module.load_sources()[0]["type"], "webcam", "the newer state kept")

    def test_start_bulk_does_not_clobber_a_concurrent_start_it_found_already_running(self):
        """A file this request could not start (another request already did) keeps that request's playing state."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )

        def already_running_started_by_another_request(*args, **kwargs):
            # A concurrent request wins the race and persists playing.
            current = app_module.load_sources()
            current[0]["state"] = "playing"
            app_module.save_sources(current)
            return False, "Already running", None

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream",
                                   side_effect=already_running_started_by_another_request):
                response = self.client.post("/api/mediasrc/start-bulk", json={"count": 1})

        self.assertEqual([e["index"] for e in response.get_json()["errors"]], [1])
        self.assertEqual(app_module.load_sources()[0]["state"], "playing",
                         "the concurrent request's playing state must survive the merge")

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


class WebcamSourceTests(unittest.TestCase):
    """Cover the browser-published webcam source type (see issue #120).

    A webcam slot has no file on disk and no Python-managed ffmpeg process, so
    every liveness decision has to come from MediaMTX rather than from
    pipeline_registry. These tests pin that difference down.
    """

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
        # No MediaMTX in tests. By default it reports no publisher anywhere, so
        # the post-release replacement checks pass; tests that need a publisher,
        # a replacement or an outage patch these again inside the test.
        for name, value in (("webcam_publisher_session", None), ("webcam_publisher_sessions", {})):
            patcher = mock.patch.object(app_module, name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        mediasrc.pipeline_registry.clear()
        app_module.MEDIA_DIR = self.old_media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.old_sources_file
        self.tmpdir.cleanup()

    def _assign_webcam(self, index=1):
        return self.client.post(
            "/api/mediasrc/assign-webcam",
            json={"index": index},
            headers={"Host": "localhost:9900"},
        )

    def test_assign_webcam_marks_slot_and_returns_publish_url(self):
        response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 200)
        source = response.get_json()["source"]
        self.assertEqual(source["type"], "webcam")
        self.assertEqual(source["file"], "")
        self.assertEqual(source["state"], "stopped")
        self.assertEqual(source["allowed_transports"], ["rtsp"])
        self.assertEqual(source["urls"]["rtsp"], "rtsp://localhost:8554/src1")
        # The browser publishes to the cam{N} ingest path, which MediaMTX
        # normalizes onto the src{N} consumer path above (see webcam_path_name).
        self.assertEqual(source["urls"]["whip"], "https://localhost:8889/cam1/whip")

    def test_assign_webcam_requires_an_index(self):
        response = self.client.post("/api/mediasrc/assign-webcam", json={})

        self.assertEqual(response.status_code, 400)
        self.assertIn("Missing index", response.get_json()["error"])

    def test_assign_webcam_rejects_unknown_source(self):
        response = self._assign_webcam(999)

        self.assertEqual(response.status_code, 404)

    def test_webcam_whip_url_uses_the_sdk_mapped_host_port(self):
        """In the SDK the WHIP listener is republished, so 8889 is not reachable."""
        remapped = [
            {"hostPortEnd": None, "hostPortStart": 18889, "name": "webrtcWhip", "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=remapped):
            response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["source"]["urls"]["whip"],
            "https://localhost:18889/cam1/whip",
        )

    def test_webcam_whip_url_falls_back_to_the_default_port(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]):
            response = self._assign_webcam(1)

        self.assertEqual(
            response.get_json()["source"]["urls"]["whip"],
            "https://localhost:8889/cam1/whip",
        )

    def test_persisted_webcam_slot_reloads_without_a_file(self):
        self.sources_file.write_text(
            '[{"index": 1, "file": "stale.mp4", "state": "stopped", "type": "webcam"}]',
            encoding="utf-8",
        )

        sources = app_module.load_sources()

        self.assertEqual(sources[0]["type"], "webcam")
        self.assertEqual(sources[0]["file"], "")
        self.assertEqual(sources[0]["transport"], "rtsp")
        self.assertEqual(sources[0]["codec"], "h264")

    def test_unknown_source_type_normalizes_to_file(self):
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "stopped", "type": "bogus"}]',
            encoding="utf-8",
        )

        sources = app_module.load_sources()

        self.assertEqual(sources[0]["type"], "file")
        self.assertEqual(sources[0]["file"], "clip.mp4")

    def test_start_rejects_a_webcam_that_is_not_publishing_yet(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_is_publishing", return_value=False):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 409)
        self.assertIn("not publishing", response.get_json()["error"])
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_start_marks_webcam_playing_once_mediamtx_reports_it(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            with mock.patch.object(app_module, "start_media_stream") as start_media_stream:
                response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.load_sources()[0]["state"], "playing")
        # A webcam is published by the browser; Insight must not spawn ffmpeg.
        start_media_stream.assert_not_called()

    def test_a_persisted_playing_webcam_reads_as_stopped_when_nothing_publishes(self):
        """A webcam slot is only live while a browser is actually publishing to it.

        This is what keeps the AC's "restarting Insight does not falsely restore
        a webcam as live" true for every case Insight stays up through: the
        browser tab closing, the camera being unplugged, the connection
        dropping. A full process restart is additionally covered by the
        reset_sources() call in main(), which clears every slot on startup.
        """
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "webcam_ready_paths", return_value=set()):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()[0]["state"], "stopped")
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_an_unreachable_status_api_leaves_a_playing_webcam_alone(self):
        """Nothing promotes a slot back, so a blip must not demote it."""
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "webcam_ready_paths",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.get_json()[0]["state"], "playing")
        self.assertEqual(app_module.load_sources()[0]["state"], "playing")

    def test_starting_a_webcam_reports_an_unreachable_media_server(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_is_publishing",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 502)
        self.assertIn("nothing was changed", response.get_json()["error"])

    def _three_playing_webcams(self):
        self.sources_file.write_text(json.dumps([
            {"index": i, "file": "", "state": "playing", "type": "webcam"} for i in (1, 2, 3)
        ]), encoding="utf-8")

    def test_source_listing_asks_mediamtx_once_when_every_webcam_is_live(self):
        """48 slots must not mean 48 control-API timeouts when MediaMTX hangs."""
        self._three_playing_webcams()

        with mock.patch.object(app_module, "webcam_ready_paths", return_value={"cam1", "cam2", "cam3"}) as ready:
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(ready.call_count, 1)
        self.assertEqual({s["state"] for s in response.get_json()[:3]}, {"playing"})

    def test_a_demotion_is_confirmed_against_a_fresh_copy_before_it_is_written(self):
        self._three_playing_webcams()

        with mock.patch.object(app_module, "webcam_ready_paths", return_value={"cam2"}) as ready:
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(ready.call_count, 2, "decide from the snapshot, confirm on the fresh copy")
        states = {s["index"]: s["state"] for s in response.get_json()[:3]}
        self.assertEqual(states, {1: "stopped", 2: "playing", 3: "stopped"})

    def test_a_demotion_does_not_undo_what_another_tab_wrote_meanwhile(self):
        """The Codex race: another tab assigns a file while the liveness request is in flight."""
        self._three_playing_webcams()
        (self.media_dir / "other.mp4").write_bytes(b"not-a-real-video")

        def ready_with_a_concurrent_write():
            # First call: while "MediaMTX is answering", another tab assigns src4.
            if ready_with_a_concurrent_write.calls == 0:
                current = app_module.load_sources()
                current[3]["file"] = "other.mp4"
                app_module.save_sources(current)
            ready_with_a_concurrent_write.calls += 1
            return set()
        ready_with_a_concurrent_write.calls = 0

        with mock.patch.object(app_module, "webcam_ready_paths", side_effect=ready_with_a_concurrent_write):
            self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        after = app_module.load_sources()
        self.assertEqual(after[0]["state"], "stopped", "the dead webcam was demoted")
        self.assertEqual(after[3]["file"], "other.mp4", "the other tab's assignment survived")

    def test_a_webcam_that_came_back_between_the_two_checks_is_not_demoted(self):
        self._three_playing_webcams()
        answers = iter([set(), {"cam1", "cam2", "cam3"}])

        with mock.patch.object(app_module, "webcam_ready_paths", side_effect=lambda: next(answers)):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual({s["state"] for s in response.get_json()[:3]}, {"playing"})

    def test_source_listing_leaves_every_webcam_alone_when_mediamtx_is_unreachable(self):
        self._three_playing_webcams()

        with mock.patch.object(app_module, "webcam_ready_paths",
                               side_effect=app_module.MediaServerUnreachable("hung")) as ready:
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(ready.call_count, 1, "one attempt, not one per slot")
        self.assertEqual({s["state"] for s in response.get_json()[:3]}, {"playing"})

    def test_source_listing_does_not_ask_mediamtx_without_playing_webcams(self):
        self._assign_webcam(1)  # registered, not playing

        with mock.patch.object(app_module, "webcam_ready_paths") as ready:
            self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        ready.assert_not_called()

    def test_a_still_publishing_webcam_stays_live_across_a_reload(self):
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "webcam_ready_paths", return_value={"cam1"}):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.get_json()[0]["state"], "playing")

    def test_webcam_liveness_ignores_the_ffmpeg_registry(self):
        """A stale file-source process must not keep a webcam slot marked live."""
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
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

        with mock.patch.object(app_module, "webcam_ready_paths", return_value=set()):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.get_json()[0]["state"], "stopped")

    def test_assigning_a_file_over_a_webcam_restores_the_file_type(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post(
                    "/api/mediasrc/assign",
                    json={"index": 1, "file": "clip.mp4"},
                    headers={"Host": "localhost:9900"},
                )

        self.assertEqual(response.status_code, 200)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "file")
        self.assertEqual(source["file"], "clip.mp4")

    def test_auto_assign_turns_webcam_slots_back_into_file_slots(self):
        """A file assignment that kept type=webcam would be cleared on the next load."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=False):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post("/api/mediasrc/auto-assign-all")

        self.assertEqual(response.status_code, 200)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "file")
        self.assertEqual(source["file"], "clip.mp4", "the assignment must survive a reload")

    def test_auto_assign_keeps_a_webcam_slot_it_could_not_confirm(self):
        """Overwriting it would lose the only record that a camera may still be live."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post("/api/mediasrc/auto-assign-all")

        body = response.get_json()
        self.assertEqual(body["unconfirmed_webcams"], [1])
        sources = app_module.load_sources()
        self.assertEqual(sources[0]["type"], "webcam", "still identifiable for a retry")
        self.assertEqual(sources[0]["state"], "playing", "Stop must remain available")
        self.assertEqual(sources[1]["file"], "clip.mp4",
                         "the skipped slot must not consume the video")

    def test_auto_assign_believes_a_caller_that_released_its_own_publisher(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
            with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=app_module.MediaServerUnreachable("down")):
                with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                    response = self.client.post(
                        "/api/mediasrc/auto-assign-all",
                        json={"released_webcams": [{"index": 1, "session": "mine"}]})

        body = response.get_json()
        self.assertEqual(body["unconfirmed_webcams"], [])
        self.assertEqual(app_module.load_sources()[0]["file"], "clip.mp4")

    def test_reset_keeps_a_webcam_slot_it_could_not_confirm(self):
        self._assign_webcam(3)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 3})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/reset")

        body = response.get_json()
        self.assertEqual(body["unconfirmed_webcams"], [3])
        source = app_module.load_sources()[2]
        self.assertEqual(source["type"], "webcam")
        self.assertEqual(source["state"], "playing", "Stop must remain available")

    def test_reset_clears_a_webcam_slot_it_did_confirm(self):
        self._assign_webcam(3)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True):
            response = self.client.post("/api/mediasrc/reset")

        self.assertEqual(response.get_json()["unconfirmed_webcams"], [])
        self.assertEqual(app_module.load_sources()[2]["type"], "file")

    def test_stop_kicks_the_browser_publishing_to_the_slot(self):
        """Stop must mean stopped for any caller, not just the tab that owns the peer connection."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        kick.assert_called_once_with(1)

    def test_stop_refuses_when_the_publisher_cannot_be_confirmed_stopped(self):
        """Reporting "stopped" for a camera that may still be live is the bug being avoided."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 502)
        self.assertIn("nothing was changed", response.get_json()["error"])

    def test_a_caller_that_released_its_own_publisher_is_believed(self):
        """The tab that owned the publish closed it itself; MediaMTX's opinion is moot."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
            with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                response = self.client.post("/api/mediasrc/stop", json={
                    "index": 1, "publisher_released": True, "publisher_session": "mine"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")
        kick.assert_not_called()

    def test_stop_all_does_not_flag_slots_the_caller_released(self):
        self._assign_webcam(2)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="mine"):
            with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=app_module.MediaServerUnreachable("down")):
                response = self.client.post(
                    "/api/mediasrc/stop-all",
                    json={"released_webcams": [{"index": 2, "session": "mine"}]})

        body = response.get_json()
        self.assertEqual(body["unconfirmed_webcams"], [])
        self.assertNotIn("Could not confirm", body["message"])

    def test_an_unhandled_unknown_answers_502_without_changing_anything(self):
        """The point of raising: a route that does not handle it fails safe.

        Every previous bug in this area was a caller reading "could not reach
        MediaMTX" as "nothing is publishing" and then mutating on it. With an
        exception the default is to abort before the mutation.
        """
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 502)
        source = app_module.load_sources()[0]
        self.assertEqual(source["state"], "playing", "state untouched")
        self.assertEqual(source["type"], "webcam", "still identifiable for a retry")

    def test_a_stale_released_stop_does_not_touch_a_slot_someone_else_now_publishes(self):
        """Tab A's dropped connection reports in after tab B took the slot over."""
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="tab-b"):
            with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                response = self.client.post("/api/mediasrc/stop", json={
                    "index": 1, "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(response.status_code, 409)
        kick.assert_not_called()
        self.assertEqual(app_module.load_sources()[0]["state"], "playing", "B's camera untouched")

    def test_a_released_stop_for_its_own_draining_session_is_honoured(self):
        """The owning tab's DELETE may still be in flight, so its id can still be on the path."""
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="tab-a"):
            with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                response = self.client.post("/api/mediasrc/stop", json={
                    "index": 1, "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(response.status_code, 200)
        kick.assert_not_called()
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_a_released_stop_never_kicks(self):
        """The caller closed its own publisher; kicking would only ever hit someone else's."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
            with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                response = self.client.post("/api/mediasrc/stop", json={
                    "index": 1, "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(response.status_code, 200)
        kick.assert_not_called()

    def test_a_stale_release_claim_does_not_stop_the_file_that_replaced_the_webcam(self):
        """Tab A's delayed disconnect must not kill the file stream tab B started on the slot."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "type": "file"}]',
            encoding="utf-8")

        with mock.patch.object(app_module, "stop_media_stream") as stop_stream:
            response = self.client.post("/api/mediasrc/stop", json={
                "index": 1, "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(response.status_code, 409)
        stop_stream.assert_not_called()
        self.assertEqual(app_module.load_sources()[0]["state"], "playing", "B's file untouched")

    def test_a_plain_stop_still_stops_a_file_source(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "type": "file"}]',
            encoding="utf-8")

        with mock.patch.object(app_module, "stop_media_stream") as stop_stream:
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        stop_stream.assert_called_once_with(1)

    def test_converting_a_playing_webcam_to_a_file_leaves_it_stopped(self):
        """No ffmpeg process was started, so the slot cannot be playing."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                with mock.patch.object(app_module, "start_media_stream") as start_stream:
                    response = self.client.post(
                        "/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})

        self.assertEqual(response.status_code, 200)
        start_stream.assert_not_called()
        source = app_module.load_sources()[0]
        self.assertEqual((source["type"], source["file"], source["state"]), ("file", "clip.mp4", "stopped"))

    def test_a_release_claim_without_a_session_is_not_a_claim(self):
        """Nothing to verify against means nothing can be honoured — for any route."""
        self._assign_webcam(1)

        for path, body in (
            ("/api/mediasrc/stop", {"index": 1, "publisher_released": True}),
            ("/api/mediasrc/assign-webcam", {"index": 1, "publisher_released": True}),
            ("/api/mediasrc/assign", {"index": 1, "file": "", "publisher_released": True}),
        ):
            with self.subTest(path=path):
                with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                    response = self.client.post(path, json=body)
                self.assertEqual(response.status_code, 400)
                self.assertIn("publisher_session", response.get_json()["error"])
                kick.assert_not_called()

    def test_a_publisher_that_keeps_changing_answers_502_and_changes_nothing(self):
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.WebcamPublisherUnconfirmed("churn")):
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 502)
        self.assertIn("nothing was changed", response.get_json()["error"])
        self.assertEqual(app_module.load_sources()[0]["state"], "playing")

    def test_a_released_stop_that_cannot_be_verified_changes_nothing(self):
        """An unverifiable claim must not mark a possibly-replaced camera stopped."""
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "webcam_publisher_session", side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/stop", json={
                "index": 1, "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(response.status_code, 502)
        self.assertEqual(app_module.load_sources()[0]["state"], "playing")

    def test_a_stale_release_claim_on_reassignment_is_refused(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="tab-b"):
            with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                switched = self.client.post(
                    "/api/mediasrc/assign-webcam",
                    json={"index": 1, "publisher_released": True, "publisher_session": "tab-a"})
                converted = self.client.post(
                    "/api/mediasrc/assign",
                    json={"index": 1, "file": "", "publisher_released": True, "publisher_session": "tab-a"})

        self.assertEqual(switched.status_code, 409)
        self.assertEqual(converted.status_code, 409)
        kick.assert_not_called()
        self.assertEqual(app_module.load_sources()[0]["type"], "webcam", "untouched")

    def test_a_bulk_stop_contacts_an_unreachable_mediamtx_once_not_per_slot(self):
        """48 webcam slots must not mean 48 one-second timeouts against a server known to be down."""
        self._three_playing_webcams()

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("hung")) as kick:
            response = self.client.post("/api/mediasrc/stop-all", json={})

        body = response.get_json()
        self.assertEqual(kick.call_count, 1, "stopped contacting MediaMTX after the first timeout")
        self.assertEqual(body["unconfirmed_webcams"], [1, 2, 3], "every remaining slot reported unconfirmed")

    def test_a_churning_slot_does_not_stop_the_bulk_loop_asking_about_the_others(self):
        self._three_playing_webcams()
        outcomes = {1: app_module.WebcamPublisherUnconfirmed("churn"), 2: True, 3: True}

        def kick(index):
            r = outcomes[index]
            if isinstance(r, Exception):
                raise r
            return r

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick) as kicked:
            response = self.client.post("/api/mediasrc/stop-all", json={})

        self.assertEqual(kicked.call_count, 3, "only MediaMTX being down short-circuits, not one bad slot")
        self.assertEqual(response.get_json()["unconfirmed_webcams"], [1])

    def test_a_stale_bulk_release_claim_falls_back_to_a_confirmed_kick(self):
        """Stop All means stop everything; a stale claim just loses its shortcut."""
        self._assign_webcam(2)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="tab-b"):
            with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True) as kick:
                response = self.client.post(
                    "/api/mediasrc/stop-all",
                    json={"released_webcams": [{"index": 2, "session": "tab-a"}]})

        self.assertEqual(response.get_json()["unconfirmed_webcams"], [])
        kick.assert_called_once_with(2)

    def test_a_bare_index_in_released_webcams_is_not_a_claim(self):
        self._assign_webcam(2)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True) as kick:
            response = self.client.post(
                "/api/mediasrc/stop-all", json={"released_webcams": [2]})

        self.assertEqual(response.status_code, 200)
        kick.assert_called_once_with(2)

    def test_a_boolean_index_in_released_webcams_is_not_a_claim(self):
        """bool is an int subclass; {"index": true} must not read as slot 1."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=True) as kick:
            response = self.client.post(
                "/api/mediasrc/stop-all", json={"released_webcams": [{"index": True, "session": "mine"}]})

        self.assertEqual(response.status_code, 200)
        kick.assert_called_once_with(1)

    def test_stop_all_does_not_count_a_camera_it_could_not_confirm_stopped(self):
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            body = self.client.post("/api/mediasrc/stop-all").get_json()

        self.assertEqual(body["unconfirmed_webcams"], [1])
        self.assertEqual(body["stopped_count"], 0, "still publishing, so not stopped")
        self.assertEqual(app_module.load_sources()[0]["state"], "playing")

    # --- Requests that wait on MediaMTX act on a fresh copy of the file ---
    # Each of these makes the MediaMTX call itself change the file, the way a
    # second tab would during the up-to-one-second wait, and checks that the
    # route neither overwrites that change nor acts on the slot it now holds.

    def _write_file_slot(self, index, file_name="other.mp4", state="stopped"):
        sources = app_module.load_sources()
        sources[index - 1].update({"type": "file", "file": file_name, "state": state})
        app_module.save_sources(sources)

    def test_webcam_start_answers_410_when_the_slot_became_a_file_meanwhile(self):
        self._assign_webcam(1)

        def publishing_then_reassigned(index):
            self._write_file_slot(1, "clip.mp4")
            return True

        with mock.patch.object(app_module, "webcam_is_publishing", side_effect=publishing_then_reassigned):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 410)
        source = app_module.load_sources()[0]
        self.assertEqual((source["type"], source["file"], source["state"]), ("file", "clip.mp4", "stopped"),
                         "the file nothing started must not be marked playing")

    def test_webcam_start_keeps_a_change_made_to_another_slot_meanwhile(self):
        self._assign_webcam(1)

        def publishing_while_slot_2_assigned(index):
            self._write_file_slot(2, "clip.mp4")
            return True

        with mock.patch.object(app_module, "webcam_is_publishing", side_effect=publishing_while_slot_2_assigned):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        sources = app_module.load_sources()
        self.assertEqual(sources[0]["state"], "playing")
        self.assertEqual(sources[1]["file"], "clip.mp4", "the other tab's assignment survived the save")

    def test_webcam_stop_answers_409_when_the_slot_became_a_file_meanwhile(self):
        self._assign_webcam(1)

        def kick_then_reassigned(index):
            self._write_file_slot(1, "clip.mp4", state="playing")
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick_then_reassigned):
            with mock.patch.object(app_module, "stop_media_stream") as stop:
                response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 409)
        stop.assert_not_called()
        self.assertEqual(app_module.load_sources()[0]["state"], "playing", "the file stream was never stopped")

    def test_assign_webcam_answers_409_when_the_slot_became_a_file_meanwhile(self):
        self._assign_webcam(1)

        def kick_then_reassigned(index):
            self._write_file_slot(1, "clip.mp4")
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick_then_reassigned):
            response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(app_module.load_sources()[0]["file"], "clip.mp4")

    def test_assign_file_answers_409_when_the_webcam_slot_changed_meanwhile(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        def kick_then_reassigned(index):
            self._write_file_slot(1, "other.mp4")
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick_then_reassigned):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(app_module.load_sources()[0]["file"], "other.mp4")

    def test_assign_file_answers_409_when_a_replacement_webcam_publishes_during_the_probe(self):
        """A new camera on the slot has the same ("webcam", "") identity; only its session id tells it apart.

        The replacement appears *during* the probe, so this passes only because
        the release (and its session recheck) runs after the probe, not before.
        """
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        publishing = {"session": None}

        def probe_then_newcomer(*args, **kwargs):
            # A browser publishes to the slot while the file is being probed.
            publishing["session"] = "a-newcomer"
            return ("rtsp", "h264", ["rtsp"])

        with mock.patch.object(app_module, "_derive_source_stream_settings", side_effect=probe_then_newcomer):
            with mock.patch.object(app_module, "kick_webcam_publisher", return_value=None):
                with mock.patch.object(app_module, "webcam_publisher_session",
                                       side_effect=lambda index: publishing["session"]):
                    with mock.patch.object(app_module, "stop_media_stream") as stop:
                        response = self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})

        self.assertEqual(response.status_code, 409)
        stop.assert_not_called()
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "webcam", "the replacement camera's slot was not erased to a file")

    def test_stop_all_leaves_a_slot_reassigned_while_it_was_running(self):
        """Slot 1 is stopped first; releasing slot 2 takes time, during which slot 1 is given a live file."""
        self._assign_webcam(1)
        self._assign_webcam(2)

        def kick(index):
            if index == 2:
                self._write_file_slot(1, "clip.mp4", state="playing")
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick):
            body = self.client.post("/api/mediasrc/stop-all").get_json()

        self.assertEqual(body["changed_sources"], [1])
        self.assertIn("reassigned while stopping", body["message"])
        sources = app_module.load_sources()
        self.assertEqual((sources[0]["file"], sources[0]["state"]), ("clip.mp4", "playing"))
        self.assertEqual(sources[1]["state"], "stopped")

    def test_file_start_stops_its_stream_when_the_slot_changed_meanwhile(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._write_file_slot(1, "clip.mp4")

        def start_then_reassigned(index, *args, **kwargs):
            self._write_file_slot(1, "other.mp4")
            return True, None, 101  # 101 = the identity this start captured

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            with mock.patch.object(app_module, "start_media_stream", side_effect=start_then_reassigned):
                with mock.patch.object(app_module, "media_stream_identity", return_value=999) as reread:
                    with mock.patch.object(app_module, "stop_media_stream_if") as stop:
                        response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 410)
        stop.assert_called_once()
        self.assertEqual(stop.call_args[0][0], 1, "only the stream this request started is stopped")
        # The identity must be the one start_media_stream returned (101), not a
        # later re-read (999) that could name a replacement started meanwhile.
        self.assertEqual(stop.call_args[0][1], 101, "uses the atomically captured identity")
        reread.assert_not_called()
        source = app_module.load_sources()[0]
        self.assertEqual((source["file"], source["state"]), ("other.mp4", "stopped"))

    def test_file_start_does_not_overwrite_a_transport_reassigned_during_the_start(self):
        """Same file, different transport, mid-start: our RTSP start must not overwrite the concurrent HTTP one."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._write_file_slot(1, "clip.mp4")  # rtsp by default

        def start_then_reassigned_to_http(index, *args, **kwargs):
            s = app_module.load_sources()
            s[0].update({"type": "file", "file": "clip.mp4", "transport": "http", "codec": "mjpeg", "state": "playing"})
            app_module.save_sources(s)
            return True, None, 101

        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("rtsp", "h264", ["rtsp"])):
            with mock.patch.object(app_module, "start_media_stream", side_effect=start_then_reassigned_to_http):
                with mock.patch.object(app_module, "stop_media_stream_if") as stop:
                    response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 410)
        stop.assert_called_once()
        self.assertEqual(stop.call_args[0][1], 101, "stops only the stream this request started")
        source = app_module.load_sources()[0]
        self.assertEqual((source["transport"], source["codec"]), ("http", "mjpeg"),
                         "the concurrent HTTP reassignment survived, not overwritten with RTSP")

    def test_start_bulk_does_not_overwrite_a_transport_reassigned_during_the_start(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "stopped", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )

        def start_then_reassigned_to_http(*args, **kwargs):
            s = app_module.load_sources()
            s[0].update({"transport": "http", "codec": "mjpeg", "state": "playing"})
            app_module.save_sources(s)
            return True, None, 101

        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
            with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("rtsp", "h264", ["rtsp"])):
                with mock.patch.object(app_module, "start_media_stream", side_effect=start_then_reassigned_to_http):
                    with mock.patch.object(app_module, "stop_media_stream_if") as stop:
                        body = self.client.post("/api/mediasrc/start-bulk", json={"count": 1}).get_json()

        self.assertEqual([e["index"] for e in body["errors"]], [1], "reported as changed, not started")
        stop.assert_called_once()
        self.assertEqual(app_module.load_sources()[0]["transport"], "http",
                         "the concurrent HTTP reassignment survived the merge")

    def test_auto_assign_leaves_a_slot_reassigned_while_it_was_running(self):
        """Slot 1 is planned first; releasing slot 2 takes time, during which slot 1 gets a live webcam."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(2)

        def kick(index):
            sources = app_module.load_sources()
            sources[0].update({"type": "webcam", "file": "", "state": "playing"})
            app_module.save_sources(sources)
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                body = self.client.post("/api/mediasrc/auto-assign-all").get_json()

        self.assertEqual(body["changed_sources"], [1])
        self.assertEqual(body["assigned_count"], 0, "the file planned for slot 1 was not written over the camera")
        sources = app_module.load_sources()
        self.assertEqual((sources[0]["type"], sources[0]["state"]), ("webcam", "playing"))
        self.assertEqual(sources[1]["type"], "file", "slot 2 was still reset to a file slot")

    def test_reset_leaves_a_slot_reassigned_while_it_was_running(self):
        self._assign_webcam(2)

        def kick(index):
            self._write_file_slot(1, "clip.mp4", state="playing")
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick):
            body = self.client.post("/api/mediasrc/reset").get_json()

        self.assertEqual(body["changed_sources"], [1])
        sources = app_module.load_sources()
        self.assertEqual((sources[0]["file"], sources[0]["state"]), ("clip.mp4", "playing"))
        self.assertEqual((sources[1]["type"], sources[1]["file"]), ("file", ""))

    def test_stop_all_leaves_a_webcam_re_published_on_a_released_slot(self):
        """The released camera and its replacement share the slot identity ("webcam", ""); only the session id differs."""
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        # Release reports it kicked session "old"; a new camera "new" is on the
        # path by the time the replacement check runs.
        with mock.patch.object(app_module, "kick_webcam_publisher", return_value="old"):
            with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
                with mock.patch.object(app_module, "webcam_publisher_sessions", return_value={"cam1": "new"}):
                    body = self.client.post("/api/mediasrc/stop-all").get_json()

        self.assertEqual(body["changed_sources"], [1])
        self.assertEqual(app_module.load_sources()[0]["state"], "playing",
                         "the replacement camera keeps its Live row and Stop control")

    def test_reset_marks_every_released_slot_unconfirmed_when_sessions_cannot_be_listed(self):
        """If MediaMTX cannot answer the replacement check, no released webcam may be erased."""
        self._assign_webcam(2)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value="old"):
            with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
                with mock.patch.object(app_module, "webcam_publisher_sessions",
                                       side_effect=app_module.MediaServerUnreachable("down")):
                    body = self.client.post("/api/mediasrc/reset").get_json()

        self.assertEqual(body["unconfirmed_webcams"], [2])
        self.assertEqual(app_module.load_sources()[1]["type"], "webcam",
                         "not erased while a live camera cannot be ruled out")

    def test_assign_replaces_a_same_file_stream_started_during_the_probe(self):
        """Identity (type, file) cannot see a restart of the same file; the running process is what gets replaced."""
        for name in ("clip.mp4", "next.mp4"):
            (self.media_dir / name).write_bytes(b"not-a-real-video")
        self._write_file_slot(1, "clip.mp4", state="stopped")
        running = {"value": False}

        def probe_then_started_elsewhere(*args, **kwargs):
            # Another tab starts clip.mp4 on slot 1 while this probe runs.
            self._write_file_slot(1, "clip.mp4", state="playing")
            running["value"] = True
            return ("rtsp", "h264", ["rtsp"])

        with mock.patch.object(app_module, "_derive_source_stream_settings", side_effect=probe_then_started_elsewhere):
            with mock.patch.object(app_module, "media_stream_is_running", side_effect=lambda i: running["value"]):
                with mock.patch.object(app_module, "stop_media_stream") as stop:
                    with mock.patch.object(app_module, "start_media_stream", return_value=(True, None, 101)) as start:
                        with mock.patch.object(app_module, "_source_media_codec", return_value="h264"):
                            response = self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "next.mp4"})

        self.assertEqual(response.status_code, 200)
        stop.assert_called_once_with(1)
        self.assertEqual(start.call_args[0][0], 1)
        self.assertEqual((app_module.load_sources()[0]["file"], app_module.load_sources()[0]["state"]), ("next.mp4", "playing"))

    def test_stop_all_stops_a_same_file_restarted_while_it_was_running(self):
        """Slot 1's file is stopped, then restarted by another tab while slot 2's publisher is released."""
        self._write_file_slot(1, "clip.mp4", state="playing")
        self._assign_webcam(2)
        running = {"value": False}

        def kick(index):
            self._write_file_slot(1, "clip.mp4", state="playing")
            running["value"] = True
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick):
            with mock.patch.object(app_module, "media_stream_is_running", side_effect=lambda i: running["value"] and i == 1):
                with mock.patch.object(app_module, "stop_media_stream") as stop:
                    body = self.client.post("/api/mediasrc/stop-all").get_json()

        self.assertEqual(body["changed_sources"], [])
        self.assertEqual([c.args[0] for c in stop.call_args_list].count(1), 1, "stopped in the merge, after the identity check")
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_assign_webcam_does_not_kill_a_file_another_tab_assigned_meanwhile(self):
        """The old file was playing; it is replaced and started by another tab before this request's lock."""
        self._write_file_slot(1, "clip.mp4", state="playing")
        real_load, calls = app_module.load_sources, []

        def load_with_swap_before_the_lock():
            # First load is the route's snapshot; the swap lands before its reload.
            calls.append(1)
            if len(calls) == 2:
                self._write_file_slot(1, "other.mp4", state="playing")
            return real_load()

        with mock.patch.object(app_module, "load_sources", side_effect=load_with_swap_before_the_lock):
            with mock.patch.object(app_module, "stop_media_stream") as stop:
                response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 409)
        stop.assert_not_called()
        source = app_module.load_sources()[0]
        self.assertEqual((source["file"], source["state"]), ("other.mp4", "playing"))

    # --- A camera re-published on a released slot has the slot's identity; only its
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        calls = []

        def ready_paths():
            calls.append(1)
            if len(calls) == 2:
                self._write_file_slot(2, "clip.mp4")
            return set()

        with mock.patch.object(app_module, "webcam_ready_paths", side_effect=ready_paths):
            listed = self.client.get("/api/mediasrc").get_json()

        self.assertEqual(len(calls), 2)
        by_index = {src["index"]: src for src in listed}
        self.assertEqual(by_index[1]["state"], "stopped")
        self.assertEqual(by_index[2]["file"], "clip.mp4", "the assignment made during the re-check survived")

    def test_webcam_rtsp_url_uses_the_sdk_mapped_port(self):
        remapped = [{"hostPortEnd": None, "hostPortStart": 18554, "name": "rtsp.tcp", "protocol": "tcp"}]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=remapped):
            response = self._assign_webcam(1)

        self.assertEqual(response.get_json()["source"]["urls"]["rtsp"], "rtsp://localhost:18554/src1")

    def test_stop_succeeds_when_there_was_nothing_publishing(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher", return_value=False):
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_stop_all_does_not_undo_an_assignment_made_while_it_ran(self):
        """Stop All changes state only; a concurrent file assignment must survive."""
        (self.media_dir / "other.mp4").write_bytes(b"not-a-real-video")
        self._three_playing_webcams()

        def kick_and_race(index):
            if index == 1:
                current = app_module.load_sources()
                current[3]["file"] = "other.mp4"
                app_module.save_sources(current)
            return True

        with mock.patch.object(app_module, "kick_webcam_publisher", side_effect=kick_and_race):
            response = self.client.post("/api/mediasrc/stop-all", json={})

        self.assertEqual(response.status_code, 200)
        after = app_module.load_sources()
        self.assertEqual({s["state"] for s in after[:3]}, {"stopped"})
        self.assertEqual(after[3]["file"], "other.mp4", "the other tab's assignment survived")

    def test_stop_all_names_the_slots_it_could_not_confirm(self):
        self._assign_webcam(2)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 2})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self.client.post("/api/mediasrc/stop-all")

        body = response.get_json()
        self.assertEqual(response.status_code, 200, "the other sources still stopped")
        self.assertEqual(body["unconfirmed_webcams"], [2])
        self.assertIn("Could not confirm", body["message"])
        self.assertEqual(app_module.load_sources()[1]["state"], "playing",
                         "still playing, so the Stop control stays available to retry")

    def test_stopping_a_file_source_does_not_call_the_kick_api(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})

        with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
            self.client.post("/api/mediasrc/stop", json={"index": 1})

        kick.assert_not_called()

    def test_bulk_paths_kick_webcam_publishers(self):
        for endpoint, payload in (
            ("/api/mediasrc/stop-all", None),
            ("/api/mediasrc/reset", None),
            ("/api/mediasrc/auto-assign-all", None),
        ):
            with self.subTest(endpoint=endpoint):
                self.sources_file.write_text("[]", encoding="utf-8")
                self._assign_webcam(2)

                with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
                    with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                        response = self.client.post(endpoint, json=payload)

                self.assertEqual(response.status_code, 200)
                self.assertIn(2, [call.args[0] for call in kick.call_args_list])

    def test_switching_cameras_refuses_when_the_old_publisher_is_unconfirmed(self):
        """Persisting stopped would hide the Stop control for a camera still live."""
        self._assign_webcam(1)
        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
            self.client.post("/api/mediasrc/start", json={"index": 1})

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 502)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "webcam")
        self.assertEqual(source["state"], "playing", "still stoppable")

    def test_switching_cameras_is_allowed_when_the_caller_released_its_publisher(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value="mine"):
            response = self.client.post(
                "/api/mediasrc/assign-webcam",
                json={"index": 1, "publisher_released": True, "publisher_session": "mine"},
                headers={"Host": "localhost:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_switching_cameras_kicks_the_previous_publisher(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
            self._assign_webcam(1)

        kick.assert_called_once_with(1)

    def test_an_unreadable_port_map_candidate_is_skipped(self):
        """The candidate list walks /home, so another user's directory must not be fatal."""
        denied = Path("/home/someone-else/.insight-config/neat-port-map.json")

        with mock.patch.object(app_module, "_sysinfo_port_map_candidates", return_value=iter([denied])):
            with mock.patch.object(app_module.Path, "is_file", side_effect=PermissionError(13, "denied")):
                self.assertEqual(app_module._read_exposed_ports_from_port_map(), [])
                self.assertEqual(app_module._resolve_webcam_ice_port(), 8189)

    def test_the_ice_port_follows_the_sdk_port_map(self):
        """MediaMTX must bind the port the SDK published, since SDP carries it."""
        remapped = [
            {"hostPortEnd": None, "hostPortStart": 18259, "name": "webrtcWhipIce", "protocol": "udp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=remapped):
            self.assertEqual(app_module._resolve_webcam_ice_port(), 18259)

    def test_the_ice_port_falls_back_to_the_default(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]):
            self.assertEqual(app_module._resolve_webcam_ice_port(), 8189)

    def test_the_whip_url_brackets_an_ipv6_host(self):
        self.client.post("/api/mediasrc/assign-webcam", json={"index": 1},
                         headers={"Host": "[fd00::23]:9900"})
        response = self.client.get("/api/mediasrc", headers={"Host": "[fd00::23]:9900"})

        urls = response.get_json()[0]["urls"]
        self.assertEqual(urls["whip"], "https://[fd00::23]:8889/cam1/whip")
        self.assertEqual(urls["rtsp"], "rtsp://[fd00::23]:8554/src1")

    def test_a_named_host_is_left_alone(self):
        self.client.post("/api/mediasrc/assign-webcam", json={"index": 1},
                         headers={"Host": "insight.local:9900"})
        response = self.client.get("/api/mediasrc", headers={"Host": "insight.local:9900"})

        urls = response.get_json()[0]["urls"]
        self.assertEqual(urls["whip"], "https://insight.local:8889/cam1/whip")
        self.assertEqual(urls["rtsp"], "rtsp://insight.local:8554/src1")

    def test_assigning_a_file_refuses_when_the_publisher_cannot_be_confirmed(self):
        """Converting the slot would erase the only record that a camera may be live."""
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher",
                               side_effect=app_module.MediaServerUnreachable("down")):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post(
                    "/api/mediasrc/assign", json={"index": 1, "file": "clip.mp4"})

        self.assertEqual(response.status_code, 502)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "webcam", "left unchanged so it can be retried")
        self.assertEqual(source["file"], "")

    def test_assigning_a_file_is_allowed_when_the_caller_released_the_publisher(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

        with mock.patch.object(app_module, "webcam_publisher_session", return_value=None):
            with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
                response = self.client.post(
                    "/api/mediasrc/assign",
                    json={"index": 1, "file": "clip.mp4",
                          "publisher_released": True, "publisher_session": "mine"})

        self.assertEqual(response.status_code, 200)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "file")
        self.assertEqual(source["file"], "clip.mp4")

    def test_assigning_a_webcam_over_a_playing_file_stops_its_stream(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self.sources_file.write_text(
            '[{"index": 1, "file": "clip.mp4", "state": "playing", "transport": "rtsp", "codec": "h264"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "stop_media_stream") as stop_media_stream:
            response = self._assign_webcam(1)

        self.assertEqual(response.status_code, 200)
        stop_media_stream.assert_called_once_with(1)
        self.assertEqual(app_module.load_sources()[0]["type"], "webcam")


class WebcamPublishStateTests(unittest.TestCase):
    """mediasrc.webcam_is_publishing() talks to the MediaMTX status API."""

    def _urlopen_returning(self, payload):
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(json.dumps(payload).encode("utf-8"))
        return mock.Mock(return_value=response)

    def test_reports_publishing_when_mediamtx_marks_the_path_ready(self):
        urlopen = self._urlopen_returning({"name": "src1", "ready": True})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertTrue(mediasrc.webcam_is_publishing(1))

        request = urlopen.call_args[0][0]
        # The browser publishes to the cam{N} ingest path, so liveness and
        # session questions are asked about cam{N}, not the src{N} consumer path.
        self.assertIn("/v3/paths/get/cam1", request.full_url)
        self.assertEqual(request.get_method(), "GET")

    def test_reports_not_publishing_when_the_path_is_not_ready(self):
        urlopen = self._urlopen_returning({"name": "src1", "ready": False})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.webcam_is_publishing(1))

    def test_raises_when_the_api_is_unreachable(self):
        """MediaMTX may not be up yet, and "not up" is not "not publishing"."""
        urlopen = mock.Mock(side_effect=mediasrc.urllib.error.URLError("refused"))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.webcam_is_publishing(1)

    def test_ready_paths_collects_only_ready_names_from_one_request(self):
        urlopen = self._urlopen_returning({"itemCount": 3, "pageCount": 1, "items": [
            {"name": "src1", "ready": True}, {"name": "src2", "ready": False}, {"name": "src3", "ready": True}]})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertEqual(mediasrc.webcam_ready_paths(), {"src1", "src3"})

        self.assertEqual(urlopen.call_count, 1)
        self.assertIn("/v3/paths/list", urlopen.call_args[0][0].full_url)

    def test_ready_paths_raises_when_unreachable(self):
        urlopen = mock.Mock(side_effect=mediasrc.urllib.error.URLError("refused"))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.webcam_ready_paths()

    def test_publisher_session_reports_the_current_webrtc_session_id(self):
        urlopen = self._urlopen_returning(
            {"name": "src1", "ready": True, "source": {"type": "webRTCSession", "id": "abc-123"}})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertEqual(mediasrc.webcam_publisher_session(1), "abc-123")

    def test_publisher_session_is_none_for_an_idle_or_non_webrtc_path(self):
        for payload in (
            {"name": "src1", "ready": False, "source": None},
            {"name": "src1", "ready": True, "source": {"type": "rtspSession", "id": "x"}},
        ):
            urlopen = self._urlopen_returning(payload)
            with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
                self.assertIsNone(mediasrc.webcam_publisher_session(1))

    def test_kick_closes_the_session_publishing_to_the_path(self):
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append((request.full_url, request.get_method()))
            if "/v3/paths/get/" in request.full_url:
                payload = {"name": "src1", "ready": True,
                           "source": {"type": "webRTCSession", "id": "abc-123"}}
            else:
                payload = {}
            response = mock.MagicMock()
            response.__enter__.return_value = io.BytesIO(json.dumps(payload).encode("utf-8"))
            return response

        with mock.patch.object(mediasrc.urllib.request, "urlopen", fake_urlopen):
            self.assertTrue(mediasrc.kick_webcam_publisher(1))

        self.assertEqual(calls[1], (
            "http://127.0.0.1:9997/v3/webrtcsessions/kick/abc-123", "POST"))
        self.assertEqual(len(calls), 2, "a successful kick needs no re-check")

    def test_kick_is_a_no_op_when_nothing_is_publishing(self):
        urlopen = self._urlopen_returning({"name": "src1", "ready": False, "source": None})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.kick_webcam_publisher(1))

        self.assertEqual(urlopen.call_count, 1, "no kick issued when there is no session")

    def test_kick_does_not_touch_a_non_webrtc_publisher(self):
        """A file source pushed by ffmpeg must never be kicked through this path."""
        urlopen = self._urlopen_returning(
            {"name": "src1", "ready": True, "source": {"type": "rtspSession", "id": "x"}})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.kick_webcam_publisher(1))

        self.assertEqual(urlopen.call_count, 1)

    def _http_error(self, code):
        return mediasrc.urllib.error.HTTPError(
            "http://127.0.0.1:9997/x", code, "err", {}, None)

    def test_a_missing_path_reads_as_not_publishing_not_unknown(self):
        """404 is an answer: the path is not there."""
        urlopen = mock.Mock(side_effect=self._http_error(404))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertIs(mediasrc.webcam_is_publishing(1), False)

    def test_a_broken_status_api_raises_rather_than_reading_as_idle(self):
        """A blip must not be evidence that a live camera stopped."""
        urlopen = mock.Mock(side_effect=self._http_error(500))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.webcam_is_publishing(1)

    def _mediamtx_sequence(self, lookups, kick_results):
        """A fake control API: successive path lookups, then per-kick outcomes."""
        state = {"lookup": 0, "kick": 0}

        def fake_urlopen(request, timeout=None):
            if "/v3/paths/get/" in request.full_url:
                sid = lookups[min(state["lookup"], len(lookups) - 1)]
                state["lookup"] += 1
                payload = {"name": "src1", "ready": bool(sid),
                           "source": {"type": "webRTCSession", "id": sid} if sid else None}
                response = mock.MagicMock()
                response.__enter__.return_value = io.BytesIO(json.dumps(payload).encode("utf-8"))
                return response
            outcome = kick_results[min(state["kick"], len(kick_results) - 1)]
            state["kick"] += 1
            if outcome == 404:
                raise mediasrc.urllib.error.HTTPError(request.full_url, 404, "gone", {}, None)
            response = mock.MagicMock()
            response.__enter__.return_value = io.BytesIO(b"")
            return response

        return fake_urlopen, state

    def test_a_session_that_vanished_before_the_kick_counts_as_idle_only_after_a_recheck(self):
        """The owning tab's own teardown commonly wins this race."""
        fake, state = self._mediamtx_sequence(lookups=["abc-123", None], kick_results=[404])

        with mock.patch.object(mediasrc.urllib.request, "urlopen", fake):
            self.assertIsNone(mediasrc.kick_webcam_publisher(1))

        self.assertEqual(state["lookup"], 2, "looked again before calling the slot idle")

    def test_a_vanished_target_replaced_by_a_newcomer_kicks_the_newcomer(self):
        """A kicks its own session; B takes the path in the gap; B must be the one stopped."""
        fake, state = self._mediamtx_sequence(lookups=["tab-a", "tab-b"], kick_results=[404, 200])

        with mock.patch.object(mediasrc.urllib.request, "urlopen", fake):
            self.assertEqual(mediasrc.kick_webcam_publisher(1), "tab-b", "reports the session it actually kicked")

        self.assertEqual(state["kick"], 2)

    def test_a_path_that_keeps_changing_hands_is_reported_unconfirmed(self):
        fake, _ = self._mediamtx_sequence(lookups=["s1", "s2", "s3", "s4"], kick_results=[404])

        with mock.patch.object(mediasrc.urllib.request, "urlopen", fake):
            with self.assertRaises(mediasrc.WebcamPublisherUnconfirmed):
                mediasrc.kick_webcam_publisher(1)

    def test_kick_raises_on_an_unreachable_api_rather_than_reading_as_idle(self):
        """Raising is what stops a caller mistaking "could not tell" for "nothing there"."""
        urlopen = mock.Mock(side_effect=mediasrc.urllib.error.URLError("refused"))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.kick_webcam_publisher(1)

    def test_kick_raises_when_the_kick_itself_is_refused(self):
        def fake_urlopen(request, timeout=None):
            if "/v3/paths/get/" in request.full_url:
                payload = {"name": "src1", "ready": True,
                           "source": {"type": "webRTCSession", "id": "abc-123"}}
                response = mock.MagicMock()
                response.__enter__.return_value = io.BytesIO(json.dumps(payload).encode("utf-8"))
                return response
            raise mediasrc.urllib.error.URLError("kick refused")

        with mock.patch.object(mediasrc.urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.kick_webcam_publisher(1)

    def test_raises_when_the_api_returns_garbage(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b"not json")
        urlopen = mock.Mock(return_value=response)

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            with self.assertRaises(mediasrc.MediaServerUnreachable):
                mediasrc.webcam_is_publishing(1)


class WebcamNormalizationTests(unittest.TestCase):
    """A browser webcam is normalized so detection apps can consume it (#120).

    A browser's WebRTC stream has sparse keyframes and a negotiated H.264
    profile the board's hardware decoder and rtspsrc cannot read. So the browser
    publishes to a cam{N} ingest path and MediaMTX transcodes it to baseline
    H.264 with regular keyframes on the src{N} consumer path — the same shape a
    file source's ffmpeg already produces — leaving src{N} the only path the
    viewer and apps ever read.
    """

    def test_webcam_path_name_is_the_ingest_path_not_the_consumer_path(self):
        self.assertEqual(mediasrc.webcam_path_name(1), "cam1")
        self.assertEqual(mediasrc.webcam_path_name(12), "cam12")

    def test_mediamtx_config_normalizes_cam_ingest_onto_the_src_consumer_path(self):
        cfg = Path(__file__).resolve().parent.parent / "webrtc" / "mediamtx.yml"
        text = cfg.read_text(encoding="utf-8")
        # A bounded cam{N} ingest path runs a normalizer on ready.
        self.assertIn('"~^cam(', text)
        self.assertIn("runOnReady:", text)
        self.assertIn("runOnReadyRestart: yes", text)
        # It reads the ingest path and writes the src{N} consumer path.
        self.assertIn("rtsp://127.0.0.1:8554/$MTX_PATH", text)
        self.assertIn("rtsp://127.0.0.1:8554/src$G1", text)
        # Baseline H.264 + a keyframe every second: what the decoder needs and
        # what a raw browser stream lacks (the two fixes proven on the DevKit).
        self.assertIn("-profile:v baseline", text)
        self.assertIn("-g 30", text)
        self.assertIn("-keyint_min 30", text)


if __name__ == "__main__":
    unittest.main()
