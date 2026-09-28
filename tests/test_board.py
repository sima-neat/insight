import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from pathlib import Path

import paramiko
from flask import Flask

from neat_insight import board
from neat_insight.board import manager as manager_module
from neat_insight.board import transport as transport_module
from neat_insight.board import target as target_module
from neat_insight.board.errors import BoardError
from neat_insight.board.transport import ExecResult, LocalTransport, SshTransport, key_fingerprint

SDK_ENV = {"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2", "DEVKIT_SYNC_DEVKIT_USER": "sima", "DEVKIT_SYNC_DEVKIT_PORT": "22"}
IDENTITY_OUTPUT = b"modalix\n@@\n92b95ac6\n@@\nMACHINE = modalix\nSIMA_BUILD_VERSION = 2.1.3_master_B4837\n"


class FakeTransport:
    def __init__(self):
        self.closed = False

    def exec(self, argv, *, timeout, stdin=None):
        return ExecResult(0, IDENTITY_OUTPUT, b"")

    def remote_host_key_fingerprint(self):
        return "SHA256:abc"

    def close(self):
        self.closed = True


class TargetResolutionTests(unittest.TestCase):
    def test_validation_rejects_option_like_hosts_bad_ports_and_users(self):
        for host, port, user in (("-oProxyCommand=x", 22, "sima"), ("", 22, "sima"), ("board", 70000, "sima"), ("board", 22, "a b")):
            with self.assertRaises(BoardError) as ctx:
                target_module.validate_ssh_target(host, port, user)
            self.assertEqual(ctx.exception.status, 400)


class BoardApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env_patch = mock.patch.dict(os.environ, SDK_ENV, clear=True)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.transports = []
        ssh_patch = mock.patch.object(manager_module, "SshTransport", side_effect=self._make_transport)
        ssh_patch.start()
        self.addCleanup(ssh_patch.stop)
        self.app = Flask(__name__)
        board.init_app(self.app, Path(self.tmp.name), on_board=False)
        self.client = self.app.test_client()

    def _make_transport(self, host, port, user, known_hosts):
        transport = FakeTransport()
        self.transports.append(transport)
        return transport

    def test_board_cleanup_runs_before_the_old_transport_is_closed(self):
        self.client.get("/api/board")
        closed = []
        self.app.extensions["neat_board"].set_before_session_close(lambda session: closed.append(session.raw_transport.closed))
        self.assertEqual(self.client.post("/api/board/select", json={"host": "10.1.1.9"}).status_code, 200)
        self.assertEqual(closed, [False])
        self.assertTrue(self.transports[0].closed)

    def test_board_cleanup_wait_does_not_block_transport_error_recording(self):
        manager = self.app.extensions["neat_board"]
        old = manager.session()
        entered, release = threading.Event(), threading.Event()
        manager.set_before_session_close(lambda _session: (entered.set(), release.wait(2)))
        switcher = threading.Thread(target=manager.select, args=("10.1.1.9", 22, "sima"))
        switcher.start()
        self.assertTrue(entered.wait(1))
        old.raw_transport.exec = mock.Mock(side_effect=BoardError("unreachable", "late failure"))
        begin = time.monotonic()
        with self.assertRaises(BoardError):
            old.transport.exec(["true"], timeout=1)
        self.assertLess(time.monotonic() - begin, 0.2)
        release.set()
        switcher.join(2)
        self.assertFalse(switcher.is_alive())

    def test_trust_host_key_requires_the_presented_fingerprint(self):
        response = self.client.post("/api/board/trust-host-key", json={"fingerprint": "SHA256:x"})
        self.assertEqual(response.status_code, 400)

    def test_trusting_a_new_host_key_starts_a_new_board_generation(self):
        before = self.client.post("/api/board/test").get_json()
        old = self.transports[-1]
        key = paramiko.RSAKey.generate(1024)
        old.presented_host_key = key
        old.replace_host_key = mock.Mock()
        response = self.client.post("/api/board/trust-host-key", json={"fingerprint": key_fingerprint(key)})
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        old.replace_host_key.assert_called_once_with(key)
        self.assertTrue(old.closed)
        self.assertIsNot(self.transports[-1], old)
        self.assertGreater(body["generation"], before["generation"])
        self.assertEqual((body["status"]["state"], body["board"]), ("unknown", None))


class LocalTransportTests(unittest.TestCase):
    def test_exec_timeout_raises_board_error(self):
        with self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["sleep", "5"], timeout=0.2)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("timeout", 504))

    def test_exec_stops_a_command_at_the_output_limit_like_ssh(self):
        started = time.monotonic()
        with mock.patch.object(transport_module, "MAX_OUTPUT_BYTES", 4096), self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["yes"], timeout=10)
        self.assertEqual(ctx.exception.code, "command_failed")
        self.assertIn("more than 4096 bytes", ctx.exception.message)
        self.assertLess(time.monotonic() - started, 5, "the command is killed at the limit, not left to the timeout")

    def test_exec_timeout_covers_a_command_that_closed_its_output(self):
        with self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["sh", "-c", "exec >&- 2>&-; sleep 5"], timeout=0.3)
        self.assertEqual(ctx.exception.code, "timeout")

    def test_exec_drains_output_while_writing_large_stdin(self):
        data = b"x" * (512 * 1024)
        # Reads a little stdin, then writes more than a pipe holds before reading the rest.
        interleaved = "import sys; i, o = sys.stdin.buffer, sys.stdout.buffer; i.read(1); o.write(b'y' * (1 << 20)); o.write(i.read())"
        cases = {"cat": (["cat"], data), "interleaved": ([sys.executable, "-c", interleaved], b"y" * (1 << 20) + data[1:])}
        for name, (argv, expected) in cases.items():
            with self.subTest(name):
                self.assertEqual(LocalTransport().exec(argv, timeout=5, stdin=data).stdout, expected)


class SshTransportErrorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transport = SshTransport("192.168.2.2", 22, "sima", Path(self.tmp.name) / "known_hosts")

    def _connect_raising(self, exc):
        with mock.patch.object(paramiko.SSHClient, "connect", side_effect=exc):
            with self.assertRaises(BoardError) as ctx:
                self.transport.exec(["true"], timeout=1)
        return ctx.exception

    def test_closed_transport_never_connects(self):
        self.transport.close()
        with mock.patch.object(paramiko.SSHClient, "connect") as connect:
            with self.assertRaises(BoardError) as ctx:
                self.transport.exec(["true"], timeout=1)
        self.assertEqual(ctx.exception.code, "stale_snapshot")
        connect.assert_not_called()

    def test_changed_host_key_reports_both_fingerprints(self):
        old, new = paramiko.RSAKey.generate(1024), paramiko.RSAKey.generate(1024)
        error = self._connect_raising(paramiko.BadHostKeyException("192.168.2.2", new, old))
        self.assertEqual((error.code, error.status), ("host_key_changed", 409))
        self.assertNotEqual(error.extra["expected_fingerprint"], error.extra["presented_fingerprint"])
        self.assertIs(self.transport.presented_host_key, new)
        self.transport.replace_host_key(new)
        stored = paramiko.HostKeys(str(self.transport.known_hosts))
        self.assertEqual(stored.lookup("192.168.2.2")["ssh-rsa"], new)

    def test_close_during_connect_returns_at_once_and_discards_the_connection(self):
        started, closed, errors = threading.Event(), threading.Event(), []

        def slow_connect(*args, **kwargs):
            started.set()
            closed.wait(2)

        def run():
            try:
                self.transport.exec(["true"], timeout=2)
            except BoardError as exc:
                errors.append(exc.code)

        with mock.patch.object(paramiko.SSHClient, "connect", side_effect=slow_connect), \
             mock.patch.object(paramiko.SSHClient, "get_transport", return_value=mock.Mock()), \
             mock.patch.object(paramiko.SSHClient, "close") as close:
            worker = threading.Thread(target=run)
            worker.start()
            started.wait(2)
            begin = time.monotonic()
            self.transport.close()
            self.assertLess(time.monotonic() - begin, 0.2)
            closed.set()
            worker.join(2)
        self.assertEqual(errors, ["stale_snapshot"])
        self.assertTrue(close.called)

    def test_close_at_any_point_before_the_command_is_sent_stops_it(self):
        # close() takes no lock, so trace-inject it between every line of exec()/_open_channel().
        targets = {SshTransport.exec.__code__, SshTransport._open_channel.__code__}

        class FakeClient:
            def __init__(self):
                self.closed, self.commands = False, []
                client = self

                class Channel:
                    def settimeout(self, timeout):
                        pass

                    def exec_command(self, command):
                        if client.closed:
                            raise paramiko.SSHException("Channel is not open")
                        client.commands.append(command)

                    def shutdown_write(self):
                        pass

                    def close(self):
                        pass

                class Transport:
                    def is_active(self):
                        return not client.closed

                    def open_session(self, timeout=None):
                        if client.closed:
                            raise paramiko.SSHException("SSH session not active")
                        return Channel()

                self._transport = Transport()

            def get_transport(self):
                return self._transport

            def close(self):
                self.closed = True

        def run(connected, close_at):
            transport = SshTransport("192.168.2.2", 22, "sima", Path(self.tmp.name) / "known_hosts")
            client = FakeClient()
            if connected:
                transport._client = client
            seen = [0]

            def local(frame, event, arg):
                if event == "line" and not client.commands and not transport._closed:
                    if seen[0] == close_at:
                        transport.close()
                    seen[0] += 1
                return local

            def global_trace(frame, event, arg):
                return local if frame.f_code in targets else None

            error = None
            with mock.patch.object(SshTransport, "_connect", return_value=client) as connect, \
                 mock.patch.object(SshTransport, "_collect", return_value=ExecResult(0, b"", b"")):
                previous_trace = sys.gettrace()
                sys.settrace(global_trace)
                try:
                    transport.exec(["true"], timeout=1)
                except BoardError as exc:
                    error = exc
                finally:
                    sys.settrace(previous_trace)
            return transport, client, error, seen[0], connected or connect.called

        for connected in (False, True):
            close_at = 0
            while True:
                transport, client, error, lines, handed_out = run(connected, close_at)
                if close_at >= lines:
                    # close() never fired: the command ran normally.
                    self.assertEqual(client.commands, ["true"])
                    break
                with self.subTest(connected=connected, close_at=close_at):
                    self.assertEqual(client.commands, [])
                    self.assertIsNotNone(error)
                    self.assertEqual(error.code, "stale_snapshot")
                    # A connection that was made (or already open) is closed, not left on the transport.
                    self.assertEqual(client.closed, handed_out)
                    self.assertIsNone(transport._client)
                close_at += 1



if __name__ == "__main__":
    unittest.main()
