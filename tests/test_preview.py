import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import paramiko
from flask import Flask

from neat_insight import board, preview as preview_pkg
from neat_insight.board import BoardError, ExecResult
from neat_insight.board import manager as manager_module
from neat_insight.board.target import BoardTarget
from neat_insight.board.transport import LocalTransport, key_fingerprint
from neat_insight.peripherals import api as peripherals_api, cameras
from neat_insight.peripherals.api import peripherals_bp
from neat_insight.preview import api, gst, manager as preview
from test_board import wait_until
from test_peripherals import C920, C920_BY_ID, IMX477, board_block, c920, catalog, imx477, mipi_mode, usb_mode

MODE = {"format": "NV12", "width": 1920, "height": 1080, "fps": 30}
PREVIEW = "/api/peripherals/cameras/preview"
BOARD = {"label": "sima@board", "source": "test", "fingerprint": "fp"}
JPEG = b"\xff\xd8\xff\xe0" + b"frame" + b"\xff\xd9"
PID = 4242
PID_LINE = b"neat-preview-pid=%d\n" % PID
HAVE_GST = shutil.which("gst-launch-1.0") is not None


def multipart(*frames):
    """What multipartmux writes for these frames."""
    return b"".join(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n%s\r\n" % (len(f), f) for f in frames)


def scanned(*devices, generation=1, board=True):
    """Record a scan of the given Sentinel devices on a board whose camera overlays support the IMX477
    (`board=False`: a Sentinel that reports no overlays) and return its snapshot."""
    doc = catalog(*devices, board=board_block()) if board else catalog(*devices)
    return peripherals_api.scans.record(generation, BOARD, doc, 5)


def item_of(snapshot, item_id):
    return next(item for item in snapshot["items"] if item["id"] == item_id)


def comm(pid):
    with open(f"/proc/{pid}/comm") as handle:
        return handle.read().strip()


class FakeStream:
    """A board stream that returns `chunks` in order (None: nothing arrived in time), then ends."""

    def __init__(self, chunks=(), stderr=PID_LINE, endless=False):
        self.chunks, self._stderr, self.endless = list(chunks), stderr, endless
        self.closed = False

    def read(self, timeout):
        if self.closed:
            return b""
        if self.chunks:
            return self.chunks.pop(0)
        if self.endless:
            time.sleep(min(timeout, 0.01))
            return None
        return b""

    def stderr(self, wait=0):
        return self._stderr

    def close(self):
        self.closed = True


class FakeTransport:
    def __init__(self, gst_path=b"/usr/bin/gst-launch-1.0\n", users=None, stream=None):
        self.calls, self.streams, self.closed = [], [], False
        report = {"users": {IMX477: users or [], C920: users or []}}
        self.replies = {"command -v gst-launch-1.0": gst_path, '"cameras"': json.dumps(report).encode()}
        self.next_stream = stream

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv[-1])
        return ExecResult(0, next((out for key, out in self.replies.items() if key in argv[-1]), b""), b"")

    def stream(self, argv, *, timeout):
        stream = self.next_stream or FakeStream([multipart(JPEG)], endless=True)
        self.next_stream = None
        self.streams.append((argv, stream))
        return stream

    def close(self):
        self.closed = True

    def kills(self):
        return [call for call in self.calls if "kill $pid" in call]


def fake_session(transport=None, generation=1):
    transport = transport or FakeTransport()
    return SimpleNamespace(generation=generation, target=BoardTarget("ssh", "test", "board", 22, "sima"),
                           transport=transport, raw_transport=transport, require_current=lambda: None)


class PipelineTests(unittest.TestCase):
    def test_a_mipi_camera_is_captured_in_nv12_by_libcamera(self):
        arguments = gst.pipeline("mipi", gst.quoted("imx477 5-001a"), "NV12", 1920, 1080, Fraction(30))
        self.assertEqual(arguments, [
            "libcamerasrc", 'camera-name="imx477 5-001a"', "!", "video/x-raw,format=NV12,width=1920,height=1080,framerate=30/1",
            "!", "videoscale", "!", "videorate", "!", "video/x-raw,width=640,height=360,framerate=15/1",
            "!", "jpegenc", "quality=70", "!", "multipartmux", "boundary=frame", "!", "fdsink", "fd=1",
        ])
        command = gst.board_command(arguments)
        self.assertEqual(command[:2], ["sh", "-c"])
        self.assertTrue(command[2].startswith("echo neat-preview-pid=$$ >&2; exec gst-launch-1.0 -q libcamerasrc "))
        self.assertEqual(shlex.split(command[2])[6:], arguments)

    def test_a_usb_mjpg_mode_is_decoded_and_reencoded_small(self):
        arguments = gst.pipeline("usb", gst.quoted(C920_BY_ID), "MJPG", 1280, 720, Fraction(30))
        self.assertEqual(arguments[:6], ["v4l2src", f'device="{C920_BY_ID}"', "!", "image/jpeg,width=1280,height=720,framerate=30/1", "!", "jpegdec"])
        self.assertEqual(arguments[6:12], ["!", "videoscale", "!", "videorate", "!", "video/x-raw,width=640,height=360,framerate=15/1"])

    def test_a_usb_raw_mode_is_converted_and_a_slow_rate_is_not_raised(self):
        arguments = gst.pipeline("usb", gst.quoted("/dev/video97"), "YUYV", 640, 480, Fraction(5))
        self.assertEqual(arguments[:6], ["v4l2src", 'device="/dev/video97"', "!", "video/x-raw,format=YUY2,width=640,height=480,framerate=5/1", "!", "videoconvert"])
        self.assertEqual(arguments[6:12], ["!", "videoscale", "!", "videorate", "!", "video/x-raw,width=640,height=480,framerate=5/1"])
        self.assertEqual(gst.RAW_FORMATS["YU12"], "I420")

    def test_fractional_rates_are_exact_fractions(self):
        arguments = gst.pipeline("usb", gst.quoted("/dev/video97"), "MJPG", 640, 480, Fraction(30000, 1001))
        self.assertIn("image/jpeg,width=640,height=480,framerate=30000/1001", arguments)
        self.assertIn("video/x-raw,width=640,height=480,framerate=15/1", arguments)
        self.assertIn("video/x-raw,width=640,height=480,framerate=15/2", gst.pipeline("usb", '"/dev/v"', "MJPG", 640, 480, Fraction(15, 2)))

    def test_preview_size_keeps_the_aspect_ratio_with_even_sides(self):
        cases = {(1920, 1080): (640, 360), (2432, 2048): (640, 538), (640, 480): (640, 480), (320, 240): (320, 240),
                 (1280, 721): (640, 360), (1280, 722): (640, 362), (641, 481): (640, 480), (3, 2): (2, 2)}
        for size, expected in cases.items():
            with self.subTest(size=size):
                self.assertEqual(gst.preview_size(*size), expected)

    def test_odd_camera_names_stay_one_quoted_value(self):
        for name in ("imx477 5-001a", "a!b c", "it's", 'p"q', "b\\s", "x,y=z;w", "$(reboot)"):
            with self.subTest(name=name):
                value = gst.quoted(name)
                command = gst.board_command(gst.pipeline("mipi", value, "NV12", 1920, 1080, Fraction(30)))
                self.assertEqual(shlex.split(command[2])[7], f"camera-name={value}", "the shell passes it as one argument")
        self.assertEqual(gst.quoted('p"q\\'), '"p\\"q\\\\"')
        self.assertIsNone(gst.quoted("a\nb"))
        self.assertIsNone(gst.quoted("a\x00b"))

    @unittest.skipUnless(HAVE_GST, "gst-launch-1.0 is not installed")
    def test_gstreamer_reads_a_quoted_value_back_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("imx477 5-001a", "a!b c", "it's", 'p"q', "b\\s", "x,y=z;w"):
                path = os.path.join(tmp, name)
                with open(path, "wb") as handle:
                    handle.write(name.encode())
                command = "exec gst-launch-1.0 -q " + shlex.join(["filesrc", f"location={gst.quoted(path)}", "!", "fdsink", "fd=1"])
                with self.subTest(name=name):
                    self.assertEqual(subprocess.run(["sh", "-c", command], capture_output=True, timeout=30).stdout, name.encode())

    def test_the_frontend_offers_preview_for_the_usb_formats_the_backend_previews(self):
        model = (Path(__file__).parent.parent / "frontend" / "src" / "peripherals" / "model.js").read_text()
        listed = re.search(r"USB_PREVIEW_FORMATS = Object\.freeze\(\[([^\]]*)\]\)", model)
        self.assertIsNotNone(listed)
        self.assertEqual(re.findall(r"'([A-Z0-9]+)'", listed[1]), ["MJPG", *gst.RAW_FORMATS])


