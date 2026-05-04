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

import json
import os
import re
import logging
import socket
from neat_insight.remotefs import _load_remote_config, RemoteFS, create_ssh_client

def is_remote_devkit_configured():
    """
    Determines if the remote devkit is configured as a remote (non-local) system.

    Criteria:
    - `_load_remote_config()` must succeed (i.e., cfg.json exists and contains expected fields).
    - The IP must not be 127.0.0.1, or if it is, then rootPassword must be present.

    Returns:
        bool: True if the remote devkit is considered remotely configured, False otherwise.
    """
    try:
        creds = _load_remote_config()
        ip = creds.get("host")
        password = creds.get("password")

        return ip != "127.0.0.1"

    except (FileNotFoundError, ValueError, json.JSONDecodeError):
        return False

def get_remote_devkit_ip():
    """
    Returns the IP address of the remote devkit from config.

    Returns:
        str: IP address as a string (e.g., '192.168.2.10')
    
    Raises:
        FileNotFoundError, ValueError, json.JSONDecodeError if config is invalid
    """
    creds = _load_remote_config()
    ip = creds.get("host")
    if not ip:
        raise ValueError("Missing 'host' in remote devkit config")
    return ip

def is_remote_devkit_connected(host=None, port=22, timeout=2):
    """
    Lightweight check to see if the remote devkit is reachable over TCP.

    Args:
        host (str): Remote hostname or IP.
        port (int): Port to test (default is 22 for SSH).
        timeout (int): Connection timeout in seconds.

    Returns:
        bool: True if the host is reachable, False otherwise.
    """
    if host is None:
        creds = _load_remote_config()
        host = creds["host"]

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (socket.timeout, socket.error):
        return False


def remote_board_type():
    """
    Detects the remote board type by reading /etc/build or /etc/buildinfo via RemoteFS.

    Returns:
        str: Board type (e.g., "modalix") if found, otherwise None.
    """
    remote_paths = ["/etc/build", "/etc/buildinfo"]

    try:
        with RemoteFS() as rfs:
            for remote_path in remote_paths:
                if not rfs.exists(remote_path):
                    continue

                with rfs.sftp.open(remote_path, "r") as f:
                    for line in f:
                        if line.startswith("MACHINE"):
                            parts = line.split("=")
                            if len(parts) == 2:
                                return parts[1].strip().lower()

            logging.warning("MACHINE entry not found in any remote build files.")
    except Exception as e:
        logging.error(f"Failed to read remote board type: {e}")

    return None


def get_remote_metrics():
    ssh = create_ssh_client()

    def run(cmd):
        stdin, stdout, stderr = ssh.exec_command(cmd)
        return stdout.read().decode()

    # CPU load
    cpu_raw = run("top -bn1 | grep 'Cpu(s)'")
    cpu_match = re.search(r"(\d+\.\d+)\s+us", cpu_raw)
    cpu_percent_total = float(cpu_match.group(1)) if cpu_match else None

    # Memory
    mem_raw = run("free -b")
    mem_match = re.findall(r"Mem:\s+(\d+)\s+(\d+)\s+(\d+)", mem_raw)
    memory_usage = {}
    if mem_match:
        total, used, _ = map(int, mem_match[0])
        memory_usage = {
            "total": total,
            "used": used,
            "percent": round((used / total) * 100, 1) if total else 0
        }

    # MLA memory
    mla_allocated_bytes = 0
    # try:
    #     mla_raw = run("cat /dev/simaai-mem")
    #     match = re.search(r"Total allocated size: (0x[0-9a-fA-F]+)", mla_raw)
    #     if match:
    #         mla_allocated_bytes = int(match.group(1), 16)
    # except:
    #     pass

    # Disk
    disk_raw = run("df -B1 /data | tail -1")
    disk_parts = disk_raw.split()
    disk_usage = {}
    if len(disk_parts) >= 5:
        disk_usage = {
            "mount": "/data",
            "total": int(disk_parts[1]),
            "used": int(disk_parts[2]),
            "free": int(disk_parts[3]),
            "percent": int(disk_parts[4].rstrip('%'))
        }

    # Temperature (if available)
    avg_temp = None
    try:
        if remote_board_type() == 'davinci':
            temp_raw = run("cat /sys/kernel/temperature_profile")
            temps = [int(m.group(1)) for m in re.finditer(r"Temperature.*is (\d+) C", temp_raw)]
            if temps:
                avg_temp = sum(temps) / len(temps)
    except:
        pass

    ssh.close()
    return {
        "cpu_load": cpu_percent_total,
        "memory": memory_usage,
        "mla_allocated_bytes": mla_allocated_bytes,
        "disk": disk_usage,
        "temperature_celsius_avg": avg_temp,
        "REMOTE": True
    }

def delete_remote_file(remote_path):
    """
    Deletes a file from the remote device using RemoteFS (SFTP).

    Args:
        remote_path (str): Absolute path to the file on the remote system.

    Returns:
        dict: {"status": "deleted"} or {"error": "..."}
    """
    try:
        with RemoteFS() as rfs:
            if not rfs.exists(remote_path):
                return {"error": f"File not found: {remote_path}"}

            rfs.sftp.remove(remote_path)
            logging.info(f"🗑️ Deleted remote file: {remote_path}")
            return {"status": "deleted"}

    except Exception as e:
        logging.error(f"Failed to delete remote file {remote_path}: {e}")
        return {"error": str(e)}


def run_remote_gst_inspect(plugin, env_vars):
    """
    Executes gst-inspect-1.0 for a given plugin on the remote devkit via SSH.

    Args:
        plugin (str): GStreamer plugin name.
        env_vars (dict): Environment variables for the remote environment.

    Returns:
        (int, str): Tuple of (exit_code, combined stdout/stderr output)
    """
    try:
        ssh = create_ssh_client()
        try:
            exports = " ".join(f"{k}='{v}'" for k, v in env_vars.items())
            cmd = f"{exports} gst-inspect-1.0 {plugin}"
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=10)

            output = stdout.read().decode('utf-8') + stderr.read().decode('utf-8')
            exit_code = stdout.channel.recv_exit_status()
            return exit_code, output.strip()
        finally:
            ssh.close()
    except Exception as e:
        return -1, f"[Remote error] {str(e)}"
