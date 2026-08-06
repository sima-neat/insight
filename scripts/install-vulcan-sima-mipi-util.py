#!/usr/bin/env python3
"""
Install sima-mipi-util from a Vulcan package resource directory.

This script is copied into the published package as install_sima_mipi_util.py
and runs from the directory where sima-cli downloaded the package resources.
The .deb is small and Architecture: all, so it is bundled directly alongside
this script (no per-platform download step) — we just install the local file
and let apt resolve the runtime dependencies.

Set MIPI_UTIL_INSTALL_DRY_RUN=1 to print the install command without running it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _sudo_prefix() -> list[str]:
    is_root = getattr(os, "geteuid", lambda: 1)() == 0
    if is_root:
        return []
    if shutil.which("sudo"):
        return ["sudo"]
    return []


def _run(cmd: list[str]) -> int:
    if os.environ.get("MIPI_UTIL_INSTALL_DRY_RUN") == "1":
        print("DRY-RUN:", " ".join(cmd))
        return 0
    return subprocess.run(cmd).returncode


def main() -> int:
    package_dir = Path(__file__).resolve().parent
    debs = sorted(package_dir.glob("sima-mipi-util_*_all.deb"))
    if not debs:
        print(f"ERROR: no sima-mipi-util .deb found in {package_dir}", file=sys.stderr)
        return 1
    deb = debs[-1]
    print(f"Installing {deb.name}")

    sudo = _sudo_prefix()
    if getattr(os, "geteuid", lambda: 1)() != 0 and not sudo:
        print("ERROR: root privileges required to install the system service "
              "(run as root or install sudo).", file=sys.stderr)
        return 1

    # `apt-get install ./file.deb` installs the package AND pulls its declared
    # runtime deps (flask, waitress, gstreamer plugins, ffmpeg, psmisc, ...).
    if shutil.which("apt-get"):
        rc = _run(sudo + ["apt-get", "install", "-y", str(deb)])
        if rc == 0:
            print("sima-mipi-util installed. Open http://<device-ip>:5000")
            return 0
        print("apt-get install failed; falling back to dpkg -i + apt-get -f install",
              file=sys.stderr)

    # Fallback for hosts without apt (or if the above failed): dpkg then fix deps.
    _run(sudo + ["dpkg", "-i", str(deb)])
    if shutil.which("apt-get"):
        _run(sudo + ["apt-get", "install", "-f", "-y"])
    print("sima-mipi-util installed. Open http://<device-ip>:5000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
