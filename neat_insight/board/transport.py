import base64
import getpass
import hashlib
import shlex
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import paramiko

from neat_insight.board.errors import BoardError

MAX_OUTPUT_BYTES = 16 * 1024 * 1024


@dataclass
class ExecResult:
    exit_code: int
    stdout: bytes
    stderr: bytes


def key_fingerprint(key) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")


def _local_account() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "the Insight service"


def _timeout_error(argv: List[str], timeout: float, where: str) -> BoardError:
    return BoardError(
        "timeout",
        f"`{argv[0]}` did not finish within {timeout:g} s on {where}.",
        hint="The board may be busy. Retry the action; if it keeps timing out, check the board's load over SSH.",
    )


class LocalTransport:
    """Runs commands on the machine Insight runs on (Insight installed on the board)."""

    def exec(self, argv: List[str], *, timeout: float, stdin: Optional[bytes] = None) -> ExecResult:
        stdin_kwargs = {"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}
        try:
            proc = subprocess.run(argv, capture_output=True, timeout=timeout, check=False, **stdin_kwargs)
        except FileNotFoundError:
            return ExecResult(127, b"", f"{argv[0]}: command not found".encode())
        except subprocess.TimeoutExpired:
            raise _timeout_error(argv, timeout, "this board") from None
        return ExecResult(proc.returncode, proc.stdout, proc.stderr)

    def remote_host_key_fingerprint(self) -> Optional[str]:
        return None

    def close(self) -> None:
        pass


class SshTransport:
    """One persistent SSH connection to a board, authenticated with the service account's SSH keys.

    Host keys live in Insight's own known_hosts: the first key a board presents is trusted
    and saved, and a different key later is refused until the user trusts it explicitly.
    """

    def __init__(self, host: str, port: int, user: str, known_hosts: Path, connect_timeout: float = 8.0):
        self.host = host
        self.port = port
        self.user = user
        self.known_hosts = Path(known_hosts)
        self.connect_timeout = connect_timeout
        self.presented_host_key = None
        self._client: Optional[paramiko.SSHClient] = None
        self._closed = False
        self._lock = threading.Lock()

    @property
    def host_key_name(self) -> str:
        return self.host if self.port == 22 else f"[{self.host}]:{self.port}"

    def exec(self, argv: List[str], *, timeout: float, stdin: Optional[bytes] = None) -> ExecResult:
        channel = self._open_channel()
        try:
            channel.settimeout(timeout)
            channel.exec_command(shlex.join(argv))
            if stdin:
                channel.sendall(stdin)
            channel.shutdown_write()
            return self._collect(channel, argv, timeout)
        except socket.timeout:
            raise _timeout_error(argv, timeout, f"{self.user}@{self.host}") from None
        except (paramiko.SSHException, OSError, EOFError) as exc:
            self._drop()
            raise self._unreachable(f"The SSH session to {self.host} failed: {exc}") from exc
        finally:
            channel.close()

    def remote_host_key_fingerprint(self) -> Optional[str]:
        transport = self._client.get_transport() if self._client else None
        return key_fingerprint(transport.get_remote_server_key()) if transport else None

    def replace_host_key(self, key) -> None:
        keys = paramiko.HostKeys()
        if self.known_hosts.exists():
            keys.load(str(self.known_hosts))
        if self.host_key_name in keys:
            del keys[self.host_key_name]
        keys.add(self.host_key_name, key.get_name(), key)
        self.known_hosts.parent.mkdir(parents=True, exist_ok=True)
        keys.save(str(self.known_hosts))
        self.presented_host_key = None

    def close(self) -> None:
        # Not under the lock: a connect to an unreachable board may hold it for the full timeout.
        self._closed = True
        self._drop()

    def _collect(self, channel, argv: List[str], timeout: float) -> ExecResult:
        deadline = time.monotonic() + timeout
        stdout, stderr, size = [], [], 0
        while True:
            progressed = False
            while channel.recv_ready():
                stdout.append(channel.recv(65536))
                size += len(stdout[-1])
                progressed = True
            while channel.recv_stderr_ready():
                stderr.append(channel.recv_stderr(65536))
                size += len(stderr[-1])
                progressed = True
            if size > MAX_OUTPUT_BYTES:
                raise BoardError("command_failed", f"`{argv[0]}` produced more than {MAX_OUTPUT_BYTES} bytes of output.")
            # Exit status is sent after all output, so both buffers are complete once it arrives.
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                return ExecResult(channel.recv_exit_status(), b"".join(stdout), b"".join(stderr))
            if time.monotonic() >= deadline:
                raise _timeout_error(argv, timeout, f"{self.user}@{self.host}")
            if not progressed:
                time.sleep(0.01)

    def _open_channel(self):
        with self._lock:
            if self._closed:
                raise self._stale()
            client = self._client
            transport = client.get_transport() if client else None
            if transport is None or not transport.is_active():
                self._drop()
                client = self._connect()
                if self._closed:
                    client.close()
                    raise self._stale()
                self._client = client
            try:
                return client.get_transport().open_session(timeout=self.connect_timeout)
            except (paramiko.SSHException, OSError, EOFError, AttributeError) as exc:
                self._drop()
                raise self._unreachable(f"Could not open an SSH session on {self.host}: {exc}") from exc

    def _connect(self) -> paramiko.SSHClient:
        self.known_hosts.parent.mkdir(parents=True, exist_ok=True)
        self.known_hosts.touch(exist_ok=True)
        client = paramiko.SSHClient()
        client.load_host_keys(str(self.known_hosts))
        # With Insight's own known_hosts loaded, AutoAddPolicy only applies to unknown hosts
        # (accept-new); a changed key still raises BadHostKeyException.
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        timeout = self.connect_timeout
        try:
            client.connect(
                self.host,
                port=self.port,
                username=self.user,
                timeout=timeout,
                banner_timeout=timeout,
                auth_timeout=timeout,
                allow_agent=True,
                look_for_keys=True,
            )
        except paramiko.BadHostKeyException as exc:
            client.close()
            self.presented_host_key = exc.key
            raise BoardError(
                "host_key_changed",
                f"{self.host} presented a different SSH host key than the one Insight trusted.",
                hint="This is expected after the board is reflashed. If you reflashed it, trust the new key; "
                "otherwise check that the address still points to your board.",
                host=self.host_key_name,
                expected_fingerprint=key_fingerprint(exc.expected_key),
                presented_fingerprint=key_fingerprint(exc.key),
            ) from exc
        except paramiko.AuthenticationException as exc:
            client.close()
            command = f"ssh-copy-id -p {self.port} {shlex.quote(self.user)}@{shlex.quote(self.host)}"
            account = _local_account()
            if account == "root":
                command = f"sudo -H {command}"
            raise BoardError(
                "auth_failed",
                f"SSH key authentication as {self.user} on {self.host} failed.",
                hint=f"Insight signs in with the SSH keys of the '{account}' account on this machine. "
                f"Authorize one on the board, then retry: {command}",
                command=command,
            ) from exc
        except socket.gaierror as exc:
            client.close()
            raise BoardError(
                "unreachable",
                f"The host name {self.host} could not be resolved.",
                hint="Use the board's IP address, or check DNS on this machine.",
            ) from exc
        except (paramiko.SSHException, OSError, EOFError) as exc:
            client.close()
            raise self._unreachable(f"Could not connect to {self.host}:{self.port}: {exc}") from exc
        client.get_transport().set_keepalive(15)
        return client

    def _stale(self) -> BoardError:
        return BoardError(
            "stale_snapshot",
            "The selected board changed while this request was running.",
            hint="Retry to use the newly selected board.",
        )

    def _unreachable(self, message: str) -> BoardError:
        return BoardError(
            "unreachable",
            message,
            hint=f"Check that the board is powered on and on the network, and that "
            f"`ssh -p {self.port} {self.user}@{self.host}` works from this machine.",
        )

    def _drop(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            client.close()
