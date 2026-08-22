#!/usr/bin/env python3
"""
Install sima-mipi-util from a Vulcan package resource directory.

This script is copied into the published package as install_sima_mipi_util.py
and runs from the directory where sima-cli downloaded the package resources.
The .deb is small and Architecture: arm64, so it is bundled directly alongside
this script (no per-platform download step) — we just install the local file
and let apt resolve the runtime dependencies.

Set MIPI_UTIL_INSTALL_DRY_RUN=1 to print the install command without running it.
"""
from __future__ import annotations

import os
import ipaddress
import json
import platform
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PACKAGE_NAME = "sima-mipi-util"
SERVICE_NAME = "sima-mipi-util.service"
VENV_PYTHON = Path("/opt/sima-mipi-util/venv/bin/python")
HEALTH_URL = "http://127.0.0.1:5000/api/health"


def _devkit_target() -> tuple[str, str] | None:
    """Paired DevKit (user, ip) as exported by DevKit Sync, if any."""
    ip = os.environ.get("SIMA_DEVKIT_IP") or os.environ.get("DEVKIT_SYNC_DEVKIT_IP")
    if not ip:
        return None
    try:
        ipaddress.ip_address(ip)
    except ValueError as exc:
        raise RuntimeError(f"invalid paired DevKit IP: {ip}") from exc
    return os.environ.get("DEVKIT_SYNC_DEVKIT_USER", "sima"), ip


def _remote_install(deb: Path, script: Path) -> int:
    """Install on the paired DevKit when this host is not arm64 (e.g. the
    Neat SDK container). With NFS DevKit Sync the download directory is the
    shared /workspace, so the .deb is already visible on the board at the
    same path; otherwise the files are copied over first."""
    try:
        target = _devkit_target()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if target is None:
        print(f"ERROR: {PACKAGE_NAME} is an arm64 DevKit package and this host is "
              f"{platform.machine()}. Run sima-cli on the board, or pair a DevKit "
              "first (sima-cli sdk setup --devkit <ip>).", file=sys.stderr)
        return 1
    user, ip = target
    ssh = ["ssh", "-o", "StrictHostKeyChecking=accept-new", f"{user}@{ip}"]

    workdir = Path.cwd().resolve()
    mount = Path(os.environ.get("DEVKIT_SYNC_MOUNT_POINT", "/workspace")).resolve()
    copied = False
    if os.environ.get("DEVKIT_SYNC_METHOD") == "nfs" and workdir.is_relative_to(mount):
        remote_dir = str(workdir)
    else:
        result = subprocess.run(
            ssh + [f"mktemp -d /tmp/{PACKAGE_NAME}-install.XXXXXX"],
            capture_output=True,
            text=True,
        )
        remote_dir = result.stdout.strip()
        if result.returncode != 0 or not remote_dir.startswith(
                f"/tmp/{PACKAGE_NAME}-install."):
            print(f"ERROR: cannot reach DevKit {ip} over ssh.", file=sys.stderr)
            return 1
        copied = True
        rc = subprocess.run(["scp", "-o", "StrictHostKeyChecking=accept-new",
                             str(deb), str(script), f"{user}@{ip}:{remote_dir}/"]).returncode
        if rc != 0:
            print("ERROR: failed to copy package to the DevKit.", file=sys.stderr)
            subprocess.run(ssh + [f"rm -rf -- {shlex.quote(remote_dir)}"])
            return rc

    print(f"Host is {platform.machine()}; installing on paired DevKit {ip} ...")
    remote_cmd = (f"cd -- {shlex.quote(remote_dir)} && "
                  f"sudo python3 {shlex.quote(script.name)}")
    if subprocess.run(ssh + ["sudo -n true"], capture_output=True).returncode != 0:
        # sudo needs a password on the board — allocate a tty so it can prompt.
        ssh = ssh[:1] + ["-t"] + ssh[1:]
    rc = subprocess.run(ssh + [remote_cmd]).returncode
    if copied:
        # The directory came from mktemp and is owned by the SSH user.
        cleanup_ssh = [part for part in ssh if part != "-t"]
        subprocess.run(cleanup_ssh + [f"rm -rf -- {shlex.quote(remote_dir)}"])
    return rc


