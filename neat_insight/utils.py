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
from pathlib import Path
import shutil
import platform
from collections import Counter
from pathlib import Path
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta
import psutil
import ipaddress
import socket

CERT_FILE = 'cert.pem'
KEY_FILE = 'key.pem'
EXCLUDED_EXTENSIONS = {'.so', '.lm', '.bin', '.a', '.o', '.elf', '.rpm', '.tar', '.zip', '.gz', '.bz2', '.xz', '.out', '.pyc'}
EXCLUDED_FOLDERS = {'env', 'bin'}

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
        media_dir = Path("/data/simaai/neat-insight/media")
        media_src_file = Path("/data/simaai/neat-insight/media_sources.json")
        mpk_src_path = Path("/data/simaai/applications")
        user_root = Path("/data/simaai/neat-insight")
    else:
        user_root = Path.home() / ".simaai" / "neat-insight"
        media_dir = user_root / "media"
        media_src_file = user_root / "media_sources.json"
        mpk_src_path = user_root / "applications"

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

    # Ensure MPK source path exists
    try:
        mpk_src_path.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"❌ Error: Failed to create MPK_SRC_PATH at {mpk_src_path}: {e}")
        sys.exit(1)

    upload_root = user_root / "mpk_uploads"
    default_source_count = 16

    return {
        "MEDIA_DIR": media_dir,
        "MEDIA_SRC_DATA_FILE": media_src_file,
        "UPLOAD_ROOT": upload_root,
        "DEFAULT_SOURCE_COUNT": default_source_count,
        "MPK_SRC_PATH": mpk_src_path,
        "OPTVIEW_DATA": user_root,
        "NEAT_INSIGHT_DATA": user_root,
    }

processes = []
process_logs = []
_cleanup_done = False

def _pids_listening_on(port, proto):
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
        return pids
    except Exception:
        return []


def _terminate_conflicting_ports():
    # mediamtx uses 8554/tcp and a default UDP helper port 8000.
    # vf uses 8081/tcp.
    pids = sorted({
        *(_pids_listening_on(8554, "TCP")),
        *(_pids_listening_on(8000, "UDP")),
        *(_pids_listening_on(8081, "TCP")),
    })

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass

    if pids:
        time.sleep(0.2)


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
        raise RuntimeError("vf failed to start. Check neat_insight/bin/logs/vf.log")
    if mtx_proc.poll() is not None:
        raise RuntimeError("mediamtx failed to start. Check neat_insight/bin/logs/mediamtx.log")

def cleanup_processes(signum=None, frame=None, exit_process=True):
    global _cleanup_done
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

    for log_file in list(process_logs):
        try:
            log_file.close()
        except Exception:
            pass
    process_logs.clear()

    if exit_process:
        sys.exit(0)


def _generate_self_signed_cert(cert_file, key_file):
    # Generate private key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    print(f"Python system environment: {sys.version_info}")
    if sys.version_info < (3, 10):
        from cryptography.hazmat.backends import default_backend
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, u'localhost'),
    ])

    cert = x509.CertificateBuilder()\
        .subject_name(subject)\
        .issuer_name(issuer)\
        .public_key(key.public_key())\
        .serial_number(x509.random_serial_number())\
        .not_valid_before(datetime.utcnow())\
        .not_valid_after(datetime.utcnow() + timedelta(days=3650))\
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(u'localhost')]),
            critical=False,
        )\
        .sign(key, hashes.SHA256())

    # Ensure directory exists
    Path(cert_file).parent.mkdir(parents=True, exist_ok=True)

    # Write key
    with open(key_file, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))

    # Write cert
    with open(cert_file, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def check_and_generate_self_signed_cert():
    env = init_environment()
    insight_root = env["NEAT_INSIGHT_DATA"]
    print(insight_root)
    cert_file = os.path.join(insight_root, "cert.pem")
    key_file = os.path.join(insight_root, "key.pem")

    global CERT_FILE, KEY_FILE
    CERT_FILE = cert_file
    KEY_FILE = key_file

    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        print(f"🔐 Generating self-signed certificate in {insight_root}...")
        _generate_self_signed_cert(cert_file, key_file)
    
    ssl_context =  (cert_file, key_file)
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
