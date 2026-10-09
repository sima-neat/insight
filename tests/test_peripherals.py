import ast
import copy
import json
import subprocess
import sys
import threading
import unittest
import unittest.mock as mock
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult, board_bp
from neat_insight.peripherals import api, board_check, cameras
from neat_insight.peripherals.api import peripherals_bp

IMX477 = "camera:imx477 5-001a"
C920 = "camera:v4l2:421bbe426738013b"
ISP_NOTE = (
    "Only sizes the ISP can output (1920x1080, 2048x1080, 2432x2048) are offered; libcamera also advertises "
    "sizes the ISP cannot produce, which fail to start (core#883)."
)
C920_BY_ID = "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_BE998CAF-video-index0"
OBSERVED_AT = "2026-10-05T01:48:33.635147447Z"
# Sentinel's published contract example, copied byte for byte from sima-neat/sentinel
# docs/peripherals/catalog-example.json at commit 7efb980: a real DevKit response (IMX477 MIPI camera,
# Logitech C920 camera and its microphone) with the USB camera trimmed to one mode per format.
CONTRACT_EXAMPLE = Path(__file__).parent / "fixtures" / "sentinel-catalog-example.json"


def contract_catalog():
    return json.loads(CONTRACT_EXAMPLE.read_text(encoding="utf-8"))


def mipi_mode(fmt, width, height):
    return {"format": fmt, "width": width, "height": height, "isp_output": True}


def imx477():
    """Minimal IMX477 fixture spanning the ISP sizes and unsupported formats; the DevKit's ISP reports no rates."""
    modes = [mipi_mode("NV12", width, height) for width, height in ((1920, 1080), (2048, 1080), (2432, 2048))]
    modes += [mipi_mode(fmt, 1920, 1080) for fmt in ("AR24", "RGB3")]
    return {
        "id": IMX477, "type": "camera", "backend": "mipi", "model": "imx477", "camera_name": "imx477 5-001a",
        "media_device": "/dev/media0", "bus_info": "platform:csi2video@1",
        "availability": {"state": "unknown", "reason": "Discovery never opens a stream."},
        "isp": {"state": "available", "device_path": "/dev/video0out", "device_paths": ["/dev/video0out"]},
        "modes": modes,
    }


def usb_mode(fmt, width, height, periods):
    return {
        "format": fmt, "width": width, "height": height,
        "format_description": {"MJPG": "Motion-JPEG", "YUYV": "YUYV 4:2:2"}[fmt],
        "frame_intervals": [{"width": width, "height": height, "intervals": [
            {"numerator": n, "denominator": d, "type": "discrete"} for n, d in periods
        ]}],
    }


def c920():
    """The Logitech C920 record shape Sentinel reported on the DevKit (a subset of its 17 MJPG / 18 YUYV modes)."""
    rates = [(1, 30), (1, 24), (1, 20), (1, 15), (1, 10), (2, 15), (1, 5)]
    return {
        "id": C920, "type": "camera", "backend": "v4l2", "model": "HD Pro Webcam C920", "device_path": "/dev/video97",
        "by_id_path": C920_BY_ID,
        "identity": {
            "stable_key": "1-3.1:00:0", "topology": "1-3.1", "interface": "00", "node_index": "0",
            "vendor_id": "046d", "product_id": "08e5", "serial": "BE998CAF", "speed": "480",
        },
        "availability": {"state": "unknown", "reason": "Discovery never opens a stream."},
        "modes": [
            usb_mode("MJPG", 640, 480, rates),
            usb_mode("MJPG", 1280, 720, rates),
            usb_mode("YUYV", 640, 480, rates),
        ],
    }


IMX477_OVERLAY = "modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo"


def board_block(camera_id=IMX477, **camera):
    """Sentinel's `board` block for a Modalix SoM whose device tree configures one IMX477 (as client.board_block
    returns it); camera_id None is a configured camera no catalog camera is linked to. U-Boot also applies a PCIe overlay,
    which configures no camera sensor."""
    configured = {
        "compatible": "sony,imx477", "dt_node": "/i2cmux@0/i2c@0/imx477@1a", "i2c_device": "5-001a",
        "data_lanes": 2, **camera,
    }
    if camera_id:
        configured["camera_id"] = camera_id
    return {
        "model": "SiMa.ai Modalix SoM 16Gig Board",
        "overlays": ["pcie-8rc.dtbo", IMX477_OVERLAY],
        "configured_cameras": [configured],
        "supported_sensors": [
            {"compatible": "sony,imx477", "overlays": [IMX477_OVERLAY]},
            {"compatible": "onnn,ar0234", "overlays": ["modalix-som-ar0234.dtbo"]},
        ],
    }


def catalog(*devices, **extra):
    return {"revision": 1791164913635, "observed_at": OBSERVED_AT, "devices": list(devices), "errors": [], **extra}


def check(**extra):
    """board_check output for a board where Insight runs as root and nothing holds a camera."""
    return {
        "tools": {"media-ctl": True, "fuser": True},
        "availability_method": "proc-root",
        "users": {IMX477: [], C920: []},
        "failures": [],
        **extra,
    }


BOARD = {"label": "sima@192.168.2.2", "source": "manual", "hostname": "modalix", "fingerprint": "fp-1"}


def snapshot_of(doc, previous=None):
    return cameras.build_snapshot(doc, BOARD, 1, previous, 5)


