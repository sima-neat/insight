import os
import urllib.parse
import unittest
import unittest.mock as mock

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55579")

from neat_insight import app as app_module


class ViewerUrlTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def test_viewer_url_uses_video_ui_port_from_port_map(self):
        ports = [
            {"name": "mainUI", "hostPortStart": 19900, "protocol": "tcp"},
            {"name": "videoUI", "hostPortStart": 18081, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports):
            response = self.client.get("/api/viewer-url?mode=dark&src=0,1", headers={"Host": "192.168.1.25:19900"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["url"],
            "https://192.168.1.25:18081/static/viewer.html?mode=dark&src=0%2C1&max_channels=80",
        )

    def test_sdk_viewer_uses_configured_channel_capacity(self):
        with mock.patch.object(app_module, "is_sima_board", return_value=False), \
             mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": 4}):
            response = self.client.get("/api/viewer-url", headers={"Host": "developer.local:9900"})

        payload = response.get_json()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(payload["url"]).query)
        self.assertEqual(payload["max_video_channels"], 4)
        self.assertEqual(payload["channel_limit_source"], "sdk-port-map")
        self.assertTrue(payload["sdk_channel_limited"])
        self.assertEqual(query["src"], ["0,1,2,3"])
        self.assertEqual(query["max_channels"], ["4"])

    def test_sdk_viewer_filters_explicit_sources_above_configured_capacity(self):
        with mock.patch.object(app_module, "is_sima_board", return_value=False), \
             mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": 4}):
            response = self.client.get(
                "/api/viewer-url?src=0,3,4,79,bad,3",
                headers={"Host": "developer.local:9900"},
            )

        query = urllib.parse.parse_qs(urllib.parse.urlsplit(response.get_json()["url"]).query)
        self.assertEqual(query["src"], ["0,3"])

    def test_missing_channel_capacity_uses_legacy_eighty_channel_behavior(self):
        with mock.patch.object(app_module, "is_sima_board", return_value=False), \
             mock.patch.object(app_module, "_read_neat_port_map", return_value={}):
            response = self.client.get("/api/viewer-url", headers={"Host": "developer.local:9900"})

        payload = response.get_json()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(payload["url"]).query)
        self.assertEqual(payload["max_video_channels"], 80)
        self.assertEqual(payload["channel_limit_source"], "legacy-default")
        self.assertFalse(payload["sdk_channel_limited"])
        self.assertEqual(len(query["src"][0].split(",")), 80)

    def test_invalid_channel_capacity_uses_legacy_eighty_channel_behavior(self):
        for invalid in (0, 81, "4", True):
            with self.subTest(invalid=invalid), \
                 mock.patch.object(app_module, "is_sima_board", return_value=False), \
                 mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": invalid}):
                response = self.client.get("/api/viewer-url", headers={"Host": "developer.local:9900"})

            self.assertEqual(response.get_json()["max_video_channels"], 80)
            self.assertEqual(response.get_json()["channel_limit_source"], "legacy-default")

    def test_devkit_ignores_sdk_channel_capacity_and_keeps_eighty_channels(self):
        with mock.patch.object(app_module, "is_sima_board", return_value=True), \
             mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": 4}):
            response = self.client.get("/api/viewer-url", headers={"Host": "modalix.local:9900"})

        payload = response.get_json()
        self.assertEqual(payload["max_video_channels"], 80)
        self.assertEqual(payload["channel_limit_source"], "devkit")
        self.assertFalse(payload["sdk_channel_limited"])

    def test_viewer_url_accepts_nested_video_ui_port_name(self):
        ports = [
            {"name": "videoUI.tcp", "hostPortStart": "28081", "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports):
            response = self.client.get("/api/viewer-url", headers={"Host": "developer.local:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["url"].startswith("https://developer.local:28081/"))

    def test_viewer_url_preserves_ipv6_host(self):
        ports = [
            {"name": "videoUI", "hostPortStart": 18081, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports):
            response = self.client.get("/api/viewer-url", headers={"Host": "[fd00::23]:19900"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["url"].startswith("https://[fd00::23]:18081/"))

    def test_viewer_url_falls_back_to_default_port(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]):
            response = self.client.get("/api/viewer-url", headers={"Host": "10.0.0.22:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["url"].startswith("https://10.0.0.22:8081/"))

    def test_viewer_url_ignores_invalid_video_ui_port(self):
        ports = [
            {"name": "videoUI", "hostPortStart": 70000, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports):
            response = self.client.get("/api/viewer-url", headers={"Host": "10.0.0.22:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["url"].startswith("https://10.0.0.22:8081/"))

    def test_devkit_shell_url_uses_webssh_port_from_port_map(self):
        ports = [
            {"name": "webSSH", "hostPortStart": 26228, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
             mock.patch.object(app_module, "get_devkit_sync_devkit_ip", return_value="10.42.0.175"), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:20710"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["webssh_port"], 8022)
        self.assertEqual(payload["webssh_host_port"], 26228)
        self.assertTrue(payload["launch_url"].startswith("https://10.0.0.23:26228/?"))
        self.assertIn("hostname=10.42.0.175", payload["launch_url"])

    def test_devkit_shell_url_preserves_ipv6_host(self):
        ports = [
            {"name": "webSSH", "hostPortStart": 26228, "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
             mock.patch.object(app_module, "get_devkit_sync_devkit_ip", return_value="10.42.0.175"), \
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
             mock.patch.object(app_module, "get_devkit_sync_devkit_ip", return_value="10.42.0.175"), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:23881"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["launch_url"].startswith("https://10.0.0.23:26911/?"))

    def test_devkit_shell_url_falls_back_to_internal_webssh_port(self):
        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]), \
             mock.patch.object(app_module, "get_devkit_sync_devkit_ip", return_value="10.42.0.175"), \
             mock.patch.object(app_module, "webssh_is_available", return_value=True), \
             mock.patch.object(app_module, "is_webssh_running", return_value=False):
            response = self.client.get("/api/devkit-shell", headers={"Host": "10.0.0.23:9900"})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["webssh_host_port"], 8022)
        self.assertTrue(payload["launch_url"].startswith("https://10.0.0.23:8022/?"))


if __name__ == "__main__":
    unittest.main()
