import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

from neat_insight import utils
from neat_insight.runtime_config import RuntimeNetworkConfig, load_runtime_network_config


class RuntimeNetworkConfigTests(unittest.TestCase):
    def _load(self, *, ice=None, launch_url=None, environ=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ice_file = root / "browser-ice-address"
            launch_url_file = root / "launch-url"
            if ice is not None:
                ice_file.write_text(ice, encoding="utf-8")
            if isinstance(launch_url, bytes):
                launch_url_file.write_bytes(launch_url)
            elif launch_url is not None:
                launch_url_file.write_text(launch_url, encoding="utf-8")
            return load_runtime_network_config(
                browser_ice_address_file=ice_file,
                launch_url_file=launch_url_file,
                environ=environ or {},
            )

    def test_absent_files_preserve_container_host_ip_behavior(self):
        config = self._load(environ={"CONTAINER_HOST_IP": "10.77.0.1"})

        self.assertEqual(config.browser_ice_address, "10.77.0.1")
        self.assertEqual(config.browser_ice_address_source, "CONTAINER_HOST_IP")
        self.assertIsNone(config.public_origin)

    def test_absent_files_without_a_valid_legacy_address_are_unconfigured(self):
        for value in ("", "not-an-ip", "127.0.0.1", "::1"):
            with self.subTest(value=value):
                config = self._load(environ={"CONTAINER_HOST_IP": value})
                self.assertIsNone(config.browser_ice_address)
                self.assertEqual(config.browser_ice_address_source, "none")

    def test_absent_files_preserve_the_existing_ipv6_fallback(self):
        config = self._load(environ={"CONTAINER_HOST_IP": "fd00::23"})
        self.assertEqual(config.browser_ice_address, "fd00::23")
        self.assertEqual(config.browser_ice_address_source, "CONTAINER_HOST_IP")

    def test_files_enable_browser_address_and_public_origin(self):
        config = self._load(
            ice="54.12.34.56\n",
            launch_url="HTTPS://Insight.Example.com/\n",
            environ={"CONTAINER_HOST_IP": "10.77.0.1"},
        )

        self.assertEqual(
            config,
            RuntimeNetworkConfig(
                browser_ice_address="54.12.34.56",
                browser_ice_address_source="browser-ice-address",
                public_origin="https://insight.example.com/",
            ),
        )

    def test_public_origin_can_include_an_explicit_port(self):
        config = self._load(launch_url="https://insight.example.com:8443")
        self.assertEqual(config.public_origin, "https://insight.example.com:8443/")

    def test_public_origin_is_derived_from_a_full_launch_url(self):
        config = self._load(
            launch_url=(
                "https://Insight.Example.com:8443/environment/launch"
                "?launch-source=host-override#insight\n"
            )
        )
        self.assertEqual(config.public_origin, "https://insight.example.com:8443/")

    def test_present_invalid_browser_address_fails_startup_configuration(self):
        invalid_values = (
            "",
            "54.12.34.56\n10.77.0.1\n",
            "hostname.example.com\n",
            "::1\n",
            "127.0.0.1\n",
            "0.0.0.0\n",
            "224.0.0.1\n",
            "169.254.10.1\n",
            "255.255.255.255\n",
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                self._load(ice=value)

    def test_present_invalid_launch_url_preserves_legacy_url_fallback(self):
        invalid_values = (
            "",
            "insight.example.com\n",
            "ftp://insight.example.com/\n",
            "https://user:secret@insight.example.com/\n",
            "https://foo bar/\n",
            "https://%ZZ/\n",
            "https://faß.de/\n",
            "https://999.999.999.999/\n",
            "https://insight.example.com:0/\n",
            "https://insight.example.com:invalid-port/\n",
            "https://one.example.com/\nhttps://two.example.com/\n",
            b"https://insight.example.com/\xff\n",
        )
        for value in invalid_values:
            with self.subTest(value=value), self.assertLogs(level="WARNING"):
                config = self._load(launch_url=value)
            self.assertIsNone(config.public_origin)


class MediaProcessEnvironmentTests(unittest.TestCase):
    def test_browser_address_is_identical_for_vf_and_mediamtx(self):
        with mock.patch.dict("os.environ", {"CONTAINER_HOST_IP": "10.77.0.1"}, clear=True):
            vf_env, mtx_env = utils._media_process_environments(
                "/cert.pem",
                "/key.pem",
                "54.12.34.56",
            )

        self.assertEqual(vf_env["NEAT_INSIGHT_BROWSER_ICE_ADDRESS"], "54.12.34.56")
        self.assertEqual(mtx_env["MTX_WEBRTCADDITIONALHOSTS"], "54.12.34.56")

    def test_no_override_preserves_mediamtx_container_host_fallback(self):
        with mock.patch.dict("os.environ", {"CONTAINER_HOST_IP": "10.77.0.1"}, clear=True):
            vf_env, mtx_env = utils._media_process_environments("/cert.pem", "/key.pem")

        self.assertNotIn("NEAT_INSIGHT_BROWSER_ICE_ADDRESS", vf_env)
        self.assertEqual(mtx_env["MTX_WEBRTCADDITIONALHOSTS"], "10.77.0.1")


if __name__ == "__main__":
    unittest.main()
