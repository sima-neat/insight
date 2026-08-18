import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "media-assets" / "build_media_assets.py"
SPEC = importlib.util.spec_from_file_location("build_media_assets", MODULE_PATH)
assert SPEC and SPEC.loader
build_media_assets = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build_media_assets
SPEC.loader.exec_module(build_media_assets)

MATRIX_MODULE_PATH = (
    Path(__file__).parents[1] / "media-assets" / "create_media_asset_matrix.py"
)
MATRIX_SPEC = importlib.util.spec_from_file_location(
    "create_media_asset_matrix", MATRIX_MODULE_PATH
)
assert MATRIX_SPEC and MATRIX_SPEC.loader
create_media_asset_matrix = importlib.util.module_from_spec(MATRIX_SPEC)
sys.modules[MATRIX_SPEC.name] = create_media_asset_matrix
MATRIX_SPEC.loader.exec_module(create_media_asset_matrix)


class MediaAssetBuilderTests(unittest.TestCase):
    @staticmethod
    def compatible_stream(rendition):
        return {
            "codec_name": rendition.codec,
            "profile": "Constrained Baseline" if rendition.codec == "h264" else "Main",
            "codec_tag_string": "avc1" if rendition.codec == "h264" else "hvc1",
            "pix_fmt": "yuv420p",
            "level": build_media_assets.expected_level_code(rendition),
            "has_b_frames": 0,
            "width": build_media_assets.expected_width(rendition),
            "height": rendition.height,
            "r_frame_rate": f"{rendition.fps}/1",
            "avg_frame_rate": f"{rendition.fps}/1",
            "bits_per_raw_sample": "8",
        }

    def test_low_fps_renditions_are_h264_and_hevc_only(self):
        low_fps = {
            (rendition.profile, rendition.fps, rendition.codec)
            for rendition in build_media_assets.RENDITIONS
            if rendition.profile in {"720p10", "720p20"}
        }

        self.assertEqual(
            low_fps,
            {
                ("720p10", 10, "h264"),
                ("720p10", 10, "hevc"),
                ("720p20", 20, "h264"),
                ("720p20", 20, "hevc"),
            },
        )
        self.assertEqual(len(build_media_assets.RENDITIONS), 23)

    def test_4k_levels_match_each_codec_standard(self):
        h264 = build_media_assets.Rendition("4kp30", 2160, 30, "h264", "mp4")
        hevc = build_media_assets.Rendition("4kp30", 2160, 30, "hevc", "mp4")

        self.assertEqual(build_media_assets.video_level(h264), "5.1")
        self.assertEqual(build_media_assets.video_level(hevc), "5.1")

    def test_low_fps_renditions_use_decoder_compatible_settings(self):
        for fps in (10, 20):
            for codec in ("h264", "hevc"):
                rendition = build_media_assets.Rendition(
                    f"720p{fps}", 720, fps, codec, "mp4"
                )
                with self.subTest(fps=fps, codec=codec):
                    self.assertEqual(build_media_assets.video_bitrate(rendition), "2M")
                    self.assertEqual(build_media_assets.video_level(rendition), "3.1")
                    for encoder_mode in ("videotoolbox", "software"):
                        args = build_media_assets.ffmpeg_codec_args(
                            rendition, encoder_mode
                        )
                        self.assertEqual(args[args.index("-g") + 1], str(fps))
                        self.assertEqual(args[args.index("-keyint_min") + 1], str(fps))
                        self.assertEqual(args[args.index("-bf") + 1], "0")
                        self.assertEqual(args[args.index("-pix_fmt") + 1], "yuv420p")
                        for option in ("-b:v", "-maxrate", "-bufsize"):
                            self.assertEqual(args[args.index(option) + 1], "2M")
                        if codec == "h264":
                            expected_profile = (
                                "constrained_baseline"
                                if encoder_mode == "videotoolbox"
                                else "baseline"
                            )
                            self.assertEqual(
                                args[args.index("-profile:v") + 1], expected_profile
                            )
                        if encoder_mode == "videotoolbox":
                            self.assertEqual(args[args.index("-allow_sw") + 1], "0")
                            filters = build_media_assets.bitstream_filter_args(
                                rendition, encoder_mode
                            )
                            self.assertIn(
                                f"level={build_media_assets.expected_level_code(rendition)}",
                                filters[1],
                            )
                            if codec == "h264":
                                self.assertTrue(
                                    filters[1].startswith("h264_metadata=aud=remove")
                                )
                                self.assertLess(
                                    filters[1].index("dump_extra"),
                                    filters[1].index("h264_metadata=aud=insert"),
                                )
                            else:
                                self.assertNotIn("dump_extra", filters[1])

    def test_videotoolbox_failure_retries_with_software_encoder(self):
        def failing_then_succeeding_encoder(commands):
            def run_encoder(command, check):
                self.assertTrue(check)
                commands.append(command)
                temporary_output = Path(command[-1])
                if len(commands) == 1:
                    temporary_output.parent.mkdir(parents=True, exist_ok=True)
                    temporary_output.write_bytes(b"partial")
                    raise subprocess.CalledProcessError(1, command)
                self.assertFalse(temporary_output.exists())
                temporary_output.write_bytes(b"software")

            return run_encoder

        for codec, hardware_encoder, software_encoder in (
            ("h264", "h264_videotoolbox", "libx264"),
            ("hevc", "hevc_videotoolbox", "libx265"),
        ):
            with self.subTest(codec=codec), tempfile.TemporaryDirectory() as temp_dir:
                rendition = build_media_assets.Rendition(
                    "720p20", 720, 20, codec, "mp4"
                )
                root = Path(temp_dir)
                source_path = root / "source.mp4"
                output_path = root / "sample" / "720p20" / "output.mp4"
                source_path.write_bytes(b"source")
                commands = []

                with mock.patch.object(
                    build_media_assets.subprocess,
                    "run",
                    side_effect=failing_then_succeeding_encoder(commands),
                ):
                    build_media_assets.run_ffmpeg(
                        "ffmpeg",
                        source_path,
                        output_path,
                        rendition,
                        "videotoolbox",
                        20.0,
                        "interpolate",
                    )

                self.assertEqual(len(commands), 2)
                self.assertIn(hardware_encoder, commands[0])
                self.assertEqual(commands[0][commands[0].index("-allow_sw") + 1], "0")
                self.assertIn(software_encoder, commands[1])
                self.assertNotIn("-allow_sw", commands[1])
                self.assertEqual(output_path.read_bytes(), b"software")

    def test_successful_videotoolbox_encode_is_not_retried(self):
        rendition = build_media_assets.Rendition("720p20", 720, 20, "h264", "mp4")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.mp4"
            output_path = root / "sample" / "720p20" / "output.mp4"
            source_path.write_bytes(b"source")

            def run_encoder(command, check):
                self.assertTrue(check)
                temporary_output = Path(command[-1])
                temporary_output.parent.mkdir(parents=True, exist_ok=True)
                temporary_output.write_bytes(b"hardware")

            with mock.patch.object(
                build_media_assets.subprocess, "run", side_effect=run_encoder
            ) as run:
                build_media_assets.run_ffmpeg(
                    "ffmpeg",
                    source_path,
                    output_path,
                    rendition,
                    "videotoolbox",
                    20.0,
                    "interpolate",
                )

            run.assert_called_once()
            self.assertIn("h264_videotoolbox", run.call_args.args[0])
            self.assertEqual(output_path.read_bytes(), b"hardware")

    def test_software_encoder_failure_is_not_retried(self):
        rendition = build_media_assets.Rendition("720p20", 720, 20, "hevc", "mp4")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_path = root / "source.mp4"
            output_path = root / "sample" / "720p20" / "output.mp4"
            source_path.write_bytes(b"source")
            failure = subprocess.CalledProcessError(1, ["ffmpeg"])

            with (
                mock.patch.object(
                    build_media_assets.subprocess, "run", side_effect=failure
                ) as run,
                self.assertRaises(subprocess.CalledProcessError),
            ):
                build_media_assets.run_ffmpeg(
                    "ffmpeg",
                    source_path,
                    output_path,
                    rendition,
                    "software",
                    20.0,
                    "interpolate",
                )

            run.assert_called_once()

    def test_encoder_mode_requires_a_complete_encoder_pair(self):
        with self.assertRaisesRegex(RuntimeError, "libx264 and libx265"):
            build_media_assets.choose_encoder_mode("software", {"libx264"})
        with self.assertRaisesRegex(RuntimeError, "VideoToolbox"):
            build_media_assets.choose_encoder_mode(
                "videotoolbox", {"h264_videotoolbox"}
            )
        self.assertEqual(
            build_media_assets.choose_encoder_mode(
                "auto", {"h264_videotoolbox", "hevc_videotoolbox", "libx264", "libx265"}
            ),
            "videotoolbox",
        )

    def test_hevc_encoders_request_main_8_bit_output(self):
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")

        for encoder_mode in ("videotoolbox", "software"):
            with self.subTest(encoder_mode=encoder_mode):
                args = build_media_assets.ffmpeg_codec_args(rendition, encoder_mode)

                self.assertEqual(args[args.index("-profile:v") + 1], "main")
                self.assertEqual(args[args.index("-pix_fmt") + 1], "yuv420p")
                if encoder_mode == "software":
                    params = args[args.index("-x265-params") + 1]
                    self.assertIn("high-tier=0", params)
                    self.assertIn("level-idc=3.1", params)

    def test_hevc_output_rejects_main10(self):
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")
        stream = {"codec_name": "hevc", "profile": "Main 10", "pix_fmt": "yuv420p10le"}

        with self.assertRaisesRegex(RuntimeError, "profile='Main 10'"):
            build_media_assets.validate_rendition_output(
                rendition, Path("output.mp4"), stream
            )

    def test_h26x_output_accepts_complete_compatible_metadata(self):
        for codec in ("h264", "hevc"):
            rendition = build_media_assets.Rendition("720p20", 720, 20, codec, "mp4")
            with self.subTest(codec=codec):
                build_media_assets.validate_rendition_output(
                    rendition,
                    Path("output.mp4"),
                    self.compatible_stream(rendition),
                    reference_frames=1,
                )

    def test_h26x_output_rejects_incompatible_metadata(self):
        rendition = build_media_assets.Rendition("720p20", 720, 20, "h264", "mp4")
        valid = self.compatible_stream(rendition)

        for key, incompatible in {
            "codec_tag_string": "hev1",
            "level": 32,
            "has_b_frames": 1,
            "width": 1920,
            "r_frame_rate": "30/1",
        }.items():
            with self.subTest(key=key):
                stream = {**valid, key: incompatible}
                with self.assertRaisesRegex(RuntimeError, key):
                    build_media_assets.validate_rendition_output(
                        rendition, Path("output.mp4"), stream, reference_frames=1
                    )

        with self.assertRaisesRegex(RuntimeError, "reference_frames"):
            build_media_assets.validate_rendition_output(
                rendition, Path("output.mp4"), valid, reference_frames=2
            )

    def test_h26x_timestamps_require_one_second_closed_gop_and_no_reordering(self):
        rendition = build_media_assets.Rendition("720p10", 720, 10, "h264", "mp4")
        packets = [(index / 10, index / 10, index % 10 == 0) for index in range(30)]

        build_media_assets.validate_rendition_timestamps(
            rendition, Path("output.mp4"), packets
        )
        with self.assertRaisesRegex(RuntimeError, "keyframe cadence"):
            build_media_assets.validate_rendition_timestamps(
                rendition,
                Path("output.mp4"),
                [
                    (pts, dts, index in {0, 15})
                    for index, (pts, dts, _key) in enumerate(packets)
                ],
            )
        with self.assertRaisesRegex(RuntimeError, "not constant frame rate"):
            build_media_assets.validate_rendition_timestamps(
                rendition, Path("output.mp4"), [(0.0, 0.0, True), (0.2, 0.2, False)]
            )

    def test_bitstream_and_container_validation_rejects_incompatible_output(self):
        h264 = build_media_assets.Rendition("720p10", 720, 10, "h264", "mp4")
        hevc = build_media_assets.Rendition("720p10", 720, 10, "hevc", "mp4")

        build_media_assets.validate_output_structure(
            Path("output.mp4"), "mov,mp4,m4a,3gp,3g2,mj2", ["video"]
        )
        build_media_assets.validate_bitstream_contract(
            h264, Path("output.mp4"), None, {7, 8}, [(True, {7, 8, 9})], 1, 1
        )
        with self.assertRaisesRegex(RuntimeError, "parameter sets or AUD"):
            build_media_assets.validate_bitstream_contract(
                h264, Path("output.mp4"), None, {7, 8}, [(True, {9})], 1, 1
            )
        with self.assertRaisesRegex(RuntimeError, "Main tier"):
            build_media_assets.validate_bitstream_contract(
                hevc, Path("output.mp4"), 1, {32, 33, 34}, [(True, {35})], 1, 1
            )
        with self.assertRaisesRegex(RuntimeError, "exactly one video"):
            build_media_assets.validate_output_structure(
                Path("output.mp4"), "mov,mp4,m4a,3gp,3g2,mj2", ["video", "audio"]
            )

    def test_bitstream_validation_requires_vui_timing(self):
        h264 = build_media_assets.Rendition("720p30", 720, 30, "h264", "mp4")
        hevc = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")
        h264_args = (h264, Path("output.mp4"), None, {7, 8}, [(True, {7, 8, 9})], 1, 1)
        hevc_args = (hevc, Path("output.mp4"), 0, {32, 33, 34}, [(True, {35})], 1, 1)

        # H.264 counts field ticks, so 30 fps is 60/1; HEVC counts frame ticks.
        build_media_assets.validate_bitstream_contract(
            *h264_args, {"present": 1, "num_units_in_tick": 1, "time_scale": 60}
        )
        build_media_assets.validate_bitstream_contract(
            *hevc_args, {"present": 1, "num_units_in_tick": 1, "time_scale": 30}
        )

        # A VideoToolbox stream with correct MP4 timestamps but no VUI timing.
        with self.assertRaisesRegex(RuntimeError, "no VUI timing"):
            build_media_assets.validate_bitstream_contract(*h264_args, {"present": 0})
        # Timing present but advertising the wrong rate.
        with self.assertRaisesRegex(RuntimeError, "VUI timing is"):
            build_media_assets.validate_bitstream_contract(
                *h264_args, {"present": 1, "num_units_in_tick": 1, "time_scale": 30}
            )

    def test_asset_record_includes_actual_codec_format(self):
        source = {"id": "sample", "title": "Sample"}
        rendition = build_media_assets.Rendition("720p30", 720, 30, "hevc", "mp4")
        rel_path = Path("sample/720p30/720p30_hevc.mp4")
        stream = self.compatible_stream(rendition)

        with tempfile.TemporaryDirectory() as temp_dir:
            output_root = Path(temp_dir)
            output_path = output_root / rel_path
            output_path.parent.mkdir(parents=True)
            output_path.write_bytes(b"hevc")
            with (
                mock.patch.object(
                    build_media_assets, "probe_video", return_value=stream
                ),
                mock.patch.object(
                    build_media_assets, "probe_reference_frames", return_value=1
                ),
                mock.patch.object(
                    build_media_assets,
                    "probe_output_structure",
                    return_value=("mov,mp4,m4a,3gp,3g2,mj2", ["video"]),
                ),
                mock.patch.object(
                    build_media_assets, "probe_packets", return_value=[(0.0, 0.0, True)]
                ),
                mock.patch.object(
                    build_media_assets,
                    "probe_bitstream_contract",
                    return_value=(
                        0,
                        {32, 33, 34},
                        [(True, {35})],
                        {"present": 1, "num_units_in_tick": 1, "time_scale": 30},
                    ),
                ),
            ):
                record = build_media_assets.asset_record(
                    source, rendition, output_root, rel_path, "ffprobe", "ffmpeg"
                )

        self.assertEqual(record["codec_profile"], "Main")
        self.assertEqual(record["pixel_format"], "yuv420p")
        self.assertEqual(record["bits_per_raw_sample"], "8")
        self.assertEqual(record["reference_frames"], 1)
        self.assertEqual(record["codec_tier"], 0)

    def test_media_matrix_combines_low_fps_profiles(self):
        matrix = create_media_asset_matrix.create_matrix([{"id": "sample"}], "")
        low_fps_shards = [
            item for item in matrix if item["profile_group"] == "720p-low-fps"
        ]

        self.assertEqual(len(matrix), 7)
        self.assertEqual(len(low_fps_shards), 1)
        self.assertEqual(low_fps_shards[0]["profiles"], "720p20 720p10")


if __name__ == "__main__":
    unittest.main()
