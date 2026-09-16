import json
import os
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module
from neat_insight import mediasrc
from neat_insight.mediamtx import PathInfo


class FakeMediamtx:
    def __init__(self):
        self.paths = {}
        self.available = True
        self.kicked = []

    def snapshot(self):
        return dict(self.paths) if self.available else None

    def external_info(self, path):
        return {"protocol": path.protocol, "address": path.address, "since": path.since,
                "codec_supported": path.codec in {"h264", "h265", "mjpeg"},
                "width": None, "height": None, "fps": None, "bitrate_bps": None}

    def kick(self, source_type, session_id):
        self.kicked.append((source_type, session_id))
        self.paths = {name: p for name, p in self.paths.items() if p.source_id != session_id}


def external_path(index, codec="h264", protocol="rtsp", source_type="rtspSession", readers=None):
    return PathInfo(name=f"src{index}", ready=True, since="2026-09-16T13:09:59Z", source_type=source_type,
                    source_id=f"ext-{index}", protocol=protocol, address="172.19.0.1", query="",
                    codec=codec, bytes_received=10, readers=readers or [])


def insight_path(index, readers=None):
    return PathInfo(name=f"src{index}", ready=True, since="2026-09-16T13:00:00Z", source_type="rtspSession",
                    source_id=f"own-{index}", protocol="rtsp", address="127.0.0.1", query="publisher=insight",
                    codec="h264", bytes_received=10, readers=readers or [])


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
        self.mtx = FakeMediamtx()
        self._mtx_patch = mock.patch.object(app_module, "mediamtx_client", self.mtx)
        self._mtx_patch.start()

    def tearDown(self):
        self._mtx_patch.stop()
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

    def test_preview_command_uses_keyframes_below_5fps(self):
        slow = mediasrc.preview_command("rtsp://127.0.0.1:8554/src2?reader=insight-preview", 1.0)
        fast = mediasrc.preview_command("rtsp://127.0.0.1:8554/src2?reader=insight-preview", 5.0)
        self.assertIn("nokey", slow)
        self.assertNotIn("nokey", fast)
        self.assertEqual(slow[slow.index("-vf") + 1], "fps=1,scale=min(640\\,iw):-2")
        self.assertEqual(fast[fast.index("-vf") + 1], "fps=5,scale=min(640\\,iw):-2")
        self.assertIn("mpjpeg", fast)

    def test_preview_route_validation(self):
        self.assertEqual(self.client.get("/stream/preview/src2.mjpg?fps=2").status_code, 400)
        self.assertEqual(self.client.get("/stream/preview/src999.mjpg?fps=1").status_code, 404)
        self.assertEqual(self.client.get("/stream/preview/src2.mjpg?fps=1").status_code, 409)
        self.mtx.paths["src2"] = external_path(2)
        with mock.patch.object(app_module.shutil, "which", return_value=None):
            self.assertEqual(self.client.get("/stream/preview/src2.mjpg?fps=1").status_code, 503)
        with mock.patch.object(app_module, "PREVIEW_MAX_STREAMS", 0):
            self.assertEqual(self.client.get("/stream/preview/src2.mjpg?fps=1").status_code, 429)

    def test_preview_route_streams_and_releases_slot(self):
        self.mtx.paths["src2"] = external_path(2)
        process = mock.Mock()
        process.stdout.read.side_effect = [b"--frame\r\njpeg", b""]
        process.poll.return_value = 0
        with mock.patch.object(app_module.shutil, "which", return_value="/usr/bin/ffmpeg"):
            with mock.patch.object(app_module.subprocess, "Popen", return_value=process) as popen:
                response = self.client.get("/stream/preview/src2.mjpg?fps=0.5")
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
                response = self.client.get("/stream/preview/src2.mjpg?fps=5")
        _ = response.data  # drain the generator so the finally block runs
        process.terminate.assert_called_once()
        process.wait.assert_called_once()
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
        self.assertEqual(popen.call_args.args[0][-1], "rtsp://127.0.0.1:8554/src1?publisher=insight")

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

    def test_stop_all_and_reset_report_skipped_external(self):
        self.mtx.paths["src2"] = external_path(2)
        self.assertEqual(self.client.post("/api/mediasrc/stop-all").get_json()["skipped_external"], [2])
        self.assertEqual(self.client.post("/api/mediasrc/reset").get_json()["skipped_external"], [2])
        self.assertEqual(self.mtx.kicked, [])

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


if __name__ == "__main__":
    unittest.main()
