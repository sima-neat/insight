import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55580")

from neat_insight import app as app_module


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")


class MediaTreeTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.old_media_dir = app_module.MEDIA_DIR
        app_module.MEDIA_DIR = self.root
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.MEDIA_DIR = self.old_media_dir
        self.tmpdir.cleanup()

    def seed(self):
        touch(self.root / "30FPS" / "highway.mp4")
        touch(self.root / "30FPS" / "indoor" / "lobby.MP4")
        touch(self.root / "30FPS" / "indoor" / "notes.txt")
        touch(self.root / "30FPS" / "indoor" / "cam-a" / "deep.mkv")
        touch(self.root / "120FPS-720p-h264" / "drone.mov")
        (self.root / "empty").mkdir()
        touch(self.root / "docs-only" / "readme.md")
        touch(self.root / "readme.md")
        touch(self.root / ".hidden.mp4")
        touch(self.root / "__MACOSX" / "shadow.mp4")
        touch(self.root / "zeta.mp4")

    def by_name(self, nodes, name):
        for node in nodes:
            if node["name"] == name:
                return node
        self.fail(f"{name} not in {[n['name'] for n in nodes]}")

    def test_files_carry_streamable_flag_by_suffix_case_insensitively(self):
        self.seed()
        tree = app_module.build_media_tree(self.root)
        self.assertTrue(self.by_name(tree, "zeta.mp4")["streamable"])
        self.assertFalse(self.by_name(tree, "readme.md")["streamable"])
        indoor = self.by_name(self.by_name(tree, "/30FPS")["children"], "/indoor")["children"]
        self.assertTrue(self.by_name(indoor, "lobby.MP4")["streamable"])
        self.assertFalse(self.by_name(indoor, "notes.txt")["streamable"])

    def test_folders_count_streamable_files_at_every_depth(self):
        self.seed()
        tree = app_module.build_media_tree(self.root)
        fps30 = self.by_name(tree, "/30FPS")
        self.assertEqual(fps30["streamable_count"], 3)
        indoor = self.by_name(fps30["children"], "/indoor")
        self.assertEqual(indoor["streamable_count"], 2)
        self.assertEqual(self.by_name(indoor["children"], "/cam-a")["streamable_count"], 1)
        self.assertEqual(self.by_name(tree, "/empty")["streamable_count"], 0)
        self.assertEqual(self.by_name(tree, "/docs-only")["streamable_count"], 0)

    def test_hidden_and_macos_entries_are_omitted(self):
        self.seed()
        names = [node["name"] for node in app_module.build_media_tree(self.root)]
        self.assertNotIn(".hidden.mp4", names)
        self.assertNotIn("/__MACOSX", names)

    def test_folders_sort_before_files_case_insensitively(self):
        self.seed()
        names = [node["name"] for node in app_module.build_media_tree(self.root)]
        self.assertEqual(names, ["/120FPS-720p-h264", "/30FPS", "/docs-only", "/empty", "readme.md", "zeta.mp4"])

    def test_paths_are_relative_posix_paths(self):
        self.seed()
        tree = app_module.build_media_tree(self.root)
        cam_a = self.by_name(self.by_name(self.by_name(tree, "/30FPS")["children"], "/indoor")["children"], "/cam-a")
        self.assertEqual(self.by_name(cam_a["children"], "deep.mkv")["path"], "30FPS/indoor/cam-a/deep.mkv")

    def test_endpoint_serves_the_annotated_tree(self):
        self.seed()
        response = self.client.get("/api/media-files")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(self.by_name(payload, "/30FPS")["streamable_count"], 3)
        self.assertTrue(self.by_name(payload, "zeta.mp4")["streamable"])

    def test_missing_media_dir_returns_empty_list(self):
        app_module.MEDIA_DIR = self.root / "missing"
        self.assertEqual(self.client.get("/api/media-files").get_json(), [])

    def test_video_list_and_tree_agree_on_streamable_files(self):
        self.seed()
        listed = set(self.client.get("/api/mediasrc/videos").get_json())

        def walk(nodes, acc):
            for node in nodes:
                if node["type"] == "file" and node["streamable"]:
                    acc.add(node["path"])
                elif node["type"] == "folder":
                    walk(node["children"], acc)
            return acc

        self.assertEqual(walk(app_module.build_media_tree(self.root), set()), listed)


if __name__ == "__main__":
    unittest.main()
