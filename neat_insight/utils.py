# Copyright (c) 2025 SiMa.ai
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import os
import sys
import subprocess
import signal
import time
import importlib.util
from pathlib import Path
import shutil
import platform
import tempfile
import ssl
from datetime import datetime, timezone
from collections import Counter
import psutil
import ipaddress
import socket

CERT_FILE = "cert.pem"
KEY_FILE = "key.pem"
CERT_HOST_ENV = "NFS_SERVER_HOST_IP"
DEFAULT_CERT_HOST = "127.0.0.1"
DEFAULT_CERT_PORT = 9900
SDK_CERT_FILE = Path("/sdk-cert/neat-sdk.pem")
SDK_KEY_FILES = (
    Path("/sdk-cert/neat-sdk-key.pem"),
    Path("/sdk-cert/neat-sdk.key"),
    Path("/sdk-cert/key.pem"),
    SDK_CERT_FILE,
)
EXCLUDED_EXTENSIONS = {'.so', '.lm', '.bin', '.a', '.o', '.elf', '.rpm', '.tar', '.zip', '.gz', '.bz2', '.xz', '.out', '.pyc'}
EXCLUDED_FOLDERS = {'env', 'bin'}
DEVKIT_SYNC_DEVKIT_IP_ENV = "DEVKIT_SYNC_DEVKIT_IP"
WEBSSH_PORT_ENV = "NEAT_INSIGHT_WEBSSH_PORT"
DEFAULT_WEBSSH_PORT = 8022


def _ensure_sima_board_neat_insight_home():
    user_root = Path.home() / "neat-insight"
    nvme_root = Path("/media/nvme")
    nvme_user_root = nvme_root / "neat-insight"

    if nvme_root.exists() and nvme_root.is_dir():
        nvme_user_root.mkdir(parents=True, exist_ok=True)

        if user_root.is_symlink():
            current_target = user_root.resolve(strict=False)
            if current_target != nvme_user_root:
                user_root.unlink()
                user_root.symlink_to(nvme_user_root, target_is_directory=True)
        elif not user_root.exists():
            user_root.symlink_to(nvme_user_root, target_is_directory=True)
        elif user_root.is_dir() and not any(user_root.iterdir()):
            user_root.rmdir()
            user_root.symlink_to(nvme_user_root, target_is_directory=True)
        elif not user_root.is_dir():
            raise RuntimeError(f"{user_root} exists but is not a directory or symlink.")

        return user_root

    if user_root.is_symlink():
        user_root.unlink()

    user_root.mkdir(parents=True, exist_ok=True)
    return user_root


def tail_lines(filename, num_lines, max_bytes):
    with open(filename, 'rb') as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        size = 8192
        block = bytearray()
        lines = []

        while end > 0 and len(lines) <= num_lines:
            delta = min(size, end)
            f.seek(end - delta)
            block = f.read(delta) + block
            lines = block.split(b'\n')
            end -= delta

        # Trim to last N lines, and max byte size
        tail = b'\n'.join(lines[-num_lines:])
        return tail[-max_bytes:].decode('utf-8', errors='ignore')

def is_sima_board():
    for path in ["/etc/build", "/etc/buildinfo"]:
        build_file = Path(path)
        if build_file.exists():
            with open(build_file, "r") as f:
                if "SIMA_BUILD_VERSION" in f.read():
                    return True
    return False

def board_type():
    for path in ["/etc/build", "/etc/buildinfo"]:
        build_file = Path(path)
        if build_file.exists():
            with open(build_file, "r") as f:
                for line in f:
                    if line.startswith("MACHINE"):
                        # Example line: MACHINE = modalix
                        parts = line.split("=")
                        if len(parts) == 2:
                            return parts[1].strip().lower()
    return None