def _is_dry_run() -> bool:
    return os.environ.get("MIPI_UTIL_INSTALL_DRY_RUN") == "1"


def _sudo_prefix() -> list[str]:
    is_root = getattr(os, "geteuid", lambda: 1)() == 0
    if is_root:
        return []
    if shutil.which("sudo"):
        return ["sudo"]
    return []


def _run(cmd: list[str]) -> int:
    if _is_dry_run():
        print("DRY-RUN:", " ".join(cmd))
        return 0
    return subprocess.run(cmd).returncode


def _verify_package_status() -> None:
    result = subprocess.run(
        ["dpkg-query", "-W", "-f=${db:Status-Status}", PACKAGE_NAME],
        capture_output=True,
        text=True,
    )
    status = result.stdout.strip()
    if result.returncode != 0 or status != "installed":
        detail = result.stderr.strip() or status or "package not found"
        raise RuntimeError(f"{PACKAGE_NAME} is not fully installed: {detail}")


def _verify_venv() -> None:
    if not VENV_PYTHON.is_file():
        raise RuntimeError(f"application Python is missing: {VENV_PYTHON}")
    result = subprocess.run(
        [str(VENV_PYTHON), "-c", "import cv2, flask, numpy, waitress"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or "runtime import check failed"
        raise RuntimeError(detail)


def _verify_service() -> None:
    for action in ("is-enabled", "is-active"):
        result = subprocess.run(
            ["systemctl", action, "--quiet", SERVICE_NAME],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            detail = result.stderr.strip() or f"service is not {action[3:]}"
            raise RuntimeError(detail)


def _verify_health(attempts: int = 30, delay: float = 1.0) -> None:
    last_error = "no response"
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
                payload = json.load(response)
            if payload.get("status") == "ok":
                return
            last_error = f"unexpected response: {payload!r}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(delay)
    raise RuntimeError(f"health endpoint did not become ready: {last_error}")


def _verify_installation() -> None:
    _verify_package_status()
    _verify_venv()
    _verify_service()
    _verify_health()


def main() -> int:
    package_dir = Path(__file__).resolve().parent
    debs = list(package_dir.glob("sima-mipi-util_*_arm64.deb"))
    if not debs:
        print(f"ERROR: no sima-mipi-util .deb found in {package_dir}", file=sys.stderr)
        return 1
    # Newest by mtime, not lexicographically: sima-cli downloads into a shared
    # directory (/workspace with NFS DevKit Sync) where stale builds linger,
    # and "1.0.0+ci.<hex-sha>" versions do not sort by recency — a stale
    # a7de04c… build sorted after a fresh 6c08ec… one and got installed.
    deb = max(debs, key=lambda p: p.stat().st_mtime)

    if platform.machine() != "aarch64" and not _is_dry_run():
        return _remote_install(deb, Path(__file__).resolve())

    print(f"Installing {deb.name}")

    sudo = _sudo_prefix()
    if getattr(os, "geteuid", lambda: 1)() != 0 and not sudo:
        print("ERROR: root privileges required to install the system service "
              "(run as root or install sudo).", file=sys.stderr)
        return 1

    # `apt-get install ./file.deb` installs the package and resolves its
    # Debian-provided OS/runtime dependencies. Python web dependencies are
    # bundled in the .deb and installed offline by postinst.
    rc = 1
    if shutil.which("apt-get"):
        rc = _run(sudo + ["apt-get", "install", "-y", str(deb)])
        if rc != 0:
            print("apt-get install failed; falling back to dpkg -i + apt-get -f install",
                  file=sys.stderr)

    # Fallback for hosts without apt, or when the direct apt install failed.
    if rc != 0:
        rc = _run(sudo + ["dpkg", "-i", str(deb)])
        if rc != 0 and shutil.which("apt-get"):
            rc = _run(sudo + ["apt-get", "install", "-f", "-y"])
    if rc != 0:
        print("sima-mipi-util installation failed — see errors above.", file=sys.stderr)
        return 1

    if _is_dry_run():
        print("DRY-RUN: skipping post-install verification")
        return 0

    try:
        _verify_installation()
    except Exception as exc:
        print(f"sima-mipi-util installation verification failed: {exc}",
              file=sys.stderr)
        return 1

    print("sima-mipi-util installed. Open http://<device-ip>:5000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
