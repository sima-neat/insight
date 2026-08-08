#!/usr/bin/env python3
"""Build reusable Insight media assets from raw source videos.

The generated folder is intended to be published under the artifact bucket's
`media-assets/` prefix. The script keeps source configuration small and
declarative while centralizing the rendition matrix, ffmpeg arguments, output
layout, and index generation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

USER_AGENT = "neat-insight-media-assets/1.0"


@dataclass(frozen=True)
class Rendition:
    profile: str
    height: int
    fps: int
    codec: str
    extension: str
    preview: bool = False


RENDITIONS: tuple[Rendition, ...] = (
    Rendition("4kp30", 2160, 30, "h264", "mp4"),
    Rendition("4kp30", 2160, 30, "hevc", "mp4"),
    Rendition("4kp30", 2160, 30, "mjpeg", "avi"),
    Rendition("1080p120", 1080, 120, "h264", "mp4"),
    Rendition("1080p120", 1080, 120, "hevc", "mp4"),
    Rendition("1080p120", 1080, 120, "mjpeg", "avi"),
    Rendition("1080p30", 1080, 30, "h264", "mp4"),
    Rendition("1080p30", 1080, 30, "hevc", "mp4"),
    Rendition("1080p30", 1080, 30, "mjpeg", "avi"),
    Rendition("720p60", 720, 60, "h264", "mp4"),
    Rendition("720p60", 720, 60, "hevc", "mp4"),
    Rendition("720p60", 720, 60, "mjpeg", "avi"),
    Rendition("720p30", 720, 30, "h264", "mp4"),
    Rendition("720p30", 720, 30, "hevc", "mp4"),
    Rendition("720p30", 720, 30, "mjpeg", "avi"),
    Rendition("720p20", 720, 20, "h264", "mp4"),
    Rendition("720p20", 720, 20, "hevc", "mp4"),
    Rendition("720p10", 720, 10, "h264", "mp4"),
    Rendition("720p10", 720, 10, "hevc", "mp4"),
    Rendition("480p30", 480, 30, "h264", "mp4"),
    Rendition("480p30", 480, 30, "hevc", "mp4"),
    Rendition("480p30", 480, 30, "mjpeg", "avi"),
    Rendition("preview_320p30", 320, 30, "h264", "mp4", preview=True),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build Insight media asset renditions."
    )
    parser.add_argument(
        "--sources", type=Path, required=True, help="Path to sources.json"
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="Output folder for converted assets"
    )
    parser.add_argument(
        "--raw-cache",
        type=Path,
        default=None,
        help="Folder for downloaded raw inputs. Defaults to a temporary directory.",
    )
    parser.add_argument(
        "--existing-index",
        type=Path,
        default=None,
        help="Existing published index.json used to skip already-published renditions.",
    )
    parser.add_argument(
        "--merge-index",
        type=Path,
        action="append",
        default=[],
        help="Additional index.json file to merge into the generated metadata. Can be passed multiple times.",
    )
    parser.add_argument(
        "--source-id",
        action="append",
        default=[],
        help="Build only the given source id. Can be passed multiple times.",
    )
    parser.add_argument(
        "--profile",
        action="append",
        default=[],
        help="Build only the given rendition profile, for example preview_320p30. Can be passed multiple times.",
    )
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg executable")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe executable")
    parser.add_argument(
        "--encoder-mode",
        choices=("auto", "videotoolbox", "software"),
        default="auto",
        help="Encoder backend for H.264/HEVC. auto uses VideoToolbox when available.",
    )
    parser.add_argument(
        "--fps-upsample-mode",
        choices=("interpolate", "duplicate"),
        default="interpolate",
        help="How to increase frame rate when target FPS is higher than source FPS.",
    )
    parser.add_argument(
        "--regenerate",
        action="store_true",
        help="Rebuild even if index says output exists",
    )
    parser.add_argument(
        "--keep-raw", action="store_true", help="Do not delete downloaded raw files"
    )
    parser.add_argument(
        "--prune-removed-sources",
        action="store_true",
        help="Remove existing-index sources and assets that are no longer present in sources.json.",
    )
    parser.add_argument(
        "--index-only",
        action="store_true",
        help="Only generate metadata for files already present in the output folder; do not download or convert.",
    )
    parser.add_argument(
        "--shard-index",
        action="store_true",
        help="Write index.json with only records produced by this invocation.",
    )
    parser.add_argument(
        "--allow-empty-sources",
        action="store_true",
        help="Allow sources.json or --source-id filtering to select no sources.",
    )
    parser.add_argument(
        "--publish-s3-uri",
        default="",
        help="Optional destination S3 URI. When set, each generated media file is uploaded immediately.",
    )
    parser.add_argument(
        "--publish-progress-index-s3-uri",
        default="",
        help=(
            "Optional destination S3 URI for this shard's progress index. "
            "When set, index.json is updated and uploaded after each completed asset."
        ),
    )
    parser.add_argument(
        "--skip-existing-s3-uri",
        default="",
        help=(
            "Optional S3 URI prefix for already-published assets. When a target object exists there, "
            "download it for metadata and skip transcoding."
        ),
    )
    parser.add_argument(
        "--publish-sse",
        default="",
        help="Optional AWS S3 server-side encryption mode used with --publish-s3-uri.",
    )
    parser.add_argument(
        "--publish-sse-kms-key-id",
        default="",
        help="Optional AWS KMS key id used with --publish-s3-uri when --publish-sse is aws:kms.",
    )
    parser.add_argument(
        "--aws-refresh-role-arn",
        default="",
        help=(
            "Optional AWS role ARN to re-assume with GitHub OIDC before S3 uploads. "
            "Use this for long conversion jobs where the initial GitHub Actions AWS session can expire."
        ),
    )
    parser.add_argument(
        "--aws-refresh-region",
        default="",
        help="AWS region to set after refreshing credentials with --aws-refresh-role-arn.",
    )
    parser.add_argument(
        "--aws-refresh-duration-seconds",
        type=int,
        default=3600,
        help="Requested duration for refreshed upload credentials.",
    )
    parser.add_argument(
        "--aws-refresh-threshold-seconds",
        type=int,
        default=900,
        help="Refresh AWS credentials when they expire within this many seconds.",
    )
    parser.add_argument(
        "--delete-after-publish",
        action="store_true",
        help="Delete each generated media file after it is uploaded with --publish-s3-uri.",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def validate_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required command not found on PATH: {name}")


def source_filename(source: dict[str, Any]) -> str:
    file_name = str(
        source.get("file") or Path(str(source["url"]).split("?", 1)[0]).name
    )
    suffix = Path(file_name).suffix or ".mp4"
    return f"{source['id']}{suffix}"


def source_url(source: dict[str, Any], base_url: str) -> str:
    if source.get("url"):
        return str(source["url"])
    file_name = str(source.get("file", "")).strip()
    if not file_name:
        raise RuntimeError(f"source {source.get('id', '<unknown>')} is missing file")
    if not base_url:
        raise RuntimeError(
            f"source {source.get('id', '<unknown>')} uses file but sources manifest has no base_url"
        )
    return urllib.parse.urljoin(base_url, file_name)


def download_source(source: dict[str, Any], raw_cache: Path, base_url: str) -> Path:
    raw_cache.mkdir(parents=True, exist_ok=True)
    destination = raw_cache / source_filename(source)
    if destination.exists() and destination.stat().st_size > 0:
        print(f"Using cached source: {destination}")
        return destination

    url = source_url(source, base_url)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    print(f"Downloading {source['id']} from {url}")
    with (
        urllib.request.urlopen(request, timeout=120) as response,
        destination.open("wb") as out,
    ):
        total_header = response.headers.get("Content-Length")
        total_bytes = (
            int(total_header) if total_header and total_header.isdigit() else 0
        )
        copied = 0
        next_report = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            copied += len(chunk)
            if total_bytes:
                percent = int(copied * 100 / total_bytes)
                if percent >= next_report:
                    print(
                        f"  {source['id']}: {copied / (1024 * 1024):.1f} MiB / "
                        f"{total_bytes / (1024 * 1024):.1f} MiB ({percent}%)"
                    )
                    next_report = min(percent + 10, 100)
            elif copied >= next_report:
                print(f"  {source['id']}: {copied / (1024 * 1024):.1f} MiB downloaded")
                next_report = copied + 100 * 1024 * 1024
        if total_bytes:
            print(
                f"  {source['id']}: download complete, "
                f"{copied / (1024 * 1024):.1f} MiB / {total_bytes / (1024 * 1024):.1f} MiB"
            )
        else:
            print(
                f"  {source['id']}: download complete, {copied / (1024 * 1024):.1f} MiB"
            )
    if destination.stat().st_size == 0:
        raise RuntimeError(f"downloaded source is empty: {destination}")
    return destination


def available_ffmpeg_encoders(ffmpeg: str) -> set[str]:
    try:
        output = subprocess.check_output(
            [ffmpeg, "-hide_banner", "-encoders"],
            stderr=subprocess.STDOUT,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return set()
    encoders: set[str] = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            encoders.add(parts[1])
    return encoders


def choose_encoder_mode(requested: str, encoders: set[str]) -> str:
    videotoolbox_available = (
        "h264_videotoolbox" in encoders and "hevc_videotoolbox" in encoders
    )
    software_available = "libx264" in encoders and "libx265" in encoders
    if requested == "software":
        if not software_available:
            raise RuntimeError(
                "libx264 and libx265 encoders are not available in this ffmpeg build"
            )
        return "software"
    if requested == "videotoolbox" and not videotoolbox_available:
        raise RuntimeError(
            "VideoToolbox encoders are not available in this ffmpeg build"
        )
    if videotoolbox_available:
        return "videotoolbox"
    if software_available:
        return "software"
    raise RuntimeError(
        "No supported H.264 and HEVC encoder pair is available in this ffmpeg build"
    )


def video_level(rendition: Rendition) -> str:
    if rendition.codec not in {"h264", "hevc"}:
        raise ValueError(f"codec does not use an H.26x level: {rendition.codec}")
    if rendition.height >= 2160:
        return "5.1"
    if rendition.height >= 1080 and rendition.fps >= 100:
        return "5.1" if rendition.codec == "h264" else "5.0"
    if rendition.height >= 1080:
        return "4.0"
    if rendition.height >= 720 and rendition.fps >= 60:
        return "3.2" if rendition.codec == "h264" else "4.0"
    if rendition.height >= 720:
        return "3.1"
    if rendition.height >= 480:
        return "3.1" if rendition.codec == "h264" else "3.0"
    return "3.0"


def rate_control_args(rendition: Rendition) -> list[str]:
    bitrate = video_bitrate(rendition)
    return ["-b:v", bitrate, "-maxrate", bitrate, "-bufsize", bitrate]


def common_h26x_args(rendition: Rendition) -> list[str]:
    return [
        "-pix_fmt",
        "yuv420p",
        "-g",
        str(rendition.fps),
        "-keyint_min",
        str(rendition.fps),
        "-bf",
        "0",
        "-flags",
        "+cgop",
        *rate_control_args(rendition),
    ]


def ffmpeg_codec_args(rendition: Rendition, encoder_mode: str) -> list[str]:
    if rendition.codec == "h264":
        if encoder_mode == "videotoolbox":
            return [
                "-c:v",
                "h264_videotoolbox",
                "-allow_sw",
                "0",
                "-profile:v",
                "constrained_baseline",
                "-max_ref_frames",
                "1",
                *common_h26x_args(rendition),
                "-tag:v",
                "avc1",
            ]
        return [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-profile:v",
            "baseline",
            "-level:v",
            video_level(rendition),
            "-refs",
            "1",
            "-sc_threshold",
            "0",
            *common_h26x_args(rendition),
            "-x264-params",
            "repeat-headers=1:force-cfr=1:open-gop=0",
            "-tag:v",
            "avc1",
        ]
    if rendition.codec == "hevc":
        if encoder_mode == "videotoolbox":
            return [
                "-c:v",
                "hevc_videotoolbox",
                "-allow_sw",
                "0",
                "-profile:v",
                "main",
                "-max_ref_frames",
                "1",
                *common_h26x_args(rendition),
                "-tag:v",
                "hvc1",
            ]
        return [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-profile:v",
            "main",
            "-level:v",
            video_level(rendition),
            *common_h26x_args(rendition),
            "-tag:v",
            "hvc1",
            "-x265-params",
            (
                f"level-idc={video_level(rendition)}:high-tier=0:keyint={rendition.fps}:"
                f"min-keyint={rendition.fps}:scenecut=0:bframes=0:ref=1:open-gop=0:"
                "log-level=error"
            ),
        ]
    if rendition.codec == "mjpeg":
        return ["-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p"]
    raise ValueError(f"unsupported codec: {rendition.codec}")


def vui_tick_rate(rendition: Rendition) -> str:
    """VUI clock for the advertised frame rate.

    H.264 counts field ticks, so frame_rate = time_scale / (2 * num_units_in_tick);
    HEVC counts frame ticks. Applied in every encoder mode: VideoToolbox omits VUI
    timing entirely, and without it `h264parse`/`h265parse` report `0/1` once RTSP
    strips the MP4 container.
    """
    ticks = rendition.fps * 2 if rendition.codec == "h264" else rendition.fps
    return f":tick_rate={ticks}/1"


def bitstream_filter_args(rendition: Rendition, encoder_mode: str) -> list[str]:
    if rendition.codec == "h264":
        level = (
            f":level={expected_level_code(rendition)}"
            if encoder_mode == "videotoolbox"
            else ""
        )
        tick_rate = vui_tick_rate(rendition)
        return [
            "-bsf:v",
            (
                f"h264_metadata=aud=remove,dump_extra=freq=keyframe,"
                f"h264_metadata=aud=insert{level}{tick_rate}"
            ),
        ]
    if rendition.codec == "hevc":
        level = (
            f":level={expected_level_code(rendition)}"
            if encoder_mode == "videotoolbox"
            else ""
        )
        tick_rate = vui_tick_rate(rendition)
        return [
            "-bsf:v",
            f"hevc_metadata=aud=remove,hevc_metadata=aud=insert{level}{tick_rate}",
        ]
    return []


def video_bitrate(rendition: Rendition) -> str:
    if rendition.height >= 2160:
        return "35M"
    if rendition.height >= 1080 and rendition.fps >= 100:
        return "18M"
    if rendition.height >= 1080:
        return "12M"
    if rendition.height >= 720 and rendition.fps >= 60:
        return "8M"
    if rendition.height >= 720 and rendition.fps <= 20:
        return "2M"
    if rendition.height >= 720:
        return "5M"
    if rendition.preview:
        return "1M"
    return "3M"


def parse_rate(value: str | None) -> float:
    if not value or value == "0/0":
        return 0.0
    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return 0.0


def source_video_rate(ffprobe: str, path: Path) -> float:
    stream = probe_video(ffprobe, path)
    return parse_rate(
        str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "")
    )


def video_filter(
    rendition: Rendition, source_fps: float, fps_upsample_mode: str
) -> str:
    scale = f"scale=-2:{rendition.height}:flags=lanczos,setpts=PTS-STARTPTS"
    if source_fps > 0 and rendition.fps > source_fps + 0.5:
        if fps_upsample_mode == "duplicate":
            return f"{scale},fps={rendition.fps}"
        return (
            f"{scale},fps={source_fps:.3f},"
            f"minterpolate=fps={rendition.fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"
        )
    return f"{scale},fps={rendition.fps}"


def relative_output_path(source_id: str, rendition: Rendition) -> Path:
    filename = f"{rendition.profile}_{rendition.codec}.{rendition.extension}"
    return Path(source_id) / rendition.profile / filename


def run_ffmpeg(
    ffmpeg: str,
    source_path: Path,
    output_path: Path,
    rendition: Rendition,
    encoder_mode: str,
    source_fps: float,
    fps_upsample_mode: str,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_output = output_path.with_name(f".{output_path.stem}.tmp{output_path.suffix}")
    if tmp_output.exists():
        tmp_output.unlink()

    vf = video_filter(rendition, source_fps, fps_upsample_mode)

    def encode(mode: str) -> None:
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostats",
            "-y",
            "-i",
            str(source_path),
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            vf,
            "-fps_mode",
            "cfr",
            *ffmpeg_codec_args(rendition, mode),
            *bitstream_filter_args(rendition, mode),
            *(["-movflags", "+faststart"] if rendition.extension == "mp4" else []),
            "-avoid_negative_ts",
            "make_zero",
            str(tmp_output),
        ]
        print(
            f"Converting {output_path.relative_to(output_path.parents[2])}: "
            f"{rendition.codec} {rendition.profile} encoder={mode} filter='{vf}'"
        )
        subprocess.run(command, check=True)

    try:
        encode(encoder_mode)
    except subprocess.CalledProcessError:
        if encoder_mode != "videotoolbox" or rendition.codec not in {"h264", "hevc"}:
            raise
        tmp_output.unlink(missing_ok=True)
        print(
            f"VideoToolbox failed for {rendition.codec} {rendition.profile}; "
            "retrying with the software encoder."
        )
        encode("software")
    tmp_output.replace(output_path)


def probe_video(ffprobe: str, path: Path) -> dict[str, Any]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        (
            "stream=codec_name,profile,pix_fmt,bits_per_raw_sample,"
            "codec_tag_string,level,has_b_frames,bit_rate,"
            "width,height,r_frame_rate,avg_frame_rate,duration"
        ),
        "-of",
        "json",
        str(path),
    ]
    payload = subprocess.check_output(command, text=True)
    data = json.loads(payload)
    streams = data.get("streams") or []
    return streams[0] if streams else {}


def expected_level_code(rendition: Rendition) -> int:
    multiplier = 10 if rendition.codec == "h264" else 30
    return round(float(video_level(rendition)) * multiplier)


def validate_rendition_output(
    rendition: Rendition,
    output_path: Path,
    stream: dict[str, Any],
    reference_frames: int | None = None,
) -> None:
    if rendition.codec not in {"h264", "hevc"}:
        return

    expected_profile = "Constrained Baseline" if rendition.codec == "h264" else "Main"
    expected_tag = "avc1" if rendition.codec == "h264" else "hvc1"
    expected = {
        "codec_name": rendition.codec,
        "profile": expected_profile,
        "codec_tag_string": expected_tag,
        "pix_fmt": "yuv420p",
        "level": expected_level_code(rendition),
        "has_b_frames": 0,
        "height": rendition.height,
    }
    mismatches = [
        f"{key}={stream.get(key)!r} (expected {value!r})"
        for key, value in expected.items()
        if stream.get(key) != value
    ]
    for key in ("r_frame_rate", "avg_frame_rate"):
        if parse_rate(str(stream.get(key) or "")) != rendition.fps:
            mismatches.append(f"{key}={stream.get(key)!r} (expected {rendition.fps})")
    if reference_frames is not None and reference_frames != 1:
        mismatches.append(f"reference_frames={reference_frames!r} (expected 1)")
    if mismatches:
        raise RuntimeError(
            f"{output_path} produced incompatible {rendition.codec} output: "
            + "; ".join(mismatches)
        )


def probe_packets(ffprobe: str, path: Path) -> list[tuple[float, float, bool]]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,dts_time,flags",
        "-of",
        "json",
        str(path),
    ]
    data = json.loads(subprocess.check_output(command, text=True))
    try:
        return [
            (
                float(packet["pts_time"]),
                float(packet["dts_time"]),
                "K" in str(packet.get("flags", "")),
            )
            for packet in data.get("packets", [])
        ]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(
            f"{path} contains a packet without usable PTS/DTS timestamps"
        ) from exc


def probe_output_structure(ffprobe: str, path: Path) -> tuple[str, list[str]]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=format_name:stream=codec_type",
        "-of",
        "json",
        str(path),
    ]
    data = json.loads(subprocess.check_output(command, text=True))
    format_name = str(data.get("format", {}).get("format_name", ""))
    codec_types = [
        str(stream.get("codec_type", "")) for stream in data.get("streams", [])
    ]
    return format_name, codec_types


def probe_reference_frames(ffmpeg: str, path: Path) -> int:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "verbose",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(command, text=True, capture_output=True, check=True)
    match = re.search(r"Video:.*?([0-9]+) reference frame", proc.stderr)
    if not match:
        raise RuntimeError(f"Could not determine reference-frame count for {path}")
    return int(match.group(1))


def vui_timing_fields(codec: str) -> tuple[str, str, str]:
    """trace_headers field names carrying the VUI clock, per codec."""
    if codec == "h264":
        return "timing_info_present_flag", "num_units_in_tick", "time_scale"
    return "vui_timing_info_present_flag", "vui_num_units_in_tick", "vui_time_scale"


def probe_bitstream_contract(
    ffmpeg: str, path: Path, rendition: Rendition
) -> tuple[int | None, set[int], list[tuple[bool, set[int]]], dict[str, int]]:
    pass_types = "7|8|9" if rendition.codec == "h264" else "32|33|34|35"
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "debug",
        "-i",
        str(path),
        "-map",
        "0:v:0",
        "-c",
        "copy",
        "-bsf:v",
        f"filter_units=pass_types={pass_types},trace_headers",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(command, text=True, capture_output=True, check=True)
    tier = None
    extradata_types: set[int] = set()
    packet_types: list[tuple[bool, set[int]]] = []
    # Read the clock from the first parameter set, which is the extradata copy
    # RTSP republishes as sprop-parameter-sets.
    present_field, units_field, scale_field = vui_timing_fields(rendition.codec)
    timing: dict[str, int] = {}
    timing_keys = {
        present_field: "present",
        units_field: "num_units_in_tick",
        scale_field: "time_scale",
    }
    for line in proc.stderr.splitlines():
        if "[trace_headers" not in line:
            continue
        for field, key in timing_keys.items():
            if key not in timing and re.search(rf"\b{field}\s", line):
                value = re.search(r"=\s*([0-9]+)\s*$", line)
                if value:
                    timing[key] = int(value.group(1))
        if "Packet:" in line:
            packet_types.append(("key frame" in line, set()))
            continue
        nal_match = re.search(r"nal_unit_type:\s+([0-9]+)", line)
        if nal_match:
            target = packet_types[-1][1] if packet_types else extradata_types
            target.add(int(nal_match.group(1)))
        if "general_tier_flag" in line:
            tier_match = re.search(r"=\s*([01])\s*$", line)
            if tier_match:
                tier = int(tier_match.group(1))
    return tier, extradata_types, packet_types, timing


def validate_output_structure(
    output_path: Path, format_name: str, codec_types: list[str]
) -> None:
    if "mp4" not in format_name.split(",") or codec_types != ["video"]:
        raise RuntimeError(
            f"{output_path} must be an MP4 containing exactly one video stream and no other streams; "
            f"format={format_name!r}, streams={codec_types!r}"
        )


def validate_bitstream_contract(
    rendition: Rendition,
    output_path: Path,
    tier: int | None,
    extradata_types: set[int],
    packet_types: list[tuple[bool, set[int]]],
    expected_packets: int,
    expected_keyframes: int,
    timing: dict[str, int] | None = None,
) -> None:
    if rendition.codec == "h264":
        required_extradata = {7, 8}
        required_keyframe_types = {7, 8, 9}
    else:
        required_extradata = {32, 33, 34}
        required_keyframe_types = set()
        if tier != 0:
            raise RuntimeError(
                f"{output_path} must use the HEVC Main tier, got tier={tier!r}"
            )
    if not required_extradata.issubset(extradata_types):
        raise RuntimeError(
            f"{output_path} is missing required codec parameter-set extradata"
        )
    aud_type = 9 if rendition.codec == "h264" else 35
    if len(packet_types) != expected_packets or any(
        aud_type not in types for _is_keyframe, types in packet_types
    ):
        raise RuntimeError(
            f"{output_path} is missing an AUD NAL unit on one or more frames"
        )
    keyframe_types = [types for is_keyframe, types in packet_types if is_keyframe]
    if len(keyframe_types) != expected_keyframes or any(
        not required_keyframe_types.issubset(types) for types in keyframe_types
    ):
        raise RuntimeError(
            f"{output_path} is missing required keyframe parameter sets or AUD NAL units"
        )
    if timing is not None:
        # Container timestamps are not a substitute: RTSP stream-copies the
        # elementary stream, so only the VUI clock reaches h264parse/h265parse.
        # H.264 counts field ticks, HEVC counts frame ticks.
        ticks_per_frame = 2 if rendition.codec == "h264" else 1
        units = timing.get("num_units_in_tick", 0)
        scale = timing.get("time_scale", 0)
        if timing.get("present") != 1 or not units:
            raise RuntimeError(
                f"{output_path} parameter sets carry no VUI timing; "
                f"h264parse/h265parse would report 0/1 over RTSP"
            )
        if scale != rendition.fps * ticks_per_frame * units:
            raise RuntimeError(
                f"{output_path} VUI timing is {scale}/{units}, "
                f"expected {rendition.fps * ticks_per_frame}/1 for {rendition.fps} fps"
            )


def validate_rendition_timestamps(
    rendition: Rendition,
    output_path: Path,
    packets: list[tuple[float, float, bool]],
) -> None:
    if rendition.codec not in {"h264", "hevc"}:
        return
    tolerance = 1e-6
    keyframe_times = [pts for pts, _dts, is_keyframe in packets if is_keyframe]
    if not keyframe_times or any(
        abs(timestamp - index) > tolerance
        for index, timestamp in enumerate(keyframe_times)
    ):
        raise RuntimeError(
            f"{output_path} does not have a closed one-second keyframe cadence starting at zero"
        )
    if not packets or abs(packets[0][0]) > tolerance or abs(packets[0][1]) > tolerance:
        raise RuntimeError(f"{output_path} packet timestamps do not start at zero")
    frame_interval = 1.0 / rendition.fps
    previous_pts = None
    for pts, dts, _is_keyframe in packets:
        if abs(pts - dts) > tolerance or (
            previous_pts is not None
            and abs(pts - previous_pts - frame_interval) > tolerance
        ):
            raise RuntimeError(
                f"{output_path} packet timestamps are reordered or not constant frame rate"
            )
        previous_pts = pts


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def s3_uri_join(base_uri: str, rel_path: Path) -> str:
    return f"{base_uri.rstrip('/')}/{rel_path.as_posix()}"


def parse_s3_uri(uri: str) -> tuple[str, str]:
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme != "s3" or not parsed.netloc:
        raise ValueError(f"Invalid S3 URI: {uri}")
    return parsed.netloc, parsed.path.lstrip("/")


class AwsCredentialRefresher:
    """Refresh AWS upload credentials during long GitHub Actions media builds.

    GitHub's configure-aws-credentials action normally mints credentials once at
    the start of a job. 4K and interpolated high-FPS media conversion can take
    longer than that session, so uploads late in the job must re-assume the
    artifact publisher role with a fresh GitHub OIDC token.
    """

    def __init__(
        self, role_arn: str, region: str, duration_seconds: int, threshold_seconds: int
    ) -> None:
        self.role_arn = role_arn
        self.region = region
        self.duration_seconds = duration_seconds
        self.threshold_seconds = threshold_seconds
        self.expires_at = 0.0

    def refresh_if_needed(self) -> None:
        if not self.role_arn:
            return
        if time.time() + self.threshold_seconds < self.expires_at:
            return
        oidc_token = self._github_oidc_token()
        session_name = f"insight-media-assets-{int(time.time())}"
        command = [
            "aws",
            "sts",
            "assume-role-with-web-identity",
            "--role-arn",
            self.role_arn,
            "--role-session-name",
            session_name,
            "--web-identity-token",
            oidc_token,
            "--duration-seconds",
            str(self.duration_seconds),
            "--query",
            "Credentials",
            "--output",
            "json",
        ]
        refresh_env = os.environ.copy()
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
            refresh_env.pop(name, None)
        proc = subprocess.run(
            command, text=True, capture_output=True, env=refresh_env, check=False
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip()
            raise RuntimeError(f"Failed to refresh AWS upload credentials: {detail}")
        payload = proc.stdout
        credentials = json.loads(payload)
        os.environ["AWS_ACCESS_KEY_ID"] = credentials["AccessKeyId"]
        os.environ["AWS_SECRET_ACCESS_KEY"] = credentials["SecretAccessKey"]
        os.environ["AWS_SESSION_TOKEN"] = credentials["SessionToken"]
        if self.region:
            os.environ["AWS_REGION"] = self.region
            os.environ["AWS_DEFAULT_REGION"] = self.region
        self.expires_at = parse_aws_expiration(credentials["Expiration"])
        print(
            f"Refreshed AWS upload credentials; session expires at {credentials['Expiration']}"
        )

    @staticmethod
    def _github_oidc_token() -> str:
        request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
        request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
        if not request_url or not request_token:
            raise RuntimeError(
                "GitHub OIDC token request environment is unavailable. "
                "Set job permissions id-token: write before using --aws-refresh-role-arn."
            )
        separator = "&" if "?" in request_url else "?"
        url = f"{request_url}{separator}{urllib.parse.urlencode({'audience': 'sts.amazonaws.com'})}"
        request = urllib.request.Request(
            url, headers={"Authorization": f"bearer {request_token}"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        token = payload.get("value")
        if not token:
            raise RuntimeError(
                "GitHub OIDC token response did not include a token value"
            )
        return str(token)


def parse_aws_expiration(value: str) -> float:
    normalized = value.replace("Z", "+00:00")
    return dt.datetime.fromisoformat(normalized).timestamp()


def publish_asset_to_s3(
    path: Path,
    destination_uri: str,
    sse: str,
    sse_kms_key_id: str,
    credential_refresher: AwsCredentialRefresher | None,
) -> None:
    if credential_refresher is not None:
        credential_refresher.refresh_if_needed()
    command = ["aws", "s3", "cp", str(path), destination_uri]
    if sse:
        command.extend(["--sse", sse])
    if sse_kms_key_id:
        command.extend(["--sse-kms-key-id", sse_kms_key_id])
    print(f"Uploading {path.name} to {destination_uri}")
    subprocess.run(command, check=True)


def s3_object_exists(
    destination_uri: str, credential_refresher: AwsCredentialRefresher | None
) -> bool:
    if credential_refresher is not None:
        credential_refresher.refresh_if_needed()
    bucket, key = parse_s3_uri(destination_uri)
    proc = subprocess.run(
        ["aws", "s3api", "head-object", "--bucket", bucket, "--key", key],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode == 0:
        return True
    detail = (proc.stderr or proc.stdout).strip()
    if "Not Found" in detail or "404" in detail or "NoSuchKey" in detail:
        return False
    raise RuntimeError(f"Failed to check S3 object {destination_uri}: {detail}")


def download_asset_from_s3(
    source_uri: str,
    output_path: Path,
    credential_refresher: AwsCredentialRefresher | None,
) -> None:
    if credential_refresher is not None:
        credential_refresher.refresh_if_needed()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Found existing published object, downloading metadata source: {source_uri}")
    subprocess.run(["aws", "s3", "cp", source_uri, str(output_path)], check=True)


def load_existing_index(path: Path | None) -> dict[str, Any]:
    if not path or not path.exists():
        return {}
    return load_json(path)


def index_assets_by_path(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    assets: dict[str, dict[str, Any]] = {}
    for item in index.get("assets", []):
        rel_path = str(item.get("path", ""))
        if rel_path:
            assets[rel_path] = item
    return assets


def index_sources_by_id(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sources: dict[str, dict[str, Any]] = {}
    for item in index.get("sources", []):
        source_id = str(item.get("id", ""))
        if source_id:
            sources[source_id] = item
    return sources


def source_index_record(source: dict[str, Any], base_url: str) -> dict[str, Any]:
    return {
        "id": source["id"],
        "title": source.get("title", source["id"]),
        "description": source.get("description", ""),
        "file": source.get("file", source_filename(source)),
        "url": source_url(source, base_url),
    }


def source_record_changed(
    source: dict[str, Any], existing_source: dict[str, Any] | None, base_url: str
) -> bool:
    if existing_source is None:
        return False
    current = source_index_record(source, base_url)
    return any(
        str(existing_source.get(key, "")) != str(current.get(key, ""))
        for key in current
    )


def source_content_changed(
    source: dict[str, Any], existing_source: dict[str, Any] | None, base_url: str
) -> bool:
    if existing_source is None:
        return False
    current = source_index_record(source, base_url)
    return any(
        str(existing_source.get(key, "")) != str(current.get(key, ""))
        for key in ("file", "url")
    )


def asset_record(
    source: dict[str, Any],
    rendition: Rendition,
    output_root: Path,
    rel_path: Path,
    ffprobe: str,
    ffmpeg: str,
) -> dict[str, Any]:
    output_path = output_root / rel_path
    stream = probe_video(ffprobe, output_path)
    reference_frames = None
    tier = None
    if rendition.codec in {"h264", "hevc"}:
        reference_frames = probe_reference_frames(ffmpeg, output_path)
    validate_rendition_output(rendition, output_path, stream, reference_frames)
    if rendition.codec in {"h264", "hevc"}:
        format_name, codec_types = probe_output_structure(ffprobe, output_path)
        validate_output_structure(output_path, format_name, codec_types)
        packets = probe_packets(ffprobe, output_path)
        tier, extradata_types, packet_types, timing = probe_bitstream_contract(
            ffmpeg, output_path, rendition
        )
        validate_bitstream_contract(
            rendition,
            output_path,
            tier,
            extradata_types,
            packet_types,
            len(packets),
            sum(1 for _pts, _dts, is_keyframe in packets if is_keyframe),
            timing,
        )
        validate_rendition_timestamps(rendition, output_path, packets)
    return {
        "source_id": source["id"],
        "source_title": source.get("title", source["id"]),
        "profile": rendition.profile,
        "preview": rendition.preview,
        "codec": rendition.codec,
        "container": rendition.extension,
        "fps": rendition.fps,
        "target_height": rendition.height,
        "path": rel_path.as_posix(),
        "bytes": output_path.stat().st_size,
        "sha256": sha256(output_path),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec_name": stream.get("codec_name"),
        "codec_profile": stream.get("profile"),
        "codec_tag": stream.get("codec_tag_string"),
        "codec_level": stream.get("level"),
        "codec_tier": tier,
        "pixel_format": stream.get("pix_fmt"),
        "bits_per_raw_sample": stream.get("bits_per_raw_sample"),
        "has_b_frames": stream.get("has_b_frames"),
        "reference_frames": reference_frames,
        "r_frame_rate": stream.get("r_frame_rate"),
        "avg_frame_rate": stream.get("avg_frame_rate"),
        "bit_rate": stream.get("bit_rate"),
        "duration": stream.get("duration"),
    }


def write_index(
    output_root: Path,
    base_url: str,
    sources: list[dict[str, Any]],
    assets: list[dict[str, Any]],
) -> None:
    index = {
        "schema": "sima.neat.insight.media-assets.index.v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": [source_index_record(source, base_url) for source in sources],
        "assets": sorted(
            assets, key=lambda item: (item["source_id"], item["profile"], item["codec"])
        ),
    }
    output_root.mkdir(parents=True, exist_ok=True)
    with (output_root / "index.json").open("w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, sort_keys=True)
        f.write("\n")


def write_shard_index(
    output_root: Path,
    base_url: str,
    sources: list[dict[str, Any]],
    shard_source_ids: set[str],
    shard_assets_by_path: dict[str, dict[str, Any]],
) -> None:
    shard_sources = [source for source in sources if source["id"] in shard_source_ids]
    write_index(
        output_root, base_url, shard_sources, list(shard_assets_by_path.values())
    )


def write_removed_assets(
    output_root: Path, removed_assets: list[dict[str, Any]]
) -> None:
    payload = {
        "schema": "sima.neat.insight.media-assets.removed.v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "assets": sorted(
            [
                {
                    "source_id": str(asset.get("source_id", "")),
                    "path": str(asset.get("path", "")),
                }
                for asset in removed_assets
                if asset.get("path")
            ],
            key=lambda item: (item["source_id"], item["path"]),
        ),
    }
    with (output_root / "removed-assets.json").open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")


def main() -> int:
    args = parse_args()
    validate_tool(args.ffmpeg)
    validate_tool(args.ffprobe)
    if args.publish_s3_uri or args.publish_progress_index_s3_uri:
        validate_tool("aws")
    if args.delete_after_publish and not args.publish_s3_uri:
        raise SystemExit("--delete-after-publish requires --publish-s3-uri")
    credential_refresher = None
    if args.aws_refresh_role_arn:
        credential_refresher = AwsCredentialRefresher(
            args.aws_refresh_role_arn,
            args.aws_refresh_region,
            args.aws_refresh_duration_seconds,
            args.aws_refresh_threshold_seconds,
        )
    encoder_mode = choose_encoder_mode(
        args.encoder_mode, available_ffmpeg_encoders(args.ffmpeg)
    )
    print(f"Using encoder mode: {encoder_mode}")

    config = load_json(args.sources)
    base_url = str(config.get("base_url", "")).strip()
    sources = list(config.get("sources", []))
    if args.source_id:
        selected = set(args.source_id)
        sources = [source for source in sources if source.get("id") in selected]
        missing = selected.difference({source.get("id") for source in sources})
        if missing:
            raise SystemExit(f"Unknown source id(s): {', '.join(sorted(missing))}")
    if not sources and not args.allow_empty_sources:
        raise SystemExit("No sources selected")
    renditions = list(RENDITIONS)
    if args.profile:
        selected_profiles = set(args.profile)
        renditions = [
            rendition
            for rendition in renditions
            if rendition.profile in selected_profiles
        ]
        missing_profiles = selected_profiles.difference(
            {rendition.profile for rendition in renditions}
        )
        if missing_profiles:
            raise SystemExit(
                f"Unknown profile(s): {', '.join(sorted(missing_profiles))}"
            )
    if not renditions:
        raise SystemExit("No rendition profiles selected")

    output_root = args.output
    output_root.mkdir(parents=True, exist_ok=True)
    existing_index = load_existing_index(args.existing_index)
    existing_assets = index_assets_by_path(existing_index)
    existing_index_sources = index_sources_by_id(existing_index)
    merged_index_sources = dict(existing_index_sources)
    for merge_index_path in args.merge_index:
        merge_index = load_existing_index(merge_index_path)
        existing_assets.update(index_assets_by_path(merge_index))
        merged_index_sources.update(index_sources_by_id(merge_index))
    assets_by_path = dict(existing_assets)
    shard_assets_by_path: dict[str, dict[str, Any]] = {}
    shard_source_ids: set[str] = set()
    manifest_source_ids = {
        str(source.get("id"))
        for source in config.get("sources", [])
        if source.get("id")
    }
    removed_assets: list[dict[str, Any]] = []
    if args.prune_removed_sources:
        for rel_path, asset in list(assets_by_path.items()):
            if str(asset.get("source_id", "")) not in manifest_source_ids:
                removed_assets.append(asset)
                del assets_by_path[rel_path]

    temp_dir: tempfile.TemporaryDirectory[str] | None = None
    if args.raw_cache is None:
        temp_dir = tempfile.TemporaryDirectory(prefix="insight-media-assets-")
        raw_cache = Path(temp_dir.name)
    else:
        raw_cache = args.raw_cache

    try:
        for source in sources:
            raw_path = None
            source_fps = 0.0
            existing_source = existing_index_sources.get(str(source.get("id", "")))
            source_record_has_changed = source_record_changed(
                source, existing_source, base_url
            )
            source_media_has_changed = source_content_changed(
                source, existing_source, base_url
            )
            if source_record_has_changed:
                print(
                    f"Refreshing asset records for changed source definition: {source['id']}"
                )
            for rendition in renditions:
                rel_path = relative_output_path(source["id"], rendition)
                output_path = output_root / rel_path
                already_published = rel_path.as_posix() in existing_assets
                if (
                    already_published
                    and not source_record_has_changed
                    and not args.regenerate
                ):
                    print(
                        f"Skipping already-published asset from existing index: {rel_path.as_posix()}"
                    )
                    continue
                reused_existing_s3_object = False
                if args.index_only:
                    if not output_path.exists():
                        print(
                            f"Skipping missing output while indexing: {rel_path.as_posix()}"
                        )
                        continue
                elif not output_path.exists() or args.regenerate:
                    existing_s3_uri = (
                        s3_uri_join(args.skip_existing_s3_uri, rel_path)
                        if args.skip_existing_s3_uri and not source_media_has_changed
                        else ""
                    )
                    if (
                        existing_s3_uri
                        and not args.regenerate
                        and s3_object_exists(existing_s3_uri, credential_refresher)
                    ):
                        download_asset_from_s3(
                            existing_s3_uri, output_path, credential_refresher
                        )
                        reused_existing_s3_object = True
                    else:
                        if raw_path is None:
                            raw_path = download_source(source, raw_cache, base_url)
                        if not source_fps:
                            source_fps = source_video_rate(args.ffprobe, raw_path)
                            if source_fps:
                                print(
                                    f"Detected source FPS for {source['id']}: {source_fps:.3f}"
                                )
                        run_ffmpeg(
                            args.ffmpeg,
                            raw_path,
                            output_path,
                            rendition,
                            encoder_mode,
                            source_fps,
                            args.fps_upsample_mode,
                        )
                asset = asset_record(
                    source, rendition, output_root, rel_path, args.ffprobe, args.ffmpeg
                )
                assets_by_path[rel_path.as_posix()] = asset
                shard_assets_by_path[rel_path.as_posix()] = asset
                shard_source_ids.add(source["id"])
                if args.publish_s3_uri and output_path.exists():
                    if reused_existing_s3_object:
                        print(
                            f"Skipping upload for existing published object: {rel_path.as_posix()}"
                        )
                    else:
                        publish_asset_to_s3(
                            output_path,
                            s3_uri_join(args.publish_s3_uri, rel_path),
                            args.publish_sse,
                            args.publish_sse_kms_key_id,
                            credential_refresher,
                        )
                    if args.delete_after_publish:
                        output_path.unlink()
                        print(f"Deleted local media file after upload: {output_path}")
                if args.publish_progress_index_s3_uri:
                    write_shard_index(
                        output_root,
                        base_url,
                        sources,
                        shard_source_ids,
                        shard_assets_by_path,
                    )
                    publish_asset_to_s3(
                        output_root / "index.json",
                        args.publish_progress_index_s3_uri,
                        args.publish_sse,
                        args.publish_sse_kms_key_id,
                        credential_refresher,
                    )

            if (
                raw_path is not None
                and not args.keep_raw
                and args.raw_cache is not None
            ):
                raw_path.unlink(missing_ok=True)
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()

    if args.prune_removed_sources:
        index_sources = {
            str(source.get("id")): source
            for source in merged_index_sources.values()
            if str(source.get("id")) in manifest_source_ids
        }
    else:
        index_sources = dict(merged_index_sources)
    for source in sources:
        index_sources[source["id"]] = source
    if args.shard_index:
        write_shard_index(
            output_root, base_url, sources, shard_source_ids, shard_assets_by_path
        )
    else:
        write_index(
            output_root,
            base_url,
            list(index_sources.values()),
            list(assets_by_path.values()),
        )
    write_removed_assets(output_root, removed_assets)
    print(f"Wrote media asset index: {output_root / 'index.json'}")
    print(f"Wrote removed asset manifest: {output_root / 'removed-assets.json'}")
    if removed_assets:
        print(f"Pruned {len(removed_assets)} removed asset record(s).")
    print(f"Generated {len(assets_by_path)} asset record(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
