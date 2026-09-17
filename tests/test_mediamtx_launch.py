import os
import stat
import unittest
from pathlib import Path

from neat_insight import mediamtx, utils

REPO = Path(__file__).resolve().parent.parent


class RuntimeConfigTests(unittest.TestCase):
    def test_runtime_config_carries_the_password_and_is_private(self):
        path = utils._write_mediamtx_runtime_config(str(REPO / "webrtc" / "mediamtx.yml"))
        self.addCleanup(os.unlink, path)
        text = Path(path).read_text(encoding="utf-8")
        self.assertIn(f"pass: {mediamtx.API_PASSWORD}", text)
        self.assertNotIn(mediamtx.API_PASSWORD_PLACEHOLDER, text)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_api_port_is_freed_with_the_other_service_ports(self):
        # mediamtx exits when it cannot bind its API port, which takes Insight down with it.
        specs = []
        original = utils._terminate_conflicting_port_specs
        utils._terminate_conflicting_port_specs = specs.extend
        self.addCleanup(setattr, utils, "_terminate_conflicting_port_specs", original)
        utils._terminate_conflicting_ports()
        self.assertIn((mediamtx.API_PORT, "TCP"), specs)


if __name__ == "__main__":
    unittest.main()