def item(snapshot, item_id):
    return next(i for i in snapshot["items"] if i["id"] == item_id)


def fmt_of(camera, name):
    return next(f for f in camera["formats"] if f["format"] == name)


def size_of(fmt, width, height):
    return next(s for s in fmt["sizes"] if (s["width"], s["height"]) == (width, height))


class BoardCheckTests(unittest.TestCase):
    def test_source_parses_as_python_38(self):
        ast.parse(Path(board_check.__file__).read_text(encoding="utf-8"), feature_version=(3, 8))

    def test_media_graph_nodes_and_fuser_output(self):
        text = "- entity 1: csi2 (2 pads)\n\t\tdevice node name /dev/v4l-subdev0\n- entity 5: vid\n\t\tdevice node name /dev/video0\n"
        self.assertEqual(board_check.media_graph_nodes(text), ["/dev/v4l-subdev0", "/dev/video0"])
        self.assertEqual(board_check.parse_fuser_pids(" 4242m 17"), [17, 4242])

    def test_a_media_device_brings_its_whole_graph_and_sudo_fuser_names_other_users(self):
        tools = {"media-ctl": "/usr/bin/media-ctl", "fuser": "/bin/fuser", "sudo": "/usr/bin/sudo"}
        calls = []

        def run(argv, timeout=10):
            calls.append(argv)
            if argv[0] == "/usr/bin/media-ctl":
                return 0, "\t\tdevice node name /dev/video0\n", ""
            if argv[1:] == ["-n", "true"]:
                return 0, "", ""
            return 0, " 4242", "/dev/media0:\n"

        with mock.patch.object(board_check, "which", side_effect=tools.get), \
             mock.patch.object(board_check, "run", side_effect=run), \
             mock.patch.object(board_check.os, "geteuid", return_value=1000), \
             mock.patch.object(board_check, "_read", return_value="gst-launch-1.0"):
            result = board_check.collect({"cameras": {IMX477: ["/dev/media0"]}})
        self.assertEqual(result["availability_method"], "sudo-fuser")
        self.assertEqual(result["users"], {IMX477: [{"pid": 4242, "command": "gst-launch-1.0"}]})
        self.assertIn(["/usr/bin/sudo", "-n", "/bin/fuser", "/dev/media0", "/dev/video0"], calls)
        self.assertNotIn("libcamerasrc", result)
        self.assertEqual(result["tools"], {"media-ctl": True, "fuser": True})

    def test_sudo_fuser_distinguishes_idle_from_a_fatal_error(self):
        tools = {"media-ctl": None, "fuser": "/bin/fuser", "sudo": "/usr/bin/sudo"}
        for fuser_result, expected in (((1, "", ""), []), ((1, "", "No such file or directory"), None)):
            def run(argv, timeout=10):
                return (0, "", "") if argv[1:] == ["-n", "true"] else fuser_result

            with self.subTest(fuser_result=fuser_result), \
                 mock.patch.object(board_check, "which", side_effect=tools.get), \
                 mock.patch.object(board_check, "run", side_effect=run), \
                 mock.patch.object(board_check.os, "geteuid", return_value=1000):
                result = board_check.collect({"cameras": {C920: ["/dev/video97"]}})
            self.assertEqual(result["availability_method"], "sudo-fuser")
            self.assertEqual(result["users"], {C920: expected})

    def test_a_media_graph_that_cannot_be_read_leaves_an_idle_camera_unknown(self):
        """Without the graph, a process holding only /dev/videoN would be missed, so idle is not proof of available."""
        for media_ctl, run_media_ctl in ((None, None), ("/usr/bin/media-ctl", (1, "", "No such device"))):
            def run(argv, timeout=10):
                return run_media_ctl

            tools = {"media-ctl": media_ctl}
            with self.subTest(media_ctl=media_ctl), \
                 mock.patch.object(board_check, "which", side_effect=tools.get), \
                 mock.patch.object(board_check, "run", side_effect=run), \
                 mock.patch.object(board_check.os, "geteuid", return_value=0), \
                 mock.patch.object(board_check, "scan_proc", return_value={}):
                result = board_check.collect({"cameras": {IMX477: ["/dev/media0"], C920: ["/dev/video97"]}})
            self.assertEqual(result["availability_method"], "proc-root")
            self.assertEqual(result["users"], {IMX477: None, C920: []})

    def test_an_unreadable_proc_leaves_availability_unknown_not_available(self):
        # Codex 4188915681: root without a listable /proc used to report every camera as available.
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check.os, "listdir", side_effect=PermissionError("denied")):
            result = board_check.collect({"cameras": {C920: ["/dev/video97"]}})
        self.assertEqual(result["availability_method"], "proc-root")
        self.assertEqual(result["users"], {C920: None})

    def test_a_holder_of_the_media_device_is_reported_even_without_the_graph(self):
        held = {"/dev/media0": {4242}}
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check, "scan_proc", return_value=held), \
             mock.patch.object(board_check, "_read", return_value="neat-app"):
            result = board_check.collect({"cameras": {IMX477: ["/dev/media0"]}})
        self.assertEqual(result["users"], {IMX477: [{"pid": 4242, "command": "neat-app"}]})

    def test_runs_as_a_program_and_prints_json(self):
        request = json.dumps({"cameras": {"camera:x": ["/dev/no-such-node"]}})
        done = subprocess.run(
            [sys.executable, "-I", "-", request], input=Path(board_check.__file__).read_bytes(),
            capture_output=True, timeout=60,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual(result["users"], {"camera:x": []})
        self.assertIn(result["availability_method"], ("proc-root", "sudo-fuser", "proc-user"))
        self.assertEqual(set(result), {"tools", "availability_method", "users", "failures"})

    def test_the_check_never_asks_neat_core_about_camera_modes(self):
        """Mode support comes from Sentinel's board block, so the check does not run PyNeat or Neat Core."""
        source = Path(board_check.__file__).read_text(encoding="utf-8").lower()
        self.assertNotIn("pyneat", source)
        self.assertFalse(hasattr(board_check, "core_support"))

def states(fps):
    return [(choice["value"], choice["tier"], choice.get("reason")) for choice in fps]


class SnapshotTests(unittest.TestCase):
    def test_imx477_nv12_modes_are_available_at_the_isp_sizes_when_the_overlays_support_its_sensor(self):
        camera = item(snapshot_of(catalog(imx477(), board=board_block())), IMX477)
        self.assertEqual((camera["connection"], camera["name"], camera["model"]), ("mipi", "imx477 5-001a", "imx477"))
        self.assertEqual(camera["support"], {"tier": "available", "reason": ""})
        self.assertEqual(camera["device"], {
            "camera_name": "imx477 5-001a", "camera_name_source": "media-graph",
            "media_device": "/dev/media0", "bus_info": "platform:csi2video@1",
        })
        # CameraInput outputs NV12 only, a fixed Neat fact; the ISP's other formats are Unsupported.
        self.assertEqual(cameras.FORMAT_REASON, "Neat's CameraInput outputs NV12 only.")
        self.assertEqual([(f["format"], f["label"], f["exportable"], f["support"]) for f in camera["formats"]], [
            ("NV12", "NV12 (YUV 4:2:0)", True, {"tier": "available", "reason": ""}),
            ("AR24", "AR24 (packed 32-bit)", False, {"tier": "unsupported", "reason": cameras.FORMAT_REASON}),
            ("RGB3", "RGB3 (packed 24-bit)", False, {"tier": "unsupported", "reason": cameras.FORMAT_REASON}),
        ])
        self.assertEqual(states(size_of(fmt_of(camera, "RGB3"), 1920, 1080)["fps"]),
                         [(30, "unsupported", cameras.FORMAT_REASON)])
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual([(s["width"], s["height"]) for s in nv12["sizes"]], [(1920, 1080), (2048, 1080), (2432, 2048)])
        self.assertEqual(size_of(nv12, 1920, 1080)["fps"], [{"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": "available"}])
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(camera["availability"], {"state": "unknown", "users": [], "reason": "Discovery never opens a stream."})
        self.assertEqual(camera["modes_source"], "live")
        self.assertEqual(camera["notes"], [ISP_NOTE])

    def test_sentinels_contract_example_makes_the_imx477_available_and_the_c920_unsupported(self):
        doc = contract_catalog()
        snapshot = snapshot_of(doc)
        self.assertEqual(snapshot["scan_id"], f"{doc['revision']}:{doc['observed_at']}")
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920])
        self.assertEqual(snapshot["issues"], [])
        # Sentinel's published example carries the board block, which links its IMX477 to the camera overlay.
        self.assertEqual(snapshot["camera_setup"], {"model": "SiMa.ai Modalix SoM 16Gig Board", "overlays": [IMX477_OVERLAY]})

        mipi = item(snapshot, IMX477)
        self.assertEqual((mipi["connection"], mipi["support"]), ("mipi", {"tier": "available", "reason": ""}))
        self.assertEqual(mipi["device"]["csi"], "csidev-40c3000.csi")
        self.assertEqual([(f["format"], f["exportable"], f["support"]["tier"]) for f in mipi["formats"]],
                         [("AR24", False, "unsupported"), ("NV12", True, "available"), ("RGB3", False, "unsupported")])
        for fmt in mipi["formats"]:
            self.assertEqual([(s["width"], s["height"]) for s in fmt["sizes"]], [(1920, 1080), (2048, 1080), (2432, 2048)])
            state = (30, "available", None) if fmt["format"] == "NV12" else (30, "unsupported", cameras.FORMAT_REASON)
            for size in fmt["sizes"]:
                self.assertEqual(states(size["fps"]), [state])
        # The first Available mode in Sentinel's order.
        self.assertEqual(mipi["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(mipi["notes"], [ISP_NOTE])

        usb = item(snapshot, C920)
        self.assertEqual((usb["connection"], usb["name"]), ("usb", "HD Pro Webcam C920"))
        self.assertEqual(usb["support"], {"tier": "unsupported", "reason": cameras.USB_REASON})
        self.assertEqual(usb["device"]["usb"]["bus_path"], doc["devices"][1]["identity"]["topology"])
        self.assertEqual([(f["format"], f["exportable"], f["support"]["tier"], len(f["sizes"])) for f in usb["formats"]],
                         [("MJPG", False, "unsupported", 1), ("YUYV", False, "unsupported", 1)])
        self.assertEqual(states(size_of(fmt_of(usb, "MJPG"), 1920, 1080)["fps"]),
                         [(value, "unsupported", cameras.USB_REASON) for value in (30, 24, 20, 15, 10, 7.5, 5)])
        self.assertEqual([c["value"] for c in size_of(fmt_of(usb, "YUYV"), 2560, 1472)["fps"]], [2])
        self.assertIsNone(usb["default_selection"])

    def test_a_size_the_isp_cannot_output_is_unsupported(self):
        doc = imx477()
        doc["modes"] = [
            mipi_mode("NV12", 1920, 1080),
            dict(mipi_mode("NV12", 4056, 3040), isp_output=False),
            {"format": "NV12", "width": 1332, "height": 990},  # a Sentinel that does not say is not an ISP size
        ]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual((camera["support"]["tier"], nv12["exportable"], nv12["support"]["tier"]),
                         ("available", True, "available"))
        self.assertEqual(states(size_of(nv12, 1920, 1080)["fps"]), [(30, "available", None)])
        for width, height in ((4056, 3040), (1332, 990)):
            self.assertEqual(states(size_of(nv12, width, height)["fps"]), [(30, "unsupported", cameras.NOT_ISP_SIZE_REASON)])
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})

        doc["modes"] = doc["modes"][1:]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.NO_ISP_SIZE_REASON})
        self.assertEqual((fmt_of(camera, "NV12")["exportable"], camera["default_selection"]), (False, None))

    def test_a_camera_whose_isp_sizes_are_not_nv12_is_unsupported_for_the_format(self):
        doc = imx477()
        doc["modes"] = [mipi_mode("RGB3", 1920, 1080), dict(mipi_mode("NV12", 4056, 3040), isp_output=False)]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.FORMAT_REASON})
        self.assertEqual(fmt_of(camera, "NV12")["support"]["reason"], cameras.NO_ISP_SIZE_REASON)
        self.assertIsNone(camera["default_selection"])

    def test_a_sentinel_verdict_decides_each_mode(self):
        """A Sentinel that decides availability itself (sentinel#43) is followed. On Platform 3.0 the modes are the
        sensor's sizes, marked `sensor_mode` and not `isp_output` (as the 3.0 DevKit's IMX477 reports them)."""
        def sensor_mode(fmt, width, height, available, reason=None):
            mode = {"format": fmt, "width": width, "height": height, "sensor_mode": True, "available": available}
            return dict(mode, reason=reason) if reason else mode

        doc = imx477()
        doc["isp"]["sizing"] = "runtime"
        doc["modes"] = [
            sensor_mode("NV12", 1920, 1080, True),
            sensor_mode("NV12", 2028, 1520, True),
            sensor_mode("RGB3", 2028, 1520, False, cameras.FORMAT_REASON),
        ]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual((camera["support"]["tier"], nv12["exportable"], nv12["support"]["tier"]),
                         ("available", True, "available"))
        self.assertEqual(states(size_of(nv12, 2028, 1520)["fps"]), [(30, "available", None)])
        self.assertEqual(states(size_of(fmt_of(camera, "RGB3"), 2028, 1520)["fps"]),
                         [(30, "unsupported", cameras.FORMAT_REASON)])

        # Sentinel's "no" wins over Insight's own rule and keeps Sentinel's reason; with none of its sizes available,
        # a 3.0 camera is unsupported for the format, not for the ISP.
        doc["modes"] = [dict(mipi_mode("NV12", 1920, 1080), available=False, reason="Not set up for this mode."),
                        sensor_mode("RGB3", 2028, 1520, False, cameras.FORMAT_REASON)]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        self.assertEqual(states(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"]),
                         [(30, "unsupported", "Not set up for this mode.")])
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.FORMAT_REASON})

    def test_a_sensor_missing_from_the_boards_overlays_is_unsupported(self):
        cases = {
            "sensor not in the overlays": {**board_block(), "supported_sensors": [
                {"compatible": "onnn,ar0234", "overlays": ["modalix-som-ar0234.dtbo"]}]},
            # The device tree configures the IMX477, but Sentinel did not link it to this camera.
            "no configured camera with this id": board_block(None),
            "another camera's id": board_block("camera:imx477 6-001a"),
            "no configured cameras": {**board_block(), "configured_cameras": []},
        }
        reason = "IMX477 is not in this board's camera overlays."
        for name, block in cases.items():
            with self.subTest(name):
                camera = item(snapshot_of(catalog(imx477(), board=block)), IMX477)
                self.assertEqual(camera["support"], {"tier": "unsupported", "reason": reason})
                self.assertEqual({(f["exportable"], f["support"]["reason"]) for f in camera["formats"]}, {(False, reason)})
                self.assertEqual(states(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"]), [(30, "unsupported", reason)])
                self.assertIsNone(camera["default_selection"])
        # The configured sensor names the camera when Sentinel links it; another vendor's IMX477 is not this one.
        econ = board_block(compatible="econ,imx477")
        self.assertEqual(item(snapshot_of(catalog(imx477(), board=econ)), IMX477)["support"]["reason"], reason)
        nameless = dict(imx477(), model=None)
        self.assertEqual(item(snapshot_of(catalog(nameless, board=board_block(None))), IMX477)["support"]["reason"],
                         "imx477 5-001a is not in this board's camera overlays.")

    def test_without_sentinels_board_block_every_mode_is_unsupported_and_says_to_update_sentinel(self):
        snapshot = snapshot_of(catalog(imx477(), c920()))
        camera = item(snapshot, IMX477)
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.NO_BOARD_REASON})
        self.assertEqual(cameras.NO_BOARD_REASON, "This board's SiMa Sentinel does not report camera overlays; update Sentinel.")
        self.assertEqual({(f["exportable"], f["support"]["tier"]) for f in camera["formats"]}, {(False, "unsupported")})
        for fmt in camera["formats"]:
            for size in fmt["sizes"]:
                self.assertEqual(states(size["fps"]), [(30, "unsupported", cameras.NO_BOARD_REASON)])
        self.assertIsNone(camera["default_selection"])
        # A USB camera has no overlay whatever Sentinel reports, so it keeps its own reason.
        self.assertEqual(item(snapshot, C920)["support"]["reason"], cameras.USB_REASON)
        self.assertEqual(snapshot["issues"], [])

    def test_usb_camera_is_unsupported_and_offers_every_advertised_rate(self):
        camera = item(snapshot_of(catalog(c920(), board=board_block())), C920)
        self.assertEqual((camera["connection"], camera["name"]), ("usb", "HD Pro Webcam C920"))
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": "USB cameras have no camera overlay on this board."})
        self.assertEqual(camera["device"], {
            "video_node": "/dev/video97",
            "by_id": C920_BY_ID,
            "usb": {"vendor_id": "046d", "product_id": "08e5", "serial": "BE998CAF",
                    "product": "HD Pro Webcam C920", "bus_path": "1-3.1", "speed_mbps": 480},
        })
        mjpg = fmt_of(camera, "MJPG")
        self.assertEqual((mjpg["label"], mjpg["exportable"]), ("MJPG (Motion-JPEG)", False))
        self.assertEqual(mjpg["support"], {"tier": "unsupported", "reason": cameras.USB_REASON})
        self.assertEqual(fmt_of(camera, "YUYV")["label"], "YUYV (YUYV 4:2:2)")
        self.assertEqual(states(size_of(mjpg, 640, 480)["fps"]),
                         [(value, "unsupported", cameras.USB_REASON) for value in (30, 24, 20, 15, 10, 7.5, 5)])
        self.assertIsNone(camera["default_selection"])
        self.assertEqual(camera["notes"], [])

    def test_usb_identity_rows_degrade_when_sysfs_omits_them(self):
        doc = c920()
        doc.pop("by_id_path")
        doc["identity"].update(manufacturer="Logitech", speed="1.5")
        for mode in doc["modes"]:
            mode.pop("format_description")
        camera = item(snapshot_of(catalog(doc)), C920)
        self.assertNotIn("by_id", camera["device"])
        self.assertEqual((camera["device"]["usb"]["manufacturer"], camera["device"]["usb"]["speed_mbps"]), ("Logitech", 1.5))
        self.assertEqual(camera["notes"], [cameras.NO_BY_ID_NOTE])
        self.assertEqual(fmt_of(camera, "YUYV")["label"], "YUYV (YUV 4:2:2)")
        for speed in ("", "unknown", "0", None):
            doc["identity"]["speed"] = speed
            self.assertNotIn("speed_mbps", item(snapshot_of(catalog(doc)), C920)["device"]["usb"])

    def test_stepwise_sizes_become_the_format_range_and_interval_ranges_offer_standard_rates(self):
        doc = c920()
        doc["modes"] = [{
            "format": "YUYV", "size_range": {"type": "stepwise", "min_width": 160, "min_height": 120,
                                             "max_width": 1920, "max_height": 1080, "step_width": 16, "step_height": 8},
            "frame_intervals": [{"width": 160, "height": 120, "intervals": [
                {"type": "discrete", "numerator": 1, "denominator": 30}]}],
        }, {
            "format": "YUYV", "width": 640, "height": 480,
            "frame_intervals": [{"width": 640, "height": 480, "intervals": [{
                "type": "continuous", "minimum": {"numerator": 1, "denominator": 30},
                "maximum": {"numerator": 1, "denominator": 10}}]}],
        }]
        yuyv = fmt_of(item(snapshot_of(catalog(doc)), C920), "YUYV")
        self.assertEqual(yuyv["range"], {"min_width": 160, "min_height": 120, "max_width": 1920, "max_height": 1080,
                                         "step_width": 16, "step_height": 8})
        self.assertEqual([c["value"] for c in size_of(yuyv, 640, 480)["fps"]], [30, 25, 20, 15, 10])

    def test_camerainput_default_rate_is_offered_for_mipi_modes_only(self):
        """A USB mode is not a CameraInput mode, so a mode without frame intervals offers no rate."""
        usb = c920()
        usb["modes"] = [{"format": "MJPG", "width": 640, "height": 480}]
        mjpg = fmt_of(item(snapshot_of(catalog(usb)), C920), "MJPG")
        self.assertEqual(size_of(mjpg, 640, 480)["fps"], [])
        mipi = item(snapshot_of(catalog(imx477())), IMX477)
        self.assertEqual([c["value"] for c in size_of(fmt_of(mipi, "NV12"), 1920, 1080)["fps"]], [30])

    def test_every_rate_sentinel_reports_for_an_available_mode_is_available(self):
        doc = imx477()
        doc["modes"] = [dict(mipi_mode("NV12", 1920, 1080), frame_intervals=[{"width": 1920, "height": 1080, "intervals": [
            {"type": "discrete", "numerator": 1, "denominator": 60}, {"type": "discrete", "numerator": 1, "denominator": 30},
        ]}])]
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        self.assertEqual(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"], [
            {"value": 60, "framerate_num": 60, "framerate_den": 1, "tier": "available"},
            {"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": "available"},
        ])
        self.assertEqual(camera["notes"], [
            "Only sizes the ISP can output (1920x1080) are offered; libcamera also advertises sizes the ISP "
            "cannot produce, which fail to start (core#883).",
        ])

    def test_unreadable_isp_leaves_no_modes_and_says_why(self):
        doc = imx477()
        doc.update(modes=[], isp={"state": "unavailable", "reason": "no ISP output node was found"})
        camera = item(snapshot_of(catalog(doc, board=board_block())), IMX477)
        self.assertEqual((camera["modes_source"], camera["formats"], camera["default_selection"]), ("unavailable", [], None))
        self.assertIn("no ISP output node was found", camera["errors"][0]["message"])
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.NO_MODES_REASON})

    def test_a_failed_provider_keeps_its_last_records_marked_as_an_earlier_scan(self):
        errors = [
            {"provider": "camera.mipi", "code": "io.open", "reason": "could not open /dev/media0"},
            {"provider": "hotplug", "code": "hotplug.unavailable", "reason": "kernel uevents cannot be received"},
        ]
        snapshot = snapshot_of(catalog(imx477(), c920(), errors=errors))
        self.assertEqual(item(snapshot, IMX477)["modes_source"], "previous-scan")
        self.assertIn("its camera.mipi provider failed", " ".join(item(snapshot, IMX477)["notes"]))
        self.assertEqual(item(snapshot, C920)["modes_source"], "live")
        issues = {i["code"]: i for i in snapshot["issues"]}
        self.assertEqual(issues["io.open"]["message"], "SiMa Sentinel's camera.mipi provider failed: could not open "
                         "/dev/media0 The devices it found last time are still listed.")
        self.assertEqual(issues["hotplug.unavailable"]["message"],
                         "SiMa Sentinel's hotplug provider failed: kernel uevents cannot be received")
        self.assertEqual(issues["io.open"]["severity"], "warning")

    def test_a_board_reader_error_names_the_camera_setup(self):
        error = {"provider": "board", "code": "peripherals.discovery_failed",
                 "reason": "fw_printenv failed (exit status: 1): Cannot read environment, using default"}
        snapshot = snapshot_of(catalog(imx477(), board=board_block(), errors=[error]))
        self.assertEqual(snapshot["issues"], [{
            "severity": "warning", "code": "peripherals.discovery_failed",
            "message": "SiMa Sentinel could not read part of the board's camera setup: fw_printenv failed (exit "
                       "status: 1): Cannot read environment, using default",
            "hint": cameras.STATUS_HINT,
        }])

    def test_the_snapshot_passes_sentinels_availability_through_and_never_inspects_processes(self):
        """Whether another program holds a camera is found out when a preview opens it, not during a scan: that
        needed root (or passwordless sudo) to be right and showed "unknown" with a root banner otherwise."""
        snapshot = snapshot_of(catalog(imx477(), c920()))
        for camera_id in (IMX477, C920):
            self.assertEqual(item(snapshot, camera_id)["availability"],
                             {"state": "unknown", "users": [], "reason": "Discovery never opens a stream."})
        self.assertEqual([i["code"] for i in snapshot["issues"]], [])
        self.assertNotIn("platform", snapshot)
        self.assertFalse(hasattr(cameras, "AVAILABILITY_ISSUES"))
        self.assertFalse(hasattr(cameras, "TOOL_ISSUES"))
        doc = imx477()
        doc["availability"] = {"state": "in_use", "reason": "Open in neat-app."}
        self.assertEqual(item(snapshot_of(catalog(doc)), IMX477)["availability"],
                         {"state": "in_use", "users": [], "reason": "Open in neat-app."})

    def test_changes_are_reported_against_the_previous_refresh(self):
        first = snapshot_of(catalog(imx477(), c920()))
        second = snapshot_of(catalog(imx477()), previous=first)
        self.assertEqual(second["changes"], {"added": [], "removed": [{"id": C920, "name": "HD Pro Webcam C920"}]})
        self.assertIsNone(first["changes"])

    def test_camera_setup_names_the_model_and_camera_overlays(self):
        setup = snapshot_of(catalog(imx477(), board=board_block()))["camera_setup"]
        self.assertEqual(setup, {"model": "SiMa.ai Modalix SoM 16Gig Board", "overlays": [IMX477_OVERLAY]})
        self.assertEqual([cameras.sensor_name(c) for c in ("sony,imx477", "imx219", "sony,")], ["IMX477", "IMX219", "SONY,"])
        # Only overlays that configure a sensor are shown, in U-Boot's order; none without supported sensors.
        both = {**board_block(), "overlays": [IMX477_OVERLAY, "pcie-8rc.dtbo", "modalix-som-ar0234.dtbo"]}
        self.assertEqual(snapshot_of(catalog(imx477(), board=both))["camera_setup"]["overlays"],
                         [IMX477_OVERLAY, "modalix-som-ar0234.dtbo"])
        unsupported = {**board_block(), "supported_sensors": []}
        self.assertEqual(snapshot_of(catalog(imx477(), board=unsupported))["camera_setup"]["overlays"], [])
        sparse = {"configured_cameras": [{"compatible": "imx219"}]}
        self.assertEqual(snapshot_of(catalog(board=sparse))["camera_setup"], {"model": None, "overlays": []})

    def test_an_older_sentinel_without_a_board_block_adds_no_camera_setup(self):
        snapshot = snapshot_of(catalog(imx477()))
        self.assertIsNone(snapshot["camera_setup"])
        self.assertEqual(snapshot["issues"], [])
        self.assertIsNone(cameras.empty_snapshot(BOARD, 1)["camera_setup"])

    def test_non_camera_devices_are_not_listed(self):
        other = {"id": "future:1", "type": "future_sensor", "backend": "future"}
        microphone = next(d for d in contract_catalog()["devices"] if d["type"] == "microphone")
        self.assertEqual([i["id"] for i in snapshot_of(catalog(other, microphone, imx477()))["items"]], [IMX477])


