#!/usr/bin/env python3
"""
Cross-platform neat-insight installer.

Usage:
  python install-neat-insight.py [branch] [latest|git-short-hash]

Environment:
  NEAT_INSIGHT_BASE_URL   Base URL for metadata/wheels
                          default: https://apps.sima-neat.com/insight/download
  NEAT_INSIGHT_VENV_DIR   Virtualenv destination
                          default: ~/.simaai/neat-insight/venv
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
import urllib.request
import venv
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://apps.sima-neat.com/insight/download"
DEFAULT_VENV_DIR = Path.home() / ".simaai" / "neat-insight" / "venv"


def _download_text(url: str) -> str:
    with urllib.request.urlopen(url) as resp:
        return resp.read().decode("utf-8")


def _download_json(url: str) -> dict[str, Any]:
    return json.loads(_download_text(url))


def _branch_key(branch: str) -> str:
    return branch.replace("/", "-").replace(" ", "-")


def _detect_platform_tag() -> str:
    machine = platform.machine().lower()
    system = platform.system().lower()

    if system == "linux":
        if machine in {"x86_64", "amd64"}:
            return "manylinux2014_x86_64"
        if machine in {"aarch64", "arm64"}:
            return "manylinux2014_aarch64"
    elif system == "darwin":
        if machine == "arm64":
            return "macosx_11_0_arm64"
    elif system == "windows":
        if machine in {"amd64", "x86_64"}:
            return "win_amd64"

    raise RuntimeError(f"Unsupported host platform: {platform.system()} {platform.machine()}")


def _choose_branch(base_url: str, provided: str | None) -> str:
    if provided:
        return provided

    try:
        payload = _download_json(f"{base_url}/branches.json")
        branches = [str(x).strip() for x in payload.get("branches", []) if str(x).strip()]
    except Exception:
        branches = []

    if not branches:
        return "main"

    if not sys.stdin.isatty():
        return "main" if "main" in branches else branches[0]

    print("Available branches:")
    for idx, branch in enumerate(branches, start=1):
        print(f"  {idx:2d}) {branch}")

    while True:
        choice = input(f"Choose branch [1-{len(branches)}] (default 1): ").strip()
        if not choice:
            return branches[0]
        if choice.isdigit():
            pos = int(choice)
            if 1 <= pos <= len(branches):
                return branches[pos - 1]
        print(f"Invalid selection: {choice}")


def _resolve_tag(base_url: str, branch_key: str, tag_input: str) -> str:
    if tag_input and tag_input != "latest":
        return tag_input
    tag = _download_text(f"{base_url}/{branch_key}/latest.tag").strip()
    if not tag:
        raise RuntimeError(f"latest.tag is empty for branch key '{branch_key}'")
    return tag


def _select_wheel_filename(meta: dict[str, Any], platform_tag: str) -> str:
    for entry in meta.get("wheels", []):
        name = str(entry.get("filename", ""))
        if name.endswith(f"-{platform_tag}.whl"):
            return name
    raise RuntimeError(f"No wheel in metadata matches platform tag {platform_tag}")


def _ensure_venv(venv_dir: Path) -> Path:
    if os.name == "nt":
        python_bin = venv_dir / "Scripts" / "python.exe"
    else:
        python_bin = venv_dir / "bin" / "python"

    if not python_bin.exists():
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        venv.EnvBuilder(with_pip=True).create(str(venv_dir))
    return python_bin


def _pip_install(python_bin: Path, wheel_path: Path) -> None:
    subprocess.run([str(python_bin), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    subprocess.run([str(python_bin), "-m", "pip", "install", "--force-reinstall", str(wheel_path)], check=True)


def _print_activation_hint(venv_dir: Path) -> None:
    print("\n✅ neat-insight installed.")
    if os.name == "nt":
        print("Activate with:")
        print(f"  {venv_dir}\\Scripts\\activate")
    else:
        print("Activate with:")
        print(f"  source \"{venv_dir}/bin/activate\"")
    print("Run with:")
    print("  neat-insight")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install neat-insight into an isolated virtualenv.")
    parser.add_argument("branch", nargs="?", default=None, help="Branch name (default: interactive/main)")
    parser.add_argument("tag", nargs="?", default="latest", help="latest or git short hash")
    args = parser.parse_args()

    base_url = os.environ.get("NEAT_INSIGHT_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    venv_dir = Path(os.environ.get("NEAT_INSIGHT_VENV_DIR", str(DEFAULT_VENV_DIR))).expanduser()

    try:
        branch = _choose_branch(base_url, args.branch)
        branch_key = _branch_key(branch)
        tag = _resolve_tag(base_url, branch_key, args.tag)
        meta = _download_json(f"{base_url}/{branch_key}/{tag}.json")
        platform_tag = _detect_platform_tag()
        wheel_file = _select_wheel_filename(meta, platform_tag)
        wheel_url = f"{base_url}/{wheel_file}"

        print(f"Branch  : {branch}")
        print(f"Build   : {tag}")
        print(f"Wheel   : {wheel_file}")
        print(f"URL     : {wheel_url}")
        print(f"Venv    : {venv_dir}")

        with tempfile.NamedTemporaryFile(prefix="neat-insight-wheel.", suffix=".whl", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            with urllib.request.urlopen(wheel_url) as resp, tmp_path.open("wb") as out:
                out.write(resp.read())
            python_bin = _ensure_venv(venv_dir)
            _pip_install(python_bin, tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)

        _print_activation_hint(venv_dir)
        return 0
    except Exception as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