class FrameParserTests(unittest.TestCase):
    def test_frames_are_read_whole_from_one_chunk_or_many(self):
        second = JPEG + b"2"
        data = multipart(JPEG, second)
        self.assertEqual(gst.FrameParser().feed(data), [JPEG, second])
        parser, frames = gst.FrameParser(), []
        for byte in data:
            frames += parser.feed(bytes([byte]))
        self.assertEqual(frames, [JPEG, second])

    def test_bytes_before_a_part_are_skipped_and_garbage_is_not_kept(self):
        self.assertEqual(gst.FrameParser().feed(b"gst noise\r\n" + multipart(JPEG)), [JPEG])
        parser = gst.FrameParser()
        for _ in range(100):
            self.assertEqual(parser.feed(b"x" * 10000), [])
        self.assertLess(len(parser._buffer), 16)
        self.assertEqual(parser.feed(multipart(JPEG)), [JPEG])

    def test_an_oversized_or_malformed_part_is_refused(self):
        cases = {
            "oversized": b"--frame\r\nContent-Length: %d\r\n\r\n" % (gst.MAX_FRAME_BYTES + 1),
            "no length": b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + JPEG,
            "bad length": b"--frame\r\nContent-Length: -5\r\n\r\n" + JPEG,
            "not jpeg type": b"--frame\r\nContent-Type: text/html\r\nContent-Length: 8\r\n\r\n<script>",
            "not a jpeg": b"--frame\r\nContent-Length: 8\r\n\r\n<script>",
            "endless headers": b"--frame\r\n" + b"X-Pad: y\r\n" * 200,
            "header line": b"--frame\r\ngarbage\r\n\r\n",
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(gst.FrameError):
                gst.FrameParser().feed(data)

    def test_a_relayed_part_carries_its_type_and_length(self):
        self.assertEqual(gst.part(JPEG), b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 11\r\n\r\n" + JPEG + b"\r\n")
        self.assertEqual(gst.FrameParser().feed(gst.part(JPEG)), [JPEG])


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.manager = preview.PreviewManager()
        self.session = fake_session()
        patch = mock.patch.object(peripherals_api, "scans", cameras.ScanCache())
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(lambda: self.manager.stop_for_board_change())
        self.snapshot = scanned(imx477(), c920())
        self.imx477 = item_of(self.snapshot, IMX477)
        self.c920 = item_of(self.snapshot, C920)

    def start(self, session=None, item=None, mode=MODE):
        item = item or self.imx477
        return self.manager.start(session or self.session, item, api.previewable_mode(item, dict(mode)))

    def start_failing(self, stream, item=None, mode=MODE):
        """Start on a fresh board whose pipeline is `stream`; returns the start's BoardError and that session."""
        session = fake_session(FakeTransport(stream=stream))
        with self.assertRaises(BoardError) as ctx:
            self.start(session, item, mode)
        return ctx.exception, session

    def client(self):
        app = Flask(__name__)
        app.register_blueprint(board.board_bp)
        app.register_blueprint(api.preview_bp)
        app.extensions["neat_board"] = SimpleNamespace(session=lambda: self.session)
        app.extensions["neat_preview"] = self.manager
        return app.test_client()

    def test_mipi_previews_available_modes_and_usb_any_listed_mode(self):
        mode = api.previewable_mode(self.imx477, dict(MODE))
        self.assertEqual((mode["rate"], mode["source"]), (Fraction(30), '"imx477 5-001a"'))
        self.assertEqual({key: mode[key] for key in MODE}, MODE)
        self.assertEqual(api.previewable_mode(self.imx477, {})["fps"], 30)
        # A USB camera has no camera overlay, so its modes are Unsupported, and it still previews.
        self.assertEqual(self.c920["formats"][0]["sizes"][0]["fps"][0]["tier"], "unsupported")
        usb = api.previewable_mode(self.c920, {"format": "MJPG", "width": 1280, "height": 720, "fps": 30})
        self.assertEqual((usb["rate"], usb["source"]), (Fraction(30), f'"{C920_BY_ID}"'))
        self.assertEqual(api.previewable_mode(self.c920, {"format": "MJPG", "width": 640, "height": 480, "fps": 7.5})["rate"], Fraction(15, 2))
        self.assertEqual(api.previewable_mode(self.c920, {"format": "YUYV", "width": 640, "height": 480, "fps": 5})["format"], "YUYV")
        cases = (
            (self.imx477, {**MODE, "format": "RGB3"}, "cannot be previewed: Neat's CameraInput outputs NV12 only."),
            (self.imx477, {**MODE, "format": "H264"}, "H264 is not a format this camera reported."),
            (self.imx477, {**MODE, "width": 1280, "height": 720}, "1280x720 is not a size"),
            (self.imx477, {**MODE, "fps": 60}, "Pick one of: 30."),
            (self.c920, {}, "no default mode"),
        )
        for item, mode, reason in cases:
            with self.subTest(mode=mode), self.assertRaises(BoardError) as ctx:
                api.previewable_mode(item, mode)
            self.assertEqual(ctx.exception.code, "invalid_request")
            self.assertIn(reason, ctx.exception.message + (ctx.exception.hint or ""))

    def test_a_usb_camera_opens_its_stable_path_and_needs_a_format_gstreamer_reads(self):
        doc = c920()
        del doc["by_id_path"]
        doc["modes"].append(dict(usb_mode("MJPG", 320, 240, [(1, 30)]), format="H264", format_description="H.264"))
        item = item_of(scanned(doc), C920)
        self.assertEqual(api.previewable_mode(item, {"format": "MJPG", "width": 1280, "height": 720, "fps": 30})["source"], '"/dev/video97"')
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(item, {"format": "H264", "width": 320, "height": 240, "fps": 30})
        self.assertIn("preview decodes MJPG and converts raw formats", ctx.exception.message)
        item["device"]["video_node"] = "video97"
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(item, {"format": "MJPG", "width": 1280, "height": 720, "fps": 30})
        self.assertIn("reports no device Insight can open", ctx.exception.message)

    def test_an_unsupported_mipi_mode_is_not_previewed(self):
        doc = imx477()
        doc["modes"] = [mipi_mode("NV12", 1920, 1080), dict(mipi_mode("NV12", 1280, 720), isp_output=False)]
        item = item_of(scanned(doc), IMX477)
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(item, {**MODE, "width": 1280, "height": 720})
        self.assertIn("at 30 fps cannot be previewed: The ISP cannot output this size.", ctx.exception.message)
        self.assertEqual(ctx.exception.hint, "Pick a mode marked Available.")
        no_overlays = item_of(scanned(imx477(), board=False), IMX477)
        with self.assertRaises(BoardError) as ctx:
            api.previewable_mode(no_overlays, MODE)
        self.assertIn(f"cannot be previewed: {cameras.NO_BOARD_REASON}", ctx.exception.message)

    def test_an_unverified_mipi_mode_is_previewed(self):
        """Previewing is how a developer checks a 3.0 size Sentinel could not confirm."""
        doc = imx477()
        doc["isp"]["sizing"] = "runtime"
        doc["modes"] = [{"format": "NV12", "width": 1332, "height": 990, "sensor_mode": True, "isp_input": False}]
        item = item_of(scanned(doc), IMX477)
        mode = api.previewable_mode(item, {**MODE, "width": 1332, "height": 990})
        self.assertEqual((mode["width"], mode["height"], mode["rate"]), (1332, 990, Fraction(30)))

    def test_a_non_finite_frame_rate_is_an_invalid_request(self):
        client = self.client()
        for fps in ("1e309", "-1e309", "Infinity", "NaN", "10e400"):
            with self.subTest(fps=fps):
                body = '{"id": "%s", "format": "NV12", "width": 1920, "height": 1080, "fps": %s}' % (IMX477, fps)
                response = client.post(PREVIEW, data=body, content_type="application/json")
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))
                self.assertIn("fps must be a positive number", response.get_json()["error"])
        for fps in (10**400, float("nan"), float("inf"), 0, True, "30"):
            with self.subTest(fps=str(fps)[:12]), self.assertRaises(BoardError) as ctx:
                api.parse_mode({**MODE, "fps": fps})
            self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertEqual(self.session.transport.calls, [])
        self.assertEqual(api.parse_mode({**MODE, "fps": 7.5})["fps"], 7.5)

    def test_a_start_runs_the_pipeline_and_waits_for_its_first_frame(self):
        stream = FakeStream([multipart(JPEG)[:20], None, multipart(JPEG)[20:]], endless=True)
        self.session.transport.next_stream = stream
        session = self.client().post(PREVIEW, json={"id": IMX477, **MODE}).get_json()["session"]
        self.assertEqual(session["stream_url"], f"{PREVIEW}/{session['id']}/stream")
        self.assertEqual((session["camera_id"], session["mode"], session["generation"], session["state"]), (IMX477, MODE, 1, "live"))
        self.assertFalse({"channel", "ssrc", "viewer_url", "heartbeat_interval_ms", "expires_at"} & set(session))
        argv, _ = self.session.transport.streams[0]
        self.assertEqual(argv, gst.board_command(gst.pipeline("mipi", '"imx477 5-001a"', "NV12", 1920, 1080, Fraction(30))))
        self.assertIn("command -v gst-launch-1.0", self.session.transport.calls[0])
        self.assertEqual(self.manager.current(1)["id"], session["id"])
        self.assertIsNone(self.manager.current(2))
        self.assertFalse(stream.closed)

    def test_a_missing_gst_launch_is_reported_before_anything_runs(self):
        session = fake_session(FakeTransport(gst_path=b""))
        with self.assertRaises(BoardError) as ctx:
            self.start(session)
        self.assertEqual((ctx.exception.code, ctx.exception.extra["tool"]), ("tool_missing", "gst-launch-1.0"))
        self.assertIn("gstreamer1.0-plugins-good", ctx.exception.hint)
        self.assertEqual(session.transport.streams, [])

    def test_a_busy_camera_fails_the_start_as_in_use_and_the_pipeline_is_stopped(self):
        for message in (b"[0:01] ERROR Camera camera.cpp:1009 Failed to acquire camera imx477 5-001a\n",
                        b"ERROR: from element /GstPipeline:pipeline0/GstV4l2Src:v4l2src0: Device '/dev/video97' is busy\n"):
            stream = FakeStream([], stderr=PID_LINE + message)
            with self.subTest(message=message):
                error, session = self.start_failing(stream)
                self.assertEqual((error.code, error.status), ("camera_in_use", 409))
                self.assertEqual(error.message, "imx477 5-001a is already in use: the board reports the camera busy; another process holds it.")
                self.assertEqual(error.extra["detail"], message.decode().strip())
                self.assertTrue(stream.closed)
                self.assertEqual(len(session.transport.kills()), 1)
                self.assertIn(f"pid={PID};", session.transport.kills()[0])
                self.assertIsNone(self.manager.current(1))

    def test_a_size_libcamera_streams_differently_is_reported_with_the_size_that_works(self):
        """Transcribed from a 3.0 DevKit (B1859): asked for one size, libcamera configured another and
        libcamerasrc stopped with not-negotiated. The sizes Insight itself hides (wider than
        MAX_SENSOR_WIDTH) never reach the pipeline; this covers any other adjustment libcamera makes."""
        detail = (b"[1:37:08.150] [3009]  INFO Camera camera.cpp:1216 configuring streams: (0) 4000x3040-NV12/Unset\n"
                  b"[1:37:08.150] [3009]  INFO Modalix modalix.cpp:2992 Applying neutral DV Timings for imx477 (4000x3040) on CSI: csidev-40c3000.csi\n"
                  b"ERROR: from element /GstPipeline:pipeline0/GstLibcameraSrc:libcamerasrc0: Internal data stream error.\n"
                  b"Additional debug info:\n"
                  b"../src/gstreamer/gstlibcamerasrc.cpp(911): gst_libcamera_src_task_enter (): /GstPipeline:pipeline0/GstLibcameraSrc:libcamerasrc0:\n"
                  b"streaming stopped, reason not-negotiated (-4)\n")
        # A 3.0 catalog: the ISP sizes at run time, so Sentinel lists the sensor's sizes and marks them available.
        doc = imx477()
        doc["isp"]["sizing"] = "runtime"
        doc["modes"] = [{"format": "NV12", "width": w, "height": h, "sensor_mode": True, "available": True}
                        for w, h in ((4032, 3040), (1920, 1080))]
        imx477_30 = item_of(scanned(doc, c920()), IMX477)
        mode = {"format": "NV12", "width": 4032, "height": 3040, "fps": 30}

        def start_logging(stderr):
            return self.start_failing(FakeStream([], stderr=PID_LINE + stderr), imx477_30, mode)

        error, session = start_logging(detail)
        self.assertEqual((error.code, error.status), ("mode_adjusted", 409))
        self.assertEqual(error.message, "libcamera streams imx477 5-001a at 4000x3040, not 4032x3040.")
        self.assertEqual((error.extra["width"], error.extra["height"]), (4000, 3040))
        self.assertIn("Pick 4000x3040.", error.hint)
        self.assertEqual(len(session.transport.kills()), 1)
        # As the board really logs it: a long libcamera log whose early "configuring streams" line falls
        # outside the 1000-character detail; the DV-timings line still names the configured size.
        padding = b"".join(b"[1:37:08.150] [3009]  INFO ModalixIPA modalix.cpp:1566 calibration_shading_radial_r: YAML has 33 elements\n" for _ in range(12))
        error, _ = start_logging(detail.replace(b"Applying neutral", padding + b"Applying neutral"))
        self.assertEqual(error.code, "mode_adjusted")
        self.assertEqual(len(error.extra["detail"]), 1000)
        self.assertNotIn("configuring streams", error.extra["detail"])
        # GStreamer's error text may not have landed yet when the frame read gives up: the configured
        # size alone, with no frame, is enough.
        self.assertEqual(start_logging(detail[: detail.index(b"ERROR: from element")])[0].code, "mode_adjusted")
        # The same configured size as requested is not an adjustment: the generic failure stays.
        self.assertEqual(start_logging(detail.replace(b"4000x3040", b"4032x3040"))[0].code, "command_failed")

    def test_a_pipeline_that_fails_or_sends_no_frame_is_stopped_with_its_output(self):
        error = b"ERROR: from element /GstPipeline:pipeline0/GstLibcameraSrc:libcamerasrc0: Internal data stream error."
        failure, session = self.start_failing(FakeStream([], stderr=PID_LINE + error + b"\n"))
        self.assertEqual(failure.code, "command_failed")
        self.assertEqual(failure.message, "The preview pipeline stopped before it sent a frame.")
        self.assertEqual(failure.extra["detail"], error.decode())
        self.assertEqual(len(session.transport.kills()), 1)

        stream = FakeStream([b"--frame\r\n"], endless=True)
        with mock.patch.object(preview, "FIRST_FRAME_TIMEOUT_SEC", 0.05):
            failure, session = self.start_failing(stream)
        self.assertEqual(failure.code, "command_failed")
        self.assertIn("sent no frame within", failure.message)
        self.assertTrue(stream.closed)
        self.assertEqual(len(session.transport.kills()), 1)

        stream = FakeStream([b"--frame\r\nContent-Length: 99999999\r\n\r\n"], endless=True)
        self.assertIn("not usable", self.start_failing(stream)[0].message)
        self.assertTrue(stream.closed)
        self.assertIsNone(self.manager.current(1))

    def test_a_missing_gstreamer_plugin_is_reported_with_the_install_hint(self):
        stream = FakeStream([], stderr=PID_LINE + b'WARNING: erroneous pipeline: no element "libcamerasrc"\n')
        error, _ = self.start_failing(stream)
        self.assertEqual((error.code, error.status), ("tool_missing", 502))
        self.assertEqual(error.extra["tool"], "libcamerasrc")
        self.assertIn("no libcamerasrc element", error.message)
        self.assertEqual(error.hint, preview.GST_INSTALL_HINT)
        self.assertEqual(error.extra["detail"], 'WARNING: erroneous pipeline: no element "libcamerasrc"')
        self.assertTrue(stream.closed)
        self.assertIsNone(self.manager.current(1))

    def test_shell_banners_before_the_pid_line_are_skipped_and_kept_out_of_the_detail(self):
        banner = b"bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)\n"
        stream = FakeStream([multipart(JPEG)], stderr=banner + PID_LINE, endless=True)
        self.assertEqual(preview.PreviewManager._pid(stream), PID)
        error, session = self.start_failing(FakeStream([], stderr=banner + PID_LINE + b"ERROR: the camera went away\n"))
        self.assertEqual(error.extra["detail"], banner.decode() + "ERROR: the camera went away")
        self.assertEqual(len(session.transport.kills()), 1)
        self.assertIn(f"pid={PID};", session.transport.kills()[0])
        # A bare number is not the tagged line: no PID is guessed from a banner.
        self.assertIsNone(preview._PID.search(b"4242\n"))

    def test_a_start_that_fails_unexpectedly_still_stops_the_pipeline(self):
        stream = FakeStream([multipart(JPEG)], endless=True)
        session = fake_session(FakeTransport(stream=stream))
        with mock.patch.object(preview.PreviewManager, "_first_frames", side_effect=ValueError("boom")), \
                self.assertRaises(ValueError):
            self.start(session)
        self.assertTrue(stream.closed)
        self.assertEqual(len(session.transport.kills()), 1)
        self.assertIsNone(self.manager.current(1))

    def test_a_camera_another_process_holds_now_is_refused_before_anything_is_launched(self):
        for item, node in ((self.imx477, "/dev/media0"), (self.c920, "/dev/video97")):
            session = fake_session(FakeTransport(users=[{"pid": 77, "command": "neat-app"}]))
            mode = MODE if item is self.imx477 else {"format": "MJPG", "width": 1280, "height": 720, "fps": 30}
            with self.subTest(item=item["id"]), self.assertRaises(BoardError) as ctx:
                self.start(session, item, mode)
            self.assertEqual((ctx.exception.code, ctx.exception.status), ("camera_in_use", 409))
            self.assertEqual(ctx.exception.message, f"{item['name']} is already in use: Open in neat-app (pid 77).")
            self.assertEqual(session.transport.streams, [])
            request = next(call for call in session.transport.calls if '"cameras"' in call)
            self.assertEqual(json.loads(request), {"cameras": {item["id"]: [node]}})

    def test_a_start_needs_a_scan_of_this_board_and_a_scanned_camera(self):
        client = self.client()
        missing = client.post(PREVIEW, json={"id": "camera:nope"})
        self.assertEqual((missing.status_code, missing.get_json()["code"]), (404, "not_found"))
        self.session = fake_session(generation=2)
        stale = client.post(PREVIEW, json={"id": IMX477})
        self.assertEqual((stale.status_code, stale.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.session.transport.calls, [])

    def test_the_stream_relays_the_frames_and_ends_the_preview_with_the_board_stream(self):
        second = JPEG + b"2"
        self.session.transport.next_stream = FakeStream([multipart(JPEG), multipart(second)[:9], multipart(second)[9:]])
        client = self.client()
        session = client.post(PREVIEW, json={"id": IMX477, **MODE}).get_json()["session"]
        response = client.get(session["stream_url"])
        self.assertEqual(response.headers["Content-Type"], "multipart/x-mixed-replace; boundary=frame")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.data, gst.part(JPEG) + gst.part(second))
        # The board stream ended, so the preview did too.
        self.assertIsNone(self.manager.current(1))
        self.assertEqual(len(self.session.transport.kills()), 1)

    def test_a_head_request_neither_claims_nor_stops_the_stream(self):
        client = self.client()
        session = client.post(PREVIEW, json={"id": IMX477, **MODE}).get_json()["session"]
        probe = client.head(session["stream_url"])
        self.assertEqual(self.session.transport.kills(), [])
        self.assertFalse(self.manager.current(1)["viewer"])
        self.assertEqual((probe.status_code, probe.headers.get("Allow")), (405, "GET"))
        response = client.get(session["stream_url"])
        self.assertEqual(response.status_code, 200)
        response.close()

    def test_a_stream_request_racing_the_unclaimed_deadline_never_claims_a_preview_being_stopped(self):
        """The deadline decides under the lock: a stream request after it finds the preview gone, so the
        timer never kills a stream it just handed out."""
        self.start()
        session_id = self.manager.current(1)["id"]
        released = []
        with mock.patch.object(self.manager, "_release", side_effect=released.append):
            self.manager._stop_unclaimed(session_id)  # the deadline fires; its kill is still to come
            with self.assertRaises(BoardError) as ctx:
                self.manager.relay(self.session, session_id)
        self.assertEqual((ctx.exception.code, released), ("not_found", [session_id]))

    def test_a_viewer_that_disconnects_stops_the_pipeline_and_a_second_viewer_is_refused(self):
        self.start()
        stream = self.session.transport.streams[0][1]
        session_id = self.manager.current(1)["id"]
        self.assertFalse(self.manager.current(1)["viewer"])
        relay = self.manager.relay(self.session, session_id)
        # A page that loads now learns the stream is taken and does not open a second one.
        self.assertTrue(self.manager.current(1)["viewer"])
        with self.assertRaises(BoardError) as ctx:
            self.manager.relay(self.session, session_id)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("preview_active", 409))
        frames = iter(relay)
        self.assertEqual(next(frames), gst.part(JPEG))
        relay.close()  # What the server does when the browser goes away.
        self.assertTrue(stream.closed)
        self.assertEqual(len(self.session.transport.kills()), 1)
        self.assertIsNone(self.manager.current(1))

        self.start()
        relay = self.manager.relay(self.session, self.manager.current(1)["id"])
        relay.close()  # Closed before the server read a frame from it.
        self.assertTrue(self.session.transport.streams[1][1].closed)
        self.assertIsNone(self.manager.current(1))
        with self.assertRaises(BoardError) as ctx:
            self.manager.relay(self.session, "unknown")
        self.assertEqual(ctx.exception.code, "not_found")

    def test_a_slow_mode_is_waited_for_frame_by_frame_instead_of_stopped_as_stalled(self):
        """V4L2 lets a camera list any frame interval: one frame every 20 s is a healthy preview."""
        timeouts = []

        class Recording(FakeStream):
            def read(self, timeout):
                timeouts.append(timeout)
                return super().read(timeout)

        session = fake_session(FakeTransport(stream=Recording([multipart(JPEG), multipart(JPEG)])))
        mode = {"format": "MJPG", "width": 640, "height": 480, "fps": 0.05, "rate": Fraction(1, 20),
                "source": '"/dev/null"'}
        started = self.manager.start(session, self.c920, mode)
        self.assertGreaterEqual(timeouts[0], 39)  # Two frame periods for the first frame, too.
        relay = self.manager.relay(session, started["id"])
        frames = iter(relay)
        self.assertEqual([next(frames), next(frames)], [gst.part(JPEG)] * 2)
        self.assertEqual(timeouts[-1], 40)
        relay.close()
        # A mode faster than one frame per 5 s keeps the usual waits.
        self.assertEqual(preview._frame_wait(preview.STALL_TIMEOUT_SEC, Fraction(30)), preview.STALL_TIMEOUT_SEC)
        # Codex 4255690083: a mode Sentinel lists down to one frame per 2**32-1 s must not hold the board
        # lock for years; the wait is capped.
        for base in (preview.FIRST_FRAME_TIMEOUT_SEC, preview.STALL_TIMEOUT_SEC):
            self.assertEqual(preview._frame_wait(base, Fraction(1, 2**32 - 1)), 60)

    def test_a_stream_nobody_opens_is_stopped(self):
        with mock.patch.object(preview, "UNCLAIMED_TIMEOUT_SEC", 0.05):
            self.start()
        wait_until(lambda: self.manager.current(1) is None)
        self.assertIsNone(self.manager.current(1))
        self.assertTrue(self.session.transport.streams[0][1].closed)
        self.assertEqual(len(self.session.transport.kills()), 1)

    def test_stop_kills_by_pid_and_is_idempotent_and_an_old_id_never_stops_a_newer_session(self):
        client = self.client()
        first = client.post(PREVIEW, json={"id": IMX477, **MODE}).get_json()["session"]
        stopped = client.post(f"{PREVIEW}/{first['id']}/stop").get_json()["session"]
        self.assertEqual((stopped["id"], stopped["state"]), (first["id"], "stopped"))
        self.assertTrue(self.session.transport.streams[0][1].closed)
        [kill] = self.session.transport.kills()
        self.assertTrue(kill.startswith(f"pid={PID};"))
        again = client.post(f"{PREVIEW}/{first['id']}/stop")
        self.assertEqual((again.status_code, again.get_json()), (200, {"session": None}))
        second = client.post(PREVIEW, json={"id": IMX477, **MODE}).get_json()["session"]
        self.assertEqual(client.post(f"{PREVIEW}/{first['id']}/stop").get_json(), {"session": None})
        self.assertEqual(client.get("/api/peripherals/preview").get_json()["session"]["id"], second["id"])
        self.assertEqual(len(self.session.transport.kills()), 1)

    def test_preview_status_read_during_a_board_change_is_refused(self):
        # Codex 4263972495: the status route returned the departed board's session, which the change stopped.
        self.start()
        client = self.client()
        real_current = self.manager.current

        def read_then_switch(generation):
            session = real_current(generation)
            self.session.require_current = mock.Mock(side_effect=BoardError("stale_snapshot", "The board changed."))
            return session

        with mock.patch.object(self.manager, "current", side_effect=read_then_switch):
            response = client.get("/api/peripherals/preview")
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

    def test_a_stop_the_board_does_not_answer_keeps_the_session_for_a_retry(self):
        self.start()
        session_id = self.manager.current(1)["id"]
        exec_ = self.session.transport.exec
        self.session.transport.exec = mock.Mock(side_effect=BoardError("unreachable", "gone"))
        with self.assertRaises(BoardError):
            self.manager.stop(self.session, session_id)
        self.assertEqual(self.manager.current(1)["id"], session_id)
        self.session.transport.exec = exec_
        self.assertEqual(self.manager.stop(self.session, session_id)["state"], "stopped")

    def test_a_second_preview_is_refused_while_one_starts_and_names_its_camera(self):
        entered, release = threading.Event(), threading.Event()
        slow = staticmethod(lambda *args: (entered.set(), release.wait(5)))
        with mock.patch.object(preview.PreviewManager, "_require_gstreamer", slow):
            starter = threading.Thread(target=self.start)
            starter.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaises(BoardError) as ctx:
                self.start()
            release.set()
            starter.join(5)
        self.assertEqual((ctx.exception.code, ctx.exception.status), ("preview_active", 409))
        self.assertEqual(ctx.exception.extra["camera_id"], IMX477)

    def test_a_preview_is_stopped_on_the_board_that_runs_it(self):
        self.start()
        other = fake_session(generation=2)
        self.start(other)
        self.assertTrue(self.session.transport.kills())
        self.assertFalse(other.transport.kills())


