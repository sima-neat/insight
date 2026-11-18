import json
import os
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55579")

from neat_insight import app as app_module


class ShellAndPortMapTests(unittest.TestCase):
    """The DevKit shell's URL and the port map lookup; the viewer URL is the server's now (server/)."""

    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        # The shell opens on the selected board, which Insight saves under the user's home. Start every test with no
        # board selected, so a selection saved on the test machine cannot change the result; tests that need a board
        # patch their own manager over this one.
        no_board = mock.patch.object(app_module.board, "get_board_manager", side_effect=RuntimeError("no board"))
        no_board.start()
        self.addCleanup(no_board.stop)

    def test_port_discovery_skips_metadata_only_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            stale = Path(directory) / "stale.json"
            valid = Path(directory) / "valid.json"
            stale.write_text(json.dumps({"schema": 1}), encoding="utf-8")
            valid.write_text(
                json.dumps({"videoUI": {"host": 18081, "protocol": "tcp"}}),
                encoding="utf-8",
            )
            with mock.patch.object(
                app_module,
                "_sysinfo_port_map_candidates",
                return_value=iter((stale, valid)),
            ):
                ports = app_module._read_exposed_ports_from_port_map()

        self.assertEqual(ports[0]["name"], "videoUI")
        self.assertEqual(ports[0]["hostPortStart"], 18081)

    def test_port_discovery_skips_unreadable_candidate(self):
        # GitHub-hosted runners leave a /home/packer that the runner user cannot
        # traverse, so a candidate under it fails with EACCES instead of ENOENT.
        with tempfile.TemporaryDirectory() as directory:
            locked = Path(directory) / "locked"
            locked.mkdir()
            unreadable = locked / ".insight-config" / "neat-port-map.json"
            valid = Path(directory) / "valid.json"
            valid.write_text(
                json.dumps({"videoUI": {"host": 18081, "protocol": "tcp"}}),
                encoding="utf-8",
            )
            locked.chmod(0)
            try:
                with mock.patch.object(
                    app_module,
                    "_sysinfo_port_map_candidates",
                    return_value=iter((unreadable, valid)),
                ):
                    ports = app_module._read_exposed_ports_from_port_map()
            finally:
                locked.chmod(0o700)

        self.assertEqual(ports[0]["name"], "videoUI")
        self.assertEqual(ports[0]["hostPortStart"], 18081)

    def test_devkit_shell_url_uses_webssh_port_from_port_map(self):
        ports = [
            {"name": "webSSH", "hostPortStart": 26228, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
             mock.patch.object(app_module, "_shell_target", return_value=("10.42.0.175", 22, "sima", True)), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:20710"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["webssh_port"], 8022)
        self.assertEqual(payload["webssh_host_port"], 26228)
        self.assertTrue(payload["launch_url"].startswith("https://10.0.0.23:26228/?"))
        self.assertIn("hostname=10.42.0.175", payload["launch_url"])

    def test_the_shell_opens_on_the_selected_board_not_the_sdk_env(self):
        """One control owns the board, so its shell must follow the board that control selected."""
        target = SimpleNamespace(mode="ssh", source="manual", host="10.0.0.9", port=2222, user="dev")
        manager = SimpleNamespace(target=lambda: target)
        with app_module.app.test_request_context(headers={"Host": "10.0.0.23:9900"}), \
             mock.patch.object(app_module.board, "get_board_manager", return_value=manager), \
             mock.patch.object(app_module, "sdk_env_target", return_value={"host": "10.42.0.175", "port": 22, "user": "sima"}):
            self.assertEqual(app_module._shell_target(), ("10.0.0.9", 2222, "dev", False))
            payload = app_module._build_devkit_shell_payload()
            self.assertFalse(payload["credentials_prefilled"])
            self.assertFalse(payload["launch_supported"])
            self.assertIsNone(payload["launch_url"])

        # Insight running on the board itself has no shell of its own to open; the paired SDK DevKit stands in.
        local = SimpleNamespace(mode="local", source="on-board", host=None, port=None, user=None)
        with mock.patch.object(app_module.board, "get_board_manager", return_value=SimpleNamespace(target=lambda: local)), \
             mock.patch.object(app_module, "sdk_env_target", return_value={"host": "10.42.0.175", "port": 2222, "user": "dev"}):
            self.assertEqual(app_module._shell_target(), ("10.42.0.175", 2222, "dev", False))

    def test_sdk_shell_does_not_prefill_default_password_for_custom_user(self):
        target = SimpleNamespace(mode="ssh", source="sdk-env", host="10.0.0.9", port=2222, user="dev")
        manager = SimpleNamespace(target=lambda: target)

        with app_module.app.test_request_context(headers={"Host": "10.0.0.23:9900"}), \
             mock.patch.object(app_module.board, "get_board_manager", return_value=manager):
            self.assertEqual(app_module._shell_target(), ("10.0.0.9", 2222, "dev", False))
            payload = app_module._build_devkit_shell_payload()

        self.assertFalse(payload["credentials_prefilled"])
        self.assertFalse(payload["launch_supported"])
        self.assertIsNone(payload["launch_url"])

    def test_start_devkit_shell_rejects_target_without_safe_prefill(self):
        payload = {
            "configured": True,
            "launch_supported": False,
        }
        with mock.patch.object(app_module, "_build_devkit_shell_payload", return_value=payload), \
             mock.patch.object(app_module, "ensure_webssh_started") as start:
            response = self.client.post("/api/devkit-shell/start")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.get_json(),
            {"error": "The browser shell is available only for the SDK-paired DevKit."},
        )
        start.assert_not_called()

    def test_a_devkit_paired_only_through_sima_devkit_ip_can_open_the_shell(self):
        """The SDK's SIMA_DEVKIT_IP fallback offers the shell, so starting it must not need DEVKIT_SYNC_DEVKIT_IP."""
        env = {"SIMA_DEVKIT_IP": "10.42.0.175"}
        app_module.server_ssl_context = ("cert.pem", "key.pem")
        self.addCleanup(setattr, app_module, "server_ssl_context", None)
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(app_module.board, "get_board_manager", side_effect=RuntimeError("no board")), \
             mock.patch("neat_insight.utils.webssh_is_available", return_value=True), \
             mock.patch("neat_insight.utils.is_webssh_running", return_value=True), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=True):
            response = self.client.post("/api/devkit-shell/start", headers={"Host": "10.0.0.23:9900"})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertIn("hostname=10.42.0.175", response.get_json()["launch_url"])

    def test_devkit_shell_url_preserves_ipv6_host(self):
        ports = [
            {"name": "webSSH", "hostPortStart": 26228, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
             mock.patch.object(app_module, "sdk_env_target", return_value={"host": "10.42.0.175", "port": 22, "user": "sima"}), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "[fd00::23]:20710"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["launch_url"].startswith("https://[fd00::23]:26228/?"))

    def test_devkit_shell_url_accepts_nested_webssh_port_name(self):
        ports = [
            {"name": "webSSH.tcp", "hostPortStart": "26911", "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
             mock.patch.object(app_module, "sdk_env_target", return_value={"host": "10.42.0.175", "port": 22, "user": "sima"}), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:23881"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["launch_url"].startswith("https://10.0.0.23:26911/?"))

    def test_devkit_shell_url_falls_back_to_internal_webssh_port(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]), \
             mock.patch.object(app_module, "sdk_env_target", return_value={"host": "10.42.0.175", "port": 22, "user": "sima"}), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:9900"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["webssh_host_port"], 8022)
        self.assertTrue(payload["launch_url"].startswith("https://10.0.0.23:8022/?"))


if __name__ == "__main__":
    unittest.main()
