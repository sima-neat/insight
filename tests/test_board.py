import os
import socket
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
    def __init__(self, results=None, error=None):
        self.results = list(results or [])
        self.error = error
        self.calls = []
        self.closed = False

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv)
        if self.error:
            raise self.error
        return self.results.pop(0) if self.results else ExecResult(0, IDENTITY_OUTPUT, b"")

    def remote_host_key_fingerprint(self):
        return "SHA256:abc"

    def close(self):
        self.closed = True


class TargetResolutionTests(unittest.TestCase):
    def test_precedence_is_manual_then_board_then_sdk_env(self):
        saved = {"host": "10.0.0.5", "port": 2222, "user": "dev"}
        sdk = {"host": "192.168.2.2", "port": 22, "user": "sima"}
        manual = target_module.resolve_target(saved, True, sdk)
        self.assertEqual((manual.mode, manual.source, manual.label), ("ssh", "manual", "dev@10.0.0.5:2222"))
        local = target_module.resolve_target(None, True, sdk)
        self.assertEqual((local.mode, local.source, local.label), ("local", "on-board", "This board"))
        env = target_module.resolve_target(None, False, sdk)
        self.assertEqual((env.source, env.label), ("sdk-env", "sima@192.168.2.2"))
        self.assertIsNone(target_module.resolve_target(None, False, None))

    def test_sdk_env_reads_devkit_sync_like_the_rest_of_insight(self):
        env = {"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.7", "DEVKIT_SYNC_DEVKIT_USER": "dev", "DEVKIT_SYNC_DEVKIT_PORT": "2222"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(target_module.sdk_env_target(), {"host": "192.168.2.7", "port": 2222, "user": "dev"})
        with mock.patch.dict(os.environ, {"DEVKIT_SYNC_DEVKIT_IP": "devkit.local"}, clear=True):
            with self.assertLogs(level="WARNING"):
                self.assertIsNone(target_module.sdk_env_target())
        with mock.patch.dict(os.environ, {"SIMA_DEVKIT_IP": "192.168.2.9"}, clear=True):
            self.assertEqual(target_module.sdk_env_target()["host"], "192.168.2.9")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(target_module.sdk_env_target())

    def test_validation_rejects_option_like_hosts_bad_ports_and_users(self):
        for host, port, user in (("-oProxyCommand=x", 22, "sima"), ("", 22, "sima"), ("board", 70000, "sima"), ("board", 22, "a b")):
            with self.assertRaises(BoardError) as ctx:
                target_module.validate_ssh_target(host, port, user)
            self.assertEqual(ctx.exception.status, 400)

    def test_store_round_trips_and_ignores_corrupt_files(self):
        with tempfile.TemporaryDirectory() as directory:
            store = target_module.TargetStore(Path(directory) / "board-target.json")
            self.assertIsNone(store.load())
            store.save({"host": "board", "port": 22, "user": "sima"})
            self.assertEqual(store.load(), {"host": "board", "port": 22, "user": "sima"})
            store.path.write_text("{not json", encoding="utf-8")
            with self.assertLogs(level="WARNING"):
                self.assertIsNone(store.load())
            store.clear()
            store.clear()


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
        transport.target = (host, port, user)
        self.transports.append(transport)
        return transport

    def test_state_reports_sdk_default_without_connecting(self):
        body = self.client.get("/api/board").get_json()
        self.assertEqual(body["target"]["source"], "sdk-env")
        self.assertEqual(body["defaults"]["sdk_env"], {"host": "192.168.2.2", "port": 22, "user": "sima"})
        self.assertEqual(body["status"]["state"], "unknown")
        self.assertEqual(body["generation"], 1)
        self.assertEqual(self.transports[0].calls, [])

    def test_test_reads_identity_and_marks_connected(self):
        body = self.client.post("/api/board/test").get_json()
        self.assertEqual(body["status"]["state"], "connected")
        self.assertEqual(body["board"]["hostname"], "modalix")
        self.assertEqual(body["board"]["machine"], "modalix")
        self.assertEqual(body["board"]["build_version"], "2.1.3_master_B4837")
        self.assertEqual(len(body["board"]["fingerprint"]), 16)

    def test_select_and_reset_bump_generation_and_close_old_connection(self):
        first = self.client.get("/api/board").get_json()["generation"]
        body = self.client.post("/api/board/select", json={"host": "10.1.1.1", "port": 2222, "user": "dev"}).get_json()
        self.assertEqual(body["target"]["source"], "manual")
        self.assertEqual(body["saved"], {"host": "10.1.1.1", "port": 2222, "user": "dev"})
        self.assertGreater(body["generation"], first)
        self.assertTrue(self.transports[0].closed)
        self.assertEqual(self.transports[-1].target, ("10.1.1.1", 2222, "dev"))
        body = self.client.post("/api/board/select", json={"reset": True}).get_json()
        self.assertEqual(body["target"]["source"], "sdk-env")
        self.assertIsNone(body["saved"])

    def test_invalid_selection_returns_400_with_hint(self):
        response = self.client.post("/api/board/select", json={"host": "", "user": "sima"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "invalid_request")
        self.assertTrue(response.get_json()["hint"])

    def test_connection_errors_surface_with_code_and_are_recorded(self):
        self.client.get("/api/board")
        self.transports[-1].error = BoardError("unreachable", "Could not connect", hint="Check the cable")
        response = self.client.post("/api/board/test")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json(), {"error": "Could not connect", "code": "unreachable", "hint": "Check the cable"})
        status = self.client.get("/api/board").get_json()["status"]
        self.assertEqual((status["state"], status["error"]["code"]), ("error", "unreachable"))

    def test_errors_from_a_replaced_target_do_not_overwrite_new_status(self):
        with self.app.app_context():
            old = board.get_board_manager().session()
            self.client.post("/api/board/select", json={"host": "10.1.1.1"})
            self.transports[0].error = BoardError("timeout", "late")
            with self.assertRaises(BoardError):
                old.transport.exec(["true"], timeout=1)
        self.assertEqual(self.client.get("/api/board").get_json()["status"]["state"], "unknown")

    def test_no_target_is_409(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            response = self.client.post("/api/board/test")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "no_target")

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

    def test_identity_is_read_on_every_call(self):
        with self.app.app_context():
            session = board.get_board_manager().session()
            session.identity()
            session.identity()
        self.assertEqual(len(self.transports[-1].calls), 2)

    def test_empty_identity_output_is_an_error(self):
        self.client.get("/api/board")
        self.transports[-1].results = [ExecResult(0, b"", b"")]
        response = self.client.post("/api/board/test")
        self.assertEqual((response.status_code, response.get_json()["code"]), (502, "command_failed"))

    def test_non_object_bodies_get_the_json_error_shape(self):
        response = self.client.post("/api/board/select", json=[1])
        self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))

    def test_board_state_is_not_cached(self):
        self.assertEqual(self.client.get("/api/board").headers["Cache-Control"], "no-store")