def init_environment():
    if is_sima_board():
        user_root = _ensure_sima_board_neat_insight_home()
        media_dir = user_root / "media"
        media_src_file = user_root / "media_sources.json"
    else:
        user_root = Path.home() / ".simaai" / "neat-insight"
        media_dir = user_root / "media"
        media_src_file = user_root / "media_sources.json"

        sima_mem_file = Path("/tmp/simaai-mem")
        if not sima_mem_file.exists():
            sima_mem_file.touch()
            print("✅ Created /tmp/simaai-mem (non-SIMA board) for simulation")

    # Ensure media directory exists
    media_dir.mkdir(parents=True, exist_ok=True)

    # Ensure media source file exists
    if not media_src_file.exists():
        media_src_file.parent.mkdir(parents=True, exist_ok=True)
        media_src_file.write_text("[]")

    default_source_count = 16

    return {
        "MEDIA_DIR": media_dir,
        "MEDIA_SRC_DATA_FILE": media_src_file,
        "DEFAULT_SOURCE_COUNT": default_source_count,
        "OPTVIEW_DATA": user_root,
        "NEAT_INSIGHT_DATA": user_root,
    }

processes = []
process_logs = []
_cleanup_done = False
webssh_proc = None

def _pids_listening_on(port, proto):
    proto = proto.upper()
    try:
        result = subprocess.run(
            ["lsof", "-nP", f"-ti{proto}:{port}"],
            check=False,
            capture_output=True,
            text=True,
        )
        pids = []
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.isdigit():
                pids.append(int(line))
        if pids:
            return pids
    except Exception:
        pass

    try:
        kind = "inet"
        conn_type = socket.SOCK_STREAM if proto == "TCP" else socket.SOCK_DGRAM
        pids = []
        for conn in psutil.net_connections(kind=kind):
            if conn.type != conn_type or not conn.laddr or conn.laddr.port != port:
                continue
            if proto == "TCP" and conn.status != psutil.CONN_LISTEN:
                continue
            if conn.pid:
                pids.append(conn.pid)
        return pids
    except Exception:
        return []


def _pids_listening_on_ports(port_specs):
    pids = set()
    for port, proto in port_specs:
        pids.update(_pids_listening_on(port, proto))
    return pids


