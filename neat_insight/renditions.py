"""FPS-specific renditions of media-library videos.

A rendition is a re-encoded copy of a source video at a different constant
frame rate. Encoder arguments and validators are ported from
media-assets/build_media_assets.py so renditions follow the same contract as
catalog assets and stream through mediasrc with ``-c:v copy``.
"""
import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

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


# Level limits from the codec specs, lowest first:
# (level, max picture size, max pictures-per-second throughput, max bitrate in bit/s).
# H.264 (ITU-T H.264 Annex A, table A-1) counts 16x16 macroblocks: MaxFS, MaxMBPS and MaxBR for the
# Baseline/Main/Extended profiles (1000 bit/s units).
H264_LEVELS = (
    ("3.0", 1620, 40500, 10_000_000),
    ("3.1", 3600, 108000, 14_000_000),
    ("3.2", 5120, 216000, 20_000_000),
    ("4.0", 8192, 245760, 20_000_000),
    ("4.2", 8704, 522240, 50_000_000),
    ("5.0", 22080, 589824, 135_000_000),
    ("5.1", 36864, 983040, 240_000_000),
    ("5.2", 36864, 2073600, 240_000_000),
    ("6.0", 139264, 4177920, 240_000_000),
    ("6.1", 139264, 8355840, 480_000_000),
    ("6.2", 139264, 16711680, 800_000_000),
)
# H.265 (ITU-T H.265 Annex A, tables A-8 and A-9, Main tier) counts luma samples: MaxLumaPs, MaxLumaSr
# and the Main-tier MaxBR (the encoder is pinned to high-tier=0).
H265_LEVELS = (
    ("3.0", 552960, 16588800, 6_000_000),
    ("3.1", 983040, 33177600, 10_000_000),
    ("4.0", 2228224, 66846720, 12_000_000),
    ("4.1", 2228224, 133693440, 20_000_000),
    ("5.0", 8912896, 267386880, 25_000_000),
    ("5.1", 8912896, 534773760, 40_000_000),
    ("5.2", 8912896, 1069547520, 60_000_000),
    ("6.0", 35651584, 1069547520, 60_000_000),
    ("6.1", 35651584, 2139095040, 120_000_000),
    ("6.2", 35651584, 4278190080, 240_000_000),
)


def _bitrate_bits(value: str) -> int:
    """'35M' -> 35_000_000, '500k' -> 500_000."""
    units = {"k": 1_000, "m": 1_000_000}
    return int(float(value[:-1]) * units[value[-1].lower()]) if value[-1].lower() in units else int(value)