class LocalTransportTests(unittest.TestCase):
    def test_exec_captures_output_stdin_and_missing_commands(self):
        transport = LocalTransport()
        result = transport.exec(["sh", "-c", "cat; echo err >&2; exit 3"], timeout=5, stdin=b"hello")
        self.assertEqual((result.exit_code, result.stdout, result.stderr), (3, b"hello", b"err\n"))
        self.assertEqual(transport.exec(["no-such-command-xyz"], timeout=5).exit_code, 127)

    def test_exec_timeout_raises_board_error(self):
        with self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["sleep", "5"], timeout=0.2)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("timeout", 504))


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

    def test_auth_failure_command_uses_sudo_when_insight_runs_as_root(self):
        with mock.patch.object(transport_module, "_local_account", return_value="root"):
            error = self._connect_raising(paramiko.AuthenticationException("denied"))
        self.assertEqual(error.extra["command"], "sudo -H ssh-copy-id -p 22 sima@192.168.2.2")

    def test_closed_transport_never_connects(self):
        self.transport.close()
        with mock.patch.object(paramiko.SSHClient, "connect") as connect:
            with self.assertRaises(BoardError) as ctx:
                self.transport.exec(["true"], timeout=1)
        self.assertEqual(ctx.exception.code, "stale_snapshot")
        connect.assert_not_called()

    def test_auth_failure_suggests_ssh_copy_id(self):
        error = self._connect_raising(paramiko.AuthenticationException("denied"))
        self.assertEqual(error.code, "auth_failed")
        self.assertIn("ssh-copy-id -p 22 sima@192.168.2.2", error.hint)

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

    def test_network_failures_are_unreachable(self):
        self.assertEqual(self._connect_raising(socket.timeout("timed out")).code, "unreachable")
        self.assertEqual(self._connect_raising(ConnectionRefusedError("refused")).code, "unreachable")
        self.assertIn("could not be resolved", self._connect_raising(socket.gaierror("nope")).message)


if __name__ == "__main__":
    unittest.main()
