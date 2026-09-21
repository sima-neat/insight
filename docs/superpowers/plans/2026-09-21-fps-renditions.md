# FPS-Specific Video Renditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick an FPS per streaming slot; Insight re-encodes the source at that rate once (catalog encoding contract), stores and records the rendition, reuses it across starts and restarts, and streams it.

**Architecture:** A new pure module `neat_insight/renditions.py` owns FPS validation, the ffmpeg encode command, ffprobe validation, the content-hash cache and the `renditions.json` index, and an `ensure_rendition` generator that either reuses or encodes. `app.py` gains an `fps` field on slots, a shared `_start_source_slot` helper used by start/start-bulk/assign, and a streaming `POST /api/mediasrc/prepare`. The React UI adds a `[−] N fps [+]` stepper per source row and a determinate progress state in the preview panel.

**Tech Stack:** Python 3.10+/Flask, stdlib `unittest`, ffmpeg/ffprobe (libx264/libx265), React 18 + Vite (plain JSX), `node --test`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-21-fps-renditions-design.md`

## Global Constraints

- FPS is an integer, `1 ≤ fps ≤ 240`; arrows step by `5`.
- Rendition codec = source codec: `h264 → libx264 baseline`, `h265 → libx265 main`; MJPEG sources reject any FPS ≠ native with HTTP 400.
- Renditions live in `MEDIA_DIR/.renditions/`; index is `renditions.json` next to `media_sources.json`; index schema string `sima.neat.insight.renditions.v1`.
- Lookup key `{source_sha256}:{fps}:{codec}:{profile}`; file name `{stem}_{sha[:6]}_{fps}fps_{codec}.mp4`.
- If requested FPS equals the source's detected FPS (rounded to integer), no rendition is made; the source streams as today.
- Encoding failures unlink the temp file and never touch the index or the source.
- Every new `/api/...` route must be in `neat_insight/openapi.json` (enforced by `tests/test_api_docs.py`).
- Backend style: `# API:` comment + docstring on routes, `_json_error(message, status)` for errors, leading-underscore private helpers. Frontend style: no semicolons, 2-space indent, single quotes.
- Local Python interpreter for tests: `PY=/home/justin/dev/sima-neat/insight/.venv/bin/python` (the worktree has no venv). Run all commands from the worktree root `/home/justin/dev/sima-neat/insight/.claude/worktrees/fps-renditions-111`.
- Commit after every task; never `git stash`.

---

## File map

| File | Responsibility |
|---|---|
| `neat_insight/renditions.py` (new) | FPS validation, level/bitrate rules, `encode_command`, ffprobe probes + `validate_rendition`, index I/O, source cache/hash, `ensure_rendition` generator, per-key locks |
| `neat_insight/mediasrc.py` | `MediaStream.rendition` field, `start_media_stream(..., rendition=)`, `media_stream_file(index)` |
| `neat_insight/app.py` | `RENDITIONS_INDEX_FILE`, slot `fps` field, `native_fps`/`active_file` in `GET /api/mediasrc`, `_start_source_slot`, `/api/mediasrc/prepare`, delete-media cleanup, hide `.renditions` from video lists |
| `neat_insight/openapi.json` | `prepare` operation, `fps`/`native_fps`/`active_file` fields |
| `skills/use-neat-insight/SKILL.md` | endpoint table: `fps` on assign + `prepare` row |
| `tests/test_fps_renditions.py` (new) | unit + integration tests (real ffmpeg) |
| `frontend/src/fps.js` (new) + `fps.test.js` (new) | pure stepper logic |
| `frontend/src/App.jsx` | `FpsStepper`, prepare/start flow, row + preview panel changes |
| `frontend/src/styles.css` | stepper, encoding badge, preview-loading, grid columns |
| `frontend/package.json` | `test:unit` script |
| `scripts/test-fps-renditions.sh` (new) | reusable local/CI test runner |
| `.github/workflows/vulcan-ci.yml` | `tests` job |
| `docs/user-interface.md`, `docs/api-reference.md` | user/API docs |

---

### Task 1: `renditions.py` — FPS validation and encoder rules (no ffmpeg needed)

**Files:**
- Create: `neat_insight/renditions.py`
- Create: `tests/test_fps_renditions.py`

**Interfaces:**
- Produces: `FPS_MIN=1`, `FPS_MAX=240`, `FPS_STEP=5`, `PROFILES = {"h264": "baseline", "h265": "main"}`, `RENDITIONS_DIRNAME=".renditions"`, `class RenditionError(RuntimeError)`, `class UnsupportedRendition(RenditionError)`, `coerce_fps(value) -> Optional[int]`, `validate_fps(value) -> int`, `parse_rate(value) -> float`, `detect_fps(stream: dict) -> Optional[int]`, `video_level(codec, height, fps) -> str`, `video_bitrate(height, fps) -> str`, `expected_level_code(codec, height, fps) -> int`, `rendition_key(sha, fps, codec) -> str`, `rendition_rel_path(rel_path, sha, fps, codec) -> str`, `encode_command(source: Path, output: Path, fps: int, codec: str, height: int) -> list[str]`, `parse_progress_seconds(key, value) -> Optional[float]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_fps_renditions.py`:

```python
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


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions -v`
Expected: `ImportError: cannot import name 'renditions'` / `ModuleNotFoundError`.

- [ ] **Step 3: Create the module**

Create `neat_insight/renditions.py`:

```python
"""FPS-specific renditions of media-library videos.

A rendition is a re-encoded copy of a source video at a different constant
frame rate. Encoder arguments and validators are ported from
media-assets/build_media_assets.py so renditions follow the same contract as
catalog assets and stream through mediasrc with ``-c:v copy``.
"""
import hashlib
import json
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterator, Optional

FPS_MIN = 1
FPS_MAX = 240
FPS_STEP = 5
RENDITIONS_DIRNAME = ".renditions"
INDEX_SCHEMA = "sima.neat.insight.renditions.v1"
ENCODER_PRESET = "medium"
PROFILES = {"h264": "baseline", "h265": "main"}
FFMPEG_CODEC_NAMES = {"h264": "h264", "h265": "hevc"}
ENCODER_NAMES = {"h264": "libx264", "h265": "libx265"}


class RenditionError(RuntimeError):
    """A rendition could not be created or validated."""


class UnsupportedRendition(RenditionError):
    """The source cannot have an FPS rendition (MJPEG or unknown codec)."""


def coerce_fps(value: Any) -> Optional[int]:
    """Return a valid integer FPS, or None for anything invalid (used for persisted slot values)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not number.is_integer() or not FPS_MIN <= number <= FPS_MAX:
        return None
    return int(number)


def validate_fps(value: Any) -> int:
    fps = coerce_fps(value)
    if fps is None:
        raise ValueError(f"FPS must be a whole number between {FPS_MIN} and {FPS_MAX}")
    return fps


def parse_rate(value: Any) -> float:
    text = str(value or "")
    if not text or text == "0/0":
        return 0.0
    try:
        return float(Fraction(text))
    except (ValueError, ZeroDivisionError):
        return 0.0


def detect_fps(stream: dict) -> Optional[int]:
    rate = parse_rate(stream.get("avg_frame_rate")) or parse_rate(stream.get("r_frame_rate"))
    if rate <= 0:
        return None
    return int(round(rate))


# Ported from media-assets/build_media_assets.py:video_level.
def video_level(codec: str, height: int, fps: int) -> str:
    if height >= 2160:
        return "5.1"
    if height >= 1080 and fps >= 100:
        return "5.1" if codec == "h264" else "5.0"
    if height >= 1080:
        return "4.0"
    if height >= 720 and fps >= 60:
        return "3.2" if codec == "h264" else "4.0"
    if height >= 720:
        return "3.1"
    if height >= 480:
        return "3.1" if codec == "h264" else "3.0"
    return "3.0"


# Ported from media-assets/build_media_assets.py:video_bitrate (no preview tier).
def video_bitrate(height: int, fps: int) -> str:
    if height >= 2160:
        return "35M"
    if height >= 1080 and fps >= 100:
        return "18M"
    if height >= 1080:
        return "12M"
    if height >= 720 and fps >= 60:
        return "8M"
    if height >= 720 and fps <= 20:
        return "2M"
    if height >= 720:
        return "5M"
    return "3M"


def expected_level_code(codec: str, height: int, fps: int) -> int:
    multiplier = 10 if codec == "h264" else 30
    return round(float(video_level(codec, height, fps)) * multiplier)


def rendition_key(sha: str, fps: int, codec: str) -> str:
    return f"{sha}:{fps}:{codec}:{PROFILES[codec]}"


def rendition_rel_path(rel_path: str, sha: str, fps: int, codec: str) -> str:
    return f"{RENDITIONS_DIRNAME}/{Path(rel_path).stem}_{sha[:6]}_{fps}fps_{codec}.mp4"


def _codec_args(codec: str, height: int, fps: int) -> list[str]:
    if codec not in PROFILES:
        raise ValueError(f"unsupported rendition codec: {codec}")
    level = video_level(codec, height, fps)
    bitrate = video_bitrate(height, fps)
    common = [
        "-pix_fmt", "yuv420p",
        "-g", str(fps),
        "-keyint_min", str(fps),
        "-bf", "0",
        "-flags", "+cgop",
        "-b:v", bitrate,
        "-maxrate", bitrate,
        "-bufsize", bitrate,
    ]
    if codec == "h264":
        # H.264 VUI counts field ticks, so tick_rate is 2 * fps.
        return [
            "-c:v", "libx264",
            "-preset", ENCODER_PRESET,
            "-profile:v", "baseline",
            "-level:v", level,
            "-refs", "1",
            "-sc_threshold", "0",
            *common,
            "-x264-params", "repeat-headers=1:force-cfr=1:open-gop=0",
            "-tag:v", "avc1",
            "-bsf:v", f"h264_metadata=aud=remove,dump_extra=freq=keyframe,h264_metadata=aud=insert:tick_rate={fps * 2}/1",
        ]
    return [
        "-c:v", "libx265",
        "-preset", ENCODER_PRESET,
        "-profile:v", "main",
        "-level:v", level,
        *common,
        "-tag:v", "hvc1",
        "-x265-params",
        f"level-idc={level}:high-tier=0:keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:ref=1:open-gop=0:log-level=error",
        "-bsf:v", f"hevc_metadata=aud=remove,hevc_metadata=aud=insert:tick_rate={fps}/1",
    ]


def encode_command(source: Path, output: Path, fps: int, codec: str, height: int) -> list[str]:
    """ffmpeg argv that writes a constant-frame-rate rendition of `source` to `output`."""
    return [
        "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(source),
        "-map", "0:v:0", "-an",
        "-vf", f"setpts=PTS-STARTPTS,fps={fps}",
        "-fps_mode", "cfr",
        *_codec_args(codec, height, fps),
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        "-progress", "pipe:1", "-nostats",
        str(output),
    ]


def parse_progress_seconds(key: str, value: str) -> Optional[float]:
    if key in {"out_time_us", "out_time_ms"}:
        try:
            return max(0.0, float(value) / 1_000_000.0)
        except ValueError:
            return None
    if key != "out_time":
        return None
    try:
        hours, minutes, seconds = value.split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except (ValueError, TypeError):
        return None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions -v`
