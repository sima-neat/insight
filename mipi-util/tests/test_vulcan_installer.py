"""Regression tests for the sima-cli/Vulcan Debian installer."""

import importlib.util
import io
from pathlib import Path
import subprocess

import pytest


INSTALLER_PATH = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "install-vulcan-sima-mipi-util.py"
)
SPEC = importlib.util.spec_from_file_location("mipi_vulcan_installer", INSTALLER_PATH)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def test_package_verification_rejects_removed_package(monkeypatch):
    result = subprocess.CompletedProcess(
        args=[],
        returncode=1,
        stdout="",
        stderr="dpkg-query: no packages found",
    )
    monkeypatch.setattr(installer.subprocess, "run", lambda *args, **kwargs: result)

    with pytest.raises(RuntimeError, match="not fully installed"):
        installer._verify_package_status()


def test_health_verification_accepts_ok_payload(monkeypatch):
    response = io.BytesIO(b'{"status": "ok"}')
    monkeypatch.setattr(
        installer.urllib.request,
        "urlopen",
        lambda *args, **kwargs: response,
    )

    installer._verify_health(attempts=1, delay=0)


def test_health_verification_rejects_unhealthy_payload(monkeypatch):
    response = io.BytesIO(b'{"status": "starting"}')
    monkeypatch.setattr(
        installer.urllib.request,
        "urlopen",
        lambda *args, **kwargs: response,
    )

    with pytest.raises(RuntimeError, match="did not become ready"):
        installer._verify_health(attempts=1, delay=0)


def test_main_rejects_false_success_after_apt(monkeypatch, tmp_path, capsys):
    fake_installer = tmp_path / "install_sima_mipi_util.py"
    fake_installer.write_text("# test\n", encoding="utf-8")
    (tmp_path / "sima-mipi-util_1.0.0_arm64.deb").touch()

    monkeypatch.setattr(installer, "__file__", str(fake_installer))
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(installer, "_run", lambda _cmd: 0)
    monkeypatch.setattr(
        installer,
        "_verify_installation",
        lambda: (_ for _ in ()).throw(RuntimeError("package not found")),
    )

    assert installer.main() == 1
    assert "verification failed: package not found" in capsys.readouterr().err
