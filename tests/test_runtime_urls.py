import os
import unittest
import unittest.mock as mock
import urllib.parse

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55581")

from neat_insight import app as app_module
from neat_insight.runtime_config import RuntimeNetworkConfig


class RuntimePublicUrlTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        self.config = RuntimeNetworkConfig(
            browser_ice_address="54.12.34.56",
            browser_ice_address_source="browser-ice-address",
            public_origin="https://insight.example.com/",
        )

    def test_health_reports_the_applied_startup_configuration(self):
        with mock.patch.object(app_module, "runtime_network_config", self.config):
            response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["network"],
            {
                "browser_ice_address": "54.12.34.56",
                "browser_ice_address_source": "browser-ice-address",
                "public_origin": "https://insight.example.com/",
            },
        )

    def test_viewer_uses_the_public_origin_without_an_internal_port(self):
        with mock.patch.object(app_module, "runtime_network_config", self.config), \
             mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": 4}):
            response = self.client.get("/api/viewer-url?mode=dark&src=0,1", headers={"Host": "10.77.0.1:9900"})

        url = response.get_json()["url"]
        parsed = urllib.parse.urlsplit(url)
        self.assertEqual(f"{parsed.scheme}://{parsed.netloc}", "https://insight.example.com")
        self.assertEqual(parsed.path, "/static/viewer.html")
        self.assertEqual(urllib.parse.parse_qs(parsed.query)["src"], ["0,1"])

    def test_direct_sdk_launch_uses_the_mapped_viewer_port(self):
        for origin, ports, expected in [
            ("https://127.0.0.1:9900/", [], "https://127.0.0.1:8081"),
            ("https://sdk.example:19900/", [
                {"name": "mainUI", "hostPortStart": 19900, "protocol": "tcp"},
                {"name": "videoUI", "hostPortStart": 18081, "protocol": "tcp"},
            ], "https://sdk.example:18081"),
            ("https://[::1]:9900/", [], "https://[::1]:8081"),
            ("https://insight.example:8443/", [], "https://insight.example:8443"),
        ]:
            with self.subTest(origin=origin), \
                 mock.patch.object(app_module, "runtime_network_config",
                     RuntimeNetworkConfig(None, "none", origin)), \
                 mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=ports), \
                 mock.patch.object(app_module, "_read_neat_port_map", return_value={"insightVideoChannels": 4}):
                response = self.client.get("/api/viewer-url?mode=light&src=0,1")
            self.assertEqual(response.status_code, 200)
            url = urllib.parse.urlsplit(response.get_json()["url"])
            self.assertEqual(f"{url.scheme}://{url.netloc}", expected)
            self.assertEqual(url.path, "/static/viewer.html")
            self.assertEqual(urllib.parse.parse_qs(url.query),
                             {"mode": ["light"], "src": ["0,1"], "max_channels": ["4"]})

    def test_whip_and_mjpeg_use_the_public_origin_but_rtsp_does_not(self):
        with mock.patch.object(app_module, "runtime_network_config", self.config), \
             mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=[]), \
             app_module.app.test_request_context(headers={"Host": "10.77.0.1:9900"}):
            whip = app_module._webcam_whip_url({"index": 2})
            mjpeg = app_module._source_url({"index": 2}, "http")
            rtsp = app_module._source_url({"index": 2}, "rtsp")

        self.assertEqual(whip, "https://insight.example.com/cam2/whip")
        self.assertEqual(mjpeg, "https://insight.example.com/stream/http/src2.mjpg")
        self.assertEqual(rtsp, "rtsp://10.77.0.1:8554/src2")


if __name__ == "__main__":
    unittest.main()