Expected: all `FpsRuleTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add neat_insight/renditions.py tests/test_fps_renditions.py
git commit -m "Add FPS rendition rules: validation, level/bitrate, encode command"
```

---

### Task 2: `renditions.py` — index I/O, source cache, and content hash

**Files:**
- Modify: `neat_insight/renditions.py`
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Consumes: Task 1 constants.
- Produces: `load_index(index_path) -> dict`, `save_index(index_path, data) -> None`, `sha256_file(path) -> str`, `probe_video(path) -> dict` (ffprobe; raises `RenditionError`), `source_info(index_path, media_dir, rel_path) -> dict` (keys `size, mtime_ns, native_fps, width, height, duration`, optional `sha256`), `source_hash(index_path, media_dir, rel_path) -> str`, `find_rendition(index_path, media_dir, key) -> Optional[dict]`, `add_rendition(index_path, record) -> None`, `remove_source(index_path, media_dir, rel_path) -> list[str]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_fps_renditions.py` (before `if __name__ == "__main__":`):

```python
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions.RenditionIndexTests -v`
Expected: `AttributeError: module 'neat_insight.renditions' has no attribute 'load_index'` (and similar).

- [ ] **Step 3: Implement index I/O, probe, cache and hash**

Append to `neat_insight/renditions.py`:

```python
_index_lock = threading.RLock()


def _empty_index() -> dict:
    return {"schema": INDEX_SCHEMA, "sources": {}, "renditions": []}


def load_index(index_path: Path) -> dict:
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict) or data.get("schema") != INDEX_SCHEMA:
        return _empty_index()
    sources = data.get("sources")
    records = data.get("renditions")
    return {
        "schema": INDEX_SCHEMA,
        "sources": sources if isinstance(sources, dict) else {},
        "renditions": records if isinstance(records, list) else [],
    }


def save_index(index_path: Path, data: dict) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_name(f".{index_path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(index_path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _float_or_none(value: Any) -> Optional[float]:
    if value in (None, "", "N/A"):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def probe_video(path: Path) -> dict:
    """Return the first video stream's ffprobe fields (with the container duration as fallback)."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RenditionError("ffprobe is not installed; install FFmpeg and ensure ffprobe is on PATH.")
    cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,profile,pix_fmt,level,has_b_frames,width,height,r_frame_rate,avg_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RenditionError(f"ffprobe failed for {path.name}: {detail or result.returncode}")
    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RenditionError(f"ffprobe returned invalid JSON for {path.name}: {exc}") from exc
    streams = data.get("streams") or []
    if not streams or not isinstance(streams[0], dict):
        raise RenditionError(f"{path.name} has no video stream")
    stream = dict(streams[0])
    container = data.get("format") if isinstance(data.get("format"), dict) else {}
    if _float_or_none(stream.get("duration")) is None:
        stream["duration"] = container.get("duration")
    return stream


def _stat_matches(entry: Any, stat) -> bool:
    return isinstance(entry, dict) and entry.get("size") == stat.st_size and entry.get("mtime_ns") == stat.st_mtime_ns


def source_info(index_path: Path, media_dir: Path, rel_path: str) -> dict:
    """Cached probe of a source: {size, mtime_ns, native_fps, width, height, duration[, sha256]}; re-probes when size or mtime change."""
    source_path = media_dir / rel_path
    stat = source_path.stat()
    with _index_lock:
        index = load_index(index_path)
        entry = index["sources"].get(rel_path)
        if _stat_matches(entry, stat) and "native_fps" in entry:
            return dict(entry)
        stream = probe_video(source_path)
        fresh = {
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "native_fps": detect_fps(stream),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "duration": _float_or_none(stream.get("duration")),
        }
        if _stat_matches(entry, stat) and entry.get("sha256"):
            fresh["sha256"] = entry["sha256"]
        index["sources"][rel_path] = fresh
        save_index(index_path, index)
        return dict(fresh)


def source_hash(index_path: Path, media_dir: Path, rel_path: str) -> str:
    """SHA-256 of the source content, cached in the index and validated by size + mtime_ns."""
    source_path = media_dir / rel_path
    stat = source_path.stat()
    with _index_lock:
        index = load_index(index_path)
        entry = index["sources"].get(rel_path)
        if _stat_matches(entry, stat) and entry.get("sha256"):
            return entry["sha256"]
        digest = sha256_file(source_path)
        if not _stat_matches(entry, stat):
            entry = {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
        entry["sha256"] = digest
        index["sources"][rel_path] = entry
        save_index(index_path, index)
        return digest


def find_rendition(index_path: Path, media_dir: Path, key: str) -> Optional[dict]:
    """Return the record for `key` if its file exists; drop records whose files are gone."""
    with _index_lock:
        index = load_index(index_path)
        kept = []
        found = None
        for record in index["renditions"]:
            rel = record.get("path") if isinstance(record, dict) else None
            if not rel or not (media_dir / rel).is_file():
                continue
            kept.append(record)
            if record.get("key") == key:
                found = record
        if len(kept) != len(index["renditions"]):
            index["renditions"] = kept
            save_index(index_path, index)
        return dict(found) if found else None


def add_rendition(index_path: Path, record: dict) -> None:
    with _index_lock:
        index = load_index(index_path)
        index["renditions"] = [r for r in index["renditions"] if r.get("key") != record["key"]]
        index["renditions"].append(record)
        save_index(index_path, index)


def remove_source(index_path: Path, media_dir: Path, rel_path: str) -> list[str]:
    """Forget a source: drop its cache entry and delete its rendition files and records. Returns removed rendition paths."""
    with _index_lock:
        index = load_index(index_path)
        index["sources"].pop(rel_path, None)
        removed = []
        kept = []
        for record in index["renditions"]:
            if record.get("source_file") == rel_path and record.get("path"):
                (media_dir / record["path"]).unlink(missing_ok=True)
                removed.append(record["path"])
            else:
                kept.append(record)
        index["renditions"] = kept
        save_index(index_path, index)
        return removed
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add neat_insight/renditions.py tests/test_fps_renditions.py
git commit -m "Add rendition index with content-hash cache"
```

---

### Task 3: `renditions.py` — validation and `ensure_rendition` (real ffmpeg)

