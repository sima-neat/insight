import json
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import renditions

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
if os.environ.get("NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS") and not HAVE_FFMPEG:
    raise RuntimeError("ffmpeg and ffprobe are required for tests.test_fps_renditions (NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS is set)")


class FpsRuleTests(unittest.TestCase):
    def test_coerce_fps_accepts_integers_and_numeric_strings(self):
        self.assertEqual(renditions.coerce_fps(30), 30)
        self.assertEqual(renditions.coerce_fps("15"), 15)
        self.assertEqual(renditions.coerce_fps(60.0), 60)
        self.assertEqual(renditions.coerce_fps(240), 240)
        self.assertEqual(renditions.coerce_fps(1), 1)

    def test_coerce_fps_rejects_invalid_values(self):
        for value in (None, "", "abc", 0, -5, 2.5, "29.97", 241, True, [30]):
            with self.subTest(value=value):
                self.assertIsNone(renditions.coerce_fps(value))

    def test_validate_fps_raises_with_range_message(self):
        with self.assertRaises(ValueError) as ctx:
            renditions.validate_fps(0)
        self.assertIn("between 1 and 240", str(ctx.exception))
        self.assertEqual(renditions.validate_fps("25"), 25)

    def test_detect_fps_rounds_avg_frame_rate_and_falls_back(self):
        self.assertEqual(renditions.detect_fps({"avg_frame_rate": "30000/1001", "r_frame_rate": "30/1"}), 30)
        self.assertEqual(renditions.detect_fps({"avg_frame_rate": "0/0", "r_frame_rate": "25/1"}), 25)
        self.assertIsNone(renditions.detect_fps({"avg_frame_rate": "0/0", "r_frame_rate": "0/0"}))
        self.assertIsNone(renditions.detect_fps({}))

    def test_level_and_bitrate_follow_catalog_rules(self):
        self.assertEqual(renditions.video_level("h264", 720, 30), "3.1")
        self.assertEqual(renditions.video_level("h264", 720, 60), "3.2")
        self.assertEqual(renditions.video_level("h265", 720, 60), "4.0")
        self.assertEqual(renditions.video_level("h264", 1080, 120), "5.1")
        self.assertEqual(renditions.video_level("h264", 240, 15), "3.0")
        self.assertEqual(renditions.expected_level_code("h264", 720, 30), 31)
        self.assertEqual(renditions.expected_level_code("h265", 720, 30), 93)
        self.assertEqual(renditions.video_bitrate(720, 15), "2M")
        self.assertEqual(renditions.video_bitrate(720, 30), "5M")
        self.assertEqual(renditions.video_bitrate(1080, 30), "12M")
        self.assertEqual(renditions.video_bitrate(240, 30), "3M")

    def test_rendition_key_and_path(self):
        sha = "3a9fc2" + "0" * 58
        self.assertEqual(renditions.rendition_key(sha, 15, "h264"), f"{sha}:15:h264:baseline")
        self.assertEqual(renditions.rendition_key(sha, 15, "h265"), f"{sha}:15:h265:main")
        self.assertEqual(
            renditions.rendition_rel_path("clips/demo.mp4", sha, 15, "h264"),
            ".renditions/demo_3a9fc2_15fps_h264.mp4",
        )

    def test_encode_command_h264_matches_catalog_contract(self):
        cmd = renditions.encode_command(Path("/m/demo.mp4"), Path("/m/.renditions/.x.tmp.mp4"), 15, "h264", 720)
        joined = " ".join(cmd)
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertIn("-vf setpts=PTS-STARTPTS,fps=15", joined)
        self.assertIn("-fps_mode cfr", joined)
        self.assertIn("-c:v libx264", joined)
        self.assertIn("-profile:v baseline", joined)
        self.assertIn("-level:v 3.1", joined)
        self.assertIn("-refs 1", joined)
        self.assertIn("-sc_threshold 0", joined)
        self.assertIn("-pix_fmt yuv420p", joined)
        self.assertIn("-g 15 -keyint_min 15 -bf 0 -flags +cgop", joined)
        self.assertIn("-b:v 2M -maxrate 2M -bufsize 2M", joined)
        self.assertIn("-x264-params repeat-headers=1:force-cfr=1:open-gop=0", joined)
        self.assertIn("-tag:v avc1", joined)
        self.assertIn("h264_metadata=aud=insert:tick_rate=30/1", joined)
        self.assertIn("-movflags +faststart", joined)
        self.assertIn("-progress pipe:1", joined)
        self.assertEqual(cmd[-1], "/m/.renditions/.x.tmp.mp4")

    def test_encode_command_h265_matches_catalog_contract(self):
        cmd = renditions.encode_command(Path("/m/demo.mp4"), Path("/m/out.mp4"), 60, "h265", 720)
        joined = " ".join(cmd)
        self.assertIn("-c:v libx265", joined)
        self.assertIn("-profile:v main", joined)
        self.assertIn("-level:v 4.0", joined)
        self.assertIn("-tag:v hvc1", joined)
        self.assertIn("keyint=60:min-keyint=60:scenecut=0:bframes=0:ref=1:open-gop=0", joined)
        self.assertIn("hevc_metadata=aud=insert:tick_rate=60/1", joined)

    def test_encode_command_rejects_mjpeg(self):
        with self.assertRaises(ValueError):
            renditions.encode_command(Path("/m/a.mp4"), Path("/m/b.mp4"), 15, "mjpeg", 720)

    def test_parse_progress_seconds(self):
        self.assertEqual(renditions.parse_progress_seconds("out_time_us", "2500000"), 2.5)
        self.assertEqual(renditions.parse_progress_seconds("out_time", "00:01:02.5"), 62.5)
        self.assertIsNone(renditions.parse_progress_seconds("frame", "12"))
        self.assertIsNone(renditions.parse_progress_seconds("out_time", "garbage"))


class RenditionIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.index_path = self.root / "renditions.json"

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_load_index_returns_empty_index_for_missing_or_corrupt_file(self):
        self.assertEqual(renditions.load_index(self.index_path), {"schema": renditions.INDEX_SCHEMA, "sources": {}, "renditions": []})
        self.index_path.write_text("{not json", encoding="utf-8")
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])
        self.index_path.write_text(json.dumps({"schema": "other", "renditions": [{"key": "x"}]}), encoding="utf-8")
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_save_index_writes_atomically_with_trailing_newline(self):
        renditions.save_index(self.index_path, {"schema": renditions.INDEX_SCHEMA, "sources": {}, "renditions": []})
        text = self.index_path.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(json.loads(text)["schema"], renditions.INDEX_SCHEMA)
        self.assertFalse(self.index_path.with_name(".renditions.json.tmp").exists())

    def test_source_hash_is_cached_by_size_and_mtime(self):
        source = self.media_dir / "demo.mp4"
        source.write_bytes(b"first content")
        first = renditions.source_hash(self.index_path, self.media_dir, "demo.mp4")
        self.assertEqual(first, renditions.sha256_file(source))

        with mock.patch.object(renditions, "sha256_file", side_effect=AssertionError("must not re-hash")):
            self.assertEqual(renditions.source_hash(self.index_path, self.media_dir, "demo.mp4"), first)

        source.write_bytes(b"second content!")  # different size and mtime
        second = renditions.source_hash(self.index_path, self.media_dir, "demo.mp4")
        self.assertNotEqual(first, second)
        entry = renditions.load_index(self.index_path)["sources"]["demo.mp4"]
        self.assertEqual(entry["sha256"], second)
        self.assertEqual(entry["size"], source.stat().st_size)
        self.assertEqual(entry["mtime_ns"], source.stat().st_mtime_ns)

    def test_source_info_probes_once_and_caches_native_fps(self):
        source = self.media_dir / "demo.mp4"
        source.write_bytes(b"x")
        stream = {"avg_frame_rate": "30/1", "r_frame_rate": "30/1", "width": 320, "height": 240, "duration": "2.000000"}
        with mock.patch.object(renditions, "probe_video", return_value=stream) as probe:
            info = renditions.source_info(self.index_path, self.media_dir, "demo.mp4")
            again = renditions.source_info(self.index_path, self.media_dir, "demo.mp4")
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(info["native_fps"], 30)
        self.assertEqual(info["height"], 240)
        self.assertEqual(info["duration"], 2.0)
        self.assertEqual(again, info)

    def test_find_rendition_prunes_records_whose_file_is_gone(self):
        (self.media_dir / ".renditions").mkdir()
        present = self.media_dir / ".renditions" / "a.mp4"
        present.write_bytes(b"a")
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/a.mp4", "source_file": "a.mp4"})
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/missing.mp4", "source_file": "b.mp4"})

        self.assertEqual(renditions.find_rendition(self.index_path, self.media_dir, "k1")["path"], ".renditions/a.mp4")
        self.assertIsNone(renditions.find_rendition(self.index_path, self.media_dir, "k2"))
        self.assertEqual([r["key"] for r in renditions.load_index(self.index_path)["renditions"]], ["k1"])

    def test_add_rendition_replaces_same_key(self):
        renditions.add_rendition(self.index_path, {"key": "k", "path": "old"})
        renditions.add_rendition(self.index_path, {"key": "k", "path": "new"})
        records = renditions.load_index(self.index_path)["renditions"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["path"], "new")

    def test_remove_source_deletes_rendition_files_and_records(self):
        (self.media_dir / ".renditions").mkdir()
        target = self.media_dir / ".renditions" / "demo_15.mp4"
        target.write_bytes(b"r")
        other = self.media_dir / ".renditions" / "other.mp4"
        other.write_bytes(b"o")
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/demo_15.mp4", "source_file": "demo.mp4"})
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/other.mp4", "source_file": "other.mp4"})
        (self.media_dir / "demo.mp4").write_bytes(b"d")
        renditions.source_hash(self.index_path, self.media_dir, "demo.mp4")

        removed = renditions.remove_source(self.index_path, self.media_dir, "demo.mp4")

        self.assertEqual(removed, [".renditions/demo_15.mp4"])
        self.assertFalse(target.exists())
        self.assertTrue(other.exists())
        index = renditions.load_index(self.index_path)
        self.assertNotIn("demo.mp4", index["sources"])
        self.assertEqual([r["key"] for r in index["renditions"]], ["k2"])

    def test_remove_source_drops_records_without_a_path(self):
        renditions.add_rendition(self.index_path, {"key": "k1", "source_file": "demo.mp4"})
        renditions.add_rendition(self.index_path, {"key": "k2", "source_file": "other.mp4", "path": ".renditions/other.mp4"})
        self.assertEqual(renditions.remove_source(self.index_path, self.media_dir, "demo.mp4"), [])
        self.assertEqual([r["key"] for r in renditions.load_index(self.index_path)["renditions"]], ["k2"])


if __name__ == "__main__":
    unittest.main()
