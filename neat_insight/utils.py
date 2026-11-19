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
from pathlib import Path
import shutil
import platform
import tempfile
import ssl
from datetime import datetime, timezone
from collections import Counter
import ipaddress
import psutil
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
SDK_RELEASE_FILE = Path("/etc/sdk-release")
SDK_WORKSPACE = Path("/workspace")
SDK_MEDIA_DIR_NAME = ".insight-media"
DEVKIT_NVME_ROOT = Path("/media/nvme")


def _ensure_sima_board_neat_insight_home():
    user_root = Path.home() / "neat-insight"
    nvme_root = DEVKIT_NVME_ROOT
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


def is_sdk_environment():
    """Return whether Insight is running inside a SiMa SDK image."""
    return SDK_RELEASE_FILE.is_file()


def _sdk_media_dir():
    """Return persistent SDK media storage when the workspace is usable."""
    if not is_sdk_environment():
        return None

    if not SDK_WORKSPACE.exists() or not SDK_WORKSPACE.is_dir():
        print(
            f"WARNING: SDK workspace {SDK_WORKSPACE} is unavailable; "
            "Insight media will use ephemeral home-directory storage.",
            file=sys.stderr,
        )
        return None

    if not os.access(SDK_WORKSPACE, os.W_OK | os.X_OK):
        print(
            f"WARNING: SDK workspace {SDK_WORKSPACE} is not writable; "
            "Insight media will use ephemeral home-directory storage.",
            file=sys.stderr,
        )
        return None

    return SDK_WORKSPACE / SDK_MEDIA_DIR_NAME


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
    else:
        user_root = Path.home() / ".simaai" / "neat-insight"
        media_dir = _sdk_media_dir() or user_root / "media"

        sima_mem_file = Path("/tmp/simaai-mem")
        if not sima_mem_file.exists():
            sima_mem_file.touch()
            print("✅ Created /tmp/simaai-mem (non-SIMA board) for simulation")

    # Ensure media directory exists
    media_dir.mkdir(parents=True, exist_ok=True)
    print(f"Insight media directory: {media_dir}")

    return {
        "MEDIA_DIR": media_dir,
        "OPTVIEW_DATA": user_root,
        "NEAT_INSIGHT_DATA": user_root,
    }


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


def get_certificate_host():
    configured_host = os.getenv(CERT_HOST_ENV, "").strip()
    if not configured_host:
        return get_lan_ip()

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
    "docker",
    "br-",
    "veth",
    "virbr",
    "vmnet",
    "vboxnet",
    "vethernet",
    "utun",
    "tun",
    "tap",
    "ppp",
    "wg",
    "zt",
    "tailscale",
    "ipsec",
    "gif",
    "stf",
    "awdl",
    "llw",
    "bridge",
    "anpi",
)
SKIP_IFACE_KEYWORDS = (
    "bluetooth",
    "bridge",
    "container",
    "docker",
    "hyper-v",
    "tunnel",
    "virtual",
    "virtualbox",
    "vmware",
    "vpn",
    "wireguard",
    "zerotier",
)
PHYSICAL_IFACE_PREFIXES = (
    "en",
    "eth",
    "eno",
    "ens",
    "enp",
    "end",
    "wl",
    "wlan",
    "wlp",
)
PHYSICAL_IFACE_KEYWORDS = (
    "ethernet",
    "wi-fi",
    "wifi",
    "wireless",
    "wlan",
    "local area connection",
)


def _valid_reachable_ipv4(value):
    if not value:
        return ""

    try:
        ip_obj = ipaddress.ip_address(value)
    except ValueError:
        return ""

    if (
        ip_obj.version == 4
        and not ip_obj.is_loopback
        and not ip_obj.is_link_local
        and not ip_obj.is_unspecified
    ):
        return value

    return ""


def _source_ip_for_target(target_host, target_port=443):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect((target_host, target_port))
            return _valid_reachable_ipv4(sock.getsockname()[0])
    except OSError:
        return ""


def _interface_is_skipped(iface):
    normalized = iface.strip().lower()
    return normalized.startswith(SKIP_IFACE_PREFIXES) or any(
        keyword in normalized for keyword in SKIP_IFACE_KEYWORDS
    )


def _interface_is_physical(iface):
    normalized = iface.strip().lower()
    if _interface_is_skipped(normalized):
        return False
    return normalized.startswith(PHYSICAL_IFACE_PREFIXES) or any(
        keyword in normalized for keyword in PHYSICAL_IFACE_KEYWORDS
    )


def _physical_interface_ipv4_candidates():
    candidates = []
    for iface, addrs in psutil.net_if_addrs().items():
        if not _interface_is_physical(iface):
            continue

        for addr in addrs:
            if addr.family != socket.AF_INET:
                continue

            ip = _valid_reachable_ipv4(addr.address)
            if ip:
                candidates.append(ip)

    return candidates


def get_lan_ip():
    # Explicit override (containers / orchestration)
    container_ip = os.getenv("CONTAINER_HOST_IP")
    if _valid_reachable_ipv4(container_ip):
        return container_ip

    devkit_ip = os.getenv(DEVKIT_SYNC_DEVKIT_IP_ENV, "").strip()
    physical_ips = _physical_interface_ipv4_candidates()
    if devkit_ip:
        local_ip = _source_ip_for_target(devkit_ip, 22)
        if local_ip and local_ip in physical_ips:
            return local_ip

    default_route_ip = _source_ip_for_target("8.8.8.8")
    if default_route_ip and default_route_ip in physical_ips:
        return default_route_ip

    if physical_ips:
        return physical_ips[0]

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
