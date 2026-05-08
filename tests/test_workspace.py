import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask

from neat_insight import workspace as workspace_module


class WorkspaceTreeTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name).resolve()
        self.original_workspace_root = workspace_module._workspace_root
        workspace_module._workspace_root = lambda: self.root

        app = Flask(__name__)
        app.register_blueprint(workspace_module.workspace_bp)
        self.client = app.test_client()

    def tearDown(self):
        workspace_module._workspace_root = self.original_workspace_root
        self.tmpdir.cleanup()

    def test_tree_ignores_macos_trash_before_metadata_access(self):
        (self.root / ".Trash").mkdir()
        (self.root / "app.py").write_text("print('ok')\n", encoding="utf-8")

        original_is_dir = Path.is_dir

        def guarded_is_dir(path):
            if path.name == ".Trash":
                raise PermissionError(1, "Operation not permitted", str(path))
            return original_is_dir(path)

        with mock.patch.object(Path, "is_dir", guarded_is_dir):
            response = self.client.get("/api/workspace/tree")

        self.assertEqual(response.status_code, 200)
        names = [child["name"] for child in response.get_json()["children"]]
        self.assertEqual(names, ["app.py"])


if __name__ == "__main__":
    unittest.main()
