#!/usr/bin/env python3
"""Build reusable Insight media assets from raw source videos.

The generated folder is intended to be published under the artifact bucket's
`media-assets/` prefix. The script keeps source configuration small and
declarative while centralizing the rendition matrix, ffmpeg arguments, output
layout, and index generation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from fractions import Fraction
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
    Rendition("480p30", 480, 30, "h264", "mp4"),
    Rendition("480p30", 480, 30, "hevc", "mp4"),
    Rendition("480p30", 480, 30, "mjpeg", "avi"),
    Rendition("preview_320p30", 320, 30, "h264", "mp4", preview=True),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Insight media asset renditions.")
    parser.add_argument("--sources", type=Path, required=True, help="Path to sources.json")
    parser.add_argument("--output", type=Path, required=True, help="Output folder for converted assets")
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
    parser.add_argument("--regenerate", action="store_true", help="Rebuild even if index says output exists")
    parser.add_argument("--keep-raw", action="store_true", help="Do not delete downloaded raw files")
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
        "--publish-s3-uri",
        default="",
        help="Optional destination S3 URI. When set, each generated media file is uploaded immediately.",
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
    file_name = str(source.get("file") or Path(str(source["url"]).split("?", 1)[0]).name)
    suffix = Path(file_name).suffix or ".mp4"
    return f"{source['id']}{suffix}"


def source_url(source: dict[str, Any], base_url: str) -> str:
    if source.get("url"):
        return str(source["url"])
    file_name = str(source.get("file", "")).strip()
    if not file_name:
        raise RuntimeError(f"source {source.get('id', '<unknown>')} is missing file")
    if not base_url:
        raise RuntimeError(f"source {source.get('id', '<unknown>')} uses file but sources manifest has no base_url")
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
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as out:
        total_header = response.headers.get("Content-Length")
        total_bytes = int(total_header) if total_header and total_header.isdigit() else 0
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
            print(f"  {source['id']}: download complete, {copied / (1024 * 1024):.1f} MiB")
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
    if requested == "software":
        return "software"
    videotoolbox_available = "h264_videotoolbox" in encoders and "hevc_videotoolbox" in encoders
    if requested == "videotoolbox" and not videotoolbox_available:
        raise RuntimeError("VideoToolbox encoders are not available in this ffmpeg build")
    return "videotoolbox" if videotoolbox_available else "software"


def ffmpeg_codec_args(rendition: Rendition, encoder_mode: str) -> list[str]:
    if rendition.codec == "h264":
        if encoder_mode == "videotoolbox":
            return [
                "-c:v",
                "h264_videotoolbox",
                "-allow_sw",
                "1",
                "-b:v",
                video_bitrate(rendition),
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]
        return [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
    if rendition.codec == "hevc":
        if encoder_mode == "videotoolbox":
            return [
                "-c:v",
                "hevc_videotoolbox",
                "-allow_sw",
                "1",
                "-b:v",
                video_bitrate(rendition),
                "-pix_fmt",
                "yuv420p",
                "-tag:v",
                "hvc1",
                "-movflags",
                "+faststart",
            ]
        return [
            "-c:v",
            "libx265",
            "-preset",
            "medium",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-tag:v",
            "hvc1",
            "-x265-params",
            "log-level=error",
        ]
    if rendition.codec == "mjpeg":
        return ["-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p"]
    raise ValueError(f"unsupported codec: {rendition.codec}")


def video_bitrate(rendition: Rendition) -> str:
    if rendition.height >= 2160:
        return "35M"
    if rendition.height >= 1080 and rendition.fps >= 100:
        return "18M"
    if rendition.height >= 1080:
        return "12M"
    if rendition.height >= 720 and rendition.fps >= 60:
        return "8M"
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
    return parse_rate(str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or ""))


def video_filter(rendition: Rendition, source_fps: float, fps_upsample_mode: str) -> str:
    scale = f"scale=-2:{rendition.height}:flags=lanczos"
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
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostats",
        "-y",
        "-i",
        str(source_path),
        "-an",
        "-vf",
        vf,
        *ffmpeg_codec_args(rendition, encoder_mode),
        str(tmp_output),
    ]
    print(
        f"Converting {output_path.relative_to(output_path.parents[2])}: "
        f"{rendition.codec} {rendition.profile} encoder={encoder_mode} filter='{vf}'"
    )
    subprocess.run(command, check=True)
    tmp_output.replace(output_path)


def probe_video(ffprobe: str, path: Path) -> dict[str, Any]:
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,duration",
        "-of",
        "json",
        str(path),
    ]
    payload = subprocess.check_output(command, text=True)
    data = json.loads(payload)
    streams = data.get("streams") or []
    return streams[0] if streams else {}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def s3_uri_join(base_uri: str, rel_path: Path) -> str:
    return f"{base_uri.rstrip('/')}/{rel_path.as_posix()}"


def publish_asset_to_s3(
    path: Path,
    destination_uri: str,
    sse: str,
    sse_kms_key_id: str,
) -> None:
    command = ["aws", "s3", "cp", str(path), destination_uri]
    if sse:
        command.extend(["--sse", sse])
    if sse_kms_key_id:
        command.extend(["--sse-kms-key-id", sse_kms_key_id])
    print(f"Uploading {path.name} to {destination_uri}")
    subprocess.run(command, check=True)


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


def asset_record(
    source: dict[str, Any], rendition: Rendition, output_root: Path, rel_path: Path, ffprobe: str
) -> dict[str, Any]:
    output_path = output_root / rel_path
    stream = probe_video(ffprobe, output_path)
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
        "avg_frame_rate": stream.get("avg_frame_rate"),
        "duration": stream.get("duration"),
    }


def write_index(output_root: Path, base_url: str, sources: list[dict[str, Any]], assets: list[dict[str, Any]]) -> None:
    index = {
        "schema": "sima.neat.insight.media-assets.index.v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sources": [
            {
                "id": source["id"],
                "title": source.get("title", source["id"]),
                "description": source.get("description", ""),
                "file": source.get("file", source_filename(source)),
                "url": source_url(source, base_url),
            }
            for source in sources
        ],
        "assets": sorted(assets, key=lambda item: (item["source_id"], item["profile"], item["codec"])),
    }
    output_root.mkdir(parents=True, exist_ok=True)
    with (output_root / "index.json").open("w", encoding="utf-8") as f:
        json.dump(index, f, indent=2, sort_keys=True)
        f.write("\n")


def write_removed_assets(output_root: Path, removed_assets: list[dict[str, Any]]) -> None:
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
    if args.publish_s3_uri:
        validate_tool("aws")
    if args.delete_after_publish and not args.publish_s3_uri:
        raise SystemExit("--delete-after-publish requires --publish-s3-uri")
    encoder_mode = choose_encoder_mode(args.encoder_mode, available_ffmpeg_encoders(args.ffmpeg))
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
    if not sources:
        raise SystemExit("No sources selected")
    renditions = list(RENDITIONS)
    if args.profile:
        selected_profiles = set(args.profile)
        renditions = [rendition for rendition in renditions if rendition.profile in selected_profiles]
        missing_profiles = selected_profiles.difference({rendition.profile for rendition in renditions})
        if missing_profiles:
            raise SystemExit(f"Unknown profile(s): {', '.join(sorted(missing_profiles))}")
    if not renditions:
        raise SystemExit("No rendition profiles selected")

    output_root = args.output
    output_root.mkdir(parents=True, exist_ok=True)
    existing_index = load_existing_index(args.existing_index)
    existing_assets = index_assets_by_path(existing_index)
    merged_index_sources = index_sources_by_id(existing_index)
    for merge_index_path in args.merge_index:
        merge_index = load_existing_index(merge_index_path)
        existing_assets.update(index_assets_by_path(merge_index))
        merged_index_sources.update(index_sources_by_id(merge_index))
    assets_by_path = dict(existing_assets)
    manifest_source_ids = {str(source.get("id")) for source in config.get("sources", []) if source.get("id")}
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
            raw_path = None if args.index_only else download_source(source, raw_cache, base_url)
            source_fps = 0.0 if raw_path is None else source_video_rate(args.ffprobe, raw_path)
            if source_fps:
                print(f"Detected source FPS for {source['id']}: {source_fps:.3f}")
            for rendition in renditions:
                rel_path = relative_output_path(source["id"], rendition)
                output_path = output_root / rel_path
                already_published = rel_path.as_posix() in existing_assets
                if already_published and not args.regenerate:
                    print(f"Skipping already-published asset from existing index: {rel_path.as_posix()}")
                    continue
                if args.index_only:
                    if not output_path.exists():
                        print(f"Skipping missing output while indexing: {rel_path.as_posix()}")
                        continue
                elif not output_path.exists() or args.regenerate:
                    if raw_path is None:
                        raise RuntimeError("internal error: raw source path missing during conversion")
                    run_ffmpeg(
                        args.ffmpeg,
                        raw_path,
                        output_path,
                        rendition,
                        encoder_mode,
                        source_fps,
                        args.fps_upsample_mode,
                    )
                asset = asset_record(source, rendition, output_root, rel_path, args.ffprobe)
                assets_by_path[rel_path.as_posix()] = asset
                if args.publish_s3_uri and output_path.exists():
                    publish_asset_to_s3(
                        output_path,
                        s3_uri_join(args.publish_s3_uri, rel_path),
                        args.publish_sse,
                        args.publish_sse_kms_key_id,
                    )
                    if args.delete_after_publish:
                        output_path.unlink()
                        print(f"Deleted local media file after upload: {output_path}")

            if raw_path is not None and not args.keep_raw and args.raw_cache is not None:
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
    write_index(output_root, base_url, list(index_sources.values()), list(assets_by_path.values()))
    write_removed_assets(output_root, removed_assets)
    print(f"Wrote media asset index: {output_root / 'index.json'}")
    print(f"Wrote removed asset manifest: {output_root / 'removed-assets.json'}")
    if removed_assets:
        print(f"Pruned {len(removed_assets)} removed asset record(s).")
    print(f"Generated {len(assets_by_path)} asset record(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
