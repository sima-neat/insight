import base64
import getpass
import hashlib
import os
import selectors
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


class CommandCancelled(Exception):
    """Raised by exec when its cancel_event is set; the command has been stopped."""


def _board_changed() -> BoardError:
    return BoardError(
        "stale_snapshot",
        "The selected board changed while this request was running.",
        hint="Retry to use the newly selected board.",
    )


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


def _output_too_large(argv: List[str]) -> BoardError:
    return BoardError("command_failed", f"`{argv[0]}` produced more than {MAX_OUTPUT_BYTES} bytes of output.")


class LocalTransport:
    """Runs commands on the machine Insight runs on (Insight installed on the board).

    exec's on_stdout, when given, is called with each stdout chunk as it arrives (the microphone
    test meters audio live); setting cancel_event stops the command and raises CommandCancelled.
    close() kills the commands still running, so a board change ends a recording at once.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._active = set()
        self._closed = False

    def exec(
        self, argv: List[str], *, timeout: float, stdin: Optional[bytes] = None, on_stdout=None, cancel_event=None
    ) -> ExecResult:
        deadline = time.monotonic() + timeout
        with self._lock:
            if self._closed:
                raise _board_changed()
            try:
                proc = subprocess.Popen(
                    argv,
                    stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except FileNotFoundError:
                return ExecResult(127, b"", f"{argv[0]}: command not found".encode())
            except OSError as exc:
                # As a shell reports a command it cannot run (an argument list too long, a non-executable file).
                return ExecResult(126, b"", f"{argv[0]}: {exc.strerror or exc}".encode())
            self._active.add(proc)
        try:
            stdout, stderr = self._collect(proc, argv, stdin, deadline, timeout, on_stdout, cancel_event)
            try:
                exit_code = proc.wait(max(deadline - time.monotonic(), 0))
            except subprocess.TimeoutExpired:
                raise _timeout_error(argv, timeout, "this board") from None
            with self._lock:
                if self._closed:
                    raise _board_changed()
            return ExecResult(exit_code, stdout, stderr)
        finally:
            if proc.poll() is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                proc.wait()
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                if pipe and not pipe.closed:
                    pipe.close()
            with self._lock:
                self._active.discard(proc)

    @staticmethod
    def _collect(proc, argv, stdin, deadline, timeout, on_stdout=None, cancel_event=None):
        # Read as the output arrives, so the SSH transport's output limit holds here too.
        chunks = {proc.stdout: [], proc.stderr: []}
        pending = memoryview(stdin or b"")
        size = 0
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            selector.register(proc.stderr, selectors.EVENT_READ)
            if proc.stdin:
                if pending:
                    os.set_blocking(proc.stdin.fileno(), False)
                    selector.register(proc.stdin, selectors.EVENT_WRITE)
                else:
                    proc.stdin.close()
            while selector.get_map():
                if cancel_event is not None and cancel_event.is_set():
                    raise CommandCancelled()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _timeout_error(argv, timeout, "this board")
                # Wake up regularly when the command can be cancelled, even if it prints nothing.
                wait = min(remaining, 0.1) if cancel_event is not None else remaining
                for key, _ in selector.select(wait):
                    if key.fileobj is proc.stdin:
                        try:
                            pending = pending[os.write(key.fd, pending[:65536]):]
                        except BlockingIOError:
                            pass
                        except BrokenPipeError:
                            pending = pending[:0]
                        if not pending:
                            selector.unregister(proc.stdin)
                            proc.stdin.close()
                        continue
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    chunks[key.fileobj].append(chunk)
                    size += len(chunk)
                    if on_stdout is not None and key.fileobj is proc.stdout:
                        on_stdout(chunk)
                    if size > MAX_OUTPUT_BYTES:
                        raise _output_too_large(argv)
        return b"".join(chunks[proc.stdout]), b"".join(chunks[proc.stderr])

    def remote_host_key_fingerprint(self) -> Optional[str]:
        return None

    def close(self) -> None:
        with self._lock:
            self._closed = True
            active = list(self._active)
        for proc in active:
            if proc.poll() is None:
                try:
                    proc.kill()
                except ProcessLookupError:
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

    def exec(
        self, argv: List[str], *, timeout: float, stdin: Optional[bytes] = None, on_stdout=None, cancel_event=None
    ) -> ExecResult:
        # on_stdout and cancel_event as for LocalTransport.exec; cancelling closes only this command's channel.
        deadline = time.monotonic() + timeout
        channel = None
        channel_cancelled = threading.Event()
        guard = threading.Lock()

        def cancel_channel():
            with guard:
                channel_cancelled.set()
                target = channel
            if target is not None:
                threading.Thread(target=target.close, daemon=True).start()

        def open_channel():
            # Runs in _run_bounded's worker: a channel that opens after Stop was pressed is closed.
            nonlocal channel
            opened = self._open_channel(deadline, argv, timeout)
            with guard:
                if not channel_cancelled.is_set():
                    channel = opened
                    return opened
            opened.close()
            raise CommandCancelled()

        def check_cancelled():
            if cancel_event is not None and cancel_event.is_set():
                raise CommandCancelled()

        try:
            check_cancelled()
            if cancel_event is None:
                channel = self._open_channel(deadline, argv, timeout)
            else:
                self._run_bounded(open_channel, cancel_channel, deadline, argv, timeout, cancel_event)
            check_cancelled()
            self._arm(channel, deadline, argv, timeout)
            self._run_bounded(
                lambda: channel.exec_command(shlex.join(argv)), cancel_channel, deadline, argv, timeout, cancel_event
            )
            if stdin:
                self._sendall(channel, stdin, deadline, argv, timeout, check_cancelled)
            self._arm(channel, deadline, argv, timeout)
            self._run_bounded(channel.shutdown_write, cancel_channel, deadline, argv, timeout, cancel_event)
            return self._collect(channel, argv, deadline, timeout, on_stdout, cancel_event)
        except BoardError as exc:
            if channel is not None and exc.code == "timeout" and not channel_cancelled.is_set():
                cancel_channel()
            raise
        except socket.timeout:
            if channel is not None:
                cancel_channel()
            raise _timeout_error(argv, timeout, f"{self.user}@{self.host}") from None
        except (paramiko.SSHException, OSError, EOFError) as exc:
            self._drop()
            if self._closed:
                raise self._stale() from exc
            if time.monotonic() >= deadline:
                raise _timeout_error(argv, timeout, f"{self.user}@{self.host}") from None
            raise self._unreachable(f"The SSH session to {self.host} failed: {exc}") from exc
        finally:
            if channel is not None and not channel_cancelled.is_set():
                cancel_channel()

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
        # Set the flag before dropping the client; _open_channel stores its client before checking
        # the flag, so one of the two always sees the other and the connection is never kept.
        self._closed = True
        self._drop()

    def _collect(self, channel, argv: List[str], deadline: float, timeout: float, on_stdout=None, cancel_event=None) -> ExecResult:
        stdout, stderr, size = [], [], 0
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise CommandCancelled()
            self._remaining(deadline, argv, timeout)
            progressed = False
            # The limit is checked per chunk: output that never pauses must not grow past it.
            while channel.recv_ready():
                self._arm(channel, deadline, argv, timeout)
                stdout.append(channel.recv(65536))
                size += len(stdout[-1])
                if on_stdout is not None:
                    on_stdout(stdout[-1])
                progressed = True
                if size > MAX_OUTPUT_BYTES:
                    raise _output_too_large(argv)
            while channel.recv_stderr_ready():
                self._arm(channel, deadline, argv, timeout)
                stderr.append(channel.recv_stderr(65536))
                size += len(stderr[-1])
                progressed = True
                if size > MAX_OUTPUT_BYTES:
                    raise _output_too_large(argv)
            # Exit status is sent after all output, so both buffers are complete once it arrives.
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                return ExecResult(channel.recv_exit_status(), b"".join(stdout), b"".join(stderr))
            if not progressed:
                time.sleep(min(0.01, self._remaining(deadline, argv, timeout)))

    def _open_channel(self, deadline, argv, timeout):
        if not self._lock.acquire(timeout=self._remaining(deadline, argv, timeout)):
            raise _timeout_error(argv, timeout, f"{self.user}@{self.host}")
        try:
            if self._closed:
                raise self._stale()
            client = self._client
            transport = client.get_transport() if client else None
            if transport is None or not transport.is_active():
                self._drop()
                client = self._connect(deadline, argv, timeout)
                # Store first, then check: a close() that ran before the store saw no client to
                # close, so this check has to catch it (see close()).
                self._client = client
                if self._closed:
                    self._drop()
                    raise self._stale()
            try:
                remaining = self._remaining(deadline, argv, timeout)
                return client.get_transport().open_session(timeout=min(self.connect_timeout, remaining))
            except (paramiko.SSHException, OSError, EOFError, AttributeError) as exc:
                self._drop()
                if self._closed:
                    raise self._stale() from exc
                if time.monotonic() >= deadline:
                    raise _timeout_error(argv, timeout, f"{self.user}@{self.host}") from None
                raise self._unreachable(f"Could not open an SSH session on {self.host}: {exc}") from exc
        finally:
            self._lock.release()

    def _connect(self, deadline, argv, command_timeout) -> paramiko.SSHClient:
        self.known_hosts.parent.mkdir(parents=True, exist_ok=True)
        self.known_hosts.touch(exist_ok=True)
        client = paramiko.SSHClient()
        client.load_host_keys(str(self.known_hosts))
        # With Insight's own known_hosts loaded, AutoAddPolicy only applies to unknown hosts
        # (accept-new); a changed key still raises BadHostKeyException.
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        raw_socket = None
        remaining = self._remaining(deadline, argv, command_timeout)
        timeout = min(self.connect_timeout, remaining)
        try:
            raw_socket = self._connect_socket(deadline, argv, command_timeout)

            def connect():
                client.connect(
                    self.host,
                    port=self.port,
                    username=self.user,
                    sock=raw_socket,
                    timeout=timeout,
                    banner_timeout=timeout,
                    auth_timeout=timeout,
                    allow_agent=True,
                    look_for_keys=True,
                )

            def cancel():
                def close():
                    raw_socket.close()
                    client.close()

                threading.Thread(target=close, daemon=True).start()

            self._run_bounded(connect, cancel, deadline, argv, command_timeout)
        except paramiko.BadHostKeyException as exc:
            client.close()
            raw_socket.close()
            self._check_connect_deadline(deadline, argv, command_timeout)
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
            raw_socket.close()
            self._check_connect_deadline(deadline, argv, command_timeout)
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
            if raw_socket is not None:
                raw_socket.close()
            self._check_connect_deadline(deadline, argv, command_timeout)
            raise BoardError(
                "unreachable",
                f"The host name {self.host} could not be resolved.",
                hint="Use the board's IP address, or check DNS on this machine.",
            ) from exc
        except (paramiko.SSHException, OSError, EOFError) as exc:
            client.close()
            if raw_socket is not None:
                raw_socket.close()
            self._check_connect_deadline(deadline, argv, command_timeout)
            raise self._unreachable(f"Could not connect to {self.host}:{self.port}: {exc}") from exc
        self._check_connect_deadline(deadline, argv, command_timeout, client)
        client.get_transport().set_keepalive(15)
        # The board now presents the trusted key, so an earlier rejected one must not be trusted later.
        self.presented_host_key = None
        return client

    def _connect_socket(self, deadline, argv, timeout):
        addresses = self._run_bounded(
            lambda: socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM),
            lambda: None,
            deadline,
            argv,
            timeout,
        )

        last_error = None
        for family, socktype, proto, _, address in addresses:
            connection = socket.socket(family, socktype, proto)
            try:
                connection.settimeout(min(self.connect_timeout, self._remaining(deadline, argv, timeout)))
                connection.connect(address)
                return connection
            except OSError as exc:
                last_error = exc
                connection.close()
        raise last_error or socket.gaierror(f"Could not resolve {self.host}")

    def _run_bounded(self, action, cancel, deadline, argv, timeout, cancel_event=None):
        # A set cancel_event stops the wait at once: the channel is closed and CommandCancelled raised.
        result = []
        done = threading.Event()
        remaining = self._remaining(deadline, argv, timeout)

        def run():
            try:
                result.append((True, action()))
            except BaseException as exc:
                result.append((False, exc))
            finally:
                done.set()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        end = time.monotonic() + remaining
        while not done.is_set():
            left = end - time.monotonic()
            if left <= 0:
                # Cancellation is best-effort and must return without extending the caller's deadline.
                cancel()
                raise _timeout_error(argv, timeout, f"{self.user}@{self.host}")
            if cancel_event is not None and cancel_event.is_set():
                cancel()
                raise CommandCancelled()
            done.wait(left if cancel_event is None else min(left, 0.05))
        succeeded, value = result[0]
        if not succeeded:
            raise value
        return value

    def _remaining(self, deadline, argv, timeout) -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _timeout_error(argv, timeout, f"{self.user}@{self.host}")
        return remaining

    def _arm(self, channel, deadline, argv, timeout) -> None:
        channel.settimeout(self._remaining(deadline, argv, timeout))

    def _sendall(self, channel, data, deadline, argv, timeout, check_cancelled=lambda: None) -> None:
        pending = memoryview(data)
        while pending:
            check_cancelled()
            self._arm(channel, deadline, argv, timeout)
            sent = channel.send(pending)
            if sent <= 0:
                raise paramiko.SSHException("SSH channel closed while sending input")
            pending = pending[sent:]

    def _check_connect_deadline(self, deadline, argv, timeout, client=None) -> None:
        if time.monotonic() >= deadline:
            if client is not None:
                client.close()
            raise _timeout_error(argv, timeout, f"{self.user}@{self.host}") from None

    def _stale(self) -> BoardError:
        return _board_changed()

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
