import unittest
import unittest.mock as mock

from neat_insight import app as app_module
from neat_insight.runtime_config import RuntimeNetworkConfig


class HealthNetworkTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
