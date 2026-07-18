import importlib.util
import sys
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "media-assets" / "build_media_assets.py"
SPEC = importlib.util.spec_from_file_location("build_media_assets", MODULE_PATH)
assert SPEC and SPEC.loader
build_media_assets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build_media_assets
SPEC.loader.exec_module(build_media_assets)


class MediaAssetBuilderTests(unittest.TestCase):
    def test_hevc_encoders_request_main_8_bit_output(self):
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")

        for encoder_mode in ("videotoolbox", "software"):
            with self.subTest(encoder_mode=encoder_mode):
                args = build_media_assets.ffmpeg_codec_args(rendition, encoder_mode)

                self.assertEqual(args[args.index("-profile:v") + 1], "main")
                self.assertEqual(args[args.index("-pix_fmt") + 1], "yuv420p")

    def test_hevc_output_rejects_main10(self):
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")
        stream = {"codec_name": "hevc", "profile": "Main 10", "pix_fmt": "yuv420p10le"}

        with self.assertRaisesRegex(RuntimeError, "expected codec=hevc, profile=Main, pix_fmt=yuv420p"):
            build_media_assets.validate_rendition_output(rendition, Path("output.mp4"), stream)

    def test_asset_record_includes_actual_codec_format(self):
        source = {"id": "sample", "title": "Sample"}
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")
        rel_path = Path("sample/720p30/720p30_hevc.mp4")
        stream = {
            "codec_name": "hevc",
            "profile": "Main",
            "pix_fmt": "yuv420p",
            "bits_per_raw_sample": "8",
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir)
            output_path = output_root / rel_path
            output_path.parent.mkdir(parents=True)
            output_path.write_bytes(b"hevc")
            with mock.patch.object(build_media_assets, "probe_video", return_value=stream):
                record = build_media_assets.asset_record(source, rendition, output_root, rel_path, "ffprobe")

        self.assertEqual(record["codec_profile"], "Main")
        self.assertEqual(record["pixel_format"], "yuv420p")
        self.assertEqual(record["bits_per_raw_sample"], "8")


if __name__ == "__main__":
    unittest.main()
