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
        f"level-idc={level}:high-tier=0:keyint={fps}:min-keyint={fps}:scenecut=0:bframes=0:ref=1:open-gop=0:log-level=error:repeat-headers=1",
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


def add_rendition(index_path: Path, record: dict, media_dir: Path) -> None:
    """Store `record`, replacing the same key and pruning renditions orphaned by a replaced source."""
    source_file = record.get("source_file")
    digest = record.get("source_sha256")
    with _index_lock:
        index = load_index(index_path)
        kept = []
        for existing in index["renditions"]:
            if existing.get("key") == record["key"]:
                continue
            if existing.get("source_file") == source_file and existing.get("source_sha256") != digest:
                rel_out = existing.get("path")
                if rel_out:
                    (media_dir / rel_out).unlink(missing_ok=True)
                continue
            kept.append(existing)
        kept.append(record)
        index["renditions"] = kept
        save_index(index_path, index)


def probe_packets(path: Path) -> list[tuple[float, float, bool]]:
    """(pts_time, dts_time, is_keyframe) per video packet."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RenditionError("ffprobe is not installed; install FFmpeg and ensure ffprobe is on PATH.")
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "json", str(path)]
    try:
        data = json.loads(subprocess.check_output(cmd, text=True, timeout=60))
    except (subprocess.SubprocessError, ValueError) as exc:
        raise RenditionError(f"ffprobe failed for {path.name}: {exc}") from exc
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
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=60)
    except (subprocess.SubprocessError, ValueError) as exc:
        raise RenditionError(f"ffmpeg failed for {path.name}: {exc}") from exc
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
            validate_rendition(tmp, fps, source_codec, height)
        except BaseException:
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
        add_rendition(index_path, record, media_dir)
        yield {"event": "done", "path": str(output), "rendition": rel_out, "reused": False, "native": False}


def remove_source(index_path: Path, media_dir: Path, rel_path: str) -> list[str]:
    """Forget a source: drop its cache entry and delete its rendition files and records. Returns removed rendition paths."""
    with _index_lock:
        index = load_index(index_path)
        index["sources"].pop(rel_path, None)
        removed = []
        kept = []
        for record in index["renditions"]:
            if record.get("source_file") != rel_path:
                kept.append(record)
                continue
            rel_out = record.get("path")
            if rel_out:
                (media_dir / rel_out).unlink(missing_ok=True)
                removed.append(rel_out)
        index["renditions"] = kept
        save_index(index_path, index)
        return removed
