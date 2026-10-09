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
        touch(self.root / "Beta.mp4")
        touch(self.root / "alpha.mp4")
        (self.root / "Zulu").mkdir()

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
        self.assertEqual(
            names,
            ["/120FPS-720p-h264", "/30FPS", "/docs-only", "/empty", "/Zulu", "alpha.mp4", "Beta.mp4", "readme.md", "zeta.mp4"],
        )

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

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unsupported")
    def test_symlinked_directories_are_not_descended(self):
        touch(self.root / "real" / "clip.mp4")
        try:
            (self.root / "real" / "loop").symlink_to(self.root / "real", target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unsupported")
        tree = app_module.build_media_tree(self.root)
        real = self.by_name(tree, "/real")
        self.assertEqual(real["streamable_count"], 1)
        names = [node["name"] for node in real["children"]]
        self.assertNotIn("/loop", names)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unsupported")
    def test_symlinked_directory_named_like_a_video_is_not_streamable(self):
        touch(self.root / "real" / "clip.mp4")
        try:
            (self.root / "real" / "alias.mp4").symlink_to(self.root / "real", target_is_directory=True)
        except OSError:
            self.skipTest("symlinks unsupported")
        tree = app_module.build_media_tree(self.root)
        real = self.by_name(tree, "/real")
        self.assertEqual(real["streamable_count"], 1)
        alias = self.by_name(real["children"], "alias.mp4")
        self.assertFalse(alias["streamable"])
        listed = set(self.client.get("/api/mediasrc/videos").get_json())
        self.assertNotIn("real/alias.mp4", listed)

    def test_macosx_prefix_folders_are_kept(self):
        touch(self.root / "__MACOSX" / "junk.mp4")
        touch(self.root / "__MACOSX_backup" / "keep.mp4")
        tree = app_module.build_media_tree(self.root)
        names = [node["name"] for node in tree]
        self.assertNotIn("/__MACOSX", names)
        backup = self.by_name(tree, "/__MACOSX_backup")
        self.assertEqual(backup["streamable_count"], 1)
        listed = set(self.client.get("/api/mediasrc/videos").get_json())
        self.assertIn("__MACOSX_backup/keep.mp4", listed)
        self.assertNotIn("__MACOSX/junk.mp4", listed)


@unittest.skipUnless(hasattr(os, "symlink"), "symlinks unsupported")
class DeleteMediaSymlinkTests(unittest.TestCase):
    """Codex review: deleting a symlinked entry must remove the link, never what it points at."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.media_dir = self.root / "media"
        self.media_dir.mkdir()
        self.sources_file = self.root / "media_sources.json"
        self.sources_file.write_text("[]", encoding="utf-8")
        self.old = (app_module.MEDIA_DIR, app_module.MEDIA_SRC_DATA_FILE, app_module.RENDITIONS_INDEX_FILE)
        app_module.MEDIA_DIR = self.media_dir
        app_module.MEDIA_SRC_DATA_FILE = self.sources_file
        app_module.RENDITIONS_INDEX_FILE = self.root / "renditions.json"
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.MEDIA_DIR, app_module.MEDIA_SRC_DATA_FILE, app_module.RENDITIONS_INDEX_FILE = self.old
        self.tmpdir.cleanup()

    def link(self, name, target, is_dir):
        try:
            (self.media_dir / name).symlink_to(target, target_is_directory=is_dir)
        except OSError:
            self.skipTest("symlinks unsupported")

    def delete(self, path):
        return self.client.post("/api/delete-media", json={"path": path})

    def test_deleting_a_linked_folder_removes_only_the_link(self):
        touch(self.media_dir / "dataset" / "clip.mp4")
        self.link("alias", self.media_dir / "dataset", is_dir=True)
        response = self.delete("alias")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse((self.media_dir / "alias").is_symlink())
        self.assertTrue((self.media_dir / "dataset" / "clip.mp4").is_file(), "the real folder survives")

    def test_deleting_a_link_to_a_folder_outside_the_library_keeps_that_folder(self):
        touch(self.root / "elsewhere" / "clip.mp4")
        self.link("external", self.root / "elsewhere", is_dir=True)
        response = self.delete("external")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse((self.media_dir / "external").is_symlink())
        self.assertTrue((self.root / "elsewhere" / "clip.mp4").is_file())

    def test_deleting_a_linked_file_removes_only_the_link(self):
        touch(self.media_dir / "real.mp4")
        self.link("alias.mp4", self.media_dir / "real.mp4", is_dir=False)
        response = self.delete("alias.mp4")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse((self.media_dir / "alias.mp4").is_symlink())
        self.assertTrue((self.media_dir / "real.mp4").is_file(), "the target file survives")

    def test_deleting_a_dangling_link_succeeds(self):
        self.link("gone", self.media_dir / "missing", is_dir=True)
        self.assertEqual(self.delete("gone").status_code, 200)
        self.assertFalse((self.media_dir / "gone").is_symlink())

    def test_slots_assigned_through_a_deleted_link_are_cleared(self):
        touch(self.media_dir / "dataset" / "clip.mp4")
        self.link("alias", self.media_dir / "dataset", is_dir=True)
        sources = app_module.load_sources()
        sources[0]["file"] = "alias/clip.mp4"
        sources[1]["file"] = "dataset/clip.mp4"
        app_module.save_sources(sources)
        self.assertEqual(self.delete("alias").status_code, 200)
        after = app_module.load_sources()
        self.assertEqual(after[0]["file"], "", "the slot reading through the link is unassigned")
        self.assertEqual(after[1]["file"], "dataset/clip.mp4", "the slot reading the real file keeps it")

    def test_a_link_outside_the_library_is_refused(self):
        touch(self.root / "outside.mp4")
        (self.root / "escape").symlink_to(self.root / "outside.mp4")
        self.assertEqual(self.delete("../escape").status_code, 403)
        self.assertTrue((self.root / "escape").is_symlink())


if __name__ == "__main__":
    unittest.main()
