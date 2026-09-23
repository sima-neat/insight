import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module
from neat_insight import mediasrc
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

    def test_level_matches_catalog_grid(self):
        # The catalog's fixed resolution/fps grid keeps the levels it always had.
        self.assertEqual(renditions.video_level("h264", 1280, 720, 30), "3.1")
        self.assertEqual(renditions.video_level("h264", 1280, 720, 60), "3.2")
        self.assertEqual(renditions.video_level("h265", 1280, 720, 60), "4.0")
        self.assertEqual(renditions.video_level("h264", 1920, 1080, 30), "4.0")
        self.assertEqual(renditions.video_level("h264", 1920, 1080, 120), "5.1")
        self.assertEqual(renditions.video_level("h265", 1920, 1080, 120), "5.0")
        self.assertEqual(renditions.video_level("h264", 3840, 2160, 30), "5.1")
        # Codex review: HEVC Main tier level 5.0 caps the bitrate at 25 Mbps; a 4K rendition is
        # encoded at 35 Mbps, so it needs 5.1 like the catalog builder always assigned.
        self.assertEqual(renditions.video_level("h265", 3840, 2160, 30), "5.1")
        self.assertEqual(renditions.video_level("h265", 1920, 1080, 30), "4.0")  # 12 Mbps fits 4.0 exactly
        self.assertEqual(renditions.video_level("h264", 854, 480, 30), "3.1")
        self.assertEqual(renditions.video_level("h265", 854, 480, 30), "3.0")
        self.assertEqual(renditions.video_level("h264", 426, 240, 15), "3.0")
        self.assertEqual(renditions.expected_level_code("h264", 1280, 720, 30), 31)
        self.assertEqual(renditions.expected_level_code("h265", 1280, 720, 30), 93)

    def test_level_grows_with_frame_rate_and_frame_size(self):
        # Codex review: a level must cover the macroblock (H.264) or luma-sample (H.265)
        # rate of the requested fps, not just the resolution tier.
        self.assertEqual(renditions.video_level("h264", 1280, 720, 61), "4.0")
        self.assertEqual(renditions.video_level("h264", 1280, 720, 120), "4.2")
        self.assertEqual(renditions.video_level("h264", 1280, 720, 240), "5.1")
        self.assertEqual(renditions.video_level("h264", 1920, 1080, 60), "4.2")
        self.assertEqual(renditions.video_level("h264", 1920, 1080, 240), "5.2")
        self.assertEqual(renditions.video_level("h264", 3840, 2160, 60), "5.2")
        self.assertEqual(renditions.video_level("h264", 3840, 2160, 240), "6.1")
        self.assertEqual(renditions.video_level("h265", 1280, 720, 240), "5.0")
        self.assertEqual(renditions.video_level("h265", 3840, 2160, 240), "6.1")
        # 4:3 content is judged by its real width, not a 16:9 assumption.
        self.assertEqual(renditions.video_level("h264", 640, 480, 60), "3.1")
        # Per-axis bound (Annex A: width and height each <= sqrt(8 * max picture size)).
        # 7680x432 fits level 5.0 by area and throughput but is 480 macroblocks wide; 5.0 allows 420.
        self.assertEqual(renditions.video_level("h264", 7680, 432, 30), "5.1")
        # 8448x432 fits H.265 level 5.0 by area but exceeds its 8444-sample width bound.
        self.assertEqual(renditions.video_level("h265", 8448, 432, 30), "6.0")
        with self.assertRaises(renditions.UnsupportedRendition):
            renditions.video_level("h264", 7680, 4320, 240)
        with self.assertRaises(renditions.UnsupportedRendition):
            renditions.video_level("h265", 7680, 4320, 240)

    def test_bitrate_follows_catalog_rules(self):
        self.assertEqual(renditions.video_bitrate(720, 15), "2M")
        self.assertEqual(renditions.video_bitrate(720, 30), "5M")
        self.assertEqual(renditions.video_bitrate(1080, 30), "12M")
        self.assertEqual(renditions.video_bitrate(240, 30), "3M")

    def test_rendition_key_and_path(self):
        sha = "3a9fc2" + "0" * 58
        self.assertEqual(renditions.rendition_key(sha, 15, "h264"), f"{sha}:15:h264:baseline")
        self.assertEqual(renditions.rendition_key(sha, 15, "h265"), f"{sha}:15:h265:main")
        # Codex review: 16 hex digits (64 bits) of the digest, so two different sources with the same
        # stem, fps and codec cannot plausibly map to one output path.
        self.assertEqual(
            renditions.rendition_rel_path("clips/demo.mp4", sha, 15, "h264"),
            ".renditions/demo_3a9fc20000000000_15fps_h264.mp4",
        )

    def test_encode_command_h264_matches_catalog_contract(self):
        cmd = renditions.encode_command(Path("/m/demo.mp4"), Path("/m/.renditions/.x.tmp.mp4"), 15, "h264", 1280, 720)
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
        cmd = renditions.encode_command(Path("/m/demo.mp4"), Path("/m/out.mp4"), 60, "h265", 1280, 720)
        joined = " ".join(cmd)
        self.assertIn("-c:v libx265", joined)
        self.assertIn("-profile:v main", joined)
        self.assertIn("-level:v 4.0", joined)
        self.assertIn("-tag:v hvc1", joined)
        self.assertIn("keyint=60:min-keyint=60:scenecut=0:bframes=0:ref=1:open-gop=0", joined)
        self.assertIn("hevc_metadata=aud=insert:tick_rate=60/1", joined)

    def test_encode_command_rejects_mjpeg(self):
        with self.assertRaises(ValueError):
            renditions.encode_command(Path("/m/a.mp4"), Path("/m/b.mp4"), 15, "mjpeg", 1280, 720)

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
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/a.mp4", "source_file": "a.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/missing.mp4", "source_file": "b.mp4"}, self.media_dir)

        self.assertEqual(renditions.find_rendition(self.index_path, self.media_dir, "k1")["path"], ".renditions/a.mp4")
        self.assertIsNone(renditions.find_rendition(self.index_path, self.media_dir, "k2"))
        self.assertEqual([r["key"] for r in renditions.load_index(self.index_path)["renditions"]], ["k1"])

    def test_add_rendition_replaces_same_key(self):
        renditions.add_rendition(self.index_path, {"key": "k", "path": "old"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k", "path": "new"}, self.media_dir)
        records = renditions.load_index(self.index_path)["renditions"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["path"], "new")

    def test_remove_source_deletes_rendition_files_and_records(self):
        (self.media_dir / ".renditions").mkdir()
        target = self.media_dir / ".renditions" / "demo_15.mp4"
        target.write_bytes(b"r")
        other = self.media_dir / ".renditions" / "other.mp4"
        other.write_bytes(b"o")
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/demo_15.mp4", "source_file": "demo.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/other.mp4", "source_file": "other.mp4"}, self.media_dir)
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
        renditions.add_rendition(self.index_path, {"key": "k1", "source_file": "demo.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k2", "source_file": "other.mp4", "path": ".renditions/other.mp4"}, self.media_dir)
        self.assertEqual(renditions.remove_source(self.index_path, self.media_dir, "demo.mp4"), [])
        self.assertEqual([r["key"] for r in renditions.load_index(self.index_path)["renditions"]], ["k2"])

    def test_rendition_usage_counts_existing_files(self):
        (self.media_dir / ".renditions").mkdir()
        present = self.media_dir / ".renditions" / "a.mp4"
        present.write_bytes(b"hello world")
        # k1 has no "bytes" field, so rendition_usage must fall back to stat().st_size.
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/a.mp4", "source_file": "a.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/missing.mp4", "source_file": "b.mp4", "bytes": 999}, self.media_dir)

        count, total_bytes = renditions.rendition_usage(self.index_path, self.media_dir)

        self.assertEqual(count, 1)
        self.assertEqual(total_bytes, present.stat().st_size)
        # The record for the missing file is pruned, same as find_rendition.
        self.assertEqual([r["key"] for r in renditions.load_index(self.index_path)["renditions"]], ["k1"])

    def test_clear_renditions_deletes_all_but_kept(self):
        rend_dir = self.media_dir / ".renditions"
        rend_dir.mkdir()
        a = rend_dir / "a.mp4"
        a.write_bytes(b"aaaa")
        b = rend_dir / "b.mp4"
        b.write_bytes(b"bbbbbb")
        c = rend_dir / "c.mp4"
        c.write_bytes(b"cccccccc")
        renditions.add_rendition(self.index_path, {"key": "k1", "path": ".renditions/a.mp4", "source_file": "x.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k2", "path": ".renditions/b.mp4", "source_file": "x.mp4"}, self.media_dir)
        renditions.add_rendition(self.index_path, {"key": "k3", "path": ".renditions/c.mp4", "source_file": "y.mp4"}, self.media_dir)
        (self.media_dir / "x.mp4").write_bytes(b"src")
        renditions.source_hash(self.index_path, self.media_dir, "x.mp4")  # populate the sources cache

        removed, freed = renditions.clear_renditions(self.index_path, self.media_dir, keep={".renditions/b.mp4"})

        self.assertEqual(removed, [".renditions/a.mp4", ".renditions/c.mp4"])
        self.assertEqual(freed, len(b"aaaa") + len(b"cccccccc"))
        self.assertFalse(a.exists())
        self.assertTrue(b.exists())
        self.assertFalse(c.exists())
        index = renditions.load_index(self.index_path)
        self.assertEqual([r["key"] for r in index["renditions"]], ["k2"])
        self.assertIn("x.mp4", index["sources"])  # the sources probe/hash cache is left untouched


def make_test_clip(path: Path, fps: int = 30, seconds: float = 2.0, codec: str = "libx264") -> None:
    """Generate a small synthetic H.264 (or other) clip with ffmpeg's testsrc."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=size=320x240:rate={fps}",
            "-t", str(seconds), "-c:v", codec, "-pix_fmt", "yuv420p", "-g", str(fps),
            str(path),
        ],
        check=True,
    )


def ffprobe_stream(path: Path) -> dict:
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,profile,pix_fmt,has_b_frames,r_frame_rate,avg_frame_rate,width,height",
            "-of", "json", str(path),
        ],
        text=True,
    )
    return json.loads(out)["streams"][0]


def drain(generator):
    events = list(generator)
    return events, events[-1]


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class RenditionEncodeTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.index_path = self.root / "renditions.json"
        self.source = self.media_dir / "demo.mp4"
        make_test_clip(self.source, fps=30, seconds=2.0)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_native_fps_streams_the_source_without_encoding(self):
        with mock.patch.object(renditions, "encode_command", side_effect=AssertionError("must not encode")):
            events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 30, "h264"))
        self.assertEqual(done["event"], "done")
        self.assertTrue(done["native"])
        self.assertIsNone(done["rendition"])
        self.assertEqual(Path(done["path"]), self.source)

    def test_encodes_rendition_that_meets_the_catalog_contract(self):
        events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))

        self.assertEqual([e["event"] for e in events][0], "encoding")
        self.assertEqual(events[0]["encoder"], "libx264 baseline")
        self.assertFalse(done["reused"])
        self.assertEqual(done["rendition"], ".renditions/demo_" + renditions.sha256_file(self.source)[:16] + "_15fps_h264.mp4")
        output = Path(done["path"])
        self.assertTrue(output.is_file())
        self.assertFalse(any(p.name.startswith(".") and p.name.endswith(".tmp.mp4") for p in output.parent.iterdir()))

        stream = ffprobe_stream(output)
        self.assertEqual(stream["codec_name"], "h264")
        self.assertEqual(stream["profile"], "Constrained Baseline")
        self.assertEqual(stream["pix_fmt"], "yuv420p")
        self.assertEqual(stream["has_b_frames"], 0)
        self.assertEqual(stream["r_frame_rate"], "15/1")
        self.assertEqual(stream["avg_frame_rate"], "15/1")
        self.assertEqual(renditions.probe_reference_frames(output), 1)
        keyframes = [i for i, (_pts, _dts, key) in enumerate(renditions.probe_packets(output)) if key]
        self.assertEqual(keyframes, [0, 15])

        record = renditions.load_index(self.index_path)["renditions"][0]
        self.assertEqual(record["fps"], 15)
        self.assertEqual(record["codec"], "h264")
        self.assertEqual(record["profile"], "baseline")
        self.assertEqual(record["source_file"], "demo.mp4")
        self.assertEqual(record["source_sha256"], renditions.sha256_file(self.source))
        self.assertEqual(record["path"], done["rendition"])
        self.assertEqual(record["height"], 240)

    def test_second_call_reuses_without_running_the_encoder(self):
        _events, first = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        with mock.patch.object(renditions, "encode_command", side_effect=AssertionError("must not encode")):
            events, second = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        self.assertTrue(second["reused"])
        self.assertEqual(second["path"], first["path"])
        self.assertEqual(len(events), 1)

    def test_replacing_source_content_creates_a_new_rendition(self):
        _events, first = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        make_test_clip(self.source, fps=30, seconds=3.0)  # same name, new content

        _events, second = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))

        self.assertFalse(second["reused"])
        self.assertNotEqual(first["path"], second["path"])
        # The orphaned rendition of the replaced source is pruned with its file.
        self.assertFalse(Path(first["path"]).exists())
        records = renditions.load_index(self.index_path)["renditions"]
        self.assertEqual([r["path"] for r in records if r["source_file"] == "demo.mp4"], [second["rendition"]])
        self.assertEqual(len(records), 1)

    def test_encodes_h265_rendition_that_meets_the_catalog_contract(self):
        make_test_clip(self.media_dir / "hevc.mp4", fps=30, seconds=2.0, codec="libx265")

        _events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "hevc.mp4", 15, "h265"))

        output = Path(done["path"])
        stream = ffprobe_stream(output)
        self.assertEqual(stream["codec_name"], "hevc")
        self.assertEqual(stream["profile"], "Main")
        self.assertEqual(stream["pix_fmt"], "yuv420p")
        self.assertEqual(stream["has_b_frames"], 0)
        self.assertEqual(stream["avg_frame_rate"], "15/1")
        self.assertEqual(renditions.probe_reference_frames(output), 1)
        record = next(r for r in renditions.load_index(self.index_path)["renditions"] if r["source_file"] == "hevc.mp4")
        self.assertEqual(record["codec"], "h265")
        self.assertEqual(record["profile"], "main")

    def test_upsampling_duplicates_frames(self):
        _events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 60, "h264"))
        stream = ffprobe_stream(Path(done["path"]))
        self.assertEqual(stream["avg_frame_rate"], "60/1")

    def test_mjpeg_and_unknown_codecs_are_unsupported(self):
        with self.assertRaises(renditions.UnsupportedRendition):
            drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "mjpeg"))
        with self.assertRaises(renditions.UnsupportedRendition):
            drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, None))

    def test_encoder_failure_cleans_up_and_leaves_source_and_index_untouched(self):
        source_bytes = self.source.read_bytes()

        def broken_command(source, output, fps, codec, width, height):
            return ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(self.media_dir / "missing.mp4"), "-progress", "pipe:1", "-nostats", str(output)]

        with mock.patch.object(renditions, "encode_command", side_effect=broken_command):
            with self.assertRaises(renditions.RenditionError) as ctx:
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))

        self.assertIn("missing.mp4", str(ctx.exception))  # ffmpeg's diagnostics reach the error message
        self.assertEqual(self.source.read_bytes(), source_bytes)
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])

    def test_validation_failure_removes_output(self):
        with mock.patch.object(renditions, "validate_rendition", side_effect=renditions.RenditionError("bad")):
            with self.assertRaises(renditions.RenditionError):
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_failing_ffprobe_during_validation_raises_rendition_error_and_cleans_up(self):
        # The packet probe is the last validation step; a failure to launch it must surface as a
        # RenditionError. Only that ffprobe invocation is broken; ffmpeg and the stream probe run for real.
        real_popen = subprocess.Popen

        def popen(cmd, *args, **kwargs):
            if Path(cmd[0]).name == "ffprobe" and "packet=pts_time,dts_time,flags" in cmd:
                raise OSError("ffprobe crashed")
            return real_popen(cmd, *args, **kwargs)
        with mock.patch.object(renditions.subprocess, "Popen", side_effect=popen):
            with self.assertRaises(renditions.RenditionError) as ctx:
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        self.assertIn("ffprobe failed", str(ctx.exception))
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_unexpected_validation_failure_also_removes_the_temp_file(self):
        with mock.patch.object(renditions, "validate_rendition", side_effect=KeyboardInterrupt()):
            with self.assertRaises(KeyboardInterrupt):
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_closing_the_generator_terminates_ffmpeg_and_removes_temp(self):
        gen = renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264")
        first = next(gen)
        self.assertEqual(first["event"], "encoding")
        second = next(gen)  # ffmpeg is running now; the first progress block is not throttled
        self.assertEqual(second["event"], "progress")
        gen.close()
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_rendition_is_published_under_the_index_lock(self):
        # Codex review: the final source check, the rename and the record insertion must be
        # one step under the index lock so remove_source cannot slip between them.
        held = []
        real_add = renditions.add_rendition

        def spy(index_path, record, media_dir):
            held.append(lock_is_held(renditions._index_lock))
            return real_add(index_path, record, media_dir)
        with mock.patch.object(renditions, "add_rendition", side_effect=spy):
            drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        self.assertEqual(held, [True])

    def test_failed_index_write_removes_the_published_file(self):
        # Codex review: a rendition renamed into place but never recorded would be invisible to
        # usage and clear, so a failing index write must take the file with it.
        # The probe cache also writes the index earlier, so only the record insertion is broken here.
        with mock.patch.object(renditions, "add_rendition", side_effect=OSError("No space left on device")):
            with self.assertRaises(OSError):
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_source_deleted_during_encoding_is_not_published(self):
        # Codex review: on POSIX ffmpeg keeps reading an unlinked source, so the
        # encode succeeds; the result must not be recorded for a source that is gone.
        gen = renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264")
        self.assertEqual(next(gen)["event"], "encoding")
        self.assertEqual(next(gen)["event"], "progress")  # ffmpeg is running and has the source open
        self.source.unlink()
        with self.assertRaises(renditions.RenditionError) as ctx:
            for _event in gen:
                pass
        self.assertIn("removed", str(ctx.exception))
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_validate_rendition_rejects_wrong_fps(self):
        _events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        with self.assertRaises(renditions.RenditionError) as ctx:
            renditions.validate_rendition(Path(done["path"]), 20, "h264", 426, 240)
        self.assertIn("r_frame_rate", str(ctx.exception))


class MediaStreamRenditionTests(unittest.TestCase):
    def setUp(self):
        from neat_insight import mediasrc
        self.mediasrc = mediasrc
        mediasrc.pipeline_registry.clear()

    def tearDown(self):
        self.mediasrc.pipeline_registry.clear()

    def test_media_stream_file_reports_running_input_and_rendition(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.stderr = None
        with mock.patch.object(self.mediasrc.os.path, "isfile", return_value=True):
            with mock.patch.object(self.mediasrc.subprocess, "Popen", return_value=process):
                ok, err = self.mediasrc.start_media_stream(3, "/m/.renditions/demo_15fps.mp4", "rtsp", "h264", "h264", rendition=".renditions/demo_15fps.mp4")
        self.assertTrue(ok, err)
        self.assertEqual(self.mediasrc.media_stream_file(3), "/m/.renditions/demo_15fps.mp4")
        self.assertEqual(self.mediasrc.pipeline_registry[2].rendition, ".renditions/demo_15fps.mp4")
        self.assertIsNone(self.mediasrc.media_stream_file(4))


class RenditionApiTestCase(unittest.TestCase):
    """Flask test client against a temp media dir; the stream process is mocked, ffmpeg encodes for real."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.sources_file = self.root / "media_sources.json"
        self.sources_file.write_text("[]", encoding="utf-8")
        self.index_path = self.root / "renditions.json"
        self.old = (app_module.MEDIA_DIR, app_module.MEDIA_SRC_DATA_FILE, app_module.RENDITIONS_INDEX_FILE)
        app_module.MEDIA_DIR = self.media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.sources_file
        app_module.RENDITIONS_INDEX_FILE = self.index_path
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        mediasrc.pipeline_registry.clear()

    def tearDown(self):
        mediasrc.pipeline_registry.clear()
        app_module.MEDIA_DIR, app_module.MEDIA_SRC_DATA_FILE, app_module.RENDITIONS_INDEX_FILE = self.old
        self.tmpdir.cleanup()

    def assign(self, index=1, file="demo.mp4", **extra):
        return self.client.post("/api/mediasrc/assign", json={"index": index, "file": file, **extra})

    def source(self, index=1):
        return next(s for s in self.client.get("/api/mediasrc").get_json() if s["index"] == index)


def lock_is_held(lock) -> bool:
    """True when another thread holds `lock` (probed from a helper thread so RLock re-entrancy cannot mask it)."""
    result = []

    def probe():
        got = lock.acquire(blocking=False)
        result.append(not got)
        if got:
            lock.release()

    t = threading.Thread(target=probe)
    t.start()
    t.join()
    return result[0]


class StartPersistenceTests(RenditionApiTestCase):
    """Codex review: a start that encodes for minutes must not save a stale copy of the other slots."""

    def setUp(self):
        super().setUp()
        self.sources_file.write_text(json.dumps([
            {"index": 1, "file": "a.mp4", "state": "stopped", "fps": None},
            {"index": 2, "file": "b.mp4", "state": "stopped", "fps": None},
        ]), encoding="utf-8")
        self.seen = []

    def fake_start(self, src, generation=None):
        # While slot 1 "encodes", another request changes slot 2.
        self.seen.append((src["index"], src.get("file"), src.get("fps")))
        if src["index"] == 1:
            sources = app_module.load_sources()
            other = next(s for s in sources if s["index"] == 2)
            other["file"] = "c.mp4"
            other["fps"] = 20
            app_module.save_sources(sources)
        src["state"] = "playing"
        app_module._persist_slot(src)  # the real starter persists its own slot
        return True, None, 200

    def persisted(self):
        return {s["index"]: s for s in app_module.load_sources()}

    def test_bulk_start_keeps_edits_made_while_encoding_and_starts_the_fresh_slot(self):
        with mock.patch.object(app_module, "_start_source_slot", side_effect=self.fake_start), \
             mock.patch.object(app_module, "media_stream_is_running", return_value=False):
            response = self.client.post("/api/mediasrc/start-bulk", json={"count": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["started"], [1, 2])
        after = self.persisted()
        self.assertEqual(after[1]["state"], "playing")
        self.assertEqual((after[2]["file"], after[2]["fps"], after[2]["state"]), ("c.mp4", 20, "playing"))
        # Slot 2 was started from its current assignment, not the pre-encode snapshot.
        self.assertEqual(self.seen, [(1, "a.mp4", None), (2, "c.mp4", 20)])

    def start_slot_for_real(self, mutate, resolve_error=None, on_stream=None):
        """Run the real _start_source_slot with the encode step replaced by `mutate` (which edits the persisted slot)."""
        def fake_resolve(src):
            mutate()
            if resolve_error:
                return None, None, resolve_error, 500
            return self.media_dir / (src.get("file") or ""), None, None, 200
        stream = mock.Mock(side_effect=on_stream) if on_stream else mock.Mock(return_value=(True, None))
        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_source_media_codec", return_value="h264"), \
             mock.patch.object(app_module, "_resolve_stream_input", side_effect=fake_resolve), \
             mock.patch.object(app_module, "start_media_stream", stream):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        return response, stream

    def edit_slot_one(self, **changes):
        sources = app_module.load_sources()
        next(s for s in sources if s["index"] == 1).update(changes)
        app_module.save_sources(sources)

    def test_start_abandons_a_slot_reassigned_while_encoding(self):
        response, stream = self.start_slot_for_real(lambda: self.edit_slot_one(file="z.mp4", fps=20))
        self.assertEqual(response.status_code, 409)
        self.assertIn("changed", response.get_json()["error"])
        stream.assert_not_called()
        self.assertEqual((self.persisted()[1]["file"], self.persisted()[1]["fps"], self.persisted()[1]["state"]), ("z.mp4", 20, "stopped"))

    def test_start_abandons_a_slot_whose_file_was_deleted_while_encoding(self):
        response, stream = self.start_slot_for_real(lambda: self.edit_slot_one(file=""))
        self.assertEqual(response.status_code, 409)
        stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["file"], "")

    def test_start_abandons_a_slot_stopped_while_encoding(self):
        # Codex review: stop keeps file and fps, so it must be detected another way.
        response, stream = self.start_slot_for_real(lambda: self.client.post("/api/mediasrc/stop", json={"index": 1}))
        self.assertEqual(response.status_code, 409)
        stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["state"], "stopped")

    def test_start_abandons_a_slot_after_stop_all_while_encoding(self):
        response, stream = self.start_slot_for_real(lambda: self.client.post("/api/mediasrc/stop-all"))
        self.assertEqual(response.status_code, 409)
        stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["state"], "stopped")

    def test_failed_start_does_not_restore_a_slot_deleted_while_encoding(self):
        # Codex review: delete-media clears the slot and makes the encode fail; the
        # failure path must not write the pre-encode snapshot (old file name) back.
        def deleted():
            self.edit_slot_one(file="")
            app_module._bump_slot(1)
        response, stream = self.start_slot_for_real(deleted, resolve_error="File not found: a.mp4")
        self.assertEqual(response.status_code, 409)
        stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["file"], "")

    def test_failed_start_still_persists_an_unchanged_slot(self):
        response, _stream = self.start_slot_for_real(lambda: None, resolve_error="ffmpeg exploded")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.persisted()[1]["state"], "stopped")

    def test_slot_lock_is_held_while_the_stream_starts(self):
        # Codex review: the staleness check and the launch must be atomic against stop/assign/delete.
        held = []

        def on_stream(*_args, **_kwargs):
            held.append(lock_is_held(app_module._slot_lock))
            return True, None
        response, _stream = self.start_slot_for_real(lambda: None, on_stream=on_stream)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(held, [True])

    def test_reset_holds_the_slot_lock_while_stopping_streams(self):
        # Codex review: a launch between reset's stop loop and its save would leave an orphan process.
        held = []
        with mock.patch.object(app_module, "stop_media_stream", side_effect=lambda _i: held.append(lock_is_held(app_module._slot_lock))):
            self.assertEqual(self.client.post("/api/mediasrc/reset").status_code, 200)
        self.assertGreaterEqual(len(held), 2)
        self.assertTrue(all(held), held)

    def test_slot_lock_is_held_while_a_slot_is_stopped(self):
        held = []
        with mock.patch.object(app_module, "stop_media_stream", side_effect=lambda _i: held.append(lock_is_held(app_module._slot_lock))):
            self.client.post("/api/mediasrc/stop", json={"index": 1})
            self.client.post("/api/mediasrc/stop-all")  # stops every slot, not just the two in the fixture
        self.assertGreaterEqual(len(held), 3)
        self.assertTrue(all(held), held)

    def test_assign_restart_passes_the_generation_it_captured_under_the_lock(self):
        # Codex review: a stop landing between assign releasing the lock and the starter reading
        # the generation must still invalidate the restart, so assign hands over its own value.
        self.edit_slot_one(state="playing")
        seen = []

        def spy(src, generation=None):
            seen.append(generation)
            src["state"] = "playing"
            app_module._persist_slot(src)
            return True, None, 200
        with mock.patch.object(app_module, "media_stream_is_running", return_value=True), \
             mock.patch.object(app_module, "stop_media_stream"), \
             mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_start_source_slot", side_effect=spy):
            response = self.client.post("/api/mediasrc/assign", json={"index": 1, "file": "a.mp4", "fps": 20})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen, [app_module._slot_generation(1)])
        self.assertIsNotNone(seen[0])

    def test_start_and_bulk_start_pass_the_generation_captured_with_the_snapshot(self):
        # Codex review: like the assign restart, the direct and bulk paths must not let the
        # helper read a generation that a stop may already have bumped after the snapshot.
        seen = []

        def spy(src, generation=None):
            seen.append((src["index"], generation))
            src["state"] = "playing"
            app_module._persist_slot(src)
            return True, None, 200
        with mock.patch.object(app_module, "_start_source_slot", side_effect=spy), \
             mock.patch.object(app_module, "media_stream_is_running", return_value=False):
            self.assertEqual(self.client.post("/api/mediasrc/start", json={"index": 1}).status_code, 200)
            self.assertEqual(self.client.post("/api/mediasrc/start-bulk", json={"count": 2}).status_code, 200)
        self.assertEqual(len(seen), 3)
        for index, generation in seen:
            self.assertEqual(generation, app_module._slot_generation(index), seen)

    def test_start_with_a_stale_generation_is_abandoned(self):
        src = self.persisted()[1]
        before = app_module._slot_generation(1)
        app_module._bump_slot(1)  # a stop that landed after the caller captured `before`
        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_resolve_stream_input", return_value=(self.media_dir / "a.mp4", None, None, 200)), \
             mock.patch.object(app_module, "start_media_stream") as stream:
            ok, _err, status = app_module._start_source_slot(src, generation=before)
        self.assertEqual((ok, status), (False, 409))
        stream.assert_not_called()

    def test_start_re_prepares_when_the_cached_rendition_vanished_before_launch(self):
        # Codex review: clear-renditions can unlink a reused file between the lookup and the
        # locked launch; the start must notice under the lock and prepare again.
        gone = self.media_dir / ".renditions" / "gone.mp4"
        fresh = self.media_dir / ".renditions" / "fresh.mp4"
        fresh.parent.mkdir()
        fresh.write_bytes(b"x")
        resolve = mock.Mock(side_effect=[(gone, ".renditions/gone.mp4", None, 200), (fresh, ".renditions/fresh.mp4", None, 200)])
        stream = mock.Mock(return_value=(True, None))
        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_source_media_codec", return_value="h264"), \
             mock.patch.object(app_module, "_resolve_stream_input", resolve), \
             mock.patch.object(app_module, "start_media_stream", stream):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(resolve.call_count, 2)
        self.assertEqual(stream.call_args.args[1], str(fresh))
        self.assertEqual(self.persisted()[1]["state"], "playing")

    def test_start_rechecks_external_ownership_before_launching(self):
        # Codex review: an external publisher that takes the slot during the encode must turn
        # the start into a conflict, not a launch that mediamtx rejects asynchronously.
        holder = mock.Mock(protocol="rtsp", address="10.0.0.5")
        taken = []

        def external_holder(index, snapshot=None):
            return holder if taken and index == 1 else None
        with mock.patch.object(app_module, "_external_holder", side_effect=external_holder):
            response, stream = self.start_slot_for_real(lambda: taken.append(True))
        self.assertEqual(response.status_code, 409)
        self.assertIn("external publisher", response.get_json()["error"])
        stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["state"], "stopped")

    def test_duplicate_start_does_not_overwrite_a_live_slot(self):
        # Codex review: two overlapping starts share a snapshot; the loser's "Already running"
        # must not persist its stale stopped snapshot over the winner's playing slot.
        first, stream = self.start_slot_for_real(lambda: None)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.persisted()[1]["state"], "playing")
        stale = dict(self.persisted()[1], state="stopped")  # the second request's pre-launch snapshot
        stale_generation = app_module._slot_generation(1) - 1  # captured before the first launch bumped it
        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_resolve_stream_input", return_value=(self.media_dir / "a.mp4", None, None, 200)), \
             mock.patch.object(app_module, "media_stream_is_running", return_value=True), \
             mock.patch.object(app_module, "start_media_stream", return_value=(False, "Already running")) as second_stream:
            ok, _err, status = app_module._start_source_slot(stale, generation=stale_generation)
        self.assertEqual((ok, status), (True, 200))
        second_stream.assert_not_called()
        self.assertEqual(self.persisted()[1]["state"], "playing")

    def test_superseded_start_is_not_treated_as_a_duplicate(self):
        # Codex review: a live slot only counts as "already started" for a request whose
        # snapshot still matches the persisted file and fps; otherwise it is stale (409).
        first, _stream = self.start_slot_for_real(lambda: None)
        self.assertEqual(first.status_code, 200)
        self.edit_slot_one(file="b.mp4", fps=20)  # reassigned and (re)started as b.mp4 meanwhile
        app_module._bump_slot(1)
        stale = dict(self.persisted()[1], file="a.mp4", fps=None, state="stopped")
        with mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_resolve_stream_input", return_value=(self.media_dir / "a.mp4", None, None, 200)), \
             mock.patch.object(app_module, "media_stream_is_running", return_value=True), \
             mock.patch.object(app_module, "start_media_stream") as stream:
            ok, err, status = app_module._start_source_slot(stale, generation=0)
        self.assertEqual((ok, status), (False, 409), err)
        stream.assert_not_called()
        self.assertEqual((self.persisted()[1]["file"], self.persisted()[1]["fps"]), ("b.mp4", 20))

    def test_successful_start_bumps_the_generation(self):
        before = app_module._slot_generation(1)
        response, _stream = self.start_slot_for_real(lambda: None)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(app_module._slot_generation(1), before + 1)

    def test_probe_timeout_is_a_json_error_and_bulk_start_continues(self):
        # Codex review: an ffprobe timeout must surface as the documented JSON error, not a
        # generic Flask error, and Bulk Start must record the slot and go on.
        real_run = renditions.subprocess.run

        def run(cmd, *args, **kwargs):
            if Path(cmd[0]).name == "ffprobe" and str(cmd[-1]).endswith("a.mp4"):
                raise subprocess.TimeoutExpired(cmd, 30)
            return real_run(cmd, *args, **kwargs)
        (self.media_dir / "a.mp4").write_bytes(b"x")
        (self.media_dir / "b.mp4").write_bytes(b"x")
        self.edit_slot_one(fps=15)
        with mock.patch.object(renditions.subprocess, "run", side_effect=run), \
             mock.patch.object(app_module, "_derive_source_stream_settings", return_value=("udp", "h264", ["udp"])), \
             mock.patch.object(app_module, "_source_media_codec", return_value="h264"), \
             mock.patch.object(app_module, "media_stream_is_running", return_value=False), \
             mock.patch.object(app_module, "start_media_stream", return_value=(True, None)):
            single = self.client.post("/api/mediasrc/start", json={"index": 1})
            bulk = self.client.post("/api/mediasrc/start-bulk", json={"count": 2})
        self.assertEqual(single.status_code, 500)
        self.assertIn("timed out", single.get_json()["error"].lower())
        self.assertEqual(bulk.status_code, 200)
        payload = bulk.get_json()
        self.assertEqual([e["index"] for e in payload["errors"]], [1])
        self.assertEqual(payload["started"], [2])

    def test_start_proceeds_when_the_slot_is_unchanged(self):
        response, stream = self.start_slot_for_real(lambda: None)
        self.assertEqual(response.status_code, 200)
        stream.assert_called_once()
        self.assertEqual(self.persisted()[1]["state"], "playing")

    def test_single_start_keeps_edits_made_to_other_slots_while_encoding(self):
        with mock.patch.object(app_module, "_start_source_slot", side_effect=self.fake_start):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        after = self.persisted()
        self.assertEqual(after[1]["state"], "playing")
        self.assertEqual((after[2]["file"], after[2]["fps"]), ("c.mp4", 20))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class SlotFpsTests(RenditionApiTestCase):
    def setUp(self):
        super().setUp()
        make_test_clip(self.media_dir / "demo.mp4", fps=30)

    def test_default_slot_has_null_fps_and_reports_native_fps(self):
        self.assertEqual(self.assign().status_code, 200)
        src = self.source()
        self.assertIsNone(src["fps"])
        self.assertEqual(src["native_fps"], 30)
        self.assertIsNone(src["active_file"])

    def test_assign_accepts_valid_fps_and_persists_it(self):
        self.assertEqual(self.assign(fps=15).status_code, 200)
        self.assertEqual(self.source()["fps"], 15)
        self.assertEqual(app_module.load_sources()[0]["fps"], 15)
        self.assertEqual(json.loads(self.sources_file.read_text())[0]["fps"], 15)

    def test_assign_rejects_invalid_fps(self):
        for value in (0, -5, "abc", 2.5, 999):
            with self.subTest(value=value):
                response = self.assign(fps=value)
                self.assertEqual(response.status_code, 400)
                self.assertIn("between 1 and 240", response.get_json()["error"])

    def test_changing_file_resets_fps_but_changing_transport_keeps_it(self):
        make_test_clip(self.media_dir / "other.mp4", fps=25)
        self.assign(fps=15)
        self.assign(file="demo.mp4", transport="rtsp")
        self.assertEqual(self.source()["fps"], 15)
        self.assign(file="other.mp4")
        src = self.source()
        self.assertIsNone(src["fps"])
        self.assertEqual(src["native_fps"], 25)

    def test_auto_assign_resets_fps_like_a_manual_file_change(self):
        # Auto Assign replaces every slot's file; a frame-rate override chosen
        # for the previous clip must not carry over to the new one.
        make_test_clip(self.media_dir / "other.mp4", fps=25)
        self.assign(index=1, file="other.mp4", fps=15)  # auto-assign will move slot 1 to demo.mp4
        self.assign(index=2, file="other.mp4", fps=20)  # auto-assign keeps slot 2 on other.mp4
        response = self.client.post("/api/mediasrc/auto-assign-all")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.source(1)["file"], "demo.mp4")
        self.assertIsNone(self.source(1)["fps"])
        self.assertEqual(self.source(2)["file"], "other.mp4")
        self.assertEqual(self.source(2)["fps"], 20)
        persisted = {s["index"]: s["fps"] for s in app_module.load_sources()}
        self.assertIsNone(persisted[1])
        self.assertEqual(persisted[2], 20)

    def test_normalize_source_drops_invalid_persisted_fps(self):
        self.sources_file.write_text('[{"index": 1, "file": "demo.mp4", "state": "stopped", "fps": "bogus"}, {"index": 2, "file": "demo.mp4", "state": "stopped", "fps": 20}]', encoding="utf-8")
        sources = app_module.load_sources()
        self.assertIsNone(sources[0]["fps"])
        self.assertEqual(sources[1]["fps"], 20)

    def test_failed_probe_is_cached_until_the_file_changes(self):
        # Codex review: a broken file must not be re-probed (up to the 30 s timeout) on every poll
        # of /api/mediasrc; the failure is cached under the same size/mtime key as a success.
        bad = self.media_dir / "broken.mp4"
        bad.write_bytes(b"not a video")
        with mock.patch.object(renditions, "probe_video", wraps=renditions.probe_video) as probe:
            first = renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
            second = renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
        self.assertEqual(probe.call_count, 1)
        self.assertIn("broken.mp4", first)
        self.assertIsNone(first["broken.mp4"]["native_fps"])
        self.assertEqual(second["broken.mp4"]["native_fps"], None)
        # The slot listing shows the file with an unknown native rate rather than stalling.
        self.assign(index=1, file="broken.mp4")
        self.assertIsNone(self.source()["native_fps"])
        # A changed file is probed again.
        make_test_clip(bad, fps=25)
        os.utime(bad, ns=(1, 1))
        with mock.patch.object(renditions, "probe_video", wraps=renditions.probe_video) as probe:
            third = renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(third["broken.mp4"]["native_fps"], 25)

    def test_cached_probe_failure_expires_and_is_retried(self):
        # Codex review: a timeout under load is transient; the listing must retry after a while.
        bad = self.media_dir / "broken.mp4"
        bad.write_bytes(b"not a video")
        with mock.patch.object(renditions, "probe_video", wraps=renditions.probe_video) as probe:
            renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
            renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
            self.assertEqual(probe.call_count, 1)
            with mock.patch.object(renditions.time, "time", return_value=time.time() + renditions.PROBE_RETRY_SECONDS + 1):
                renditions.source_infos(self.index_path, self.media_dir, ["broken.mp4"])
            self.assertEqual(probe.call_count, 2)

    def test_explicit_probe_ignores_a_cached_failure(self):
        # Codex review: start/prepare use source_info; a failure cached by the listing (e.g. a
        # one-off timeout on a valid file) must not stop them from probing for real.
        with mock.patch.object(renditions, "probe_video", side_effect=subprocess.TimeoutExpired("ffprobe", 30)):
            listing = renditions.source_infos(self.index_path, self.media_dir, ["demo.mp4"])
        self.assertIsNone(listing["demo.mp4"]["native_fps"])
        info = renditions.source_info(self.index_path, self.media_dir, "demo.mp4")
        self.assertEqual(info["native_fps"], 30)
        self.assertEqual(info["width"], 320)
        # The real probe repairs the cache for the listing too.
        with mock.patch.object(renditions, "probe_video", side_effect=AssertionError("must use the cache")):
            self.assertEqual(renditions.source_infos(self.index_path, self.media_dir, ["demo.mp4"])["demo.mp4"]["native_fps"], 30)

    def test_sources_probe_each_file_once_per_request(self):
        self.assign(index=1)
        self.assign(index=2)
        with mock.patch.object(renditions, "probe_video", wraps=renditions.probe_video) as probe:
            # The per-slot helper must not be used: GET /api/mediasrc resolves every file in one pass.
            with mock.patch.object(renditions, "source_info", side_effect=AssertionError("must not probe per slot")):
                payload = self.client.get("/api/mediasrc").get_json()
        self.assertEqual(probe.call_count, 1)
        self.assertEqual([s["native_fps"] for s in payload if s["index"] in (1, 2)], [30, 30])

    def test_renditions_directory_is_hidden_from_video_lists(self):
        (self.media_dir / ".renditions").mkdir()
        make_test_clip(self.media_dir / ".renditions" / "demo_abc123_15fps_h264.mp4", fps=15, seconds=0.5)
        self.assertEqual(self.client.get("/api/mediasrc/videos").get_json(), ["demo.mp4"])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class StartWithRenditionTests(RenditionApiTestCase):
    def setUp(self):
        super().setUp()
        make_test_clip(self.media_dir / "demo.mp4", fps=30)
        self.start_patch = mock.patch.object(app_module, "start_media_stream", return_value=(True, None))
        self.start_mock = self.start_patch.start()
        self.running_patch = mock.patch.object(app_module, "media_stream_is_running", return_value=True)
        self.running_patch.start()

    def tearDown(self):
        self.running_patch.stop()
        self.start_patch.stop()
        super().tearDown()

    def started_path(self):
        return self.start_mock.call_args.args[1]

    def test_start_without_fps_streams_the_source(self):
        self.assign()
        self.assertEqual(self.client.post("/api/mediasrc/start", json={"index": 1}).status_code, 200)
        self.assertEqual(self.started_path(), str(self.media_dir / "demo.mp4"))
        self.assertIsNone(self.start_mock.call_args.kwargs.get("rendition"))

    def test_start_with_native_fps_streams_the_source(self):
        self.assign(fps=30)
        self.assertEqual(self.client.post("/api/mediasrc/start", json={"index": 1}).status_code, 200)
        self.assertEqual(self.started_path(), str(self.media_dir / "demo.mp4"))

    def test_start_with_other_fps_encodes_then_streams_the_rendition(self):
        self.assign(fps=15)
        with mock.patch.object(renditions, "encode_command", wraps=renditions.encode_command) as encode:
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(encode.call_count, 1)
        started = self.started_path()
        self.assertTrue(started.startswith(str(self.media_dir / ".renditions")), started)
        self.assertTrue(started.endswith("_15fps_h264.mp4"))
        self.assertEqual(self.start_mock.call_args.kwargs["rendition"], os.path.relpath(started, self.media_dir))
        self.assertEqual(ffprobe_stream(Path(started))["avg_frame_rate"], "15/1")
        self.assertEqual(self.source()["state"], "playing")

    def test_second_start_reuses_the_rendition_without_encoding(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/start", json={"index": 1})
        first = self.started_path()
        self.client.post("/api/mediasrc/stop", json={"index": 1})
        with mock.patch.object(renditions, "encode_command", side_effect=AssertionError("must not encode")):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.started_path(), first)

    def test_rendition_is_reused_after_a_restart(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/start", json={"index": 1})
        first = self.started_path()
        self.client.post("/api/mediasrc/stop", json={"index": 1})

        # Simulate a restart: forget every in-process state; only the JSON files survive.
        mediasrc.pipeline_registry.clear()
        renditions._key_locks.clear()
        fresh_client = app_module.app.test_client()
        with mock.patch.object(renditions, "encode_command", side_effect=AssertionError("must not encode")):
            response = fresh_client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.started_path(), first)

    def test_replacing_the_source_invalidates_the_old_rendition(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/start", json={"index": 1})
        first = self.started_path()
        self.client.post("/api/mediasrc/stop", json={"index": 1})
        make_test_clip(self.media_dir / "demo.mp4", fps=30, seconds=3.0)
        self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertNotEqual(self.started_path(), first)

    def test_mjpeg_source_with_other_fps_is_rejected(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        with mock.patch.object(app_module, "_media_video_codec", return_value="mjpeg"):
            with mock.patch.object(app_module, "_source_native_fps", return_value=25):
                self.assign(file="cam.mjpg", fps=10)
                with mock.patch.object(renditions, "source_info", return_value={"native_fps": 25, "height": 240}):
                    response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 400)
        self.assertIn("MJPEG", response.get_json()["error"])
        self.start_mock.assert_not_called()

    def test_encode_failure_returns_500_and_cleans_up(self):
        self.assign(fps=15)
        source_bytes = (self.media_dir / "demo.mp4").read_bytes()

        def broken_command(source, output, fps, codec, width, height):
            return ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(self.media_dir / "missing.mp4"), "-progress", "pipe:1", "-nostats", str(output)]

        with mock.patch.object(renditions, "encode_command", side_effect=broken_command):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})

        self.assertEqual(response.status_code, 500)
        self.start_mock.assert_not_called()
        self.assertEqual((self.media_dir / "demo.mp4").read_bytes(), source_bytes)
        rend_dir = self.media_dir / ".renditions"
        self.assertEqual([p.name for p in rend_dir.iterdir()] if rend_dir.exists() else [], [])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])
        self.assertEqual(self.source()["state"], "stopped")

    def test_start_reports_filesystem_errors_as_an_encode_failure(self):
        self.assign(fps=15)
        with mock.patch.object(renditions, "source_hash", side_effect=OSError("disk full")):
            response = self.client.post("/api/mediasrc/start", json={"index": 1})
        self.assertEqual(response.status_code, 500)
        self.assertIn("disk full", response.get_json()["error"])
        self.start_mock.assert_not_called()

    def test_bulk_start_uses_each_slots_fps(self):
        self.assign(index=1, fps=15)
        self.assign(index=2, fps=30)
        response = self.client.post("/api/mediasrc/start-bulk", json={"count": 2})
        self.assertEqual(response.get_json()["started"], [1, 2])
        paths = [call.args[1] for call in self.start_mock.call_args_list]
        self.assertTrue(paths[0].endswith("_15fps_h264.mp4"))
        self.assertEqual(paths[1], str(self.media_dir / "demo.mp4"))

    def test_assign_while_playing_restarts_with_the_new_fps(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/start", json={"index": 1})
        response = self.assign(fps=20)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.started_path().endswith("_20fps_h264.mp4"))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class PrepareEndpointTests(RenditionApiTestCase):
    def setUp(self):
        super().setUp()
        make_test_clip(self.media_dir / "demo.mp4", fps=30)

    def lines(self, response):
        return [line for line in response.get_data(as_text=True).splitlines() if line.strip()]

    def test_prepare_streams_progress_and_ready_line(self):
        self.assign(fps=15)
        response = self.client.post("/api/mediasrc/prepare", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.mimetype.startswith("text/plain"))
        lines = self.lines(response)
        self.assertTrue(lines[0].startswith("Encoding demo.mp4 at 15 fps (libx264 baseline)"), lines)
        self.assertTrue(any(line.startswith("progress ") for line in lines), lines)
        self.assertTrue(lines[-1].startswith("Rendition ready: .renditions/demo_"), lines)
        self.assertTrue(lines[-1].endswith("_15fps_h264.mp4"))

    def test_prepare_reports_reuse_and_native(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1}).get_data()
        self.assertTrue(self.lines(self.client.post("/api/mediasrc/prepare", json={"index": 1}))[-1].startswith("Reusing rendition:"))
        self.assign(fps=30)
        self.assertEqual(self.lines(self.client.post("/api/mediasrc/prepare", json={"index": 1}))[-1], "Source frame rate matches; no rendition needed.")

    def test_prepare_validation_errors(self):
        self.assertEqual(self.client.post("/api/mediasrc/prepare", json={}).status_code, 400)
        self.assertEqual(self.client.post("/api/mediasrc/prepare", json={"index": 99}).status_code, 404)
        self.assertEqual(self.client.post("/api/mediasrc/prepare", json={"index": 1}).status_code, 400)  # unassigned

    def test_prepare_rejects_mjpeg_before_streaming(self):
        (self.media_dir / "cam.mjpg").write_bytes(b"not-a-real-video")
        with mock.patch.object(app_module, "_media_video_codec", return_value="mjpeg"):
            with mock.patch.object(app_module, "_source_native_fps", return_value=25):
                self.assign(file="cam.mjpg", fps=10)
                response = self.client.post("/api/mediasrc/prepare", json={"index": 1})
        self.assertEqual(response.status_code, 400)
        self.assertIn("MJPEG", response.get_json()["error"])

    def test_prepare_reports_encode_errors_in_stream(self):
        self.assign(fps=15)

        def broken_command(source, output, fps, codec, width, height):
            return ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(self.media_dir / "missing.mp4"), "-progress", "pipe:1", "-nostats", str(output)]

        with mock.patch.object(renditions, "encode_command", side_effect=broken_command):
            response = self.client.post("/api/mediasrc/prepare", json={"index": 1})
            lines = self.lines(response)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(lines[-1].startswith("Error: "))

    def test_prepare_reports_unexpected_failures_in_stream(self):
        self.assign(fps=15)
        with mock.patch.object(renditions, "source_info", side_effect=FileNotFoundError("demo.mp4")):
            response = self.client.post("/api/mediasrc/prepare", json={"index": 1})
            lines = self.lines(response)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(lines[-1].startswith("Error: "), lines)

    def test_delete_media_removes_renditions_and_records(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1}).get_data()
        record = renditions.load_index(self.index_path)["renditions"][0]
        self.assertTrue((self.media_dir / record["path"]).exists())

        response = self.client.post("/api/delete-media", json={"path": "demo.mp4"})

        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.media_dir / record["path"]).exists())
        index = renditions.load_index(self.index_path)
        self.assertEqual(index["renditions"], [])
        self.assertNotIn("demo.mp4", index["sources"])

    def test_delete_media_unlinks_before_forgetting_renditions(self):
        # Codex review: a publish racing the delete must be cleaned up by the record removal
        # that follows, which only works if the file is already gone when records are removed.
        self.assign(fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1}).get_data()
        seen = []
        real_remove = renditions.remove_source

        def spy(index_path, media_dir, rel_path):
            seen.append((self.media_dir / rel_path).exists())
            return real_remove(index_path, media_dir, rel_path)
        with mock.patch.object(renditions, "remove_source", side_effect=spy):
            response = self.client.post("/api/delete-media", json={"path": "demo.mp4"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen, [False])
        self.assertEqual(renditions.load_index(self.index_path)["renditions"], [])

    def test_delete_directory_removes_renditions_and_unassigns_slots(self):
        (self.media_dir / "clips").mkdir()
        make_test_clip(self.media_dir / "clips" / "inner.mp4", fps=30, seconds=1.5)  # distinct bytes from demo.mp4
        self.assign(index=2, file="clips/inner.mp4", fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 2}).get_data()
        self.assign(index=3, file="demo.mp4", fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 3}).get_data()
        records = {r["source_file"]: r for r in renditions.load_index(self.index_path)["renditions"]}
        self.assertEqual(set(records), {"clips/inner.mp4", "demo.mp4"})

        response = self.client.post("/api/delete-media", json={"path": "clips"})

        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.media_dir / "clips").exists())
        self.assertFalse((self.media_dir / records["clips/inner.mp4"]["path"]).exists())
        self.assertTrue((self.media_dir / records["demo.mp4"]["path"]).exists())
        index = renditions.load_index(self.index_path)
        self.assertEqual([r["source_file"] for r in index["renditions"]], ["demo.mp4"])
        self.assertNotIn("clips/inner.mp4", index["sources"])
        self.assertEqual(self.source(2)["file"], "")
        self.assertEqual(self.source(3)["file"], "demo.mp4")


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class ClearRenditionsApiTests(RenditionApiTestCase):
    def setUp(self):
        super().setUp()
        make_test_clip(self.media_dir / "demo.mp4", fps=30)

    def test_clear_renditions_keeps_the_playing_rendition(self):
        self.assign(index=1, file="demo.mp4", fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1}).get_data()
        fifteen_fps_path = renditions.load_index(self.index_path)["renditions"][0]["path"]

        usage = self.client.get("/api/mediasrc/renditions").get_json()
        self.assertEqual(usage["count"], 1)
        self.assertGreater(usage["bytes"], 0)

        self.assign(index=2, file="demo.mp4", fps=20)
        self.client.post("/api/mediasrc/prepare", json={"index": 2}).get_data()
        self.assertEqual(len(renditions.load_index(self.index_path)["renditions"]), 2)

        running = {1: fifteen_fps_path}  # models the process registry: a stopped slot has no file
        with mock.patch.object(app_module, "start_media_stream", return_value=(True, None)), \
                mock.patch.object(app_module, "media_stream_is_running", return_value=True), \
                mock.patch.object(app_module, "stop_media_stream", side_effect=lambda index: running.pop(index, None)), \
                mock.patch.object(app_module, "_active_stream_file", side_effect=running.get):
            self.assertEqual(self.client.post("/api/mediasrc/start", json={"index": 1}).status_code, 200)

            clear_payload = self.client.post("/api/mediasrc/renditions/clear").get_json()
            self.assertEqual(clear_payload["removed"], 1)
            self.assertEqual(clear_payload["kept"], [fifteen_fps_path])
            self.assertGreater(clear_payload["freed_bytes"], 0)
            self.assertEqual(self.client.get("/api/mediasrc/renditions").get_json()["count"], 1)

            self.client.post("/api/mediasrc/stop", json={"index": 1})

            clear_payload = self.client.post("/api/mediasrc/renditions/clear").get_json()
            self.assertEqual(clear_payload["removed"], 1)
            self.assertEqual(self.client.get("/api/mediasrc/renditions").get_json()["count"], 0)

    def test_clear_renditions_trusts_the_registry_not_the_persisted_state(self):
        # Codex review: between launch and persist the slot still reads "stopped" on disk
        # while its process is already registered; the keep set must come from the registry.
        self.assign(index=1, file="demo.mp4", fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1}).get_data()
        path = renditions.load_index(self.index_path)["renditions"][0]["path"]
        self.assertEqual(app_module.load_sources()[0]["state"], "stopped")
        with mock.patch.object(app_module, "_active_stream_file", side_effect=lambda index: path if index == 1 else None):
            payload = self.client.post("/api/mediasrc/renditions/clear").get_json()
        self.assertEqual(payload["kept"], [path])
        self.assertEqual(payload["removed"], 0)
        self.assertTrue((self.media_dir / path).exists())

    def test_clear_renditions_holds_the_slot_lock(self):
        held = []
        with mock.patch.object(renditions, "clear_renditions", side_effect=lambda *a, **k: (held.append(lock_is_held(app_module._slot_lock)), ([], 0))[1]):
            self.assertEqual(self.client.post("/api/mediasrc/renditions/clear").status_code, 200)
        self.assertEqual(held, [True])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
