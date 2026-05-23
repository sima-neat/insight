#!/usr/bin/env python3
"""Install a downloaded neat-insight wheel into an isolated virtualenv."""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import venv
from pathlib import Path


def platform_tag() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    elif machine in {"aarch64", "arm64"}:
        arch = "aarch64"
    else:
        raise SystemExit(f"Unsupported machine architecture: {machine}")

    if system == "linux":
        return f"manylinux2014_{arch}"
    if system == "darwin" and arch == "aarch64":
        return "macosx_11_0_arm64"
    if system == "windows" and arch == "x86_64":
        return "win_amd64"
    raise SystemExit(f"Unsupported platform: system={system} arch={arch}")


def venv_python(root: Path) -> Path:
    if platform.system().lower() == "windows":
        return root / "Scripts" / "python.exe"
    return root / "bin" / "python"


def main() -> int:
    root = Path.cwd()
    tag = platform_tag()
    wheels = sorted(root.glob(f"neat_insight-*-{tag}.whl"))
    if not wheels:
        available = "\n".join(f"  {p.name}" for p in sorted(root.glob("neat_insight-*.whl")))
        raise SystemExit(f"No neat-insight wheel found for platform tag {tag}. Available wheels:\n{available}")
    wheel = wheels[-1]

    venv_dir = Path(os.environ.get("NEAT_INSIGHT_VENV_DIR", "~/.simaai/neat-insight/venv")).expanduser()
    venv_dir.parent.mkdir(parents=True, exist_ok=True)
    if not venv_python(venv_dir).exists():
        venv.EnvBuilder(with_pip=True).create(venv_dir)

    python = venv_python(venv_dir)
    subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    subprocess.run([str(python), "-m", "pip", "install", "--force-reinstall", str(wheel)], check=True)

    console = venv_dir / ("Scripts/neat-insight.exe" if platform.system().lower() == "windows" else "bin/neat-insight")
    print(f"Installed neat-insight from {wheel.name}")
    print(f"Virtual environment: {venv_dir}")
    print(f"Run: {console}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
