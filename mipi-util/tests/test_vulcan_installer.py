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
    # Simulate running on the board so main() takes the local install path.
    monkeypatch.setattr(installer.platform, "machine", lambda: "aarch64")
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


def test_devkit_target_rejects_invalid_ip(monkeypatch):
    monkeypatch.setenv("DEVKIT_SYNC_DEVKIT_IP", "not-an-ip")

    with pytest.raises(RuntimeError, match="invalid paired DevKit IP"):
        installer._devkit_target()


def test_remote_install_uses_shared_nfs_path(monkeypatch, tmp_path):
    workdir = tmp_path / "workspace" / "package with spaces"
    workdir.mkdir(parents=True)
    deb = workdir / "sima-mipi-util_1.0.0_arm64.deb"
    script = workdir / "install script.py"
    deb.touch()
    script.touch()
    calls = []

    monkeypatch.chdir(workdir)
    monkeypatch.setenv("DEVKIT_SYNC_DEVKIT_IP", "192.0.2.10")
    monkeypatch.setenv("DEVKIT_SYNC_METHOD", "nfs")
    monkeypatch.setenv("DEVKIT_SYNC_MOUNT_POINT", str(tmp_path / "workspace"))

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(installer.subprocess, "run", fake_run)

    assert installer._remote_install(deb, script) == 0
    assert not any(cmd[0] == "scp" for cmd in calls)
    install_cmd = next(cmd[-1] for cmd in calls if "sudo python3" in cmd[-1])
    assert shlex_quote(str(workdir)) in install_cmd
    assert shlex_quote(script.name) in install_cmd


def shlex_quote(value):
    import shlex
    return shlex.quote(value)


def test_remote_install_copies_to_unique_dir_and_cleans_up(monkeypatch, tmp_path):
    deb = tmp_path / "sima-mipi-util_1.0.0_arm64.deb"
    script = tmp_path / "install_sima_mipi_util.py"
    deb.touch()
    script.touch()
    calls = []
    remote_dir = "/tmp/sima-mipi-util-install.A1b2C3"

    monkeypatch.setenv("DEVKIT_SYNC_DEVKIT_IP", "192.0.2.10")
    monkeypatch.delenv("DEVKIT_SYNC_METHOD", raising=False)

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if "mktemp -d" in cmd[-1]:
            return subprocess.CompletedProcess(cmd, 0, stdout=remote_dir + "\n", stderr="")
        if cmd[0] == "ssh" and "sudo python3" in cmd[-1]:
            return subprocess.CompletedProcess(cmd, 7, stdout="", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(installer.subprocess, "run", fake_run)

    assert installer._remote_install(deb, script) == 7
    assert any(cmd[0] == "scp" and "StrictHostKeyChecking=accept-new" in cmd
               for cmd in calls)
    assert any(cmd[-1] == f"rm -rf -- {remote_dir}" for cmd in calls)