class SharedRenditionTests(RenditionApiTestCase):
    """Codex review: a content-addressed rendition can be claimed by several identical files;
    it must outlive the deletion or replacement of any one of them."""

    def setUp(self):
        super().setUp()
        make_test_clip(self.media_dir / "demo.mp4", fps=30)
        shutil.copyfile(self.media_dir / "demo.mp4", self.media_dir / "copy.mp4")  # identical bytes

    def prepare(self, index, file):
        self.assign(index=index, file=file, fps=15)
        return self.client.post("/api/mediasrc/prepare", json={"index": index}).get_data(as_text=True)

    def records(self):
        return renditions.load_index(self.index_path)["renditions"]

    def test_reuse_records_every_claiming_source(self):
        self.assertIn("Rendition ready", self.prepare(1, "demo.mp4"))
        self.assertIn("Reusing rendition", self.prepare(2, "copy.mp4"))
        (record,) = self.records()
        self.assertEqual(record["source_files"], ["demo.mp4", "copy.mp4"])
        self.assertEqual(record["source_file"], "demo.mp4")

    def test_deleting_one_claimant_keeps_the_shared_rendition(self):
        self.prepare(1, "demo.mp4")
        self.prepare(2, "copy.mp4")
        (record,) = self.records()
        self.assertEqual(self.client.post("/api/delete-media", json={"path": "demo.mp4"}).status_code, 200)
        self.assertTrue((self.media_dir / record["path"]).exists())
        (record,) = self.records()
        self.assertEqual(record["source_files"], ["copy.mp4"])
        self.assertIn("Reusing rendition", self.prepare(2, "copy.mp4"))
        self.assertEqual(self.client.post("/api/delete-media", json={"path": "copy.mp4"}).status_code, 200)
        self.assertFalse((self.media_dir / record["path"]).exists())
        self.assertEqual(self.records(), [])

    def test_replacing_one_claimant_keeps_the_shared_rendition(self):
        self.prepare(1, "demo.mp4")
        self.prepare(2, "copy.mp4")
        (shared,) = self.records()
        make_test_clip(self.media_dir / "demo.mp4", fps=30, seconds=1.5)  # new content under the old name
        os.utime(self.media_dir / "demo.mp4", ns=(1, 1))  # make sure the stat differs from the cached one
        self.assertIn("Rendition ready", self.prepare(1, "demo.mp4"))
        paths = {r["path"]: r for r in self.records()}
        self.assertIn(shared["path"], paths)
        self.assertTrue((self.media_dir / shared["path"]).exists())
        self.assertEqual(paths[shared["path"]]["source_files"], ["copy.mp4"])
        self.assertEqual(len(paths), 2)

    def test_reuse_releases_the_paths_claim_on_its_previous_content(self):
        # Codex review: a path replaced with bytes identical to another source must drop its
        # claim on renditions of its old content, as the encode branch already does.
        make_test_clip(self.media_dir / "other.mp4", fps=30, seconds=1.5)  # different content
        self.assertIn("Rendition ready", self.prepare(1, "other.mp4"))
        self.assertIn("Rendition ready", self.prepare(2, "demo.mp4"))
        old = next(r for r in self.records() if r["source_files"] == ["other.mp4"])
        shutil.copyfile(self.media_dir / "demo.mp4", self.media_dir / "other.mp4")  # now identical to demo
        os.utime(self.media_dir / "other.mp4", ns=(1, 1))
        self.assertIn("Reusing rendition", self.prepare(1, "other.mp4"))
        self.assertFalse((self.media_dir / old["path"]).exists())
        (shared,) = self.records()
        self.assertEqual(shared["source_files"], ["demo.mp4", "other.mp4"])

    def test_legacy_record_without_source_files_still_removes(self):
        self.prepare(1, "demo.mp4")
        index = renditions.load_index(self.index_path)
        del index["renditions"][0]["source_files"]
        renditions.save_index(self.index_path, index)
        path = self.records()[0]["path"]
        renditions.remove_source(self.index_path, self.media_dir, "demo.mp4")
        self.assertFalse((self.media_dir / path).exists())
        self.assertEqual(self.records(), [])