class FakeSession:
    def __init__(self, generation: int, transport, fingerprint: str = "fp-1", mode: str = "ssh"):
        self.generation = generation
        self.raw_transport = transport
        self.transport = transport
        self.target = SimpleNamespace(mode=mode, source="manual", label="sima@192.168.2.2")
        self.fingerprint = fingerprint
        self.stale = False

    def identity(self):
        return {"hostname": "modalix", "machine": "modalix", "build_version": "2.1.3", "fingerprint": self.fingerprint}

    def require_current(self):
        if self.stale:
            raise BoardError("stale_snapshot", "The selected board changed while this request was running.")


class FakeManager:
    def __init__(self):
        self.current = None
        self.error = None

    def session(self):
        if self.error:
            raise self.error
        return self.current


class CheckTransport:
    """Answers the board_check command with queued output, ExecResults, or errors."""

    def __init__(self, *responses, default=None):
        self.responses = list(responses)
        self.default = default or check()
        self.calls = []

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append((argv, timeout, stdin))
        response = self.responses.pop(0) if self.responses else self.default
        if isinstance(response, Exception):
            raise response
        if isinstance(response, ExecResult):
            return response
        return ExecResult(0, json.dumps(response).encode(), b"")


class PeripheralsApiTests(unittest.TestCase):
    def setUp(self):
        scans = mock.patch.object(api, "scans", cameras.ScanCache())
        scans.start()
        self.addCleanup(scans.stop)
        self.catalogs = []
        sentinel = mock.patch.object(api.PeripheralClient, "refresh", autospec=True, side_effect=self._sentinel_refresh)
        self.sentinel = sentinel.start()
        self.addCleanup(sentinel.stop)
        self.manager = FakeManager()
        self.scan_id = "unscanned"
        app = Flask(__name__)
        app.register_blueprint(board_bp)
        app.register_blueprint(peripherals_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def _sentinel_refresh(self, client):
        response = self.catalogs.pop(0) if len(self.catalogs) > 1 else self.catalogs[0]
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)

    def use(self, *catalogs, generation: int = 1, fingerprint: str = "fp-1") -> CheckTransport:
        self.catalogs = list(catalogs) or [catalog(imx477(), c920())]
        transport = CheckTransport()
        self.manager.current = FakeSession(generation, transport, fingerprint)
        return transport

    def refresh(self):
        response = self.client.post("/api/peripherals/refresh")
        if response.status_code == 200:
            self.scan_id = response.get_json()["scan_id"]
        return response

    def test_scan_responses_are_not_cached(self):
        self.use()
        self.assertEqual(self.client.get("/api/peripherals").headers["Cache-Control"], "no-store")

    def test_get_before_refresh_is_empty_and_never_connects(self):
        transport = self.use()
        response = self.client.get("/api/peripherals")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(
            (body["scan_id"], body["scanned_at"], body["items"], body["changes"]),
            (None, None, [], None),
        )
        self.assertEqual(body["board"]["label"], "sima@192.168.2.2")
        self.assertEqual(transport.calls, [])
        self.sentinel.assert_not_called()

    def test_refresh_asks_sentinel_and_runs_nothing_else_on_the_board(self):
        transport = self.use()
        response = self.refresh()
        self.assertEqual(response.status_code, 200)
        self.sentinel.assert_called_once()
        # No process check during a scan: whether a camera is busy is reported when a preview opens it.
        self.assertEqual(transport.calls, [])
        snapshot = response.get_json()
        self.assertEqual(snapshot["board"]["fingerprint"], "fp-1")
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920])
        self.assertIsNone(snapshot["changes"])
        self.assertEqual(self.client.get("/api/peripherals").get_json(), snapshot)

    def test_sentinels_contract_example_refreshes_both_cameras(self):
        self.use(contract_catalog())
        snapshot = self.refresh().get_json()
        self.assertEqual([(i["id"], i["support"]["tier"]) for i in snapshot["items"]],
                         [(IMX477, "available"), (C920, "unsupported")])

    def test_a_board_without_cameras_needs_no_board_check(self):
        transport = self.use(catalog())
        self.assertEqual(self.refresh().get_json()["items"], [])
        self.assertEqual(transport.calls, [])

    def test_a_refresh_runs_nothing_on_the_board_beyond_sentinels_rescan(self):
        raw = self.use()
        reporting = mock.Mock()
        self.manager.current.transport = reporting
        self.assertEqual(self.refresh().status_code, 200)
        self.assertEqual(raw.calls, [])
        reporting.exec.assert_not_called()

    def test_refresh_reflects_removal_and_reconnection(self):
        self.use(catalog(imx477()), catalog(), catalog(imx477()))
        self.refresh()
        removed = self.refresh().get_json()["changes"]
        self.assertEqual(removed, {"added": [], "removed": [{"id": IMX477, "name": "imx477 5-001a"}]})
        added = self.refresh().get_json()["changes"]
        self.assertEqual(added, {"added": [{"id": IMX477, "name": "imx477 5-001a"}], "removed": []})

    def test_changes_are_not_carried_across_boards(self):
        self.use(catalog(imx477()))
        self.refresh()
        self.use(catalog(), fingerprint="fp-2")
        self.assertIsNone(self.refresh().get_json()["changes"])

    def test_stepwise_intervals_offer_only_rates_on_their_step(self):
        doc = c920()
        doc["modes"] = [dict(usb_mode("YUYV", 640, 480, [(1, 30)]), frame_intervals=[{
            "width": 640, "height": 480, "intervals": [{
                "type": "stepwise",
                "minimum": {"numerator": 333333, "denominator": 10000000},
                "maximum": {"numerator": 2000000, "denominator": 10000000},
                "step": {"numerator": 333333, "denominator": 10000000},
            }],
        }])]
        self.use(catalog(doc))
        camera = item(self.refresh().get_json(), C920)
        self.assertEqual([choice["value"] for choice in size_of(fmt_of(camera, "YUYV"), 640, 480)["fps"]], [30, 15, 10, 5])

    def test_get_is_refused_when_the_board_changes_before_it_returns(self):
        self.use()
        self.refresh()
        self.manager.current.stale = True  # /api/board/select lands after session() returned
        response = self.client.get("/api/peripherals")
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

    def test_a_board_change_during_refresh_is_refused_and_not_recorded(self):
        self.use()
        self.manager.current.stale = True
        response = self.refresh()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertIsNone(api.scans.snapshot(1))

    def test_a_board_change_while_the_snapshot_is_built_is_refused(self):
        self.use()
        record = api.scans.record

        def record_then_switch_board(*args):
            snapshot = record(*args)
            self.manager.current.stale = True  # /api/board/select lands while the snapshot is built
            return snapshot

        with mock.patch.object(api.scans, "record", record_then_switch_board):
            response = self.refresh()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

    def test_board_and_sentinel_errors_pass_through(self):
        self.use(BoardError("unreachable", "Cannot reach sima@192.168.2.2.", hint="Check the cable."))
        response = self.refresh()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.get_json(),
            {"error": "Cannot reach sima@192.168.2.2.", "code": "unreachable", "hint": "Check the cable."},
        )
        missing = BoardError("peripheral_missing", "SiMa Sentinel is not installed or not running.", hint="Install it.")
        self.use(missing)
        response = self.refresh()
        self.assertEqual((response.status_code, response.get_json()["code"]), (503, "peripheral_missing"))
        self.manager.error = BoardError("no_target", "No board is selected.")
        self.assertEqual(self.client.get("/api/peripherals").status_code, 409)

    def test_concurrent_refreshes_share_one_sentinel_refresh(self):
        started, release = threading.Event(), threading.Event()
        self.use()

        def slow_refresh(client):
            started.set()
            release.wait(5)
            return catalog(imx477(), c920())

        self.sentinel.side_effect = slow_refresh
        lock_requests = []
        second_waiting = threading.Event()
        refresh_lock = api.scans.refresh_lock

        def counting_refresh_lock(generation):
            lock_requests.append(generation)
            if len(lock_requests) == 2:
                second_waiting.set()
            return refresh_lock(generation)

        results = []
        with mock.patch.object(api.scans, "refresh_lock", counting_refresh_lock):
            first = threading.Thread(target=lambda: results.append(self.refresh().get_json()))
            first.start()
            started.wait(5)
            second = threading.Thread(target=lambda: results.append(self.refresh().get_json()))
            second.start()
            second_waiting.wait(5)
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(self.sentinel.call_count, 1)
        self.assertEqual(results[0], results[1])


    def test_a_shared_refresh_is_refused_when_the_board_changed_while_it_waited(self):
        started, release = threading.Event(), threading.Event()
        self.use()

        def slow_refresh(client):
            started.set()
            release.wait(5)
            return catalog(imx477(), c920())

        self.sentinel.side_effect = slow_refresh
        second_waiting = threading.Event()
        refresh_lock, completed_since = api.scans.refresh_lock, api.scans.completed_since

        def counting_refresh_lock(generation):
            if started.is_set():
                second_waiting.set()
            return refresh_lock(generation)

        def switch_board_once_shared(*args):
            shared = completed_since(*args)
            if shared:
                self.manager.current.stale = True  # /api/board/select lands after the first refresh returned
            return shared

        results = {}
        with mock.patch.object(api.scans, "refresh_lock", counting_refresh_lock), \
                mock.patch.object(api.scans, "completed_since", switch_board_once_shared):
            first = threading.Thread(target=lambda: results.setdefault("first", self.refresh()))
            first.start()
            started.wait(5)
            second = threading.Thread(target=lambda: results.setdefault("second", self.refresh()))
            second.start()
            second_waiting.wait(5)
            release.set()
            first.join(5)
            second.join(5)
        self.assertEqual(self.sentinel.call_count, 1)
        self.assertEqual(results["first"].status_code, 200)
        second = results["second"]
        self.assertEqual((second.status_code, second.get_json()["code"]), (409, "stale_snapshot"))
if __name__ == "__main__":
    unittest.main()
