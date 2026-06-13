#!/usr/bin/env python3
"""
Install neat-insight from a Vulcan package resource directory.

This script is copied into the published package as install_neat_insight.py and
runs from the directory where sima-cli downloaded package resources. The package
metadata downloads only this script and a small manifest; the script then
downloads the wheel matching the current platform from the same Vulcan build.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import venv
from pathlib import Path


DEFAULT_VENV_DIR = Path.home() / ".simaai" / "neat-insight" / "venv"
MANIFEST_NAME = "neat_insight_vulcan_manifest.json"


def _venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _ensure_venv(venv_dir: Path) -> Path:
    python_bin = _venv_python(venv_dir)
    if not python_bin.exists():
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        venv.EnvBuilder(with_pip=True).create(str(venv_dir))
    return python_bin


def _platform_suffix() -> str:
    machine = platform.machine().lower()
    system = platform.system().lower()

    if system == "linux":
        if machine in {"x86_64", "amd64"}:
            return "manylinux2014_x86_64.whl"
        if machine in {"aarch64", "arm64"}:
            return "manylinux2014_aarch64.whl"
    elif system == "darwin":
        if machine == "arm64":
            return "macosx_11_0_arm64.whl"
    elif system == "windows":
        if machine in {"amd64", "x86_64"}:
            return "win_amd64.whl"

    raise RuntimeError(f"Unsupported host platform: {platform.system()} {platform.machine()}")


def _load_manifest(package_dir: Path) -> dict:
    manifest_path = package_dir / MANIFEST_NAME
    if not manifest_path.is_file():
        raise RuntimeError(f"Missing {MANIFEST_NAME} in {package_dir}")
    with manifest_path.open(encoding="utf-8") as file_obj:
        return json.load(file_obj)


def _select_wheel(manifest: dict) -> dict:
    suffix = _platform_suffix()
    wheels = manifest.get("wheels", [])
    for wheel in wheels:
        name = str(wheel.get("resource", ""))
        if name.endswith(suffix):
            return wheel
    available = ", ".join(str(wheel.get("resource", "")) for wheel in wheels)
    raise RuntimeError(f"No neat-insight wheel matches platform suffix {suffix}. Available: {available}")


def _resource_url(base_url: str, resource: str) -> str:
    encoded = "/".join(urllib.parse.quote(part, safe="") for part in resource.split("/"))
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", encoded)


def _escape_percent_path(base_url: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    escaped_path = parsed.path.replace("%", "%25")
    if escaped_path == parsed.path:
        return ""
    return urllib.parse.urlunsplit((
        parsed.scheme,
        parsed.netloc,
        escaped_path,
        parsed.query,
        parsed.fragment,
    ))


def _resource_url_candidates(base_url: str, resource: str) -> list[str]:
    candidates = []
    seen = set()
    for candidate_base in (base_url, _escape_percent_path(base_url)):
        if not candidate_base or candidate_base in seen:
            continue
        seen.add(candidate_base)
        candidates.append(_resource_url(candidate_base, resource))
    return candidates


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _download_wheel(manifest: dict, wheel: dict, destination: Path) -> Path:
    resource = str(wheel.get("resource", ""))
    expected_sha256 = str(wheel.get("sha256", "")).lower()
    if not resource:
        raise RuntimeError("Selected wheel is missing resource name")
    if not expected_sha256:
        raise RuntimeError(f"Selected wheel {resource} is missing sha256")

    local_candidate = destination / Path(resource).name
    if local_candidate.is_file():
        actual = _sha256_file(local_candidate)
        if actual == expected_sha256:
            return local_candidate

    base_url = str(manifest.get("artifact_base_url", "")).strip()
    if not base_url:
        raise RuntimeError("Installer manifest is missing artifact_base_url")

    errors = []
    for url in _resource_url_candidates(base_url, resource):
        print(f"Downloading wheel: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "neat-insight-vulcan-installer/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as response, local_candidate.open("wb") as output:
                output.write(response.read())
        except urllib.error.HTTPError as exc:
            local_candidate.unlink(missing_ok=True)
            errors.append(f"HTTP {exc.code} while downloading {url}")
            continue
        except urllib.error.URLError as exc:
            local_candidate.unlink(missing_ok=True)
            errors.append(f"Failed to download {url}: {exc}")
            continue

        actual = _sha256_file(local_candidate)
        if actual == expected_sha256:
            return local_candidate
        local_candidate.unlink(missing_ok=True)
        errors.append(f"SHA-256 mismatch for {resource}: expected {expected_sha256}, got {actual}")

    raise RuntimeError("; ".join(errors) if errors else f"No download URL candidates for {resource}")


def _install_wheel(python_bin: Path, wheel: Path) -> None:
    subprocess.run([str(python_bin), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    subprocess.run([str(python_bin), "-m", "pip", "install", "--force-reinstall", str(wheel)], check=True)


def _print_activation_hint(venv_dir: Path) -> None:
    print("\nneat-insight installed.")
    if os.name == "nt":
        print("Activate with:")
        print(f"  {venv_dir}\\Scripts\\activate")
    else:
        print("Activate with:")
        print(f"  source \"{venv_dir}/bin/activate\"")
    print("Run with:")
    print("  neat-insight")


def main() -> int:
    package_dir = Path(__file__).resolve().parent
    venv_dir = Path(os.environ.get("NEAT_INSIGHT_VENV_DIR", str(DEFAULT_VENV_DIR))).expanduser()

    try:
        manifest = _load_manifest(package_dir)
        selected = _select_wheel(manifest)
        wheel = _download_wheel(manifest, selected, package_dir)
        print(f"Package version: {manifest.get('version', 'unknown')}")
        print(f"Wheel: {wheel.name}")
        print(f"Venv : {venv_dir}")
        python_bin = _ensure_venv(venv_dir)
        _install_wheel(python_bin, wheel)
        _print_activation_hint(venv_dir)
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
