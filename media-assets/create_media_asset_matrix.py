#!/usr/bin/env python3
"""Create the GitHub Actions matrix for Insight media asset conversion.

The conversion workflow intentionally shards by source video and profile group.
That gives long-running files their own runner slot, while keeping all codecs for
the same source/profile together so the raw download and source probe work are
shared within a job.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


PROFILE_GROUPS: tuple[tuple[str, str], ...] = (
    ("4k", "4kp30"),
    ("1080p-high-fps", "1080p120"),
    ("1080p-standard", "1080p30"),
    ("720p60", "720p60"),
    ("720p30", "720p30"),
    ("480p-preview", "480p30 preview_320p30"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create the media asset GitHub Actions matrix.")
    parser.add_argument("--sources", type=Path, required=True, help="Path to media-assets/sources.json")
    parser.add_argument("--source-id", default="", help="Optional single source id to include")
    parser.add_argument(
        "--github-output",
        default="",
        help="Optional $GITHUB_OUTPUT path. When set, writes matrix_json for GitHub Actions.",
    )
    return parser.parse_args()


def load_sources(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    sources = payload.get("sources")
    if not isinstance(sources, list):
        raise SystemExit(f"{path} does not contain a sources array")
    return sources


def safe_matrix_name(source_id: str, profile_group: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", f"{source_id}-{profile_group}").strip("-")
    if not name:
        raise SystemExit(f"Could not create matrix name for source id {source_id!r}")
    return name


def create_matrix(sources: list[dict[str, Any]], source_id: str) -> list[dict[str, str]]:
    if source_id:
        sources = [source for source in sources if source.get("id") == source_id]
        if not sources:
            raise SystemExit(f"Unknown source id: {source_id}")

    matrix: list[dict[str, str]] = []
    for source in sources:
        current_source_id = str(source.get("id", "")).strip()
        if not current_source_id:
            raise SystemExit("Every media source must have a non-empty id")
        for profile_group, profiles in PROFILE_GROUPS:
            matrix.append(
                {
                    "name": safe_matrix_name(current_source_id, profile_group),
                    "source_id": current_source_id,
                    "profile_group": profile_group,
                    "profiles": profiles,
                }
            )
    if not matrix:
        raise SystemExit("Media asset matrix is empty")
    return matrix


def write_github_output(path: str, matrix: list[dict[str, str]]) -> None:
    output_path = Path(path)
    payload = json.dumps(matrix, separators=(",", ":"))
    with output_path.open("a", encoding="utf-8") as f:
        f.write("matrix_json<<MEDIA_ASSET_MATRIX\n")
        f.write(payload)
        f.write("\nMEDIA_ASSET_MATRIX\n")


def main() -> int:
    args = parse_args()
    matrix = create_matrix(load_sources(args.sources), args.source_id)
    if args.github_output:
        write_github_output(args.github_output, matrix)
    print(json.dumps(matrix, indent=2, sort_keys=True))
    print(f"Generated {len(matrix)} media asset shard(s).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
