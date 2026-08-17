import tempfile
import unittest
import unittest.mock as mock
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from neat_insight import utils


class EnvironmentStorageTests(unittest.TestCase):
    def test_sdk_detection_uses_sdk_release_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "sdk-release"
            with mock.patch.object(utils, "SDK_RELEASE_FILE", marker):
                self.assertFalse(utils.is_sdk_environment())
                marker.write_text("SDK Profile = platform-cross\n", encoding="utf-8")
                self.assertTrue(utils.is_sdk_environment())

    def _init_non_board(self, home, workspace, *, sdk=True, writable=True):
        stdout = StringIO()
        stderr = StringIO()
        with mock.patch.object(utils, "is_sima_board", return_value=False), \
             mock.patch.object(utils, "is_sdk_environment", return_value=sdk), \
             mock.patch.object(utils.Path, "home", return_value=home), \
             mock.patch.object(utils, "SDK_WORKSPACE", workspace), \
             mock.patch.object(utils.os, "access", return_value=writable), \
             redirect_stdout(stdout), redirect_stderr(stderr):
            environment = utils.init_environment()
        return environment, stdout.getvalue(), stderr.getvalue()

    def test_sdk_uses_persistent_workspace_media_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()

            environment, output, warning = self._init_non_board(home, workspace)

            expected = workspace / ".insight-media"
            self.assertEqual(environment["MEDIA_DIR"], expected)
            self.assertTrue(expected.is_dir())
            self.assertIn(str(expected), output)
            self.assertEqual(warning, "")

    def test_sdk_without_workspace_uses_existing_home_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()

            environment, _, warning = self._init_non_board(home, root / "missing")

            self.assertEqual(environment["MEDIA_DIR"], home / ".simaai" / "neat-insight" / "media")
            self.assertIn("unavailable", warning)
            self.assertIn("ephemeral", warning)

    def test_sdk_with_unwritable_workspace_uses_existing_home_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()

            environment, _, warning = self._init_non_board(home, workspace, writable=False)

            self.assertEqual(environment["MEDIA_DIR"], home / ".simaai" / "neat-insight" / "media")
            self.assertIn("not writable", warning)
            self.assertIn("ephemeral", warning)

    def test_generic_host_keeps_existing_home_media_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            workspace = root / "workspace"
            home.mkdir()
            workspace.mkdir()

            environment, _, warning = self._init_non_board(home, workspace, sdk=False)

            self.assertEqual(environment["MEDIA_DIR"], home / ".simaai" / "neat-insight" / "media")
            self.assertEqual(warning, "")

    def test_devkit_uses_nvme_when_home_is_not_initialized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            nvme = root / "nvme"
            home.mkdir()
            nvme.mkdir()

            with mock.patch.object(utils.Path, "home", return_value=home), \
                 mock.patch.object(utils, "DEVKIT_NVME_ROOT", nvme):
                user_root = utils._ensure_sima_board_neat_insight_home()

            self.assertTrue(user_root.is_symlink())
            self.assertEqual(user_root.resolve(), (nvme / "neat-insight").resolve())

    def test_devkit_keeps_existing_populated_home_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            user_root = home / "neat-insight"
            nvme = root / "nvme"
            user_root.mkdir(parents=True)
            (user_root / "existing.mp4").write_bytes(b"video")
            nvme.mkdir()

            with mock.patch.object(utils.Path, "home", return_value=home), \
                 mock.patch.object(utils, "DEVKIT_NVME_ROOT", nvme):
                selected = utils._ensure_sima_board_neat_insight_home()

            self.assertEqual(selected, user_root)
            self.assertFalse(selected.is_symlink())
            self.assertTrue((selected / "existing.mp4").exists())

    def test_devkit_without_nvme_keeps_existing_home_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()

            with mock.patch.object(utils.Path, "home", return_value=home), \
                 mock.patch.object(utils, "DEVKIT_NVME_ROOT", root / "missing"):
                selected = utils._ensure_sima_board_neat_insight_home()

            self.assertEqual(selected, home / "neat-insight")
            self.assertTrue(selected.is_dir())


if __name__ == "__main__":
    unittest.main()
