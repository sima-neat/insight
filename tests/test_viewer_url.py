import os
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
            "https://192.168.1.25:18081/static/viewer.html?mode=dark&src=0%2C1",
        )

    def test_viewer_url_accepts_nested_video_ui_port_name(self):
        ports = [
            {"name": "videoUI.tcp", "hostPortStart": "28081", "protocol": "tcp"},
        ]

        with mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports):
            response = self.client.get("/api/viewer-url", headers={"Host": "developer.local:9900"})

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["url"].startswith("https://developer.local:28081/"))

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


if __name__ == "__main__":
    unittest.main()
