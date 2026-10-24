import json
import os
import unittest
import unittest.mock as mock
from types import SimpleNamespace

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55586")

from neat_insight import app as app_module


PORTS = [
    {"name": "mainUI", "hostPortStart": 19900, "hostPortEnd": None, "protocol": "tcp"},
    {"name": "videoUI", "hostPortStart": 18081, "hostPortEnd": None, "protocol": "tcp"},
]


class SysinfoMissingNeatTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def get_without_neat(self):
        with mock.patch.object(app_module.subprocess, "run", side_effect=FileNotFoundError("neat")), \
             mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=list(PORTS)), \
             mock.patch.dict(os.environ, {"CONTAINER_HOST_IP": ""}):
            return self.client.get("/api/sysinfo", base_url="https://192.168.1.25:19900")

    def test_missing_neat_answers_200_with_missing_and_unknown_fields(self):
        response = self.get_without_neat()

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["schema"], "sima.neat.status.v1")
        self.assertEqual(body["missing"], ["neat"])
        self.assertEqual(body["components"], {})
        self.assertEqual(
            body["environment"],
            {"label": None, "mode": None, "sdkVersion": None, "devkitBuildVersion": None, "sysroot": None},
        )
        self.assertEqual(body["updateCheck"], {"offline": None, "status": None})
        self.assertIsNone(body["insight"]["serviceState"])
        self.assertIsNone(body["insight"]["venv"])

    def test_missing_neat_invents_no_versions(self):
        # These are the commits the removed sample payload reported as installed.
        text = self.get_without_neat().get_data(as_text=True)

        self.assertNotIn("7c0ff36", text)
        self.assertNotIn("346c6e9", text)

    def test_missing_neat_still_reports_ports_and_web_ui_url(self):
        body = self.get_without_neat().get_json()

        self.assertEqual(body["exposedPorts"], PORTS)
        self.assertEqual(body["insight"]["webUiUrl"], "https://192.168.1.25:19900")

    def test_neat_answer_carries_no_missing_key(self):
        status = {"schema": "sima.neat.status.v1", "components": {"core": {"name": "Neat core"}}, "exposedPorts": PORTS}
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(status), stderr="")

        with mock.patch.object(app_module.subprocess, "run", return_value=completed), \
             mock.patch.object(app_module, "_read_exposed_ports_from_port_map", return_value=list(PORTS)):
            response = self.client.get("/api/sysinfo", base_url="https://192.168.1.25:19900")

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("missing", response.get_json())
        self.assertEqual(response.get_json()["components"], {"core": {"name": "Neat core"}})


if __name__ == "__main__":
    unittest.main()