class FakeSentinel:
    """Stands in for PeripheralClient: records each rescan and answers with `answer` (an exception is raised)."""

    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def __call__(self, session):
        sentinel = self

        class Client:
            def refresh(self, timeout):
                sentinel.calls.append((session, timeout))
                if isinstance(sentinel.answer, Exception):
                    raise sentinel.answer
                return sentinel.answer

        return Client()


class CameraFpsTests(unittest.TestCase):
    """The rate a running preview reports: a MIPI sensor's from SiMa Sentinel once it runs, a USB mode's own."""

    setUp = PreviewTests.setUp
    start = PreviewTests.start

    def start_with(self, answer, item=None, mode=MODE):
        sentinel = FakeSentinel(answer)
        with mock.patch.object(preview, "PeripheralClient", sentinel):
            session = self.start(item=item, mode=mode)
            reader = self.manager._run["fps_reader"]
            if reader is not None:
                reader.join(5)
                self.assertFalse(reader.is_alive())
        return session, sentinel

    def assert_still_live_without_side_effects(self, session_id):
        current = self.manager.current(1)
        self.assertEqual((current["id"], current["state"]), (session_id, "live"))
        self.assertEqual(self.session.transport.kills(), [])
        self.assertFalse(self.session.transport.streams[0][1].closed)
        # No Insight scan was recorded: the page's snapshot is the one from before the preview.
        self.assertIs(peripherals_api.scans.snapshot(1), self.snapshot)

    def test_a_mipi_preview_reads_the_sensors_rate_from_one_sentinel_rescan_after_its_first_frame(self):
        session, sentinel = self.start_with(catalog(dict(imx477(), max_fps=66.18), c920()))
        self.assertIsNone(session["camera_fps"], "unknown until Sentinel answers")
        self.assertEqual(sentinel.calls, [(self.session, preview.CAMERA_FPS_TIMEOUT_SEC)])
        self.assertEqual(self.manager.current(1)["camera_fps"], 66.18)
        self.assert_still_live_without_side_effects(session["id"])

    def test_a_failed_rescan_or_no_rate_leaves_camera_fps_null_and_the_preview_live(self):
        answers = {
            "sentinel error": BoardError("timeout", "SiMa Sentinel did not answer."),
            "unexpected error": RuntimeError("boom"),
            "no max_fps": catalog(imx477()),
            "camera gone": catalog(c920()),
            # Codex 4263972484: a failed provider's camera is kept from its last scan, whose rate may be stale.
            "provider failed": catalog(dict(imx477(), max_fps=66.18),
                                       errors=[{"provider": "camera.mipi", "code": "io.read", "message": "failed"}]),
        }
        for name, answer in answers.items():
            with self.subTest(name):
                session, sentinel = self.start_with(answer)
                self.assertEqual(len(sentinel.calls), 1)
                self.assertIsNone(self.manager.current(1)["camera_fps"])
                self.assert_still_live_without_side_effects(session["id"])
                self.manager.stop(self.session, session["id"])
                self.session = fake_session()

    def test_a_rate_read_for_a_preview_that_already_ended_asks_nothing(self):
        session, sentinel = self.start_with(catalog(dict(imx477(), max_fps=66.18)))
        self.manager.stop(self.session, session["id"])
        sentinel.calls.clear()
        with mock.patch.object(preview, "PeripheralClient", sentinel):
            self.manager._read_camera_fps(self.session, session["id"], IMX477)
        self.assertEqual(sentinel.calls, [])

    def test_a_start_that_sends_no_frame_never_asks_sentinel(self):
        self.session.transport.next_stream = FakeStream([], stderr=PID_LINE + b"ERROR: no camera\n")
        sentinel = FakeSentinel(catalog(dict(imx477(), max_fps=66.18)))
        with mock.patch.object(preview, "PeripheralClient", sentinel), self.assertRaises(BoardError):
            self.start()
        self.assertEqual(sentinel.calls, [])

    def test_a_rate_that_arrives_after_the_preview_stopped_is_dropped(self):
        answered, release = threading.Event(), threading.Event()
        sentinel = FakeSentinel(catalog(dict(imx477(), max_fps=66.18)))
        refresh = sentinel.__call__

        def slow(session):
            client = refresh(session)
            original = client.refresh
            client.refresh = lambda timeout: (answered.set(), release.wait(5), original(timeout))[2]
            return client

        with mock.patch.object(preview, "PeripheralClient", slow):
            first = self.start()
            reader = self.manager._run["fps_reader"]
            self.assertTrue(answered.wait(5))
            self.manager.stop(self.session, first["id"])
            release.set()
            reader.join(5)
        self.assertIsNone(self.manager.current(1))

    def test_a_usb_preview_reports_its_modes_rate_without_asking_sentinel(self):
        session, sentinel = self.start_with(RuntimeError("not called"), item=self.c920,
                                            mode={"format": "MJPG", "width": 640, "height": 480, "fps": 7.5})
        self.assertEqual(session["camera_fps"], 7.5)
        self.assertEqual(sentinel.calls, [])
        self.assertIsNone(self.manager._run["fps_reader"])


