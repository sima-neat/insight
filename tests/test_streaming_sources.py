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
        self.assertEqual(source["urls"]["whip"], "https://localhost:8889/src1/whip")

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
            "https://localhost:18889/src1/whip",
        )

    def test_webcam_whip_url_falls_back_to_the_default_port(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]):
            response = self._assign_webcam(1)

        self.assertEqual(
            response.get_json()["source"]["urls"]["whip"],
            "https://localhost:8889/src1/whip",
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

        with mock.patch.object(app_module, "webcam_is_publishing", return_value=False):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()[0]["state"], "stopped")
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")

    def test_a_still_publishing_webcam_stays_live_across_a_reload(self):
        self.sources_file.write_text(
            '[{"index": 1, "file": "", "state": "playing", "type": "webcam"}]',
            encoding="utf-8",
        )

        with mock.patch.object(app_module, "webcam_is_publishing", return_value=True):
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

        with mock.patch.object(app_module, "webcam_is_publishing", return_value=False):
            response = self.client.get("/api/mediasrc", headers={"Host": "localhost:9900"})

        self.assertEqual(response.get_json()[0]["state"], "stopped")

    def test_assigning_a_file_over_a_webcam_restores_the_file_type(self):
        (self.media_dir / "clip.mp4").write_bytes(b"not-a-real-video")
        self._assign_webcam(1)

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

        with mock.patch.object(app_module, "_media_video_codec", return_value="h264"):
            response = self.client.post("/api/mediasrc/auto-assign-all")

        self.assertEqual(response.status_code, 200)
        source = app_module.load_sources()[0]
        self.assertEqual(source["type"], "file")
        self.assertEqual(source["file"], "clip.mp4", "the assignment must survive a reload")

    def test_stop_kicks_the_browser_publishing_to_the_slot(self):
        """Stop must mean stopped for any caller, not just the tab that owns the peer connection."""
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
            response = self.client.post("/api/mediasrc/stop", json={"index": 1})

        self.assertEqual(response.status_code, 200)
        kick.assert_called_once_with(1)

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

    def test_switching_cameras_kicks_the_previous_publisher(self):
        self._assign_webcam(1)

        with mock.patch.object(app_module, "kick_webcam_publisher") as kick:
            self._assign_webcam(1)

        kick.assert_called_once_with(1)

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
        self.assertEqual(urls["whip"], "https://[fd00::23]:8889/src1/whip")
        self.assertEqual(urls["rtsp"], "rtsp://[fd00::23]:8554/src1")

    def test_a_named_host_is_left_alone(self):
        self.client.post("/api/mediasrc/assign-webcam", json={"index": 1},
                         headers={"Host": "insight.local:9900"})
        response = self.client.get("/api/mediasrc", headers={"Host": "insight.local:9900"})

        urls = response.get_json()[0]["urls"]
        self.assertEqual(urls["whip"], "https://insight.local:8889/src1/whip")
        self.assertEqual(urls["rtsp"], "rtsp://insight.local:8554/src1")

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
        self.assertIn("/v3/paths/get/src1", request.full_url)
        self.assertEqual(request.get_method(), "GET")

    def test_reports_not_publishing_when_the_path_is_not_ready(self):
        urlopen = self._urlopen_returning({"name": "src1", "ready": False})

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.webcam_is_publishing(1))

    def test_reports_not_publishing_when_the_api_is_unreachable(self):
        """MediaMTX may not be up yet; that must read as "not live", not crash."""
        urlopen = mock.Mock(side_effect=mediasrc.urllib.error.URLError("refused"))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.webcam_is_publishing(1))

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

    def test_kick_survives_an_unreachable_api(self):
        urlopen = mock.Mock(side_effect=mediasrc.urllib.error.URLError("refused"))

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.kick_webcam_publisher(1))

    def test_reports_not_publishing_when_the_api_returns_garbage(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b"not json")
        urlopen = mock.Mock(return_value=response)

        with mock.patch.object(mediasrc.urllib.request, "urlopen", urlopen):
            self.assertFalse(mediasrc.webcam_is_publishing(1))


if __name__ == "__main__":
    unittest.main()