def _terminate_pids(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

    if pids:
        time.sleep(1.0)


def _terminate_conflicting_port_specs(port_specs):
    pids = sorted(_pids_listening_on_ports(port_specs))
    _terminate_pids(pids)
    remaining_pids = sorted(_pids_listening_on_ports(port_specs))
    for pid in remaining_pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass

    if remaining_pids:
        time.sleep(0.2)


def _terminate_conflicting_ports():
    # mediamtx uses 8554/tcp and a default UDP helper port 8000.
    # vf uses 8081/tcp, 9000-9079/udp for RTP, and 9100-9179/udp for metadata.
    port_specs = [
        (8554, "TCP"),
        (8000, "UDP"),
        (8081, "TCP"),
        *[(port, "UDP") for port in range(9000, 9080)],
        *[(port, "UDP") for port in range(9100, 9180)],
    ]
    devkit_ip = get_devkit_sync_devkit_ip()
    if devkit_ip:
        port_specs.append((get_webssh_port(), "TCP"))

    _terminate_conflicting_port_specs(port_specs)


def start_processes(ssl_context):
    _terminate_conflicting_ports()
    bin_dir = os.path.join(os.path.dirname(__file__), "bin")
    is_windows = os.name == "nt"
    vf = os.path.join(bin_dir, "vf.exe" if is_windows else "vf")
    mtx = os.path.join(bin_dir, "mediamtx.exe" if is_windows else "mediamtx")
    mtx_config = os.path.join(bin_dir, "mediamtx.yml")

    if not os.path.isfile(vf):
        raise RuntimeError(f"vf binary not found at {vf}. Rebuild package with build.sh.")
    if not os.path.isfile(mtx):
        raise RuntimeError(f"mediamtx binary not found at {mtx}. Rebuild package with build.sh.")
    if not os.path.isfile(mtx_config):
        raise RuntimeError(f"mediamtx config not found at {mtx_config}.")

    cert_file, key_file = ssl_context

    # Ensure a log directory exists
    log_dir = os.path.join(bin_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)

    vf_log = open(os.path.join(log_dir, "vf.log"), "a")
    mtx_log = open(os.path.join(log_dir, "mediamtx.log"), "a")
    process_logs.extend([vf_log, mtx_log])

    # Start subprocesses and redirect logs
    vf_proc = subprocess.Popen(
        [vf, "--cert", cert_file, "--key", key_file],
        cwd=bin_dir,
        stdout=vf_log,
        stderr=subprocess.STDOUT
    )
    processes.append(vf_proc)

    mtx_proc = subprocess.Popen(
        [mtx, mtx_config],
        stdout=mtx_log,
        stderr=subprocess.STDOUT
    )
    processes.append(mtx_proc)

    time.sleep(0.25)
    if vf_proc.poll() is not None:
        raise RuntimeError(f"vf failed to start. Check {os.path.join(log_dir, 'vf.log')}")
    if mtx_proc.poll() is not None:
        raise RuntimeError(f"mediamtx failed to start. Check {os.path.join(log_dir, 'mediamtx.log')}")


def get_devkit_sync_devkit_ip():
    value = os.getenv(DEVKIT_SYNC_DEVKIT_IP_ENV, "").strip()
    if not value:
        return ""

    try:
        ipaddress.ip_address(value)
    except ValueError as exc:
        raise RuntimeError(
            f"{DEVKIT_SYNC_DEVKIT_IP_ENV} must be an IP address, got: {value}"
        ) from exc

    return value


def get_webssh_port():
    configured = os.getenv(WEBSSH_PORT_ENV, "").strip()
    if not configured:
        return DEFAULT_WEBSSH_PORT

    try:
        port = int(configured)
    except ValueError as exc:
        raise RuntimeError(f"{WEBSSH_PORT_ENV} must be an integer, got: {configured}") from exc

    if not 1 <= port <= 65535:
        raise RuntimeError(f"{WEBSSH_PORT_ENV} must be between 1 and 65535, got: {port}")

    return port


def webssh_is_available():
    try:
        return importlib.util.find_spec("webssh.main") is not None
    except ModuleNotFoundError:
        return False


def is_webssh_running():
    return webssh_proc is not None and webssh_proc.poll() is None


def _wait_for_tcp_listener(port, host="127.0.0.1", timeout_sec=5.0):
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def ensure_webssh_started(ssl_context):
    global webssh_proc

    devkit_ip = get_devkit_sync_devkit_ip()
    if not devkit_ip:
        raise RuntimeError(f"{DEVKIT_SYNC_DEVKIT_IP_ENV} is not set.")
    if not webssh_is_available():
        raise RuntimeError(
            "webssh is not installed in the current neat-insight environment. "
            "Install the package dependency and restart Insight."
        )
    if is_webssh_running():
        return

    cert_file, key_file = ssl_context
    webssh_port = get_webssh_port()
    _terminate_conflicting_port_specs([(webssh_port, "TCP")])

    bin_dir = os.path.join(os.path.dirname(__file__), "bin")
    log_dir = os.path.join(bin_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    webssh_log = open(os.path.join(log_dir, "webssh.log"), "a")
    process_logs.append(webssh_log)

    webssh_proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "webssh.main",
            "--address=127.0.0.1",
            "--port=0",
            "--ssladdress=0.0.0.0",
            f"--sslport={webssh_port}",
            f"--certfile={cert_file}",
            f"--keyfile={key_file}",
            "--redirect=False",
            "--fbidhttp=False",
            "--policy=warning",
            "--xheaders=False",
        ],
        cwd=bin_dir,
        stdout=webssh_log,
        stderr=subprocess.STDOUT,
    )
    processes.append(webssh_proc)

    if not _wait_for_tcp_listener(webssh_port):
        if webssh_proc.poll() is None:
            try:
                webssh_proc.terminate()
                webssh_proc.wait(timeout=2)
            except Exception:
                try:
                    webssh_proc.kill()
                except Exception as e:
                    print(f"Warning: failed to kill webssh process during startup cleanup: {e}")
        raise RuntimeError(f"webssh failed to start. Check {os.path.join(log_dir, 'webssh.log')}")

