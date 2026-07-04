import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55581")

from neat_insight import app as app_module


class YoutubeImportUrlTests(unittest.TestCase):
    def test_preview_preserves_seconds_timestamp(self):
        payload = app_module._youtube_preview_payload("https://youtu.be/ABCDEFGHIJK?t=90")

        self.assertEqual(payload["clip_start"], 90)
        self.assertEqual(payload["normalized_url"], "https://www.youtube.com/watch?v=ABCDEFGHIJK")
        self.assertEqual(payload["embed_url"], "https://www.youtube.com/embed/ABCDEFGHIJK?start=90")

    def test_preview_parses_compound_timestamp(self):
        payload = app_module._youtube_preview_payload("https://www.youtube.com/watch?v=ABCDEFGHIJK&t=1m30s")

        self.assertEqual(payload["clip_start"], 90)
        self.assertEqual(payload["normalized_url"], "https://www.youtube.com/watch?v=ABCDEFGHIJK")

    def test_preview_uses_embed_start_param(self):
        payload = app_module._youtube_preview_payload("https://www.youtube.com/embed/ABCDEFGHIJK?start=75")

        self.assertEqual(payload["clip_start"], 75)
        self.assertEqual(payload["embed_url"], "https://www.youtube.com/embed/ABCDEFGHIJK?start=75")

    def test_publish_unique_media_file_does_not_overwrite_existing_target(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            original_media_dir = app_module.MEDIA_DIR
            app_module.MEDIA_DIR = Path(temp_dir)
            try:
                rel_path = Path("youtube/youtube_ABCDEFGHIJK_1080p30_s0_d300_h264.mp4")
                target_path = app_module.MEDIA_DIR / rel_path
                target_path.parent.mkdir(parents=True)
                target_path.write_bytes(b"existing")
                source_path = target_path.with_name(".new-transcode.mp4")
                source_path.write_bytes(b"new")

                published_path = app_module._publish_unique_media_file(source_path, rel_path)

                self.assertEqual(published_path.name, "youtube_ABCDEFGHIJK_1080p30_s0_d300_h264_2.mp4")
                self.assertEqual(target_path.read_bytes(), b"existing")
                self.assertEqual(published_path.read_bytes(), b"new")
            finally:
                app_module.MEDIA_DIR = original_media_dir


if __name__ == "__main__":
    unittest.main()