class KillScriptTests(unittest.TestCase):
    """The board-side stop, run for real with `sh`."""

    def kill(self, pid):
        subprocess.run(["sh", "-c", preview._kill_script(pid)], timeout=30, check=True)

    def test_a_pid_that_is_not_gst_launch_is_never_signalled(self):
        sleeper = subprocess.Popen(["sleep", "30"])
        self.addCleanup(sleeper.kill)
        self.kill(sleeper.pid)
        self.assertIsNone(sleeper.poll())
        self.kill(999999999)  # No such process: nothing to do.

    @unittest.skipUnless(HAVE_GST, "gst-launch-1.0 is not installed")
    def test_the_pipeline_is_stopped_by_its_pid(self):
        pipeline = subprocess.Popen(["gst-launch-1.0", "-q", "videotestsrc", "is-live=true", "!", "fakesink"])
        self.addCleanup(pipeline.kill)
        wait_until(lambda: comm(pipeline.pid) == "gst-launch-1.0", timeout=10, interval=0.05)
        self.kill(pipeline.pid)
        self.assertIsNotNone(pipeline.wait(5))


@unittest.skipUnless(HAVE_GST, "gst-launch-1.0 is not installed")
class LocalPipelineTests(unittest.TestCase):
    """A start, relay and stop through LocalTransport with a real gst-launch-1.0 (a test source stands in for the camera)."""

    ITEM = {"id": "camera:test", "name": "test", "connection": "usb", "device": {}}

    def setUp(self):
        transport = LocalTransport()
        self.session = SimpleNamespace(generation=1, transport=transport, raw_transport=transport)
        self.manager = preview.PreviewManager()
        self.manager._require_camera_free = lambda *args: None

    def test_frames_flow_and_closing_the_relay_ends_the_pipeline(self):
        session, manager = self.session, self.manager
        source = ["videotestsrc", "is-live=true", "!", "video/x-raw,format=YUY2,width=1280,height=720,framerate=30/1", "!", "videoconvert"]
        real = gst.pipeline

        def test_source(connection, *args):
            return source + real("usb", '"/dev/null"', "YUYV", 1280, 720, Fraction(30))[6:]

        mode = {"format": "YUYV", "width": 1280, "height": 720, "fps": 30, "rate": Fraction(30), "source": '"/dev/null"'}
        with mock.patch.object(gst, "pipeline", test_source):
            started = manager.start(session, self.ITEM, mode)
        pid = manager._run["pid"]
        self.assertEqual(comm(pid), "gst-launch-1.0")
        relay = manager.relay(session, started["id"])
        parts = iter(relay)
        frames = [gst.FrameParser().feed(next(parts)) for _ in range(5)]
        self.assertTrue(all(len(found) == 1 and found[0].startswith(b"\xff\xd8") for found in frames))
        relay.close()
        self.assertIsNone(manager.current(1))
        wait_until(lambda: not os.path.exists(f"/proc/{pid}"), timeout=10, interval=0.05)
        self.assertFalse(os.path.exists(f"/proc/{pid}"))

    def test_a_pipeline_gstreamer_rejects_reports_its_error(self):
        mode = {"format": "MJPG", "width": 640, "height": 480, "fps": 30, "rate": Fraction(30), "source": '"/dev/null"'}
        with mock.patch.object(gst, "pipeline", lambda *args: ["nosuchelement", "!", "fakesink"]), \
                self.assertRaises(BoardError) as ctx:
            self.manager.start(self.session, self.ITEM, mode)
        self.assertEqual((ctx.exception.code, ctx.exception.extra["tool"]), ("tool_missing", "nosuchelement"))
        self.assertEqual(ctx.exception.hint, preview.GST_INSTALL_HINT)
        self.assertIn('no element "nosuchelement"', ctx.exception.extra["detail"])
        self.assertNotIn("neat-preview-pid=", ctx.exception.extra["detail"])
        self.assertIsNone(self.manager.current(1))


class BoardChangeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.transports = []
        for patch in (
            mock.patch.object(manager_module, "SshTransport", side_effect=lambda *a: self.transports.append(FakeTransport()) or self.transports[-1]),
            mock.patch.dict(os.environ, {"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2"}, clear=True),
            mock.patch.object(peripherals_api, "scans", cameras.ScanCache()),
        ):
            patch.start()
            self.addCleanup(patch.stop)
        app = Flask(__name__)
        board.init_app(app, tmp.name, on_board=False)
        app.register_blueprint(peripherals_bp)
        preview_pkg.init_app(app)
        self.app = app
        self.previews = app.extensions["neat_preview"]
        # The MIPI camera-rate read runs in its own thread and talks to the board; these tests count the
        # board's commands exactly, so it is left out here (it has its own tests).
        self.previews._read_camera_fps = lambda *args: None
        self.addCleanup(self.previews.stop_for_board_change)
        self.client = app.test_client()
        item = item_of(scanned(imx477()), IMX477)
        with app.app_context():
            self.previews.start(app.extensions["neat_board"].session(), item, api.previewable_mode(item, dict(MODE)))

    def test_selecting_another_board_stops_the_preview_before_its_connection_closes(self):
        old = self.transports[0]
        for body in ({"reset": True}, {"host": "-oProxyCommand=x"}):
            self.client.post("/api/board/select", json=body)
        self.assertEqual((old.kills(), old.closed), ([], False))
        closed_at_stop = []
        exec_ = old.exec
        old.exec = lambda argv, **kw: closed_at_stop.append(old.closed) or exec_(argv, **kw)
        self.assertEqual(self.client.post("/api/board/select", json={"host": "10.1.1.9"}).status_code, 200)
        self.assertEqual((closed_at_stop, old.closed), ([False], True))
        self.assertTrue(old.streams[0][1].closed)
        self.assertIsNone(self.previews._session)

    def test_a_start_cannot_slip_between_the_cleanup_and_the_board_change(self):
        """A start racing a board change must not launch capture on the board being deselected."""
        old = self.transports[0]
        in_window, release, changed, started = threading.Event(), threading.Event(), [], []
        board_manager = self.app.extensions["neat_board"]
        guard = board_manager.target_change_guard

        @contextlib.contextmanager
        def paused_guard(changes):
            with guard(changes):
                # Inside the board change: the preview is stopped, the target not yet changed.
                in_window.set()
                release.wait(5)
                yield

        def post(results, *args, **kwargs):
            results.append(self.app.test_client().post(*args, **kwargs).status_code)

        with mock.patch.object(board_manager, "target_change_guard", paused_guard):
            changer = threading.Thread(target=post, args=(changed, "/api/board/select"), kwargs={"json": {"host": "10.1.1.9"}})
            changer.start()
            self.assertTrue(in_window.wait(5))
            self.assertTrue(old.kills(), "the preview was stopped before the target changes")
            starter = threading.Thread(target=post, args=(started, PREVIEW), kwargs={"json": {"id": IMX477}})
            starter.start()
            starter.join(1.0)
            release.set()
            changer.join(5)
            starter.join(5)
        self.assertEqual(changed, [200])
        self.assertEqual(len(old.streams), 1, "no pipeline started on the old board")
        self.assertEqual(started, [409])
        self.assertIsNone(self.previews._session)

    def test_a_rejected_host_key_trust_leaves_the_preview_running(self):
        for body in ({}, {"fingerprint": "SHA256:stale"}):
            with self.subTest(body=body):
                response = self.client.post("/api/board/trust-host-key", json=body)
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))
        self.assertEqual(self.transports[0].kills(), [])
        self.assertIsNotNone(self.previews._session)
        old = self.transports[0]
        old.presented_host_key, old.replace_host_key = paramiko.RSAKey.generate(1024), mock.Mock()
        response = self.client.post("/api/board/trust-host-key", json={"fingerprint": key_fingerprint(old.presented_host_key)})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(old.kills())
        self.assertIsNone(self.previews._session)

    def test_an_unreachable_old_board_does_not_block_the_board_change(self):
        self.transports[0].exec = mock.Mock(side_effect=BoardError("unreachable", "gone"))
        self.assertEqual(self.client.post("/api/board/select", json={"host": "10.1.1.9"}).status_code, 200)
        self.assertIsNone(self.previews._session)

    def scan(self, *args, **kwargs):
        sentinel = mock.patch.object(peripherals_api.PeripheralClient, "refresh", *args, **kwargs)
        identity = mock.patch.object(manager_module.BoardSession, "identity", return_value={"fingerprint": "fp"})
        return sentinel, identity

    def test_a_refresh_stops_the_preview_before_it_scans(self):
        sentinel, identity = self.scan(return_value=catalog(imx477()))
        with sentinel, identity:
            response = self.client.post("/api/peripherals/refresh")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.previews._session)
        self.assertTrue(self.transports[0].kills())

    def test_a_refresh_that_cannot_stop_the_preview_keeps_it_and_does_not_scan(self):
        board_transport, exec_ = self.transports[0], self.transports[0].exec
        failing = [True]

        def flaky_exec(argv, **kwargs):
            if failing[0] and "kill $pid" in argv[-1]:
                raise BoardError("unreachable", "Could not connect to sima@192.168.2.2.")
            return exec_(argv, **kwargs)

        board_transport.exec = flaky_exec
        sentinel, identity = self.scan(return_value=catalog(imx477()))
        with sentinel as sentinel_refresh, identity:
            response = self.client.post("/api/peripherals/refresh")
            self.assertEqual((response.status_code, response.get_json()["code"]), (502, "unreachable"))
            self.assertIn("Stop", response.get_json()["hint"])
            sentinel_refresh.assert_not_called()
            self.assertIsNotNone(self.previews._session)
            failing[0] = False
            self.assertEqual(self.client.post("/api/peripherals/refresh").status_code, 200)
        self.assertIsNone(self.previews._session)

    def test_a_refresh_waits_for_a_slow_start_to_finish_and_then_stops_it(self):
        self.previews.stop_for_board_change()
        entered, release, scanned_while_starting, results = threading.Event(), threading.Event(), [], []

        def slow_check(board_session):
            entered.set()
            release.wait(5)

        def sentinel_refresh(client):
            scanned_while_starting.append(not release.is_set())
            return catalog(imx477(), board=board_block())

        def post(path, **kwargs):
            results.append((path, self.app.test_client().post(path, **kwargs).status_code))

        sentinel, identity = self.scan(side_effect=sentinel_refresh, autospec=True)
        with sentinel, identity, mock.patch.object(preview.PreviewManager, "_require_gstreamer", staticmethod(slow_check)):
            starter = threading.Thread(target=post, args=(PREVIEW,), kwargs={"json": {"id": IMX477}})
            starter.start()
            self.assertTrue(entered.wait(5))
            refresher = threading.Thread(target=post, args=("/api/peripherals/refresh",))
            refresher.start()
            refresher.join(0.5)
            release.set()
            starter.join(5)
            refresher.join(5)
        self.assertEqual(sorted(results), [("/api/peripherals/cameras/preview", 200), ("/api/peripherals/refresh", 200)])
        self.assertEqual(scanned_while_starting, [False])
        self.assertIsNone(self.previews._session)

    def test_refreshes_queued_behind_the_preview_lock_still_share_one_scan(self):
        entered, release, results = threading.Event(), threading.Event(), []

        def slow_refresh(client):
            entered.set()
            release.wait(5)
            return catalog(imx477())

        def post():
            results.append(self.app.test_client().post("/api/peripherals/refresh").get_json())

        sentinel, identity = self.scan(side_effect=slow_refresh, autospec=True)
        with sentinel as refresh, identity:
            first = threading.Thread(target=post)
            first.start()
            self.assertTrue(entered.wait(5))
            second = threading.Thread(target=post)
            second.start()
            second.join(0.3)
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(refresh.call_count, 1)
        self.assertEqual(results[0], results[1])


if __name__ == "__main__":
    unittest.main()