def cleanup_processes(signum=None, frame=None, exit_process=True):
    global _cleanup_done, webssh_proc
    if _cleanup_done:
        if exit_process:
            sys.exit(0)
        return
    _cleanup_done = True

    print("\n🧹 Shutting down subprocesses...")
    for proc in list(processes):
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    processes.clear()
    webssh_proc = None

    for log_file in list(process_logs):
        try:
            log_file.close()
        except Exception:
            pass
    process_logs.clear()

    if exit_process:
        sys.exit(0)


def get_certificate_host():
    configured_host = os.getenv(CERT_HOST_ENV, "").strip()
    if not configured_host:
        return DEFAULT_CERT_HOST

    try:
        ipaddress.ip_address(configured_host)
    except ValueError as exc:
        raise RuntimeError(f"{CERT_HOST_ENV} must be an IP address, got: {configured_host}") from exc

    return configured_host


def get_certificate_access_url(port=DEFAULT_CERT_PORT):
    cert_host = get_certificate_host()
    try:
        if ipaddress.ip_address(cert_host).version == 6:
            cert_host = f"[{cert_host}]"
    except ValueError:
        pass
    return f"https://{cert_host}:{port}"


def _mkcert_subjects(cert_host):
    subjects = []

    def add_subject(subject):
        if subject not in subjects:
            subjects.append(subject)

    add_subject(cert_host)
    add_subject(DEFAULT_CERT_HOST)
    add_subject("localhost")
    return subjects


def _run_mkcert(command):
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode == 0:
        return

    output = "\n".join(part.strip() for part in [result.stdout, result.stderr] if part.strip())
    raise RuntimeError(f"mkcert failed while running {' '.join(command)}\n{output}")


def _mkcert_binary_name():
    return "mkcert.exe" if os.name == "nt" else "mkcert"