def video_level(codec: str, width: int, height: int, fps: int) -> str:
    """Lowest level whose picture-size and throughput limits cover `width`x`height` at `fps`.

    The catalog builder keyed the level on the resolution tier alone, which was
    enough for its fixed fps grid; any fps from FPS_MIN..FPS_MAX needs the real
    limits. Levels below 3.0 are never used, matching the catalog.
    """
    if codec == "h264":
        axes = (-(-width // 16), -(-height // 16))
        table = H264_LEVELS
    elif codec == "h265":
        axes = (width, height)
        table = H265_LEVELS
    else:
        raise ValueError(f"unsupported rendition codec: {codec}")
    picture = axes[0] * axes[1]
    rate = picture * fps
    bitrate = _bitrate_bits(video_bitrate(height, fps))  # the rendition is encoded at exactly this rate
    for level, max_picture, max_rate, max_bitrate in table:
        # Both specs also bound each axis on its own: width and height may each be at most
        # sqrt(8 * max picture size), which is what catches very wide or very tall pictures.
        # The bitrate cap matters for HEVC Main tier (4K at 35 Mbps needs 5.1, not 5.0).
        if picture <= max_picture and rate <= max_rate and max(axes) ** 2 <= 8 * max_picture and bitrate <= max_bitrate:
            return level
    raise UnsupportedRendition(f"{width}x{height} at {fps} fps exceeds the highest {codec} level ({table[-1][0]})")


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


def expected_level_code(codec: str, width: int, height: int, fps: int) -> int:
    multiplier = 10 if codec == "h264" else 30
    return round(float(video_level(codec, width, height, fps)) * multiplier)


def rendition_key(sha: str, fps: int, codec: str) -> str:
    return f"{sha}:{fps}:{codec}:{PROFILES[codec]}"


def rendition_rel_path(rel_path: str, sha: str, fps: int, codec: str) -> str:
    # 16 hex digits (64 bits) of the source digest: the index trusts the path to be unique per key,
    # and two sources with the same stem, fps and codec must not share one output file.
    return f"{RENDITIONS_DIRNAME}/{Path(rel_path).stem}_{sha[:16]}_{fps}fps_{codec}.mp4"


def _codec_args(codec: str, width: int, height: int, fps: int) -> list[str]:
    if codec not in PROFILES:
        raise ValueError(f"unsupported rendition codec: {codec}")
    level = video_level(codec, width, height, fps)
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
        f"level-idc={level}:high-tier=0:keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:ref=1:open-gop=0:log-level=error:repeat-headers=1",
        "-bsf:v", f"hevc_metadata=aud=remove,hevc_metadata=aud=insert:tick_rate={fps}/1",
    ]


def encode_command(source: Path, output: Path, fps: int, codec: str, width: int, height: int) -> list[str]:
    """ffmpeg argv that writes a constant-frame-rate rendition of `source` to `output`."""
    return [
        "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", str(source),
        "-map", "0:v:0", "-an",
        "-vf", f"setpts=PTS-STARTPTS,fps={fps}",
        "-fps_mode", "cfr",
        *_codec_args(codec, width, height, fps),
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


def _cached_entry(index_path: Path, rel_path: str) -> Optional[dict]:
    with _index_lock:
        entry = load_index(index_path)["sources"].get(rel_path)
    return entry if isinstance(entry, dict) else None


def _for_current_stat(source_path: Path, stat, compute):
    """Run `compute` outside the index lock; redo it once if the file changed while it ran."""
    value = compute()
    current = source_path.stat()
    if (current.st_size, current.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        return compute(), current
    return value, stat


def _source_entry(stat, stream: dict) -> dict:
    return {
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "native_fps": detect_fps(stream),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "duration": _float_or_none(stream.get("duration")),
    }


def source_info(index_path: Path, media_dir: Path, rel_path: str) -> dict:
    """Cached probe of a source: {size, mtime_ns, native_fps, width, height, duration[, sha256]}; re-probes when size or mtime change."""
    source_path = media_dir / rel_path
    stat = source_path.stat()
    entry = _cached_entry(index_path, rel_path)
    if _stat_matches(entry, stat) and "native_fps" in entry:
        return dict(entry)
    stream, stat = _for_current_stat(source_path, stat, lambda: probe_video(source_path))
    fresh = _source_entry(stat, stream)
    with _index_lock:
        index = load_index(index_path)
        entry = index["sources"].get(rel_path)
        if _stat_matches(entry, stat) and entry.get("sha256"):
            fresh["sha256"] = entry["sha256"]
        index["sources"][rel_path] = fresh
        save_index(index_path, index)
    return dict(fresh)


def source_infos(index_path: Path, media_dir: Path, rel_paths: list[str]) -> dict[str, dict]:
    """source_info for many files with one index load and at most one save; files that fail to stat/probe are omitted."""
    stats = {}
    for rel_path in dict.fromkeys(rel_paths):
        try:
            stats[rel_path] = (media_dir / rel_path).stat()
        except OSError as exc:
            logging.debug("Cannot stat the media source %s: %s", rel_path, exc)
    if not stats:
        return {}
    with _index_lock:
        cached = load_index(index_path)["sources"]
    infos: dict[str, dict] = {}
    probed: dict[str, tuple[Any, dict]] = {}
    for rel_path, stat in stats.items():
        entry = cached.get(rel_path)
        if _stat_matches(entry, stat) and "native_fps" in entry:
            infos[rel_path] = dict(entry)
            continue
        source_path = media_dir / rel_path
        try:
            stream, stat = _for_current_stat(source_path, stat, lambda: probe_video(source_path))
        except (OSError, RenditionError, subprocess.SubprocessError) as exc:
            logging.debug("Cannot probe the media source %s: %s", rel_path, exc)
            continue
        probed[rel_path] = (stat, _source_entry(stat, stream))
    if probed:
        with _index_lock:
            index = load_index(index_path)
            for rel_path, (stat, fresh) in probed.items():
                entry = index["sources"].get(rel_path)
                if _stat_matches(entry, stat) and entry.get("sha256"):
                    fresh["sha256"] = entry["sha256"]
                index["sources"][rel_path] = fresh
            save_index(index_path, index)
        infos.update({rel_path: dict(fresh) for rel_path, (_stat, fresh) in probed.items()})
    return infos


def source_hash(index_path: Path, media_dir: Path, rel_path: str) -> str:
    """SHA-256 of the source content, cached in the index and validated by size + mtime_ns."""
    source_path = media_dir / rel_path
    stat = source_path.stat()
    entry = _cached_entry(index_path, rel_path)
    if _stat_matches(entry, stat) and entry.get("sha256"):
        return entry["sha256"]
    digest, stat = _for_current_stat(source_path, stat, lambda: sha256_file(source_path))
    with _index_lock:
        index = load_index(index_path)
        entry = index["sources"].get(rel_path)
        entry = dict(entry) if _stat_matches(entry, stat) else {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
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


def record_sources(record: dict) -> list[str]:
    """Every source path that claims `record`. Renditions are content-addressed, so byte-identical
    files share one; older records carry only `source_file`."""
    sources = record.get("source_files")
    if isinstance(sources, list) and sources:
        return [str(path) for path in sources]
    single = record.get("source_file")
    return [str(single)] if single else []


def _release_source(record: dict, rel_path: str, media_dir: Path) -> bool:
    """Drop `rel_path`'s claim on `record`; unlink the file and return False when no claim is left."""
    remaining = [path for path in record_sources(record) if path != rel_path]
    if remaining:
        record["source_files"] = remaining
        record["source_file"] = remaining[0]
        return True
    rel_out = record.get("path")
    if rel_out:
        (media_dir / rel_out).unlink(missing_ok=True)
    return False


def claim_rendition(index_path: Path, media_dir: Path, key: str, rel_path: str, digest: str) -> None:
    """Record that `rel_path` (a byte-identical file) also relies on the rendition stored under `key`.

    Like add_rendition, this also releases `rel_path`'s claims on renditions of its previous
    content (a different source digest), unlinking any it was the last claimant of.
    """
    with _index_lock:
        index = load_index(index_path)
        changed = False
        kept = []
        for record in index["renditions"]:
            if record.get("key") == key:
                sources = record_sources(record)
                if rel_path not in sources:
                    record["source_files"] = [*sources, rel_path]
                    record.setdefault("source_file", sources[0] if sources else rel_path)
                    changed = True
            elif rel_path in record_sources(record) and record.get("source_sha256") != digest:
                changed = True
                if not _release_source(record, rel_path, media_dir):
                    continue
            kept.append(record)
        if changed:
            index["renditions"] = kept
            save_index(index_path, index)


def add_rendition(index_path: Path, record: dict, media_dir: Path) -> None:
    """Store `record`, replacing the same key and releasing the source's claim on renditions of its old content.

    A rendition claimed by other byte-identical files survives; only one whose last claimant
    was replaced is unlinked.
    """
    source_file = record.get("source_file")
    digest = record.get("source_sha256")
    record.setdefault("source_files", [source_file] if source_file else [])
    with _index_lock:
        index = load_index(index_path)
        kept = []
        for existing in index["renditions"]:
            if existing.get("key") == record["key"]:
                continue
            if source_file in record_sources(existing) and existing.get("source_sha256") != digest:
                if not _release_source(existing, source_file, media_dir):
                    continue
            kept.append(existing)
        kept.append(record)
        index["renditions"] = kept
        save_index(index_path, index)


def iter_packets(path: Path) -> Iterator[tuple[float, float, bool]]:
    """Yield (pts_time, dts_time, is_keyframe) per video packet, streaming ffprobe's CSV output.

    A multi-hour high-fps rendition has millions of packets; reading them line by line keeps
    memory constant and needs no overall timeout, so a long validation cannot fail after the
    (much longer) encode already succeeded.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RenditionError("ffprobe is not installed; install FFmpeg and ensure ffprobe is on PATH.")
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0", str(path)]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as exc:
        raise RenditionError(f"ffprobe failed for {path.name}: {exc}") from exc
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            fields = line.split(",")
            try:
                yield float(fields[0]), float(fields[1]), "K" in (fields[2] if len(fields) > 2 else "")
            except (IndexError, ValueError) as exc:
                raise RenditionError(f"{path.name} contains a packet without usable PTS/DTS timestamps") from exc
        stderr = proc.stderr.read()
        if proc.wait() != 0:
            raise RenditionError(f"ffprobe failed for {path.name}: {stderr.strip() or proc.returncode}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        proc.stderr.close()


def probe_packets(path: Path) -> list[tuple[float, float, bool]]:
    """(pts_time, dts_time, is_keyframe) per video packet, fully materialised; use iter_packets for long files."""
    return list(iter_packets(path))


def probe_reference_frames(path: Path) -> int:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RenditionError("ffmpeg is not installed; install FFmpeg and ensure ffmpeg is on PATH.")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "verbose", "-i", str(path), "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-f", "null", "-"]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=60)
    except (subprocess.SubprocessError, ValueError) as exc:
        raise RenditionError(f"ffmpeg failed for {path.name}: {exc}") from exc
    match = re.search(r"Video:.*?([0-9]+) reference frame", proc.stderr)
    if not match:
        raise RenditionError(f"Could not determine the reference-frame count for {path.name}")
    return int(match.group(1))


def _validate_timestamps(path: Path, fps: int, packets: Iterable[tuple[float, float, bool]]) -> None:
    """Check the CFR/keyframe contract one packet at a time; `packets` may be a lazy iterator of any length."""
    tolerance = 1e-5
    interval = 1.0 / fps
    previous = None
    keyframes = 0
    for pts, dts, is_key in packets:
        if previous is None and (abs(pts) > tolerance or abs(dts) > tolerance):
            raise RenditionError(f"{path.name} packet timestamps do not start at zero")
        if abs(pts - dts) > tolerance or (previous is not None and abs(pts - previous - interval) > tolerance):
            raise RenditionError(f"{path.name} packet timestamps are reordered or not constant frame rate")
        at_whole_second = abs(pts - round(pts)) <= tolerance
        if is_key:
            if abs(pts - keyframes) > tolerance:
                raise RenditionError(f"{path.name} does not have a closed one-second keyframe cadence starting at zero")
            keyframes += 1
        elif at_whole_second or pts > keyframes + tolerance:
            # The packet at each whole second must itself be a keyframe; passing the next expected
            # keyframe time without one means the encoder ignored the GOP settings.
            raise RenditionError(f"{path.name} is missing the keyframe expected at {keyframes} s")
        previous = pts
    if keyframes == 0:
        raise RenditionError(f"{path.name} does not have a closed one-second keyframe cadence starting at zero")


def validate_rendition(path: Path, fps: int, codec: str, width: int, height: int) -> None:
    """Raise RenditionError unless `path` meets the catalog contract for `fps`/`codec`."""
    stream = probe_video(path)
    expected = {
        "codec_name": FFMPEG_CODEC_NAMES[codec],
        "profile": "Constrained Baseline" if codec == "h264" else "Main",
        "pix_fmt": "yuv420p",
        "has_b_frames": 0,
        "level": expected_level_code(codec, width, height, fps),
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
    _validate_timestamps(path, fps, iter_packets(path))


# An ffmpeg -progress line is "key=value" with a lower-case key (frame, out_time_us, stream_0_0_q, …);
# anything else on the merged stdout/stderr is a diagnostic, even when it contains "=".
_PROGRESS_LINE = re.compile(r"[a-z_][a-z0-9_]*=")

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
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    if width <= 0 or height <= 0:
        raise RenditionError(f"Cannot determine the resolution of {rel_path}")
    video_level(source_codec, width, height, fps)  # reject impossible fps/size combinations before any work

    digest = source_hash(index_path, media_dir, rel_path)
    key = rendition_key(digest, fps, source_codec)
    with _lock_for(key):
        existing = find_rendition(index_path, media_dir, key)
        if existing:
            claim_rendition(index_path, media_dir, key, rel_path, digest)  # a byte-identical file under another name shares it
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

        cmd = encode_command(source_path, tmp, fps, source_codec, width, height)
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
                    if not _PROGRESS_LINE.match(line):
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
        finally:
            if process.stdout:
                process.stdout.close()

        if return_code != 0:
            tmp.unlink(missing_ok=True)
            raise RenditionError("; ".join(diagnostics[-4:]) or f"ffmpeg exited with status {return_code}")
        try:
            validate_rendition(tmp, fps, source_codec, width, height)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

        # On POSIX an unlinked source stays readable through ffmpeg's open descriptor, so the
        # encode succeeds even if delete-media (or a replacement upload) ran meanwhile. The final
        # source check, the rename and the record insertion happen as one step under the index
        # lock: delete-media unlinks first and then takes the same lock to remove records, so a
        # publish that wins the race is cleaned up by that removal and one that loses sees no file.
        digest_of_output = sha256_file(tmp)
        with _index_lock:
            try:
                current = source_path.stat()
            except OSError:
                current = None
            if current is None or (current.st_size, current.st_mtime_ns) != (info.get("size"), info.get("mtime_ns")):
                tmp.unlink(missing_ok=True)
                raise RenditionError(f"{rel_path} was removed or replaced while its rendition was being encoded")

            tmp.replace(output)
            try:
                record = {
                    "key": key,
                    "source_file": rel_path,
                    "source_files": [rel_path],
                    "source_sha256": digest,
                    "fps": fps,
                    "codec": source_codec,
                    "profile": PROFILES[source_codec],
                    "path": rel_out,
                    "sha256": digest_of_output,
                    "bytes": output.stat().st_size,
                    "width": info.get("width"),
                    "height": height,
                    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                add_rendition(index_path, record, media_dir)
            except BaseException:
                # Usage and Clear renditions only see indexed files, so a rendition that was
                # renamed into place but never recorded (e.g. the volume filled while writing
                # renditions.json) would be unreclaimable. Take the file down with the failure.
                output.unlink(missing_ok=True)
                raise
        yield {"event": "done", "path": str(output), "rendition": rel_out, "reused": False, "native": False}


def rendition_usage(index_path: Path, media_dir: Path) -> tuple[int, int]:
    """(count, total bytes) of stored renditions; records whose file is gone are pruned first."""
    with _index_lock:
        index = load_index(index_path)
        kept = []
        total_bytes = 0
        for record in index["renditions"]:
            rel = record.get("path") if isinstance(record, dict) else None
            if not rel or not (media_dir / rel).is_file():
                continue
            kept.append(record)
            size = record.get("bytes")
            total_bytes += size if isinstance(size, int) else (media_dir / rel).stat().st_size
        if len(kept) != len(index["renditions"]):
            index["renditions"] = kept
            save_index(index_path, index)
        return len(kept), total_bytes


def clear_renditions(index_path: Path, media_dir: Path, keep: Optional[set[str]] = None) -> tuple[list[str], int]:
    """Delete every rendition file and record except the relative paths in `keep`.
    Returns (removed relative paths, freed bytes). The `sources` probe/hash cache is left untouched."""
    keep = keep or set()
    with _index_lock:
        index = load_index(index_path)
        kept = []
        removed = []
        freed_bytes = 0
        for record in index["renditions"]:
            rel = record.get("path") if isinstance(record, dict) else None
            if not rel:
                continue
            if rel in keep:
                kept.append(record)
                continue
            output = media_dir / rel
            try:
                freed_bytes += output.stat().st_size
            except OSError:
                pass
            output.unlink(missing_ok=True)
            removed.append(rel)
        index["renditions"] = kept
        save_index(index_path, index)
        return removed, freed_bytes


def remove_source(index_path: Path, media_dir: Path, rel_path: str) -> list[str]:
    """Forget a source: drop its cache entry and delete its rendition files and records. Returns removed rendition paths."""
    with _index_lock:
        index = load_index(index_path)
        index["sources"].pop(rel_path, None)
        removed = []
        kept = []
        for record in index["renditions"]:
            if rel_path not in record_sources(record):
                kept.append(record)
                continue
            if _release_source(record, rel_path, media_dir):
                kept.append(record)  # other byte-identical files still rely on it
                continue
            if record.get("path"):
                removed.append(record["path"])
        index["renditions"] = kept
        save_index(index_path, index)
        return removed