**Files:**
- Modify: `neat_insight/renditions.py`
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: `validate_rendition(path, fps, codec, height) -> None`, `probe_packets(path)`, `probe_reference_frames(path) -> int`, `ensure_rendition(media_dir, index_path, rel_path, fps, source_codec) -> Iterator[dict]`. Events yielded: `{"event": "encoding", "file", "fps", "codec", "encoder", "total"}`, `{"event": "progress", "seconds", "total"}`, `{"event": "done", "path": str, "rendition": Optional[str], "reused": bool, "native": bool}`. Raises `UnsupportedRendition` (MJPEG/unknown codec) or `RenditionError`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_fps_renditions.py`:

```python
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
        self.assertEqual(done["rendition"], ".renditions/demo_" + renditions.sha256_file(self.source)[:6] + "_15fps_h264.mp4")
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

        def broken_command(source, output, fps, codec, height):
            return ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(self.media_dir / "missing.mp4"), "-progress", "pipe:1", "-nostats", str(output)]

        with mock.patch.object(renditions, "encode_command", side_effect=broken_command):
            with self.assertRaises(renditions.RenditionError):
                drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))

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

    def test_validate_rendition_rejects_wrong_fps(self):
        _events, done = drain(renditions.ensure_rendition(self.media_dir, self.index_path, "demo.mp4", 15, "h264"))
        with self.assertRaises(renditions.RenditionError) as ctx:
            renditions.validate_rendition(Path(done["path"]), 20, "h264", 240)
        self.assertIn("r_frame_rate", str(ctx.exception))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions.RenditionEncodeTests -v`
Expected: `AttributeError: module 'neat_insight.renditions' has no attribute 'ensure_rendition'`.

- [ ] **Step 3: Implement validation and the orchestrator**

Append to `neat_insight/renditions.py`:

```python
def probe_packets(path: Path) -> list[tuple[float, float, bool]]:
    """(pts_time, dts_time, is_keyframe) per video packet."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RenditionError("ffprobe is not installed; install FFmpeg and ensure ffprobe is on PATH.")
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", str(path)]
    data = json.loads(subprocess.check_output(cmd, text=True, timeout=60))
    try:
        return [
            (float(packet["pts_time"]), float(packet["dts_time"]), "K" in str(packet.get("flags", "")))
            for packet in data.get("packets", [])
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RenditionError(f"{path.name} contains a packet without usable PTS/DTS timestamps") from exc


def probe_reference_frames(path: Path) -> int:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenditionError("ffmpeg is not installed; install FFmpeg and ensure ffmpeg is on PATH.")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "verbose", "-i", str(path), "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-f", "null", "-"]
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=60)
    match = re.search(r"Video:.*?([0-9]+) reference frame", proc.stderr)
    if not match:
        raise RenditionError(f"Could not determine the reference-frame count for {path.name}")
    return int(match.group(1))


def _validate_timestamps(path: Path, fps: int, packets: list[tuple[float, float, bool]]) -> None:
    tolerance = 1e-5
    keyframe_times = [pts for pts, _dts, is_key in packets if is_key]
    if not keyframe_times or any(abs(ts - i) > tolerance for i, ts in enumerate(keyframe_times)):
        raise RenditionError(f"{path.name} does not have a closed one-second keyframe cadence starting at zero")
    if abs(packets[0][0]) > tolerance or abs(packets[0][1]) > tolerance:
        raise RenditionError(f"{path.name} packet timestamps do not start at zero")
    interval = 1.0 / fps
    previous = None
    for pts, dts, _is_key in packets:
        if abs(pts - dts) > tolerance or (previous is not None and abs(pts - previous - interval) > tolerance):
            raise RenditionError(f"{path.name} packet timestamps are reordered or not constant frame rate")
        previous = pts


def validate_rendition(path: Path, fps: int, codec: str, height: int) -> None:
    """Raise RenditionError unless `path` meets the catalog contract for `fps`/`codec`."""
    stream = probe_video(path)
    expected = {
        "codec_name": FFMPEG_CODEC_NAMES[codec],
        "profile": "Constrained Baseline" if codec == "h264" else "Main",
        "pix_fmt": "yuv420p",
        "has_b_frames": 0,
        "level": expected_level_code(codec, height, fps),
    }
    mismatches = [f"{key}={stream.get(key)!r} (expected {value!r})" for key, value in expected.items() if stream.get(key) != value]
    for key in ("r_frame_rate", "avg_frame_rate"):
        if parse_rate(stream.get(key)) != fps:
            mismatches.append(f"{key}={stream.get(key)!r} (expected {fps})")
    reference_frames = probe_reference_frames(path)
    if reference_frames != 1:
        mismatches.append(f"reference_frames={reference_frames!r} (expected 1)")
    if mismatches:
        raise RenditionError(f"{path.name} violates the rendition contract: " + "; ".join(mismatches))
    _validate_timestamps(path, fps, probe_packets(path))


_key_locks: dict[str, threading.Lock] = {}
_key_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _key_locks_guard:
        return _key_locks.setdefault(key, threading.Lock())


def _terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        process.kill()


def ensure_rendition(media_dir: Path, index_path: Path, rel_path: str, fps: Any, source_codec: Optional[str]) -> Iterator[dict]:
    """Yield progress events and finally a 'done' event naming the file to stream.

    Reuses a stored rendition when the source content, fps, codec and profile match;
    otherwise encodes one. Encoding failures remove the temp file and leave the
    index and the source untouched. Closing the generator terminates ffmpeg.
    """
    fps = validate_fps(fps)
    source_path = media_dir / rel_path
    if not source_path.is_file():
        raise RenditionError(f"File not found: {rel_path}")
    info = source_info(index_path, media_dir, rel_path)
    if info.get("native_fps") == fps:
        yield {"event": "done", "path": str(source_path), "rendition": None, "reused": False, "native": True}
        return
    if source_codec == "mjpeg":
        raise UnsupportedRendition("FPS changes are not supported for MJPEG sources")
    if source_codec not in PROFILES:
        raise UnsupportedRendition(f"Cannot create a rendition for {rel_path}: the source codec is unknown or unsupported")
    height = int(info.get("height") or 0)
    if height <= 0:
        raise RenditionError(f"Cannot determine the resolution of {rel_path}")

    digest = source_hash(index_path, media_dir, rel_path)
    key = rendition_key(digest, fps, source_codec)
    with _lock_for(key):
        existing = find_rendition(index_path, media_dir, key)
        if existing:
            yield {"event": "done", "path": str(media_dir / existing["path"]), "rendition": existing["path"], "reused": True, "native": False}
            return

        rel_out = rendition_rel_path(rel_path, digest, fps, source_codec)
        output = media_dir / rel_out
        output.parent.mkdir(parents=True, exist_ok=True)
        tmp = output.with_name(f".{output.stem}.tmp{output.suffix}")
        tmp.unlink(missing_ok=True)
        total = _float_or_none(info.get("duration"))
        yield {
            "event": "encoding",
            "file": rel_path,
            "fps": fps,
            "codec": source_codec,
            "encoder": f"{ENCODER_NAMES[source_codec]} {PROFILES[source_codec]}",
            "total": total,
        }

        cmd = encode_command(source_path, tmp, fps, source_codec, height)
        try:
            process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except FileNotFoundError as exc:
            raise RenditionError("ffmpeg is not installed; install FFmpeg and ensure ffmpeg is on PATH.") from exc

        diagnostics: list[str] = []
        last_progress_at = 0.0
        try:
            if process.stdout:
                for raw_line in process.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    if "=" not in line:
                        diagnostics.append(line)
                        diagnostics = diagnostics[-8:]
                        continue
                    key_name, value = line.split("=", 1)
                    seconds = parse_progress_seconds(key_name, value)
                    if seconds is None:
                        continue
                    now = time.monotonic()
                    if now - last_progress_at < 1.0:
                        continue
                    last_progress_at = now
                    yield {"event": "progress", "seconds": seconds, "total": total}
            return_code = process.wait()
        except BaseException:
            # GeneratorExit when the client disconnects, or any other interruption.
            _terminate(process)
            tmp.unlink(missing_ok=True)
            raise

        if return_code != 0:
            tmp.unlink(missing_ok=True)
            raise RenditionError("; ".join(diagnostics[-4:]) or f"ffmpeg exited with status {return_code}")
        try:
            validate_rendition(tmp, fps, source_codec, height)
        except RenditionError:
            tmp.unlink(missing_ok=True)
            raise

        tmp.replace(output)
        record = {
            "key": key,
            "source_file": rel_path,
            "source_sha256": digest,
            "fps": fps,
            "codec": source_codec,
            "profile": PROFILES[source_codec],
            "path": rel_out,
            "sha256": sha256_file(output),
            "bytes": output.stat().st_size,
            "width": info.get("width"),
            "height": height,
            "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        add_rendition(index_path, record)
        yield {"event": "done", "path": str(output), "rendition": rel_out, "reused": False, "native": False}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions -v`
Expected: all PASS (encode tests take a few seconds each). If `test_encodes_rendition_that_meets_the_catalog_contract` fails on `level`, print `ffprobe -show_entries stream=level` for the output and compare with `expected_level_code("h264", 240, 15)` (= 30); libx264 honours `-level:v`, so a mismatch means the height passed in is wrong.

- [ ] **Step 5: Commit**

```bash
git add neat_insight/renditions.py tests/test_fps_renditions.py
git commit -m "Encode, validate and reuse FPS renditions"
```

---

### Task 4: `mediasrc.py` — remember which rendition a stream uses

**Files:**
- Modify: `neat_insight/mediasrc.py:156-165` (dataclass), `:222-258` (`start_media_stream`), append after `media_stream_identity`
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Produces: `MediaStream.rendition: Optional[str]`, `start_media_stream(index, file_path, transport, codec, source_codec, rendition=None)`, `media_stream_file(index) -> Optional[str]` (absolute path of the file the running stream reads, else `None`).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_fps_renditions.py`:

```python
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
        with mock.patch.object(self.mediasrc.os.path, "isfile", return_value=True):
            with mock.patch.object(self.mediasrc.subprocess, "Popen", return_value=process):
                ok, err = self.mediasrc.start_media_stream(3, "/m/.renditions/demo_15fps.mp4", "rtsp", "h264", "h264", rendition=".renditions/demo_15fps.mp4")
        self.assertTrue(ok, err)
        self.assertEqual(self.mediasrc.media_stream_file(3), "/m/.renditions/demo_15fps.mp4")
        self.assertEqual(self.mediasrc.pipeline_registry[2].rendition, ".renditions/demo_15fps.mp4")
        self.assertIsNone(self.mediasrc.media_stream_file(4))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PY -m unittest tests.test_fps_renditions.MediaStreamRenditionTests -v`
Expected: `TypeError: start_media_stream() got an unexpected keyword argument 'rendition'`.

- [ ] **Step 3: Implement**

In `neat_insight/mediasrc.py`, add the field to the dataclass (after `process`):

```python
    process: Optional[subprocess.Popen] = None
    rendition: Optional[str] = None
```

Change the `start_media_stream` signature and construction:

```python
def start_media_stream(
    index: int,
    file_path: str,
    transport: str = DEFAULT_TRANSPORT,
    codec: str = DEFAULT_CODEC,
    source_codec: Optional[str] = None,
    rendition: Optional[str] = None,
) -> Tuple[bool, Optional[str]]:
```

```python
        stream = MediaStream(
            index=slot,
            file_path=file_path,
            transport=transport,
            codec=codec,
            source_codec=source_codec,
            rtsp_url=rtsp_url,
            rendition=rendition,
        )
```

Append after `media_stream_identity`:

```python
def media_stream_file(index: int) -> Optional[str]:
    """Absolute path of the file the running stream reads (source or rendition), or None."""
    slot = index - 1
    with registry_lock:
        stream = pipeline_registry.get(slot)
        if not stream:
            return None
        if stream.transport != "http" and not (stream.process and stream.process.poll() is None):
            return None
        return stream.file_path
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions tests.test_streaming_sources -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add neat_insight/mediasrc.py tests/test_fps_renditions.py
git commit -m "Track the rendition a media stream reads"
```

---

### Task 5: `app.py` — slot `fps` field, `native_fps`/`active_file` in GET, hide `.renditions`

**Files:**
- Modify: `neat_insight/app.py:37-48` (imports), `:80-83` (env), `:234-272` (`_default_source`, `_normalize_source`), `:1999-2007` (`_collect_video_files`), `:2061-2081` (`_source_with_urls`), `:2114-2155` (`assign_source`)
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Consumes: `renditions.coerce_fps`, `renditions.validate_fps`, `renditions.source_info`, `mediasrc.media_stream_file`.
- Produces: `RENDITIONS_INDEX_FILE: Path` module global (tests monkeypatch it), slot dict key `fps: Optional[int]`, `GET /api/mediasrc` fields `fps`, `native_fps`, `active_file`; `POST /api/mediasrc/assign` accepts `fps`; helpers `_source_native_fps(file_name) -> Optional[int]`, `_active_stream_file(index) -> Optional[str]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_fps_renditions.py`:

```python
from neat_insight import app as app_module
from neat_insight import mediasrc


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

    def test_normalize_source_drops_invalid_persisted_fps(self):
        self.sources_file.write_text('[{"index": 1, "file": "demo.mp4", "state": "stopped", "fps": "bogus"}, {"index": 2, "file": "demo.mp4", "state": "stopped", "fps": 20}]', encoding="utf-8")
        sources = app_module.load_sources()
        self.assertIsNone(sources[0]["fps"])
        self.assertEqual(sources[1]["fps"], 20)

    def test_renditions_directory_is_hidden_from_video_lists(self):
        (self.media_dir / ".renditions").mkdir()
        make_test_clip(self.media_dir / ".renditions" / "demo_abc123_15fps_h264.mp4", fps=15, seconds=0.5)
        self.assertEqual(self.client.get("/api/mediasrc/videos").get_json(), ["demo.mp4"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions.SlotFpsTests -v`
Expected: `AttributeError: module 'neat_insight.app' has no attribute 'RENDITIONS_INDEX_FILE'`.

- [ ] **Step 3: Implement**

In `neat_insight/app.py`:

Imports — add `media_stream_file` to the `neat_insight.mediasrc` import list (keep alphabetical), and after the `from neat_insight.api_docs import api_docs_bp` line add:

```python
from neat_insight import renditions
```

After `DEFAULT_SOURCE_COUNT = env["DEFAULT_SOURCE_COUNT"]`:

```python
RENDITIONS_INDEX_FILE = Path(env["NEAT_INSIGHT_DATA"]) / "renditions.json"
```

`_default_source` — add `"fps": None,` after `"codec": DEFAULT_CODEC,`.

`_normalize_source` — add `"fps": renditions.coerce_fps(src.get("fps")),` to the returned dict after `"codec": codec,`.

`_collect_video_files` — skip hidden directories and files:

```python
def _collect_video_files():
    video_files = []
    for root, dirs, files in os.walk(MEDIA_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fname in files:
            if fname.startswith("."):
                continue
            if Path(fname).suffix.lower() in ALLOWED_EXTENSIONS:
                full_path = Path(root) / fname
                rel = os.path.relpath(full_path, MEDIA_DIR).replace(os.path.sep, "/")
                video_files.append(rel)
    return sorted(video_files)
```

Add two helpers directly above `_source_with_urls`:

```python
def _source_native_fps(file_name: str) -> Optional[int]:
    if not file_name:
        return None
    try:
        _safe_media_path(file_name)
        return renditions.source_info(RENDITIONS_INDEX_FILE, MEDIA_DIR, file_name).get("native_fps")
    except Exception as exc:
        logging.debug("Failed to detect the frame rate of %s: %s", file_name, exc)
        return None


def _active_stream_file(index: Optional[int]) -> Optional[str]:
    if index is None:
        return None
    file_path = media_stream_file(index)
    if not file_path:
        return None
    try:
        return os.path.relpath(file_path, MEDIA_DIR).replace(os.path.sep, "/")
    except ValueError:
        return file_path
```

In `_source_with_urls`, after `enriched["allowed_transports"] = allowed_transports`:

```python
    enriched["fps"] = renditions.coerce_fps(src.get("fps"))
    enriched["native_fps"] = _source_native_fps(src.get("file") or "")
    enriched["active_file"] = _active_stream_file(src.get("index"))
```

In `assign_source`, after `requested_transport = data.get("transport")`:

```python
    fps_requested = "fps" in data
    requested_fps = None
    if fps_requested and data.get("fps") not in (None, ""):
        try:
            requested_fps = renditions.validate_fps(data.get("fps"))
        except ValueError as exc:
            return _json_error(str(exc))
```

and inside the loop replace `src["file"] = file_name` with:

```python
            file_changed = file_name != (src.get("file") or "")
            src["file"] = file_name
            if fps_requested:
                src["fps"] = requested_fps
            elif file_changed:
                src["fps"] = None
```

Update the docstring of `assign_source` to `"""Accept JSON {'index': int, 'file': str, 'transport': str, 'codec': str, 'fps': int|null}; update and restart if already playing. Changing the file resets fps."""`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions tests.test_streaming_sources -v`
Expected: all PASS. (`tests/test_api_docs.py` will fail until Task 7 adds the schema fields only if it validates schemas — it does not; it checks routes. Run it anyway: `$PY -m unittest tests.test_api_docs` → PASS.)

- [ ] **Step 5: Commit**

```bash
git add neat_insight/app.py tests/test_fps_renditions.py
git commit -m "Persist a per-slot FPS and report the native frame rate"
```

---

### Task 6: `app.py` — start/start-bulk/assign-restart go through the rendition

**Files:**
- Modify: `neat_insight/app.py:2114-2155` (`assign_source` restart branch), `:2185-2218` (`start_source`), `:2222-2285` (`start_sources_bulk`); add helpers above `start_source`
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Consumes: `renditions.ensure_rendition`, `renditions.RenditionError`, `renditions.UnsupportedRendition`, `start_media_stream(..., rendition=)`.
- Produces: `_resolve_stream_input(src) -> tuple[Optional[Path], Optional[str], Optional[str], int]` = `(input_path, rendition_rel, error, http_status)`; `_start_source_slot(src) -> tuple[bool, Optional[str], int]` which mutates `src["transport"]`, `src["codec"]`, `src["state"]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_fps_renditions.py`:

```python
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

        def broken_command(source, output, fps, codec, height):
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions.StartWithRenditionTests -v`
Expected: `test_start_with_other_fps_encodes_then_streams_the_rendition` fails (`started` is the source path); MJPEG test fails with 200; bulk test fails.

- [ ] **Step 3: Implement the shared start helper and wire the endpoints**

In `neat_insight/app.py`, insert directly above the `# API: start streaming one assigned media source.` comment:

```python
def _resolve_stream_input(src) -> tuple[Optional[Path], Optional[str], Optional[str], int]:
    """Return (input path, rendition rel path or None, error, http status). Encodes a missing rendition synchronously."""
    file_name = src.get("file") or ""
    fps = renditions.coerce_fps(src.get("fps"))
    if fps is None:
        return MEDIA_DIR / file_name, None, None, 200
    result = None
    try:
        for event in renditions.ensure_rendition(MEDIA_DIR, RENDITIONS_INDEX_FILE, file_name, fps, _source_media_codec(file_name)):
            if event.get("event") == "done":
                result = event
    except renditions.UnsupportedRendition as exc:
        return None, None, str(exc), 400
    except renditions.RenditionError as exc:
        return None, None, f"Encoding {file_name} at {fps} fps failed: {exc}", 500
    if not result:
        return None, None, "Rendition preparation ended unexpectedly", 500
    return Path(result["path"]), result.get("rendition"), None, 200


def _start_source_slot(src) -> tuple[bool, Optional[str], int]:
    """Derive stream settings, prepare the input (source or FPS rendition), start the slot. Mutates src; returns (ok, error, http status)."""
    file_name = src.get("file") or ""
    transport, codec, allowed_transports = _derive_source_stream_settings(file_name, src.get("transport"))
    src["transport"] = transport
    src["codec"] = codec
    if not allowed_transports:
        return False, _codec_detection_error(file_name), 400
    input_path, rendition, error, status = _resolve_stream_input(src)
    if error:
        return False, error, status
    ok, err = start_media_stream(
        src["index"],
        str(input_path),
        src.get("transport"),
        src.get("codec"),
        _source_media_codec(file_name),
        rendition=rendition,
    )
    if not ok:
        return False, err, 500
    src["state"] = "playing"
    return True, None, 200
```

Replace the body of `start_source`'s loop:

```python
    sources = load_sources()
    for src in sources:
        if src["index"] == index:
            if not src.get("file"):
                return _json_error("No file assigned to source")
            ok, err, status = _start_source_slot(src)
            save_sources(sources)
            if not ok:
                return _json_error(err, status)
            return {"success": True}

    return _json_error("Source not found", 404)
```

Update its docstring to: `"""Accept JSON {'index': int}; start the assigned file (or the slot's FPS rendition, encoding it first if missing) and mark the state as playing."""`

Replace the per-target block in `start_sources_bulk` (from `transport, codec, allowed_transports = ...` through the `else: errors.append(...)`) with:

```python
        ok, err, _status = _start_source_slot(src)
        if ok:
            started.append(source_index)
        else:
            errors.append({"index": source_index, "error": err or "Unknown error"})
```

In `assign_source`, replace the `if was_playing and file_name:` block with:

```python
            if was_playing and file_name:
                ok, err, status = _start_source_slot(src)
                if not ok:
                    src["state"] = "stopped"
                    save_sources(sources)
                    return _json_error(err, status)
```

The `transport, codec, _allowed_transports = _derive_source_stream_settings(...)` lines above it stay (they set transport/codec for the not-playing case).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions tests.test_streaming_sources -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add neat_insight/app.py tests/test_fps_renditions.py
git commit -m "Stream the slot's FPS rendition on start, bulk start and restart"
```

---

### Task 7: `POST /api/mediasrc/prepare`, delete-media cleanup, OpenAPI, playbook

**Files:**
- Modify: `neat_insight/app.py` (new route above `start_source`; `delete_media` at `:1847-1882`)
- Modify: `neat_insight/openapi.json`
- Modify: `skills/use-neat-insight/SKILL.md:347-355`
- Modify: `tests/test_fps_renditions.py`

**Interfaces:**
- Produces: `POST /api/mediasrc/prepare` `{index}` → `text/plain` lines: `Encoding {file} at {fps} fps ({encoder})...`, `progress {seconds:.1f}/{total:.1f}` (or `progress {seconds:.1f}` when the duration is unknown), then exactly one of `Rendition ready: {rel}`, `Reusing rendition: {rel}`, `Source frame rate matches; no rendition needed.`, `Error: {message}`. 400 JSON for missing index/file, MJPEG with non-native FPS, unknown codec; 404 for a bad slot.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_fps_renditions.py`:

```python
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
        self.client.post("/api/mediasrc/prepare", json={"index": 1})
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

        def broken_command(source, output, fps, codec, height):
            return ["ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
                    "-i", str(self.media_dir / "missing.mp4"), "-progress", "pipe:1", "-nostats", str(output)]

        with mock.patch.object(renditions, "encode_command", side_effect=broken_command):
            response = self.client.post("/api/mediasrc/prepare", json={"index": 1})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.lines(response)[-1].startswith("Error: "))

    def test_delete_media_removes_renditions_and_records(self):
        self.assign(fps=15)
        self.client.post("/api/mediasrc/prepare", json={"index": 1})
        record = renditions.load_index(self.index_path)["renditions"][0]
        self.assertTrue((self.media_dir / record["path"]).exists())

        response = self.client.post("/api/delete-media", json={"path": "demo.mp4"})

        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.media_dir / record["path"]).exists())
        index = renditions.load_index(self.index_path)
        self.assertEqual(index["renditions"], [])
        self.assertNotIn("demo.mp4", index["sources"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `$PY -m unittest tests.test_fps_renditions.PrepareEndpointTests tests.test_api_docs -v`
Expected: prepare tests get 404 (route missing); `test_api_docs` still passes (route not yet registered).

- [ ] **Step 3: Implement the endpoint and delete cleanup**

In `neat_insight/app.py`, insert directly above the `# API: start streaming one assigned media source.` comment (after the helpers from Task 6):

```python
# API: create or reuse the FPS rendition for one source slot, streaming progress.
@app.post("/api/mediasrc/prepare")
def prepare_source():
    """Accept JSON {'index': int}; stream plain-text progress while the slot's FPS rendition is created or reused."""
    data = request.get_json() or {}
    index = data.get("index")
    if index is None:
        return _json_error("Missing index")

    src = next((s for s in load_sources() if s["index"] == index), None)
    if src is None:
        return _json_error("Source not found", 404)
    file_name = src.get("file") or ""
    if not file_name:
        return _json_error("No file assigned to source")

    fps = renditions.coerce_fps(src.get("fps"))
    source_codec = _source_media_codec(file_name)
    native_fps = _source_native_fps(file_name)
    needs_rendition = fps is not None and fps != native_fps
    if needs_rendition and source_codec == "mjpeg":
        return _json_error("FPS changes are not supported for MJPEG sources")
    if needs_rendition and source_codec not in renditions.PROFILES:
        return _json_error(_codec_detection_error(file_name))

    def generate():
        if fps is None:
            yield "Source frame rate matches; no rendition needed.\n"
            return
        try:
            for event in renditions.ensure_rendition(MEDIA_DIR, RENDITIONS_INDEX_FILE, file_name, fps, source_codec):
                kind = event.get("event")
                if kind == "encoding":
                    yield f"Encoding {event['file']} at {event['fps']} fps ({event['encoder']})...\n"
                elif kind == "progress":
                    total = event.get("total")
                    if total:
                        yield f"progress {event['seconds']:.1f}/{total:.1f}\n"
                    else:
                        yield f"progress {event['seconds']:.1f}\n"
                elif kind == "done":
                    if event.get("native"):
                        yield "Source frame rate matches; no rendition needed.\n"
                    elif event.get("reused"):
                        yield f"Reusing rendition: {event['rendition']}\n"
                    else:
                        yield f"Rendition ready: {event['rendition']}\n"
        except renditions.RenditionError as exc:
            yield f"Error: {exc}\n"

    return Response(stream_with_context(generate()), mimetype="text/plain")
```

In `delete_media`, inside `if full_path.is_file():` after `save_sources(sources)` (still before `full_path.unlink()`):

```python
            try:
                renditions.remove_source(RENDITIONS_INDEX_FILE, MEDIA_DIR, file_name.replace(os.path.sep, "/"))
            except Exception as exc:
                logging.warning("Failed to remove renditions for %s: %s", file_name, exc)
```

- [ ] **Step 4: Document the API**

In `neat_insight/openapi.json`:

Add to `components.schemas.MediaSource.properties` (and keep `required` unchanged):

```json
"fps": {
  "type": ["integer", "null"],
  "minimum": 1,
  "maximum": 240,
  "description": "Requested output frame rate for this slot, or null to stream at the source frame rate."
},
"native_fps": {
  "type": ["integer", "null"],
  "description": "Frame rate detected in the assigned media, rounded to a whole number; null when unassigned or undetectable."
},
"active_file": {
  "type": ["string", "null"],
  "description": "Relative media-library path the running stream reads: the source, or a `.renditions/` file when an FPS rendition is in use. Null when stopped."
}
```

Add to the second `allOf` member of `MediaSourceAssignment.properties`:

```json
"fps": {
  "type": ["integer", "null"],
  "minimum": 1,
  "maximum": 240,
  "description": "Output frame rate for the slot. Omit to keep the current value; send null to stream at the source frame rate. Changing `file` without `fps` resets it to null."
}
```

Add a new path entry after `/api/mediasrc/start`:

```json
"/api/mediasrc/prepare": {
  "post": {
    "tags": ["Media sources"],
    "summary": "Prepare the FPS rendition for one source",
    "description": "Creates or reuses the constant-frame-rate rendition that `/api/mediasrc/start` will stream when the slot's `fps` differs from the media's native frame rate. Streams plain-text progress: `Encoding <file> at <fps> fps (<encoder>)...`, `progress <seconds>/<total>` lines, then one of `Rendition ready: <path>`, `Reusing rendition: <path>`, `Source frame rate matches; no rendition needed.` or `Error: <message>`. Renditions are keyed by source content hash, fps, codec and profile, so replacing a source file never reuses an old rendition. `/api/mediasrc/start` performs the same preparation without progress output when it is skipped.",
    "operationId": "prepareMediaSourceRendition",
    "x-codeSamples": [
      {
        "lang": "Shell",
        "label": "curl",
        "source": "curl -k -N -H \"Content-Type: application/json\" -d '{\"index\":1}' https://<INSIGHT_HOST>:9900/api/mediasrc/prepare"
      }
    ],
    "requestBody": { "$ref": "#/components/requestBodies/SourceIndex" },
    "responses": {
      "200": { "$ref": "#/components/responses/ProgressStream" },
      "400": { "$ref": "#/components/responses/BadRequest" },
      "404": { "$ref": "#/components/responses/NotFound" }
    }
  }
}
```

Append to the `/api/mediasrc/start` description: ` When the slot has an `fps` that differs from the media's native frame rate, the matching rendition is created (synchronously, without progress output) or reused before the stream starts; use `/api/mediasrc/prepare` first to observe progress.`

Validate: `$PY -c "import json; json.load(open('neat_insight/openapi.json'))"`.

In `skills/use-neat-insight/SKILL.md`, the endpoint table at `:347-355`: change the `/api/mediasrc/assign` row's example body to `` JSON `{"index": 1, "file": "video.mp4", "transport": "rtsp", "fps": 15}` `` and append to its description: `` `fps` (whole number 1–240, or null for the source rate) selects the output frame rate; changing `file` without `fps` resets it. ``. Insert a new row after `/api/mediasrc/start`:

```markdown
| `POST` | `/api/mediasrc/prepare` | JSON `{"index": 1}` | Create or reuse the FPS rendition `start` will stream when the slot's `fps` differs from the media's native rate; streams `text/plain` progress ending in `Rendition ready:`, `Reusing rendition:`, `Source frame rate matches`, or `Error:`. `start` does the same silently when `prepare` is skipped. |
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `$PY -m unittest tests.test_fps_renditions tests.test_streaming_sources tests.test_api_docs -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add neat_insight/app.py neat_insight/openapi.json skills/use-neat-insight/SKILL.md tests/test_fps_renditions.py
git commit -m "Add /api/mediasrc/prepare with streamed encoding progress"
```

---

### Task 8: Frontend `fps.js` — pure stepper logic

**Files:**
- Create: `frontend/src/fps.js`
- Create: `frontend/src/fps.test.js`
- Modify: `frontend/package.json` (scripts)

**Interfaces:**
- Produces: `FPS_MIN = 1`, `FPS_MAX = 240`, `FPS_STEP = 5`, `stepFps(value, direction) -> number`, `parseFps(text) -> number | null`, `formatFpsProgress({ seconds, total }) -> string` (e.g. `0:25 / 1:00`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/fps.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { FPS_MAX, FPS_MIN, FPS_STEP, formatFpsProgress, parseFps, stepFps } from './fps.js'

test('constants match the backend range', () => {
  assert.equal(FPS_MIN, 1)
  assert.equal(FPS_MAX, 240)
  assert.equal(FPS_STEP, 5)
})

test('stepFps moves by 5 and clamps to the range', () => {
  assert.equal(stepFps(30, 1), 35)
  assert.equal(stepFps(30, -1), 25)
  assert.equal(stepFps(3, -1), 1)
  assert.equal(stepFps(238, 1), 240)
  assert.equal(stepFps(240, 1), 240)
  assert.equal(stepFps(1, -1), 1)
})

test('parseFps accepts whole numbers in range', () => {
  assert.equal(parseFps('30'), 30)
  assert.equal(parseFps(' 15 '), 15)
  assert.equal(parseFps('240'), 240)
  assert.equal(parseFps('1'), 1)
})

test('parseFps rejects invalid input', () => {
  for (const text of ['', '0', '-3', 'abc', '29.97', '241', '1e2', null, undefined]) {
    assert.equal(parseFps(text), null, `expected ${JSON.stringify(text)} to be rejected`)
  }
})

test('formatFpsProgress renders m:ss pairs', () => {
  assert.equal(formatFpsProgress({ seconds: 25, total: 60 }), '0:25 / 1:00')
  assert.equal(formatFpsProgress({ seconds: 3725.4, total: null }), '1:02:05')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test src/fps.test.js; cd ..`
Expected: `Cannot find module './fps.js'`.

- [ ] **Step 3: Implement**

Create `frontend/src/fps.js`:

```js
// Pure logic behind the per-slot FPS stepper (issue #111). Keep the range in sync with neat_insight/renditions.py.
export const FPS_MIN = 1
export const FPS_MAX = 240
export const FPS_STEP = 5

export function stepFps(value, direction) {
  const next = Number(value) + (direction < 0 ? -FPS_STEP : FPS_STEP)
  return Math.min(FPS_MAX, Math.max(FPS_MIN, next))
}

export function parseFps(text) {
  if (text == null) return null
  const trimmed = String(text).trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (value < FPS_MIN || value > FPS_MAX) return null
  return value
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mmss = `${minutes}:${String(secs).padStart(2, '0')}`
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : mmss
}

export function formatFpsProgress({ seconds, total }) {
  const done = clock(Number(seconds) || 0)
  return Number.isFinite(total) && total > 0 ? `${done} / ${clock(total)}` : done
}
```

Add to `frontend/package.json` `scripts`:

```json
"test:unit": "node --test src/*.test.js",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npm run test:unit; cd ..`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/fps.js frontend/src/fps.test.js frontend/package.json
git commit -m "Add FPS stepper logic with unit tests"
```

---

### Task 9: Frontend — `FpsStepper` in every source row

**Files:**
- Modify: `frontend/src/App.jsx` (imports at top; new component before `export default function App()`; state near `:696`; row JSX `:1961-1987`)
- Modify: `frontend/src/styles.css` (`:712-722`, `:735-751`, `:3251-3253`, `:3289-3295`, plus new rules)

**Interfaces:**
- Consumes: `fps.js` exports; `src.fps`, `src.native_fps`, `src.codec` from `GET /api/mediasrc`; `updateSource(index, patch)`.
- Produces: `FpsStepper` component `({ value, nativeFps, disabled, locked, title, onCommit, onInvalidChange })`; App state `fpsInvalid: { [index]: boolean }`; row grid gains a `112px` column.

- [ ] **Step 1: Add the component and state**

At the top of `frontend/src/App.jsx` with the other imports:

```js
import { formatFpsProgress, parseFps, stepFps } from './fps.js'
```

Insert before `export default function App()` (after `UploadProgressCard`):

```jsx
function FpsStepper({ value, nativeFps, disabled = false, locked = false, title, onCommit, onInvalidChange }) {
  const effective = value ?? nativeFps ?? null
  const [draft, setDraft] = useState(effective == null ? '' : String(effective))
  const [invalid, setInvalid] = useState(false)
  const inert = disabled || locked
  const changed = value != null && nativeFps != null && value !== nativeFps

  useEffect(() => {
    setDraft(effective == null ? '' : String(effective))
    setInvalid(false)
    if (onInvalidChange) onInvalidChange(false)
  }, [effective])

  function markInvalid(next) {
    setInvalid(next)
    if (onInvalidChange) onInvalidChange(next)
  }

  function commit(next) {
    markInvalid(false)
    if (next !== effective) onCommit(next)
  }

  function commitDraft() {
    if (draft.trim() === '') {
      setDraft(effective == null ? '' : String(effective))
      markInvalid(false)
      return
    }
    const parsed = parseFps(draft)
    if (parsed == null) {
      setDraft(effective == null ? '' : String(effective))
      markInvalid(false)
      return
    }
    commit(parsed)
  }

  const className = ['fps-stepper', changed ? 'changed' : '', invalid ? 'invalid' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')
  return (
    <div className={className} title={title} onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Decrease FPS by 5" disabled={inert || effective == null} onClick={() => commit(stepFps(effective, -1))}>−</button>
      <span className="fps-field">
        <input
          inputMode="numeric"
          aria-label="Frames per second"
          aria-invalid={invalid || undefined}
          placeholder="—"
          value={draft}
          disabled={inert}
          onChange={(e) => {
            setDraft(e.target.value)
            markInvalid(e.target.value.trim() !== '' && parseFps(e.target.value) == null)
          }}
          onBlur={commitDraft}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
        />
        <small>fps</small>
      </span>
      <button type="button" aria-label="Increase FPS by 5" disabled={inert || effective == null} onClick={() => commit(stepFps(effective, 1))}>+</button>
    </div>
  )
}
```

Add state after `const [selectedSource, setSelectedSource] = useState(1)`:

```js
  const [fpsInvalid, setFpsInvalid] = useState({})
  const [encodeProgress, setEncodeProgress] = useState({})
  const encodeAbortRef = useRef({})
```

(`useRef`, `useEffect` and `useState` are already imported from React on line 1.)

- [ ] **Step 2: Render the stepper in the row**

In the source row, between the `codec-lock` `<span>` and the play/stop button, insert:

```jsx
                          <FpsStepper
                            value={src.fps ?? null}
                            nativeFps={src.native_fps ?? null}
                            disabled={!isAssigned || !canStream || src.codec === 'mjpeg'}
                            locked={src.state === 'playing' || Boolean(encodeProgress[src.index])}
                            title={!isAssigned ? 'Assign media before choosing a frame rate' : (src.codec === 'mjpeg' ? 'FPS changes are not supported for MJPEG sources' : (src.state === 'playing' ? 'Stop the source to change its frame rate' : `Output frame rate for src${src.index} (source ${src.native_fps ?? '?'} fps)`))}
                            onCommit={(fps) => updateSource(src.index, { fps }).catch((e) => setError(e.message))}
                            onInvalidChange={(bad) => setFpsInvalid((prev) => (prev[src.index] === bad ? prev : { ...prev, [src.index]: bad }))}
                          />
```

Change the play button's `disabled` to `disabled={!canStream || Boolean(fpsInvalid[src.index])}` and its `title` to `title={!canStream ? 'Codec must be detected before streaming' : (fpsInvalid[src.index] ? 'FPS must be a whole number between 1 and 240' : `Start src${src.index}`)}`.

Also disable the file `<select>` while encoding: add `disabled={Boolean(encodeProgress[src.index])}` to it.

- [ ] **Step 3: Styles**

In `frontend/src/styles.css`, change the `.source-row` grid at `:718` to:

```css
  grid-template-columns: 54px 48px minmax(180px, 1fr) 100px 100px 112px auto auto auto;
```

At `:3252` (inside `@media (max-width: 980px)`):

```css
    grid-template-columns: 54px 48px minmax(0, 1fr) 96px 96px 112px auto auto auto;
```

Inside `@media (max-width: 700px)` after `.source-row select { grid-column: 1 / -1; }` add:

```css
  .source-row .fps-stepper {
    grid-column: 1 / -1;
  }
```

After the `.codec-lock.empty` rule add:

```css
.fps-stepper {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 28px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #fff;
  overflow: hidden;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}

.fps-stepper button {
  border: 0;
  border-radius: 0;
  padding: 0;
  background: var(--surface-soft);
  color: #405f72;
  font-size: 15px;
  line-height: 1;
}

.fps-stepper button:first-child {
  border-right: 1px solid var(--line);
}

.fps-stepper button:last-child {
  border-left: 1px solid var(--line);
}

.fps-stepper button:hover:not(:disabled) {
  transform: none;
  background: var(--accent-soft);
}

.fps-field {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  padding: 0 4px;
}

.fps-field input {
  width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 0;
  padding: 0;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 12px;
  background: transparent;
}

.fps-field input:focus-visible {
  box-shadow: none;
}

.fps-field small {
  color: #7b8c9c;
  font-size: 10px;
}

.fps-stepper.changed {
  border-color: rgba(14, 90, 184, 0.45);
  box-shadow: inset 0 0 0 1px rgba(14, 90, 184, 0.12);
}

.fps-stepper.invalid {
  border-color: #edb1be;
  box-shadow: inset 0 0 0 1px rgba(179, 66, 90, 0.2);
}

.fps-stepper.locked {
  opacity: 0.55;
}

.src-state.encoding {
  background: var(--accent-soft);
  color: #174f4c;
}
```

- [ ] **Step 4: Build and check**

Run: `cd frontend && npm run build && cd ..`
Expected: Vite build succeeds with no errors. Then start the backend from the worktree (`$PY -m neat_insight.app --port 9901`, or `NEAT_INSIGHT_FRONTEND_DIST=frontend/dist $PY -m neat_insight.app --port 9901` if the dist path isn't picked up) and open the Streaming Sources tab: each row shows `[−] 30 fps [+]` after assigning a file; `+` sets 35 and the outline turns blue; typing `abc` then blur reverts; typing `0` disables ▶ until blur. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx frontend/src/styles.css
git commit -m "Add a per-slot FPS stepper to the Streaming Sources rows"
```

---

### Task 10: Frontend — prepare-then-start flow with progress and preview-panel states

**Files:**
- Modify: `frontend/src/App.jsx` (`startSource` at `:1471-1478`; row badge/stop button `:1940-1987`; preview panel `:2008-2019`; bulk modal near `:2597`)
- Modify: `frontend/src/styles.css` (new `.preview-loading` rules)

**Interfaces:**
- Consumes: `POST /api/mediasrc/prepare` line protocol (Task 7); `encodeProgress`, `encodeAbortRef` (Task 9); `formatFpsProgress`.
- Produces: `prepareSource(index)`, `readPrepareProgress(response, index)`, `prepareProgressForLine(line, prev)`; `encodeProgress[index] = { label, encoder, seconds, total, percent }`.

- [ ] **Step 1: Add the prepare flow**

Replace `startSource` in `App.jsx` with:

```js
  function prepareProgressForLine(line, prev) {
    const progress = /^progress (\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(line)
    if (progress) {
      const seconds = Number(progress[1])
      const total = progress[2] ? Number(progress[2]) : null
      const percent = total ? Math.min(99, Math.floor((seconds / total) * 100)) : null
      return { ...prev, seconds, total, percent }
    }
    const encoding = /^Encoding .+ at (\d+) fps \((.+)\)\.\.\.$/.exec(line)
    if (encoding) return { ...prev, fps: Number(encoding[1]), encoder: encoding[2], label: `Encoding ${encoding[1]} fps rendition…` }
    return { ...prev, label: line }
  }

  async function readPrepareProgress(response, index) {
    const apply = (line) => setEncodeProgress((prev) => ({ ...prev, [index]: prepareProgressForLine(line, prev[index] || {}) }))
    if (!response.body) {
      const text = await response.text()
      text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach(apply)
      return text
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let pending = ''
    while (true) {
      const { value, done } = await reader.read()
      const chunk = decoder.decode(value || new Uint8Array(), { stream: !done })
      if (chunk) {
        text += chunk
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() || ''
        lines.map((line) => line.trim()).filter(Boolean).forEach(apply)
      }
      if (done) break
    }
    if (pending.trim()) apply(pending.trim())
    return text
  }

  async function prepareSource(index) {
    const controller = new AbortController()
    encodeAbortRef.current[index] = controller
    setEncodeProgress((prev) => ({ ...prev, [index]: { label: 'Preparing rendition…', percent: null, seconds: 0, total: null } }))
    try {
      const response = await fetch('/api/mediasrc/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
        signal: controller.signal
      })
      if (!response.ok) {
        let message = `Prepare failed (${response.status})`
        try {
          const body = await response.json()
          message = body.error || body.message || message
        } catch {}
        throw new Error(message)
      }
      const text = await readPrepareProgress(response, index)
      const errorLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('Error:'))
      if (errorLine) {
        const src = sources.find((s) => s.index === index) || {}
        throw new Error(`Encoding src${index} at ${src.fps} fps failed. Partial output was removed; the source file is unchanged. ${errorLine.replace(/^Error:\s*/, '')}`)
      }
    } finally {
      delete encodeAbortRef.current[index]
      setEncodeProgress((prev) => {
        const next = { ...prev }
        delete next[index]
        return next
      })
    }
  }

  function cancelPrepare(index) {
    const controller = encodeAbortRef.current[index]
    if (controller) controller.abort()
  }

  async function startSource(index) {
    const src = sources.find((s) => s.index === index)
    const needsRendition = Boolean(src) && src.fps != null && src.native_fps != null && src.fps !== src.native_fps
    try {
      if (needsRendition) await prepareSource(index)
      await fetchJson('/api/mediasrc/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index })
      })
    } catch (e) {
      if (e.name === 'AbortError') {
        setUploadStatus(`Cancelled encoding for src${index}.`)
      } else {
        setError(e.message)
      }
    }
    await loadSources()
  }
```

- [ ] **Step 2: Row states**

In the row, replace the state badge with:

```jsx
                          <span className={encodeProgress[src.index] ? 'src-state encoding' : (src.state === 'playing' ? 'src-state playing' : 'src-state stopped')}>
                            {encodeProgress[src.index] ? 'Encoding' : (src.state === 'playing' ? 'Live' : 'Idle')}
                          </span>
```

Change the play/stop conditional to show the stop button while encoding, cancelling the prepare:

```jsx
                          {(src.state === 'playing' || encodeProgress[src.index]) ? (
                            <button
                              className="icon-action-btn stop"
                              onClick={(e) => { e.stopPropagation(); if (encodeProgress[src.index]) cancelPrepare(src.index); else stopSource(src.index) }}
                              aria-label={encodeProgress[src.index] ? `Cancel encoding for src${src.index}` : `Stop src${src.index}`}
                              title={encodeProgress[src.index] ? `Cancel encoding for src${src.index}` : `Stop src${src.index}`}
                            >
```

(keep the existing `<svg>` and closing tags).

- [ ] **Step 3: Preview panel**

Replace the preview `<section>` (`:2008-2019`) with:

```jsx
            <section className="panel">
              <h2>Source Preview: src{currentSource.index}</h2>
              {(() => {
                const info = currentSource
                const progress = encodeProgress[info.index]
                const effectiveFps = info.fps ?? info.native_fps ?? null
                const customFps = info.fps != null && info.native_fps != null && info.fps !== info.native_fps
                const streamingRendition = info.state === 'playing' && info.active_file && info.active_file !== info.file
                const fileDetail = info.file ? [info.file, info.native_fps != null ? `${info.native_fps} fps` : null].filter(Boolean).join(' · ') : 'Not assigned'
                let outputDetail = `${info.transport ? info.transport.toUpperCase() : '-'} / ${codecLabel(info.codec)}`
                if (effectiveFps != null) outputDetail += ` · ${effectiveFps} fps`
                return (
                  <>
                    <p className="hint">File: {fileDetail}</p>
                    <p className="hint">
                      Output: {outputDetail}
                      {streamingRendition && <span className="ok-text"> · streaming rendition <code>{info.active_file}</code></span>}
                      {!streamingRendition && customFps && info.state !== 'playing' && !progress && <span className="muted-text"> (rendition will be created on start)</span>}
                    </p>
                    <div className="preview">
                      <div className="preview-loading" role="status" aria-live="polite">
                        {progress && (
                          <>
                            <div className="upload-progress-track">
                              <div
                                className={Number.isFinite(progress.percent) ? 'upload-progress-bar' : 'upload-progress-bar indeterminate'}
                                style={Number.isFinite(progress.percent) ? { width: `${progress.percent}%` } : undefined}
                              />
                            </div>
                            <span>{progress.label}{Number.isFinite(progress.percent) ? ` ${progress.percent}%` : ''}</span>
                            <span className="muted-text mono">{formatFpsProgress(progress)}{progress.encoder ? ` · ${progress.encoder}` : ''}</span>
                          </>
                        )}
                      </div>
                      {!progress && info.file && sourcePreviewIsMjpeg && <img src={mediaPreviewUrl(info.file)} alt={info.file} />}
                      {!progress && info.file && sourcePreviewIsVideo && <video controls autoPlay muted loop src={`/media/${info.file}`} />}
                      {!progress && info.file && sourcePreviewIsImage && <img src={`/media/${info.file}`} alt={info.file} />}
                      {!info.file && <p>Assign a media file to preview.</p>}
                    </div>
                  </>
                )
              })()}
            </section>
```

In the Bulk Start modal (`:2592-2596`), directly after `<p>How many streams do you want to start?</p>`, add:

```jsx
                <p className="hint">Slots with a custom FPS may take longer to start while renditions are created.</p>
```

- [ ] **Step 4: Styles**

Append to `frontend/src/styles.css` after the `.preview video, .preview img` rule:

```css
.preview-loading {
  display: grid;
  gap: 10px;
  justify-items: center;
  width: min(260px, 100%);
  color: var(--ink-soft);
  font-size: 13px;
  text-align: center;
}

.preview-loading .upload-progress-track {
  width: 100%;
}

/* The live region stays mounted so screen readers announce it; keep it out of the grid while idle. */
.preview-loading:empty {
  display: none;
}

.ok-text {
  color: var(--ok);
}

.muted-text {
  color: #7b8c9c;
}

.mono {
  font-family: var(--font-mono);
  font-size: 11px;
}
```

- [ ] **Step 5: Build and verify manually**

Run: `cd frontend && npm run build && npm run test:unit && cd ..`
Expected: build OK, tests pass.

Manual check with the backend running from the worktree and a real video: set src1 to 15 fps, press ▶ → badge shows *Encoding*, the preview panel shows the determinate bar with `m:ss / m:ss · libx264 baseline`, then the row goes *Live* and the Output line shows "· streaming rendition .renditions/…". Press ■ during a second encode of a different value → "Cancelled encoding" status, no `.tmp` file left in `MEDIA_DIR/.renditions/`. Take the screenshot/recording for the PR now.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.jsx frontend/src/styles.css
git commit -m "Show encoding progress and stream the rendition from the UI"
```

---

### Task 11: Reusable test script and CI job

**Files:**
- Create: `scripts/test-fps-renditions.sh`
- Modify: `.github/workflows/vulcan-ci.yml` (new `tests` job; `build.needs`)

**Interfaces:**
- Produces: `scripts/test-fps-renditions.sh` (exit 0 only when every FPS test passes; refuses to skip when ffmpeg is missing), CI job `tests` that the `build` matrix depends on.

- [ ] **Step 1: Create the script**

```bash
#!/usr/bin/env bash
# Runs the FPS-rendition test suite for issue #111: backend integration tests
# against real ffmpeg/ffprobe and the frontend FPS-control unit tests.
# Usage: scripts/test-fps-renditions.sh   (PYTHON=/path/to/python to override the interpreter)
set -euo pipefail

cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"

for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required on PATH (install FFmpeg)" >&2
    exit 1
  fi
done
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

export NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS=1
export NEAT_METRICS_ZMQ_ENDPOINT="${NEAT_METRICS_ZMQ_ENDPOINT:-tcp://127.0.0.1:55580}"

echo "== Backend: tests.test_fps_renditions"
"$PYTHON" -m unittest tests.test_fps_renditions -v

echo "== Frontend: npm run test:unit"
npm --prefix frontend run test:unit
```

Run: `chmod +x scripts/test-fps-renditions.sh && PYTHON=$PY scripts/test-fps-renditions.sh`
Expected: both suites pass, exit 0. Then `PATH=/nonexistent scripts/test-fps-renditions.sh; echo "exit=$?"` → prints the ffmpeg error and `exit=1`.

- [ ] **Step 2: Add the CI job**

In `.github/workflows/vulcan-ci.yml`, insert before `  build:` under `jobs:`:

```yaml
  tests:
    name: Tests (ffmpeg)
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Set up Python
        uses: actions/setup-python@v6
        with:
          python-version: "3.11"

      - name: Set up Node
        uses: actions/setup-node@v5
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Install FFmpeg
        run: |
          set -euo pipefail
          sudo apt-get update
          sudo apt-get install -y ffmpeg

      - name: Install Python dependencies
        run: |
          set -euo pipefail
          python -m pip install --upgrade pip setuptools wheel
          python -m pip install -e .

      - name: Install frontend dependencies
        run: npm ci --prefix frontend

      - name: Run FPS rendition tests
        run: scripts/test-fps-renditions.sh

      - name: Run the full unit-test suite
        run: python -m unittest discover tests -v
```

Add `needs: tests` to the `build` job (directly under `runs-on: ubuntu-latest`), so the matrix waits for the tests and a failure fails the workflow.

Validate YAML: `$PY -c "import yaml,sys; yaml.safe_load(open('.github/workflows/vulcan-ci.yml'))"` (if `yaml` is missing, `npx --yes js-yaml .github/workflows/vulcan-ci.yml >/dev/null`).

- [ ] **Step 3: Full local run**

Run: `PYTHON=$PY scripts/test-fps-renditions.sh && $PY -m unittest discover tests -v 2>&1 | tail -3`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-fps-renditions.sh .github/workflows/vulcan-ci.yml
git commit -m "Run the FPS rendition tests locally and in CI"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs/user-interface.md` (Streaming Sources section, `:44+`)
- Modify: `docs/api-reference.md` (common automation flow, `:29+`)
- Locale mirrors under `docs/i18n/` are regenerated by the `sima-i18n` CLI, not edited by hand (see Step 3)

- [ ] **Step 1: User docs**

Append to the `## Streaming Sources` section of `docs/user-interface.md`, after the codec/transport rules:

```markdown
### Frame rate

Each source row has an FPS control between the codec badge and the play button. When you assign a video, the control shows the frame rate detected in the file. Use the `−` and `+` buttons to change it in steps of 5, or type a whole number between 1 and 240.

When the value differs from the file's native frame rate, starting the source first creates a *rendition*: a copy of the video re-encoded at the requested constant frame rate with the same encoding rules as the Insight media catalog (H.264 baseline or H.265 main, `yuv420p`, no B-frames, one reference frame, a closed one-second GOP). The row shows **Encoding** with a progress bar in the preview panel, then goes **Live** streaming the rendition. Renditions are stored under `.renditions/` in the media directory and recorded in `renditions.json`, so the next start — including after restarting Insight — reuses them instead of encoding again. Replacing a source file with different content invalidates its old renditions. Deleting a source file removes its renditions. If encoding fails, the source file is untouched and no partial rendition is kept.

MJPEG sources cannot change frame rate; the control is disabled for them.
```

- [ ] **Step 2: API docs**

In `docs/api-reference.md` under `## Common automation flow`, add after the assign step:

```markdown
To stream at a different frame rate, include `fps` in the assignment and optionally watch the encode:

```sh
curl -k -H "Content-Type: application/json" -d '{"index":1,"file":"person_clip.mp4","fps":15}' https://localhost:9900/api/mediasrc/assign
curl -k -N -H "Content-Type: application/json" -d '{"index":1}' https://localhost:9900/api/mediasrc/prepare
curl -k -H "Content-Type: application/json" -d '{"index":1}' https://localhost:9900/api/mediasrc/start
```

`prepare` streams `progress <seconds>/<total>` lines and ends with `Rendition ready: …`, `Reusing rendition: …`, or `Error: …`. `start` performs the same preparation silently when `prepare` is skipped.
```

- [ ] **Step 3: i18n mirrors**

`docs/i18n/README.md` says mirrors are produced by the `sima-i18n` CLI and `translation-sources.json` must not be edited by hand. If `sima-i18n` is on PATH, run `sima-i18n translate --locale ko --all --write` (and `ja`, `zh-Hant`, `uk`), then `sima-i18n check --require-complete`. If it is not installed (it is not on this machine), do **not** hand-edit the mirrors; add this line to the PR description instead: "Docs: `docs/user-interface.md` and `docs/api-reference.md` changed; locale mirrors need `sima-i18n translate` before release."

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: describe the FPS control and renditions"
```

---

## PR evidence checklist (manual, from the spec)

Run from a real server built from this branch (`./build.sh --install`, then `neat-insight --port 9900`) with a real video in the media library:

```sh
curl -sk -X POST https://localhost:9900/api/mediasrc/assign -H 'Content-Type: application/json' -d '{"index":1,"file":"demo.mp4","fps":15}'
curl -sk -N -X POST https://localhost:9900/api/mediasrc/prepare -H 'Content-Type: application/json' -d '{"index":1}'
curl -sk -X POST https://localhost:9900/api/mediasrc/start -H 'Content-Type: application/json' -d '{"index":1}'
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,pix_fmt,has_b_frames,profile -of default=nw=1 rtsp://localhost:8554/src1
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate,r_frame_rate,pix_fmt,has_b_frames,profile,level -of default=nw=1 ~/.simaai/neat-insight/media/.renditions/demo_*_15fps_h264.mp4
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv ~/.simaai/neat-insight/media/.renditions/demo_*_15fps_h264.mp4 | grep K   # keyframes at 0,1,2,… seconds
# restart neat-insight; start slot 1 again; confirm no ffmpeg encode process appears (pgrep -af 'ffmpeg.*renditions') and GET /api/mediasrc shows the same active_file
```

Record: Insight ref, ffmpeg version, source video, requested FPS values, observed ffprobe values, reuse evidence, CI run link, screenshot/recording of the stepper and the live stream.