def _go_env(name):
    if not shutil.which("go"):
        return None

    result = subprocess.run(["go", "env", name], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        return None

    value = result.stdout.strip()
    return value or None


def _go_mkcert_path():
    gobin = _go_env("GOBIN")
    if gobin:
        candidate = Path(gobin) / _mkcert_binary_name()
        if candidate.exists():
            return str(candidate)

    gopath = _go_env("GOPATH")
    if gopath:
        candidate = Path(gopath) / "bin" / _mkcert_binary_name()
        if candidate.exists():
            return str(candidate)

    candidate = Path.home() / "go" / "bin" / _mkcert_binary_name()
    if candidate.exists():
        return str(candidate)

    return None


def _find_mkcert():
    return shutil.which("mkcert") or _go_mkcert_path()


def _sudo_prefix():
    if os.name == "nt" or not hasattr(os, "geteuid") or os.geteuid() == 0:
        return []

    if shutil.which("sudo"):
        return ["sudo"]

    return None


def _mkcert_install_candidates():
    system = platform.system().lower()
    candidates = []

    if system == "darwin":
        if shutil.which("brew"):
            candidates.append(("Homebrew", [["brew", "install", "mkcert"]]))

    elif system == "linux":
        sudo = _sudo_prefix()
        if shutil.which("brew"):
            candidates.append(("Homebrew", [["brew", "install", "mkcert"]]))
        if sudo is not None and shutil.which("apt-get"):
            candidates.append(
                (
                    "apt-get",
                    [
                        [*sudo, "apt-get", "update"],
                        [*sudo, "apt-get", "install", "-y", "mkcert", "libnss3-tools"],
                    ],
                )
            )
        if sudo is not None and shutil.which("dnf"):
            candidates.append(("dnf", [[*sudo, "dnf", "install", "-y", "mkcert", "nss-tools"]]))
        if sudo is not None and shutil.which("yum"):
            candidates.append(("yum", [[*sudo, "yum", "install", "-y", "mkcert", "nss-tools"]]))
        if sudo is not None and shutil.which("pacman"):
            candidates.append(("pacman", [[*sudo, "pacman", "-Sy", "--noconfirm", "mkcert", "nss"]]))
        if sudo is not None and shutil.which("zypper"):
            candidates.append(
                (
                    "zypper",
                    [[*sudo, "zypper", "--non-interactive", "install", "mkcert", "mozilla-nss-tools"]],
                )
            )

    elif system == "windows":
        if shutil.which("winget"):
            candidates.append(
                (
                    "winget",
                    [
                        [
                            "winget",
                            "install",
                            "--id",
                            "FiloSottile.mkcert",
                            "--silent",
                            "--accept-package-agreements",
                            "--accept-source-agreements",
                        ]
                    ],
                )
            )
        if shutil.which("choco"):
            candidates.append(("Chocolatey", [["choco", "install", "mkcert", "-y"]]))
        if shutil.which("scoop"):
            candidates.append(("Scoop", [["scoop", "install", "mkcert"]]))

    if shutil.which("go"):
        candidates.append(("Go", [["go", "install", "filippo.io/mkcert@latest"]]))

    return candidates


def ensure_mkcert_installed():
    mkcert = _find_mkcert()
    if mkcert:
        return mkcert

    candidates = _mkcert_install_candidates()
    if not candidates:
        raise RuntimeError(
            "mkcert is required to generate trusted neat-insight HTTPS certificates, "
            "but no supported package manager was found. Install mkcert manually, then start neat-insight again."
        )

    failures = []
    for name, commands in candidates:
        print(f"📦 mkcert not found. Attempting installation with {name}...")
        failed_command = None
        for command in commands:
            print(f"🛠 Running: {' '.join(command)}")
            result = subprocess.run(command, check=False)
            if result.returncode != 0:
                failed_command = command
                break

        mkcert = _find_mkcert()
        if failed_command is None and mkcert:
            print("✅ mkcert installed.")
            return mkcert

        if failed_command is None:
            failures.append(f"{name}: install completed, but mkcert is not on PATH")
        else:
            failures.append(f"{name}: {' '.join(failed_command)} failed")

    raise RuntimeError(
        "Unable to install mkcert automatically. "
        "Install mkcert manually, ensure it is on PATH, then start neat-insight again. "
        f"Tried: {'; '.join(failures)}"
    )


def _generate_mkcert_certificate(cert_file, key_file, subjects):
    mkcert = ensure_mkcert_installed()

    cert_dir = Path(cert_file).parent
    cert_dir.mkdir(parents=True, exist_ok=True)

    _run_mkcert([mkcert, "-install"])

    with tempfile.TemporaryDirectory(prefix="mkcert-", dir=str(cert_dir)) as tmp_dir:
        tmp_cert = Path(tmp_dir) / "cert.pem"
        tmp_key = Path(tmp_dir) / "key.pem"
        _run_mkcert(
            [
                mkcert,
                "-cert-file",
                str(tmp_cert),
                "-key-file",
                str(tmp_key),
                *subjects,
            ]
        )
        os.replace(tmp_cert, cert_file)
        os.replace(tmp_key, key_file)
        os.chmod(key_file, 0o600)


def _cert_pair_error(cert_file, key_file):
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(cert_file), keyfile=str(key_file))
        return None
    except Exception as exc:
        return str(exc)


