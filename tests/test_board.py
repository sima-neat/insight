import os
import tempfile
import time
import unittest
import unittest.mock as mock
from pathlib import Path

import paramiko
from flask import Flask

from neat_insight import board
from neat_insight.board import manager as manager_module
from neat_insight.board import target as target_module
from neat_insight.board import transport as transport_module
from neat_insight.board.errors import BoardError
from neat_insight.board.manager import BoardManager
from neat_insight.board.target import BoardTarget, TargetStore, resolve_target
from neat_insight.board.transport import ExecResult, LocalTransport, SshTransport, key_fingerprint

SDK_ENV = {"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2", "DEVKIT_SYNC_DEVKIT_USER": "sima", "DEVKIT_SYNC_DEVKIT_PORT": "22"}
IDENTITY_OUTPUT = b"modalix\n@@\n92b95ac6\n@@\nMACHINE = modalix\nSIMA_BUILD_VERSION = 2.1.3_master_B4837\n"


class FakeTransport:
    def __init__(self):
        self.closed = False
        self.presented_host_key = None

    def exec(self, argv, *, timeout, stdin=None):
        return ExecResult(0, IDENTITY_OUTPUT, b"")

    def remote_host_key_fingerprint(self):
        return "SHA256:abc"

    def close(self):
        self.closed = True


class TargetTests(unittest.TestCase):
    def test_target_precedence_is_saved_then_local_then_sdk(self):
        saved = {"host": "manual", "port": 2200, "user": "operator"}
        sdk = {"host": "sdk", "port": 22, "user": "sima"}
        self.assertEqual(resolve_target(saved, True, sdk), BoardTarget("ssh", "manual", "manual", 2200, "operator"))
        self.assertEqual(resolve_target(None, True, sdk), BoardTarget("local", "on-board"))
        self.assertEqual(resolve_target(None, False, sdk), BoardTarget("ssh", "sdk-env", "sdk", 22, "sima"))
        self.assertIsNone(resolve_target(None, False, None))

    def test_target_store_round_trips_and_rejects_option_like_hosts(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TargetStore(Path(tmp) / "target.json")
            expected = {"host": "board.local", "port": 22, "user": "sima"}
            store.save(expected)
            self.assertEqual(store.load(), expected)
            store.clear()
            self.assertIsNone(store.load())
        for host, port, user in (("-oProxyCommand=x", 22, "sima"), ("", 22, "sima"), ("board", 70000, "sima"), ("board", 22, "a b")):
            with self.subTest(host=host, port=port, user=user), self.assertRaises(BoardError):
                target_module.validate_ssh_target(host, port, user)


class BoardManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transports = []

        def make_transport(*args):
            transport = FakeTransport()
            self.transports.append(transport)
            return transport

        patch = mock.patch.object(manager_module, "SshTransport", side_effect=make_transport)
        patch.start()
        self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ, SDK_ENV, clear=True)
        env.start()
        self.addCleanup(env.stop)

    def test_select_persists_and_generation_invalidates_old_session(self):
        manager = BoardManager(Path(self.tmp.name), on_board=False)
        old = manager.session()
        old_generation = old.generation
        manager.select("192.168.2.3", 22, "sima")
        self.assertTrue(old.raw_transport.closed)
        current = manager.session()
        self.assertGreater(current.generation, old_generation)
        with self.assertRaises(BoardError) as ctx:
            old.require_current()
        self.assertEqual(ctx.exception.code, "stale_snapshot")

        restored = BoardManager(Path(self.tmp.name), on_board=False)
        self.assertEqual(restored.target().host, "192.168.2.3")

    def test_board_api_reports_selection_and_identity(self):
        app = Flask(__name__)
        board.init_app(app, Path(self.tmp.name), on_board=False)
        client = app.test_client()
        initial = client.get("/api/board")
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.get_json()["target"]["source"], "sdk-env")
        selected = client.post("/api/board/select", json={"host": "192.168.2.3", "port": 22, "user": "sima"})
        self.assertEqual(selected.get_json()["target"]["source"], "manual")
        tested = client.post("/api/board/test")
        self.assertEqual(tested.status_code, 200)
        self.assertEqual(tested.get_json()["board"]["hostname"], "modalix")


class LocalTransportTests(unittest.TestCase):
    def test_exec_uses_argv_without_shell_interpretation(self):
        result = LocalTransport().exec(["printf", "%s", "$(touch should-not-exist); *"], timeout=2)
        self.assertEqual(result.stdout, b"$(touch should-not-exist); *")
        self.assertFalse(Path("should-not-exist").exists())

    def test_exec_timeout_is_bounded(self):
        started = time.monotonic()
        with self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["sleep", "5"], timeout=0.2)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("timeout", 504))
        self.assertLess(time.monotonic() - started, 2)

    def test_output_limit_stops_the_process(self):
        with mock.patch.object(transport_module, "MAX_OUTPUT_BYTES", 4096), self.assertRaises(BoardError) as ctx:
            LocalTransport().exec(["yes"], timeout=5)
        self.assertEqual(ctx.exception.code, "command_failed")
        self.assertIn("4096 bytes", ctx.exception.message)


class SshTransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.transport = SshTransport("192.168.2.2", 22, "sima", Path(self.tmp.name) / "known_hosts")

    def _connect_raising(self, exc):
        with mock.patch.object(paramiko.SSHClient, "connect", side_effect=exc), self.assertRaises(BoardError) as ctx:
            self.transport.exec(["true"], timeout=1)
        return ctx.exception

    def test_changed_host_key_is_not_silently_accepted(self):
        old, new = paramiko.RSAKey.generate(1024), paramiko.RSAKey.generate(1024)
        error = self._connect_raising(paramiko.BadHostKeyException("192.168.2.2", new, old))
        self.assertEqual((error.code, error.status), ("host_key_changed", 409))
        self.assertEqual(error.extra["presented_fingerprint"], key_fingerprint(new))
        self.assertIs(self.transport.presented_host_key, new)

    def test_auth_failure_explains_key_setup(self):
        with mock.patch("neat_insight.board.transport._local_account", return_value="insight"):
            error = self._connect_raising(paramiko.AuthenticationException("denied"))
        self.assertEqual((error.code, error.status), ("auth_failed", 502))
        self.assertIn("ssh-copy-id", error.hint)
        self.assertIn("insight", error.hint)


if __name__ == "__main__":
    unittest.main()