class IncrementalTimestampValidationTests(unittest.TestCase):
    """Codex review: validation must stream packets, not buffer a whole multi-hour probe."""

    def packets(self, count, bad_at=None, consumed=None):
        for i in range(count):
            if consumed is not None:
                consumed.append(i)
            pts = i / 10
            if bad_at is not None and i == bad_at:
                pts += 0.5  # jump: not constant frame rate
            yield (pts, pts, i % 10 == 0)

    def test_valid_stream_passes_without_materializing(self):
        renditions._validate_timestamps(Path("x.mp4"), 10, self.packets(1000))

    def test_stops_at_the_first_bad_packet(self):
        consumed = []
        with self.assertRaises(renditions.RenditionError):
            renditions._validate_timestamps(Path("x.mp4"), 10, self.packets(1_000_000, bad_at=25, consumed=consumed))
        self.assertLessEqual(len(consumed), 26)

    def test_keyframe_cadence_is_checked_incrementally(self):
        def packets():
            for i in range(40):
                yield (i / 10, i / 10, i in (0, 10, 25))  # third keyframe is early
        with self.assertRaises(renditions.RenditionError) as ctx:
            renditions._validate_timestamps(Path("x.mp4"), 10, packets())
        self.assertIn("keyframe", str(ctx.exception))

    def test_missing_periodic_keyframes_are_rejected(self):
        # Codex review: a keyframe only at zero passed because cadence was checked only when a
        # keyframe appeared; the packet at each whole second must itself be a keyframe.
        def packets():
            for i in range(30):
                yield (i / 10, i / 10, i == 0)
        with self.assertRaises(renditions.RenditionError) as ctx:
            renditions._validate_timestamps(Path("x.mp4"), 10, packets())
        self.assertIn("keyframe", str(ctx.exception))

    def test_empty_stream_is_rejected(self):
        with self.assertRaises(renditions.RenditionError):
            renditions._validate_timestamps(Path("x.mp4"), 10, iter(()))

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg and ffprobe are required")
    def test_iter_packets_streams_ffprobe_output(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "clip.mp4"
            make_test_clip(clip, fps=10, seconds=1.0)
            gen = renditions.iter_packets(clip)
            first = next(gen)  # a plain test clip has B-frames, so only pts and the keyframe flag are fixed
            self.assertEqual((first[0], first[2]), (0.0, True))
            rest = list(gen)
            self.assertEqual(len(rest), 9)
            self.assertEqual(renditions.probe_packets(clip), [first, *rest])


if __name__ == "__main__":
    unittest.main()