def _certificate_subject_error(cert_file, subjects):
    try:
        from cryptography import x509
        from cryptography.hazmat.backends import default_backend
    except Exception:
        return None

    try:
        cert = x509.load_pem_x509_certificate(Path(cert_file).read_bytes(), default_backend())
        not_valid_after = getattr(cert, "not_valid_after_utc", None)
        if not_valid_after is None:
            not_valid_after = cert.not_valid_after.replace(tzinfo=timezone.utc)
        if not_valid_after <= datetime.now(timezone.utc):
            return "certificate is expired"

        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        dns_names = set(san.get_values_for_type(x509.DNSName))
        ip_addresses = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
        missing = []
        for subject in subjects:
            try:
                if str(ipaddress.ip_address(subject)) not in ip_addresses:
                    missing.append(subject)
            except ValueError:
                if subject not in dns_names:
                    missing.append(subject)
        if missing:
            return f"certificate does not cover: {', '.join(missing)}"
        return None
    except x509.ExtensionNotFound:
        return "certificate has no subjectAltName extension"
    except Exception as exc:
        return str(exc)


def _existing_certificate_context(cert_file, key_file, subjects):
    cert_path = Path(cert_file)
    key_path = Path(key_file)
    if not cert_path.exists() or not key_path.exists():
        return None

    error = _cert_pair_error(cert_path, key_path)
    if error is not None:
        print(f"⚠️ Existing certificate pair is invalid and will be regenerated: {error}")
        return None

    subject_error = _certificate_subject_error(cert_path, subjects)
    if subject_error is not None:
        print(f"⚠️ Existing certificate will be regenerated: {subject_error}")
        return None

    print(f"🔐 Reusing existing trusted local certificate: {cert_path}")
    return (str(cert_path), str(key_path))


def _sdk_certificate_context():
    if not SDK_CERT_FILE.exists():
        return None

    errors = []
    for key_file in SDK_KEY_FILES:
        if not key_file.exists():
            continue

        error = _cert_pair_error(SDK_CERT_FILE, key_file)
        if error is None:
            sdk_cert = str(SDK_CERT_FILE)
            sdk_key = str(key_file)
            print(f"🔐 Using SDK-provided trusted certificate: {sdk_cert}")
            return (sdk_cert, sdk_key)

        errors.append(f"{key_file}: {error}")

    details = "; ".join(errors) if errors else "no SDK private key file found"
    raise RuntimeError(
        f"Found {SDK_CERT_FILE}, but it cannot be used as a TLS certificate/key pair ({details})."
    )


def check_and_generate_mkcert_certificate(port=DEFAULT_CERT_PORT):
    global CERT_FILE, KEY_FILE

    sdk_ssl_context = _sdk_certificate_context()
    if sdk_ssl_context:
        CERT_FILE, KEY_FILE = sdk_ssl_context
        return sdk_ssl_context

    env = init_environment()
    insight_root = env["NEAT_INSIGHT_DATA"]
    cert_file = os.path.join(insight_root, "cert.pem")
    key_file = os.path.join(insight_root, "key.pem")

    CERT_FILE = cert_file
    KEY_FILE = key_file

    cert_host = get_certificate_host()
    subjects = _mkcert_subjects(cert_host)
    existing_ssl_context = _existing_certificate_context(cert_file, key_file, subjects)
    if existing_ssl_context:
        return existing_ssl_context

    print(f"🔐 Generating trusted local certificate for {get_certificate_access_url(port)} with mkcert...")
    _generate_mkcert_certificate(cert_file, key_file, subjects)

    ssl_context = (cert_file, key_file)
    return ssl_context


def parse_build_info(build_text, remote=False):
    """
    Parses content of a /etc/build file and returns MACHINE and SIMA_BUILD_VERSION
    """
    machine = None
    sima_version = None

    for line in build_text.splitlines():
        if line.startswith('MACHINE'):
            machine = line.split('=', 1)[1].strip()
        elif line.startswith('SIMA_BUILD_VERSION'):
            sima_version = line.split('=', 1)[1].strip()

    return {
        'MACHINE': machine or 'N/A',
        'SIMA_BUILD_VERSION': sima_version or 'N/A',
        'REMOTE': remote
    }


