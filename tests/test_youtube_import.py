import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
