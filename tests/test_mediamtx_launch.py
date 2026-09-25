import os
import socket
import stat
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from neat_insight import mediamtx, utils

REPO = Path(__file__).resolve().parent.parent
CONFIG = str(REPO / "webrtc" / "mediamtx.yml")


class RuntimeConfigTests(unittest.TestCase):
    def test_runtime_config_carries_the_password_and_is_private(self):
        path = utils._write_mediamtx_runtime_config(CONFIG)
        self.addCleanup(os.unlink, path)
        text = Path(path).read_text(encoding="utf-8")
        self.assertIn(f'pass: "{mediamtx.API_PASSWORD}"', text)
        self.assertNotIn(mediamtx.API_PASSWORD_PLACEHOLDER, text)
        self.assertIn("api: yes", text)
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_runtime_config_disables_the_api_when_its_port_is_taken(self):
        # mediamtx exits when it cannot bind its API port, so it launches without the API.
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen(1)
            with self.assertLogs(level="WARNING") as logs:
                path = utils._write_mediamtx_runtime_config(CONFIG, api_port=holder.getsockname()[1])
        self.addCleanup(os.unlink, path)
        text = Path(path).read_text(encoding="utf-8")
        self.assertIn("api: no", text)
        self.assertNotIn("api: yes", text)
        self.assertTrue(any("external" in message for message in logs.output), logs.output)

    def test_port_in_time_wait_does_not_count_as_bound(self):
        # A server-side close leaves 127.0.0.1:<port> in TIME_WAIT; mediamtx (Go) binds over
        # that, so the probe must too, or a restart within a minute would lose detection.
        if os.name != "posix":
            self.skipTest("TIME_WAIT probe semantics are POSIX-specific")
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # as Go's net.Listen does
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port)) as client:
                conn, _ = server.accept()
                conn.close()  # server closes first -> its side enters TIME_WAIT
                client.recv(1)
        self.assertFalse(utils._tcp_port_is_bound(port))

    def test_bound_port_disables_the_client_at_launch(self):
        with socket.socket() as holder:
            holder.bind(("127.0.0.1", 0))
            holder.listen(1)
            with mock.patch.object(mediamtx, "api_disabled_at_launch", False):
                with self.assertLogs(level="WARNING"):
                    path = utils._write_mediamtx_runtime_config(CONFIG, api_port=holder.getsockname()[1])
                self.addCleanup(os.unlink, path)
                self.assertTrue(mediamtx.api_disabled_at_launch)
                calls = []
                client = mediamtx.MediamtxClient(request=lambda *a, **k: calls.append(a) or (200, b"{}"))
                self.assertIsNone(client.snapshot())
                self.assertEqual(calls, [])

    def test_runtime_config_without_the_placeholder_names_the_rebuild(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        broken = Path(tmpdir.name) / "mediamtx.yml"
        broken.write_text("api: yes\n", encoding="utf-8")
        with self.assertRaises(RuntimeError) as caught:
            utils._write_mediamtx_runtime_config(str(broken))
        self.assertIn("Rebuild package with build.sh.", str(caught.exception))

    def test_api_port_is_not_freed_by_force(self):
        # Another owner of 9997 keeps it: Insight degrades instead of killing the holder.
        specs = []
        original = utils._terminate_conflicting_port_specs
        utils._terminate_conflicting_port_specs = specs.extend
        self.addCleanup(setattr, utils, "_terminate_conflicting_port_specs", original)
        utils._terminate_conflicting_ports()
        self.assertNotIn((mediamtx.API_PORT, "TCP"), specs)


if __name__ == "__main__":
    unittest.main()