def is_installed(command):
    return shutil.which(command) is not None

def run_install(commands):
    for cmd in commands:
        print(f"🛠 Running: {cmd}")
        try:
            subprocess.check_call(cmd, shell=True)
        except subprocess.CalledProcessError as e:
            print(f"❌ Command failed: {cmd}\nError: {e}")
            sys.exit(1)

def ensure_dependencies_installed():
    system = platform.system().lower()

    # Check if already installed
    ffmpeg_installed = is_installed("ffmpeg")
    gst_installed = is_installed("gst-launch-1.0")

    if ffmpeg_installed and gst_installed:
        print("✅ ffmpeg and GStreamer are already installed.")
        return

    print(f"📦 Detected OS: {system}")

    if system == "darwin":  # macOS
        if not is_installed("brew"):
            print("❌ Homebrew not found. Please install it first: https://brew.sh/")
            sys.exit(1)
        cmds = []
        if not ffmpeg_installed:
            cmds.append("brew install ffmpeg")
        if not gst_installed:
            cmds.append("brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav")
        run_install(cmds)

    elif system == "linux":
        distro = ""
        try:
            with open("/etc/os-release") as f:
                lines = f.readlines()
                for line in lines:
                    if line.startswith("ID="):
                        distro = line.strip().split("=")[1].strip('"')
                        break
        except Exception:
            pass

        if distro in ["ubuntu", "debian"]:
            cmds = ["sudo apt update"]
            if not ffmpeg_installed:
                cmds.append("sudo apt install -y ffmpeg")
            if not gst_installed:
                cmds.append("sudo apt install -y gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-libav libgirepository1.0-dev libcairo2-dev gir1.2-gtk-3.0 python3-gi pkg-config gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly")
            run_install(cmds)
        else:
            print(f"❌ Unsupported Linux distribution: {distro}, Skipping dependency auto installation.")

    elif system == "windows":
        print("⚠️ Please manually install ffmpeg and GStreamer on Windows:")
        print("  - ffmpeg: https://ffmpeg.org/download.html")
        print("  - GStreamer: https://gstreamer.freedesktop.org/download/")
        sys.exit(1)
    else:
        print(f"❌ Unsupported OS: {system} for dependency auto installation.")

    print("✅ Installation completed.")

SKIP_IFACE_PREFIXES = (
    "lo",
    "docker"
)

def get_lan_ip():
    # Explicit override (containers / orchestration)
    container_ip = os.getenv("CONTAINER_HOST_IP")
    if container_ip:
        return container_ip


    for iface, addrs in psutil.net_if_addrs().items():
        if iface.startswith(SKIP_IFACE_PREFIXES):
            continue

        print(iface, addrs)
        for addr in addrs:
            if addr.family != socket.AF_INET:
                continue

            ip = addr.address
            ip_obj = ipaddress.ip_address(ip)

            if (
                ip_obj.is_private
                and not ip_obj.is_loopback
                and not ip_obj.is_link_local
            ):
                return ip

    return "127.0.0.1"

def extract_pipeline_dir(rpm_files, apps_root):
    """
    Identify the top-level installed pipeline directory from RPM file list.
    """
    apps_root = str(Path(apps_root).resolve())
    candidates = []

    for line in rpm_files:
        line = line.strip()
        if not line.startswith(apps_root + "/"):
            continue

        remainder = line[len(apps_root) + 1:]  # skip the trailing slash
        first_component = remainder.split("/", 1)[0]
        if first_component:
            candidates.append(f"{apps_root}/{first_component}")

    if not candidates:
        return None

    # Return the most common candidate (if multiple)
    return Counter(candidates).most_common(1)[0][0]
