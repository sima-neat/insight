import ast
import contextlib
import copy
import json
import math
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult, board_bp
from neat_insight.board.transport import CommandCancelled, MAX_OUTPUT_BYTES
from neat_insight.peripherals import api, board_check, cameras, microphones, mictest
from neat_insight.peripherals.api import peripherals_bp
from neat_insight.peripherals.client import PeripheralClient

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


# Catalogs with Sentinel's own per-mode verdict (sentinel#43): its example at 1f4f964 (Platform 2.1.3, fixed ISP
# sizes, `isp_output`), and a response captured from a Modalix DevKit on 3.0.0_develop_B1859 (IMX477 sensor sizes,
# `sensor_mode`; C920 camera and microphone), both byte for byte.
VERDICT_CATALOGS = {
    "sentinel#43 example": Path(__file__).parent / "fixtures" / "sentinel-catalog-example-43.json",
    "DevKit 3.0 capture": Path(__file__).parent / "fixtures" / "sentinel-catalog-devkit-3.0.json",
}


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


YETI = "microphone:alsa:3ff3d77bf791d455"
C920_MIC = "microphone:alsa:52b0c1e4a77f9d03"
MONO_MIC = "microphone:alsa:0c41d6f2e8b3a915"
ONBOARD_MIC = "microphone:alsa:7d2e9a40b6c1f358"
MIC_PROVIDER = "microphone.alsa"


def microphone(device_id, name, card_id, card_index, modes, usb=None, free=(1, 1), issues=None, **identity):
    """A Sentinel `microphone.alsa` record."""
    record = {"id": device_id, "type": "microphone",
        "name": name, "backend": "alsa", "connection": "usb" if usb else "platform",
        "capture_target": {"card_id": card_id, "device": 0, "selector": f"plughw:CARD={card_id},DEV=0"},
        "identity": {
            "stable_key": f"sysfs:devices/platform/{device_id}:pcm0c", "card_index": card_index, "card_id": card_id,
            "card_name": name, "card_driver": "USB-Audio" if usb else "simaai-codec",
            "pcm_node": f"/dev/snd/pcmC{card_index}D0c", **identity,
        },
        "modes": modes,
        "availability": {"state": "available" if free[1] else "in_use", "subdevices": free[0], "subdevices_available": free[1]}
        if free else {"state": "unknown"},
    }
    if usb:
        record["identity"]["usb"] = usb
    if issues:
        record["issues"] = issues
    return record


def yeti(**extra):
    """Blue Yeti Nano, stereo 24-bit (the specimen the approved UI was recorded with)."""
    return microphone(
        YETI, "Yeti Nano", "Nano", 2,
        [{"interface": 1, "altset": 1, "format": "S24_3LE", "channels": 2, "sample_bits": 24,
          "rates_hz": [32000, 44100, 48000], "channel_map": ["FL", "FR"]}],
        usb={"vendor_id": "b58e", "product_id": "0005", "bus_path": "1-3.2", "interface": "1-3.2:1.0",
             "manufacturer": "Blue Microphones", "product": "Yeti Nano", "serial": "2042SG000B18"},
        pcm_name="USB Audio", by_id="/dev/snd/by-id/usb-Blue_Microphones_Yeti_Nano_2042SG000B18-00",
        by_path="/dev/snd/by-path/platform-xhci-hcd.1.auto-usb-0:3.2:1.0", **extra,
    )


def c920_mic():
    """The C920 webcam's built-in stereo microphone: the same USB device as the c920() camera (synthetic)."""
    return microphone(
        C920_MIC, "HD Pro Webcam C920", "C920", 3,
        [{"interface": 3, "altset": 1, "format": "S16_LE", "channels": 2, "sample_bits": 16,
          "rates_hz": [16000, 24000, 32000]}],
        usb={"vendor_id": "046d", "product_id": "08e5", "bus_path": "1-3.1", "interface": "1-3.1:1.2",
             "product": "HD Pro Webcam C920", "serial": "BE998CAF"},
    )


def mono_mic():
    """A mono 16-bit USB microphone with a continuous rate range and no USB strings (synthetic)."""
    return microphone(
        MONO_MIC, "USB PnP Sound Device", "Device", 4,
        [{"interface": 1, "altset": 1, "format": "S16_LE", "channels": 1, "sample_bits": 16,
          "rate_range_hz": {"min": 8000, "max": 48000}}],
        usb={"vendor_id": "0d8c", "product_id": "0014", "bus_path": "1-3.3"},
    )


def onboard_mic():
    """An on-board codec: ALSA publishes no read-only formats or valid counts for it (synthetic)."""
    return microphone(ONBOARD_MIC, "simaai-codec", "sndcard", 0, [], free=None, issues=[
        {"code": "peripherals.capabilities_unavailable", "reason": "This ALSA driver does not publish read-only capture formats."},
        {"code": "peripherals.availability_unknown", "reason": "ALSA did not report valid capture subdevice availability."},
    ])


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


def collect(request, *, euid=0, tools=None, **patches):
    """board_check.collect as the given user, `which` answering from `tools`, with board_check functions replaced."""
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(board_check, "which", side_effect=(tools or {}).get))
        stack.enter_context(mock.patch.object(board_check.os, "geteuid", return_value=euid))
        for name, value in patches.items():
            stack.enter_context(mock.patch.object(board_check, name, value))
        return board_check.collect(request)


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

        result = collect({"cameras": {IMX477: ["/dev/media0"]}}, euid=1000, tools=tools, run=run,
                         _read=mock.Mock(return_value="gst-launch-1.0"))
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

            with self.subTest(fuser_result=fuser_result):
                result = collect({"cameras": {C920: ["/dev/video97"]}}, euid=1000, tools=tools, run=run)
            self.assertEqual(result["availability_method"], "sudo-fuser")
            self.assertEqual(result["users"], {C920: expected})

    def test_a_media_graph_that_cannot_be_read_leaves_an_idle_camera_unknown(self):
        """Without the graph, a process holding only /dev/videoN would be missed, so idle is not proof of available."""
        for media_ctl, run_media_ctl in ((None, None), ("/usr/bin/media-ctl", (1, "", "No such device"))):
            def run(argv, timeout=10):
                return run_media_ctl

            with self.subTest(media_ctl=media_ctl):
                result = collect({"cameras": {IMX477: ["/dev/media0"], C920: ["/dev/video97"]}},
                                 tools={"media-ctl": media_ctl}, run=run, scan_proc=mock.Mock(return_value={}))
            self.assertEqual(result["availability_method"], "proc-root")
            self.assertEqual(result["users"], {IMX477: None, C920: []})

    def test_an_unreadable_proc_leaves_availability_unknown_not_available(self):
        # Codex 4188915681: root without a listable /proc used to report every camera as available.
        with mock.patch.object(board_check.os, "listdir", side_effect=PermissionError("denied")):
            result = collect({"cameras": {C920: ["/dev/video97"]}})
        self.assertEqual(result["availability_method"], "proc-root")
        self.assertEqual(result["users"], {C920: None})

    def test_a_holder_of_the_media_device_is_reported_even_without_the_graph(self):
        result = collect({"cameras": {IMX477: ["/dev/media0"]}}, scan_proc=mock.Mock(return_value={"/dev/media0": {4242}}),
                         _read=mock.Mock(return_value="neat-app"))
        self.assertEqual(result["users"], {IMX477: [{"pid": 4242, "command": "neat-app"}]})

    def test_runs_as_a_program_and_prints_json(self):
        # A real, closed file nobody holds: with passwordless sudo and fuser (as on a CI runner) the check uses
        # fuser, which reports a missing path as an error and an open one as held (by this test).
        with tempfile.TemporaryDirectory() as folder:
            node = Path(folder, "video0")
            node.touch()
            request = json.dumps({"cameras": {"camera:x": [str(node)]}})
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

    def test_microphones_get_their_capture_node_checked(self):
        held = {"/dev/snd/pcmC2D0c": {4242}, "/dev/snd/controlC2": {77}}
        comm = {"4242": "arecord", "77": "pulseaudio", "78": "pipewire-pulse", "79": "bash"}
        result = collect({"cameras": {}, "microphones": {YETI: ["/dev/snd/pcmC2D0c"], C920_MIC: []}},
                         scan_proc=mock.Mock(return_value=held), _read=lambda path: comm.get(path.split("/")[-2]))
        self.assertEqual(result["users"], {YETI: [{"pid": 4242, "command": "arecord"}], C920_MIC: None})

    def test_a_capture_pcm_is_read_live_and_only_an_open_one_is_looked_up(self):
        with tempfile.TemporaryDirectory() as proc:
            for card, status in ((2, "closed"), (3, "state: RUNNING\nowner_pid   : 812")):
                sub = Path(proc, "asound", f"card{card}", "pcm0c", "sub0")
                sub.mkdir(parents=True)
                (sub / "status").write_text(status + "\n")
            looked_up = []

            def checker(method, tools):
                return lambda nodes: looked_up.append(sorted(nodes)) or [{"pid": 812, "command": "pulseaudio"}]

            result = collect({"microphones": {
                YETI: ["/dev/snd/pcmC2D0c"], C920_MIC: ["/dev/snd/pcmC3D0c"], MONO_MIC: ["/dev/snd/pcmC9D0c"]}},
                PROC_ROOT=proc, user_checker=checker)
        self.assertEqual(result["capture_open"], {YETI: 0, C920_MIC: 1, MONO_MIC: None})
        self.assertEqual(result["users"][YETI], [])
        self.assertEqual(result["users"][C920_MIC], [{"pid": 812, "command": "pulseaudio"}])
        self.assertEqual(looked_up, [["/dev/snd/pcmC3D0c"], ["/dev/snd/pcmC9D0c"]])


def states(fps):
    return [(choice["value"], choice["tier"], choice.get("reason")) for choice in fps]


def rates(camera, fmt, width, height):
    """The (rate, tier, reason) choices Insight offers for one mode of a scanned camera."""
    return states(size_of(fmt_of(camera, fmt), width, height)["fps"])


def scanned_camera(doc, board=None):
    """One camera record scanned on its own, with Sentinel's board block for the IMX477 overlay by default."""
    return item(snapshot_of(catalog(doc, board=board or board_block())), doc["id"])


class SnapshotTests(unittest.TestCase):
    def test_every_mode_keeps_sentinels_verdict_on_real_catalogs(self):
        """Each mode Insight lists has the state and reason Sentinel gave it; the only exception is the IMX477's
        sensor sizes wider than 4032, which libcamera streams at 4032 wide."""
        for label, path in VERDICT_CATALOGS.items():
            doc = json.loads(path.read_text(encoding="utf-8"))
            snapshot = snapshot_of(doc)
            for device in (d for d in doc["devices"] if d["type"] == "camera"):
                camera = item(snapshot, device["id"])
                for mode in device["modes"]:
                    with self.subTest(label, camera=device["id"], mode=(mode["format"], mode["width"], mode["height"])):
                        capped = (mode["available"] and device["model"] == "imx477" and mode.get("sensor_mode") is True
                                  and mode["width"] > cameras.SENSOR_MAX_WIDTH["imx477"])
                        tier = "available" if mode["available"] and not capped else "unsupported"
                        reason = (cameras.MAX_WIDTH_REASON.format(width=4032) if capped
                                  else None if mode["available"] else mode["reason"])
                        fps = size_of(fmt_of(camera, mode["format"]), mode["width"], mode["height"])["fps"]
                        self.assertTrue(fps)
                        self.assertEqual({(t, r) for _, t, r in states(fps)}, {(tier, reason)})

    def test_imx477_nv12_modes_are_available_at_the_isp_sizes_when_the_overlays_support_its_sensor(self):
        camera = scanned_camera(imx477())
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
        self.assertEqual(rates(camera, "RGB3", 1920, 1080), [(30, "unsupported", cameras.FORMAT_REASON)])
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
        mic_id = doc["devices"][2]["id"]
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920, mic_id])
        self.assertEqual(snapshot["issues"], [])
        # Sentinel's published example carries the board block, which links its IMX477 to the camera overlay.
        self.assertEqual(snapshot["camera_setup"], {"model": "SiMa.ai Modalix SoM 16Gig Board", "overlays": [IMX477_OVERLAY]})
        mic = item(snapshot, mic_id)
        self.assertEqual((mic["kind"], mic["connection"], mic["name"]), ("microphone", "usb", "HD Pro Webcam C920"))
        self.assertEqual(mic["device"]["part_of"], {"id": C920, "name": "HD Pro Webcam C920"})
        self.assertEqual(mic["device"]["alsa_name"], "hw:CARD=C920,DEV=0")
        self.assertEqual(mic["availability"], {"state": "available", "users": [], "reason": None})
        self.assertEqual([m["format"] for m in mic["capture"]], [m["format"] for m in doc["devices"][2]["modes"]])

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
        self.assertEqual(rates(usb, "MJPG", 1920, 1080),
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
        camera = scanned_camera(doc)
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual((camera["support"]["tier"], nv12["exportable"], nv12["support"]["tier"]),
                         ("available", True, "available"))
        self.assertEqual(states(size_of(nv12, 1920, 1080)["fps"]), [(30, "available", None)])
        for width, height in ((4056, 3040), (1332, 990)):
            self.assertEqual(states(size_of(nv12, width, height)["fps"]), [(30, "unsupported", cameras.NOT_ISP_SIZE_REASON)])
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})

        doc["modes"] = doc["modes"][1:]
        camera = scanned_camera(doc)
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": cameras.NO_ISP_SIZE_REASON})
        self.assertEqual((fmt_of(camera, "NV12")["exportable"], camera["default_selection"]), (False, None))

    def test_a_camera_whose_isp_sizes_are_not_nv12_is_unsupported_for_the_format(self):
        doc = imx477()
        doc["modes"] = [mipi_mode("RGB3", 1920, 1080), dict(mipi_mode("NV12", 4056, 3040), isp_output=False)]
        camera = scanned_camera(doc)
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
            sensor_mode("NV12", 4032, 3040, True),
            sensor_mode("NV12", 4056, 3040, True),
            sensor_mode("NV12", 4056, 2160, True),
            sensor_mode("RGB3", 2028, 1520, False, cameras.FORMAT_REASON),
        ]
        camera = scanned_camera(doc)
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual((camera["support"]["tier"], nv12["exportable"], nv12["support"]["tier"]),
                         ("available", True, "available"))
        self.assertEqual(states(size_of(nv12, 2028, 1520)["fps"]), [(30, "available", None)])
        # Sentinel marks the sensor's 4056-wide sizes available, but libcamera streams them at 4032 wide on
        # this board (3.0.0_develop_B1859), so Insight does not offer them; 4032 itself is fine.
        self.assertEqual(states(size_of(nv12, 4032, 3040)["fps"]), [(30, "available", None)])
        for width, height in ((4056, 3040), (4056, 2160)):
            self.assertEqual(states(size_of(nv12, width, height)["fps"]),
                             [(30, "unsupported", cameras.MAX_WIDTH_REASON.format(width=4032))], f"{width}x{height}")
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        # The 4032 limit is the IMX477's widest aligned mode, not a rule for every sensor: another sensor's wide
        # sizes keep Sentinel's verdict.
        other = scanned_camera(dict(doc, model="imx678"))
        self.assertEqual(rates(other, "NV12", 4056, 3040), [(30, "available", None)])
        self.assertEqual(rates(camera, "RGB3", 2028, 1520), [(30, "unsupported", cameras.FORMAT_REASON)])

        # Sentinel's "no" wins over Insight's own rule and keeps Sentinel's reason; with none of its modes available,
        # the camera's reason is the one Sentinel gave its NV12 modes, not one Insight infers.
        doc["modes"] = [dict(mipi_mode("NV12", 1920, 1080), available=False, reason="Not set up for this mode."),
                        sensor_mode("RGB3", 2028, 1520, False, cameras.FORMAT_REASON)]
        camera = scanned_camera(doc)
        self.assertEqual(rates(camera, "NV12", 1920, 1080), [(30, "unsupported", "Not set up for this mode.")])
        self.assertEqual(camera["support"], {"tier": "unsupported", "reason": "Not set up for this mode."})
        self.assertEqual(fmt_of(camera, "RGB3")["support"], {"tier": "unsupported", "reason": cameras.FORMAT_REASON})

    def test_the_default_mode_is_1920_wide_when_the_camera_offers_it(self):
        """The first Available size in sort order is the smallest (1280x990 on a 3.0 IMX477), not a useful start."""
        def doc_with(sizes):
            doc = imx477()
            doc["isp"]["sizing"] = "runtime"
            doc["modes"] = [{"format": "NV12", "width": w, "height": h, "sensor_mode": True, "available": True}
                            for w, h in sizes]
            return scanned_camera(doc)["default_selection"]
        imx477_30 = [(1280, 990), (1332, 990), (1920, 1080), (2028, 1080), (2028, 1520), (2048, 1080), (3840, 2160)]
        self.assertEqual(doc_with(imx477_30), {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        # No 1920-wide size: the widest Available size under 1920 wide.
        self.assertEqual(doc_with([(1280, 990), (1332, 990), (2028, 1520)]), {"format": "NV12", "width": 1332, "height": 990, "fps": 30})
        # Nothing under 1920 wide: the smallest Available size.
        self.assertEqual(doc_with([(3840, 2160), (2028, 1520)]), {"format": "NV12", "width": 2028, "height": 1520, "fps": 30})

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
                camera = scanned_camera(imx477(), block)
                self.assertEqual(camera["support"], {"tier": "unsupported", "reason": reason})
                self.assertEqual({(f["exportable"], f["support"]["reason"]) for f in camera["formats"]}, {(False, reason)})
                self.assertEqual(rates(camera, "NV12", 1920, 1080), [(30, "unsupported", reason)])
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
        camera = scanned_camera(c920())
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
        camera = scanned_camera(doc)
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
        camera = scanned_camera(doc)
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
        # Sentinel names the provider after the board field it could not read.
        error = {"provider": "board.overlays", "code": "peripherals.discovery_failed",
                 "reason": "fw_printenv failed (exit status: 1): Cannot read environment, using default"}
        snapshot = snapshot_of(catalog(imx477(), board=board_block(), errors=[error]))
        self.assertEqual(snapshot["issues"], [{
            "severity": "warning", "code": "peripherals.discovery_failed",
            "message": "SiMa Sentinel could not read part of the board's camera setup: fw_printenv failed (exit "
                       "status: 1): Cannot read environment, using default",
            "hint": cameras.STATUS_HINT,
        }])
        # Firmware older than Sentinel's MIPI support is not a read failure: Sentinel's own reason is shown.
        old = {"provider": "board.firmware", "code": "platform.unsupported",
               "reason": "Firmware 2.1.0 is older than 2.1.2; MIPI cameras are not listed."}
        snapshot = snapshot_of(catalog(c920(), board=board_block(), errors=[old]))
        self.assertEqual([i["message"] for i in snapshot["issues"]],
                         ["SiMa Sentinel: Firmware 2.1.0 is older than 2.1.2; MIPI cameras are not listed."])

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

    def test_only_cameras_and_microphones_are_listed(self):
        other = {"id": "future:1", "type": "future_sensor", "backend": "future"}
        self.assertEqual([i["id"] for i in snapshot_of(catalog(other, yeti(), imx477()))["items"]], [IMX477, YETI])


def mic_check(**extra):
    """board_check output with microphones requested: root, nobody holds anything."""
    return check(**{"users": {}, **extra})


def contract_microphone():
    return next(device for device in contract_catalog()["devices"] if device["type"] == "microphone")


class MicrophoneSnapshotTests(unittest.TestCase):
    def test_sentinels_contract_microphone_maps_to_the_approved_page_fields(self):
        record = contract_microphone()
        mic = item(snapshot_of(contract_catalog()), record["id"])
        self.assertEqual(mic, {
            "id": record["id"], "kind": "microphone", "connection": "usb", "name": "HD Pro Webcam C920",
            "device": {
                "card_index": 0, "card_id": "C920", "card_name": "HD Pro Webcam C920", "card_driver": "USB-Audio",
                "pcm_device": 0, "pcm_node": "/dev/snd/pcmC0D0c", "alsa_name": "hw:CARD=C920,DEV=0",
                "by_path": record["identity"]["by_path"], "by_id": record["identity"]["by_id"],
                "usb": record["identity"]["usb"], "part_of": {"id": C920, "name": "HD Pro Webcam C920"},
            },
            "availability": {"state": "available", "users": [], "reason": None},
            "capture": [{"format": "S16_LE", "channels": 2, "bits": 16, "rates": [rate], "rate_range": None,
                         "channel_map": ["FL", "FR"]} for rate in (16000, 24000, 32000)],
            "notes": [], "errors": [],
        })

    def test_yeti_nano_maps_to_the_approved_page_fields(self):
        mic = item(snapshot_of(catalog(yeti())), YETI)
        self.assertEqual(mic, {
            "id": YETI, "kind": "microphone", "connection": "usb", "name": "Yeti Nano",
            "device": {
                "card_index": 2, "card_id": "Nano", "card_name": "Yeti Nano", "card_driver": "USB-Audio",
                "pcm_device": 0, "pcm_node": "/dev/snd/pcmC2D0c", "alsa_name": "hw:CARD=Nano,DEV=0",
                "by_path": "/dev/snd/by-path/platform-xhci-hcd.1.auto-usb-0:3.2:1.0",
                "by_id": "/dev/snd/by-id/usb-Blue_Microphones_Yeti_Nano_2042SG000B18-00",
                "usb": yeti()["identity"]["usb"],
            },
            "availability": {"state": "available", "users": [], "reason": None},
            "capture": [{"format": "S24_3LE", "channels": 2, "bits": 24, "rates": [32000, 44100, 48000],
                         "rate_range": None, "channel_map": ["FL", "FR"]}],
            "notes": [], "errors": [],
        })

    def test_a_webcam_microphone_is_part_of_its_camera(self):
        snapshot = snapshot_of(catalog(c920(), c920_mic()))
        mic = item(snapshot, C920_MIC)
        self.assertEqual((mic["name"], mic["device"]["part_of"]), ("HD Pro Webcam C920", {"id": C920, "name": "HD Pro Webcam C920"}))
        self.assertEqual(mic["capture"][0]["rates"], [16000, 24000, 32000])
        # Sentinel's real camera topology is a sysfs path; ALSA names the USB device by its last part.
        camera = c920()
        camera["identity"]["topology"] = "devices/platform/xhci-hcd.1.auto/usb1/1-3/1-3.1"
        self.assertEqual(item(snapshot_of(catalog(camera, c920_mic())), C920_MIC)["device"]["part_of"]["id"], C920)
        self.assertNotIn("part_of", item(snapshot_of(catalog(c920_mic())), C920_MIC)["device"])

    def test_a_mono_microphone_keeps_its_continuous_rate_range_and_degrades_without_usb_strings(self):
        mic = item(snapshot_of(catalog(mono_mic())), MONO_MIC)
        self.assertEqual(mic["name"], "USB PnP Sound Device")
        self.assertEqual(mic["capture"], [{"format": "S16_LE", "channels": 1, "bits": 16, "rates": [],
                                           "rate_range": {"min": 8000, "max": 48000}, "channel_map": None}])
        self.assertNotIn("by_id", mic["device"])

    def test_an_onboard_device_without_formats_says_so_once(self):
        mic = item(snapshot_of(catalog(onboard_mic())), ONBOARD_MIC)
        self.assertEqual((mic["connection"], mic["capture"]), ("onboard", None))
        self.assertEqual(mic["notes"], [microphones.NO_CAPABILITIES_NOTE,
                                        "ALSA did not report valid capture subdevice availability."])
        self.assertEqual(mic["availability"], {"state": "unknown", "users": [], "reason": None})
        self.assertNotIn("usb", mic["device"])

    def test_availability_is_sentinels_own_and_the_scan_inspects_no_process(self):
        busy = yeti()
        busy["availability"] = {"state": "in_use", "subdevices": 1, "subdevices_available": 0}
        self.assertEqual(item(snapshot_of(catalog(busy)), YETI)["availability"], {"state": "in_use", "users": [], "reason": None})
        self.assertEqual(item(snapshot_of(catalog(yeti())), YETI)["availability"]["state"], "available")

    def test_a_failed_provider_is_noted(self):
        snapshot = snapshot_of(
            catalog(yeti(), errors=[{"provider": MIC_PROVIDER, "code": "peripherals.discovery_failed",
                                     "reason": "ALSA scan failed"}]),
        )
        notes = item(snapshot, YETI)["notes"]
        self.assertEqual(len(notes), 1)
        self.assertIn(f"its {MIC_PROVIDER} provider failed", notes[0])

    def test_sentinel_microphone_records_are_validated_before_they_are_mapped(self):
        def validate(doc):
            PeripheralClient(None)._validate_catalog(doc)

        validate(contract_catalog())
        validate(catalog(yeti(), c920_mic(), mono_mic(), onboard_mic(), microphone(
            "microphone:alsa:bare", "Codec", "Codec", 1, [{"format": "S16_LE"}])))
        malformed = {
            "modes": lambda mic: mic.update(modes=None),
            # Codex 4187561597: without a backend, provider_of() is "microphone.None" and evades provider errors.
            "missing backend": lambda mic: mic.pop("backend"),
            "empty backend": lambda mic: mic.update(backend=""),
            "non-string backend": lambda mic: mic.update(backend=7),
            "missing connection": lambda mic: mic.pop("connection"),
            "non-string connection": lambda mic: mic.update(connection=None),
            "stable key": lambda mic: mic["identity"].pop("stable_key"),
            "PCM device": lambda mic: mic["capture_target"].update(device=-1),
            "selector": lambda mic: mic["capture_target"].update(selector=7),
            "card index": lambda mic: mic["identity"].update(card_index="2"),
            "USB identity": lambda mic: mic["identity"].update(usb="1-3.2"),
            # Codex 4188864853: a non-string bus path reached a dict lookup and returned a 500.
            "USB bus path": lambda mic: mic["identity"].update(usb={"bus_path": []}),
            "USB serial": lambda mic: mic["identity"].update(usb={"bus_path": "1-3.2", "serial": 7}),
            "empty rates": lambda mic: mic["modes"][0].update(rates_hz=[]),
            "rates and range": lambda mic: mic["modes"][0].update(rate_range_hz={"min": 8000, "max": 48000}),
            "inverted range": lambda mic: mic.update(modes=[{"format": "S16_LE", "rate_range_hz": {"min": 9, "max": 8}}]),
            "channels": lambda mic: mic["modes"][0].update(channels=0),
            "channel map": lambda mic: mic["modes"][0].update(channel_map="FL FR"),
            "availability": lambda mic: mic["availability"].update(state="busy-ish"),
            "counts": lambda mic: mic["availability"].update(subdevices=True),
            # Codex 4255615190: a non-string reason reached the snapshot, which promises a string or null.
            "availability reason": lambda mic: mic["availability"].update(state="unknown", reason={"bad": True}),
            # Codex 4189179496: more free than total made the snapshot report the microphone in use.
            "more free than total": lambda mic: mic["availability"].update(subdevices=1, subdevices_available=2),
            "issues": lambda mic: mic.update(issues=[None]),
            # ALSA reports these as unsigned int; a larger value would reach the browser as Infinity.
            "channels beyond __u32": lambda mic: mic["modes"][0].update(channels=2**32),
            "rate beyond __u32": lambda mic: mic["modes"][0].update(rates_hz=[2**32]),
            "PCM device beyond __u32": lambda mic: mic["capture_target"].update(device=10**400),
        }
        unexplained = contract_microphone()
        unexplained["availability"].update(state="unknown", reason=None)
        validate(catalog(unexplained))
        # A backend or connection Sentinel may add later is not a malformed record.
        validate(catalog(dict(contract_microphone(), backend="pipewire", connection="bluetooth")))
        for name, mutate in malformed.items():
            doc = catalog(contract_microphone())
            mutate(doc["devices"][0])
            with self.subTest(name), self.assertRaises(BoardError) as ctx:
                validate(doc)
            self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_changes_include_microphones(self):
        first = snapshot_of(catalog(imx477(), yeti()))
        second = snapshot_of(catalog(imx477()), previous=first)
        self.assertEqual(second["changes"]["removed"], [{"id": YETI, "name": "Yeti Nano"}])


def sine(amplitude: float, frames: int = 4800, channels: int = 2) -> bytes:
    values = [int(amplitude * 32767 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(frames)]
    return struct.pack("<%dh" % (channels * frames), *[v for v in values for _ in range(channels)])


def record_until_stopped(recording, cancelled=None):
    """An arecord that sends one chunk, sets `recording`, then runs until Stop (setting `cancelled` if given)."""
    def record(argv, on_stdout, cancel_event):
        on_stdout(sine(0.5))
        recording.set()
        if cancel_event.wait(30) and cancelled:
            cancelled.set()
        raise CommandCancelled()
    return record


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


def patch(test, target, name, *value, **kwargs):
    """mock.patch.object for the whole of one test; returns the replacement."""
    patcher = mock.patch.object(target, name, *value, **kwargs)
    test.addCleanup(patcher.stop)
    return patcher.start()


def api_client(manager):
    app = Flask(__name__)
    app.register_blueprint(board_bp)
    app.register_blueprint(peripherals_bp)
    app.extensions["neat_board"] = manager
    return app.test_client()


class PeripheralsApiTests(unittest.TestCase):
    def setUp(self):
        patch(self, api, "scans", cameras.ScanCache())
        self.catalogs = []
        self.sentinel = patch(self, api.PeripheralClient, "refresh", autospec=True, side_effect=self._sentinel_refresh)
        self.manager = FakeManager()
        self.client = api_client(self.manager)

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
        return self.client.post("/api/peripherals/refresh")

    def test_scan_responses_are_not_cached(self):
        self.use()
        self.assertEqual(self.client.get("/api/peripherals").headers["Cache-Control"], "no-store")

    def test_get_before_refresh_is_empty_and_never_connects(self):
        transport = self.use()
        response = self.client.get("/api/peripherals")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual((body["scan_id"], body["scanned_at"], body["items"], body["changes"]), (None, None, [], None))
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
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920, contract_microphone()["id"]])
        self.assertEqual([(i["id"], i["support"]["tier"]) for i in snapshot["items"] if i["kind"] == "camera"],
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

    def refresh_twice(self, *patches):
        """Two refreshes, the second arriving while Sentinel still answers the first; returns both responses."""
        started, release, second_waiting = threading.Event(), threading.Event(), threading.Event()
        self.use()

        def slow_refresh(client):
            started.set()
            release.wait(5)
            return catalog(imx477(), c920())

        self.sentinel.side_effect = slow_refresh
        refresh_lock = api.scans.refresh_lock

        def watched_refresh_lock(generation):
            if started.is_set():
                second_waiting.set()
            return refresh_lock(generation)

        results = {}
        with contextlib.ExitStack() as stack:
            for patcher in (mock.patch.object(api.scans, "refresh_lock", watched_refresh_lock), *patches):
                stack.enter_context(patcher)
            first = threading.Thread(target=lambda: results.setdefault("first", self.refresh()))
            first.start()
            started.wait(5)
            second = threading.Thread(target=lambda: results.setdefault("second", self.refresh()))
            second.start()
            second_waiting.wait(5)
            release.set()
            first.join(5)
            second.join(5)
        return results["first"], results["second"]

    def test_concurrent_refreshes_share_one_sentinel_refresh(self):
        first, second = self.refresh_twice()
        self.assertEqual(self.sentinel.call_count, 1)
        self.assertEqual(first.get_json(), second.get_json())

    def test_a_shared_refresh_is_refused_when_the_board_changed_while_it_waited(self):
        completed_since = api.scans.completed_since

        def switch_board_once_shared(*args):
            shared = completed_since(*args)
            if shared:
                self.manager.current.stale = True  # /api/board/select lands after the first refresh returned
            return shared

        first, second = self.refresh_twice(mock.patch.object(api.scans, "completed_since", switch_board_once_shared))
        self.assertEqual(self.sentinel.call_count, 1)
        self.assertEqual(first.status_code, 200)
        self.assertEqual((second.status_code, second.get_json()["code"]), (409, "stale_snapshot"))


class MicrophoneApiTests(unittest.TestCase):
    def setUp(self):
        for target, name, value in ((api, "scans", cameras.ScanCache()), (mictest, "_current", None)):
            patch(self, target, name, value)
        self.sentinel = catalog(imx477(), yeti())
        self.reads = {method: patch(self, api.PeripheralClient, method, autospec=True,
                                    side_effect=lambda client: copy.deepcopy(self.sentinel))
                      for method in ("refresh", "catalog")}
        self.manager = FakeManager()
        self.transport = CheckTransport(mic_check(users={IMX477: []}))
        self.manager.current = FakeSession(1, self.transport)
        self.client = api_client(self.manager)

    def start(self, mic_id=YETI, **body):
        return self.client.post("/api/peripherals/microphones/test", json={"id": mic_id, **body})

    def mic_test(self):
        return self.client.get("/api/peripherals/microphones/test").get_json()["test"]

    def stop(self):
        return self.client.post("/api/peripherals/microphones/test/stop")

    def test_refresh_runs_no_board_check(self):
        """A scan only reads Sentinel: whether a microphone is held is checked when its test starts."""
        self.sentinel = catalog(yeti(), c920_mic(), onboard_mic())
        self.assertEqual(self.client.post("/api/peripherals/refresh").status_code, 200)
        self.assertEqual(self.transport.calls, [])

    def answer_checks(self, live, record=None):
        """Board check calls get `live`; arecord goes to `record`."""
        def exec_(argv, *, timeout, stdin=None, on_stdout=None, cancel_event=None):
            self.transport.calls.append((argv, timeout, stdin))
            if argv[0] == "python3":
                return ExecResult(0, json.dumps(live).encode(), b"")
            return record(argv, on_stdout, cancel_event)
        self.transport.exec = exec_

    def test_a_stale_in_use_catalog_does_not_block_a_test_the_live_check_finds_free(self):
        """On hot-plug PulseAudio holds a new microphone for a few seconds; Sentinel's catalog keeps saying
        in use after the release, because no event marks it. The live check decides."""
        self.client.post("/api/peripherals/refresh")
        busy = yeti()
        busy["availability"].update(state="in_use", subdevices_available=0)
        self.sentinel = catalog(imx477(), busy)
        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}),
                           lambda argv, on_stdout, cancel: ExecResult(0, sine(0.5), b""))
        response = self.start()
        self.assertEqual(response.status_code, 202)
        argv, _, _ = self.transport.calls[-2]
        self.assertEqual(json.loads(argv[2]), {"microphones": {YETI: ["/dev/snd/pcmC2D0c"]}})
        mictest._current.thread.join(2)
        self.assertEqual(self.transport.calls[-1][0][0], "arecord")

    def test_a_live_check_that_cannot_run_leaves_the_busy_answer_to_arecord(self):
        """The check is best effort: when it fails or times out, the test still starts, and the check ran on the
        raw transport, so its failure never marks the selected board as failing."""
        self.client.post("/api/peripherals/refresh")
        for failure in (ExecResult(1, b"", b"Traceback: boom"), BoardError("timeout", "The board did not answer.")):
            with self.subTest(failure=failure):
                mictest._current = None
                raw, reported = [], []

                class Raw:
                    def exec(self, argv, *, timeout, stdin=None, on_stdout=None, cancel_event=None):
                        raw.append(argv[0])
                        if argv[0] == "arecord":
                            return ExecResult(0, sine(0.5), b"")
                        if isinstance(failure, Exception):
                            raise failure
                        return failure

                class Reporting:
                    def exec(self, argv, **kwargs):
                        reported.append(argv[0])
                        raise AssertionError("a microphone test sent a command through the status-reporting transport")

                session = FakeSession(1, Raw())
                session.transport = Reporting()
                self.manager.current = session
                self.assertEqual(self.start().status_code, 202)
                mictest._current.thread.join(2)
                self.assertEqual((raw, reported), (["python3", "arecord"], []))

    def test_a_live_holder_refuses_the_test_and_is_named(self):
        self.client.post("/api/peripherals/refresh")
        started = []
        for live, message in (
            (mic_check(users={YETI: [{"pid": 812, "command": "pulseaudio"}]}, capture_open={YETI: 1}),
             "Open in pulseaudio (pid 812)."),
            (mic_check(availability_method="proc-user", users={YETI: []}, capture_open={YETI: 1}),
             "The kernel reports the capture device open in another process."),
        ):
            with self.subTest(message=message):
                self.answer_checks(live, lambda argv, on_stdout, cancel: started.append(argv))
                response = self.start()
                body = response.get_json()
                self.assertEqual((response.status_code, body["code"], body["error"]), (409, "microphone_in_use", message))
        self.assertEqual(started, [])

    def test_testing_before_a_scan_or_an_unscanned_id_is_refused_without_contacting_the_board(self):
        response = self.start()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.client.post("/api/peripherals/refresh")
        for mic_id, status, code in ((IMX477, 404, "not_found"), ("microphone:alsa:gone", 404, "not_found")):
            response = self.start(mic_id)
            self.assertEqual((response.status_code, response.get_json()["code"]), (status, code))
        for body in ({"seconds": 0}, {"seconds": 31}, {"seconds": True}, {"id": ""}):
            self.assertEqual(self.start(**body).status_code, 400)
        self.reads["catalog"].assert_not_called()
        self.assertEqual(self.transport.calls, [])

    def test_a_changed_microphone_never_starts_arecord(self):
        self.client.post("/api/peripherals/refresh")
        moved = yeti()
        moved["identity"]["card_index"] = 3
        self.sentinel = catalog(imx477(), moved, revision=2)
        with mock.patch.object(mictest, "start") as start:
            response = self.start()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.reads["catalog"].assert_called_once()
        start.assert_not_called()

    def test_a_refresh_between_the_cache_reads_cannot_pair_an_old_snapshot_with_a_new_catalog(self):
        """The snapshot and the catalog revision of one scan are read together (Codex finding on api.py:131)."""
        self.client.post("/api/peripherals/refresh")
        cache, refreshed = api.scans, catalog(imx477(), revision=2)  # Yeti gone, its id free to be reused

        class RefreshAfterFirstRead:
            """Records a newer scan right after the start's first cache read returns."""
            def __getattr__(self, name):
                def read(*args):
                    value = getattr(cache, name)(*args)
                    cache.record(1, BOARD, refreshed, 5)
                    return value
                return read

        reused = yeti()  # Sentinel now serves the newer catalog, the id naming a different card
        reused["capture_target"].update(card_id="Nano_1", selector="plughw:CARD=Nano_1,DEV=0")
        self.sentinel = catalog(imx477(), reused, revision=2)
        with mock.patch.object(api, "scans", RefreshAfterFirstRead()), \
                mock.patch.object(mictest, "start", return_value={}) as start:
            response = self.start()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "stale_snapshot")
        start.assert_not_called()

    def test_a_retried_start_while_insight_records_is_test_running_not_in_use(self):
        """Codex 4187561574: the live in-use check would find Insight's own arecord and orphan the test."""
        self.client.post("/api/peripherals/refresh")
        recording = threading.Event()
        record = record_until_stopped(recording)
        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}), record)
        first = self.start().get_json()["test"]
        self.assertTrue(recording.wait(2))
        # The board now shows the PCM open by Insight's own arecord.
        self.answer_checks(mic_check(users={YETI: [{"pid": 4242, "command": "arecord"}]}, capture_open={YETI: 1}), record)
        calls, reads = len(self.transport.calls), self.reads["catalog"].call_count
        response = self.start()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "test_running"))
        self.assertEqual((len(self.transport.calls), self.reads["catalog"].call_count), (calls, reads),
                         "refused before Sentinel or the board is asked")
        self.assertEqual(self.mic_test()["token"], first["token"])
        self.stop()
        mictest._current.thread.join(2)

    def test_start_records_with_sentinel_selector_then_poll_stop_and_audio_follow_the_reference_contract(self):
        self.client.post("/api/peripherals/refresh")
        recording = threading.Event()
        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}), record_until_stopped(recording))
        response = self.start()
        self.assertEqual(response.status_code, 202)
        test = response.get_json()["test"]
        self.assertEqual((test["id"], test["state"], test["device"]), (YETI, "recording", "plughw:CARD=Nano,DEV=0"))
        self.assertEqual(test["format"], {"rate": 48000, "channels": 2, "bits": 16, "seconds": 30})
        self.assertTrue(recording.wait(2))
        self.assertEqual(self.transport.calls[-1][0][:4], ["arecord", "-q", "-D", "plughw:CARD=Nano,DEV=0"])
        self.assertEqual(self.start().get_json()["code"], "test_running")
        live = self.mic_test()
        self.assertEqual((live["token"], live["elapsed_ms"]), (test["token"], 100))
        self.assertIsNotNone(live["level_dbfs"])
        self.assertEqual(self.stop().status_code, 200)
        mictest._current.thread.join(2)
        done = self.mic_test()
        self.assertEqual(done["state"], "ready")
        self.assertFalse(done["level"]["silent"])
        wav = self.client.get(done["audio_url"])
        self.assertEqual((wav.status_code, wav.mimetype, wav.data[:4]), (200, "audio/wav", b"RIFF"))
        self.assertEqual(self.client.get("/api/peripherals/microphones/test/other.wav").status_code, 404)

    def test_a_board_change_during_the_start_ends_the_test_and_is_refused(self):
        """Codex 4255505616: a test started while the board changed must not answer 202 for the departed board."""
        self.client.post("/api/peripherals/refresh")
        recording, cancelled = threading.Event(), threading.Event()
        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}), record_until_stopped(recording, cancelled))
        real_start, session, started = mictest.start, self.manager.current, []

        def start_then_switch(*args):
            status = real_start(*args)
            started.append(mictest._current)
            session.stale = True  # /api/board/select picked another board while the test started
            return status

        with mock.patch.object(mictest, "start", side_effect=start_then_switch):
            response = self.start()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertIsNone(mictest._current)
        self.assertTrue(cancelled.wait(2), "the departed board's arecord is stopped")
        started[0].thread.join(2)

    def test_a_departed_boards_recording_does_not_block_a_test_on_the_new_board(self):
        """Codex 4255561400: a test still recording on the previous board must not answer test_running here."""
        old = mictest._current = mictest.MicTest(1, YETI, "plughw:CARD=Nano,DEV=0", 48000, 2, 30)
        self.manager.current = FakeSession(2, self.transport)  # /api/board/select picked another board
        self.client.post("/api/peripherals/refresh")
        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}),
                           lambda argv, on_stdout, cancel: ExecResult(0, sine(0.5), b""))
        response = self.start()
        self.assertEqual(response.status_code, 202)
        self.assertTrue(old.stop_requested, "the departed board's recording is told to end")
        mictest._current.thread.join(2)
        self.assertEqual(self.mic_test()["state"], "ready")

    def test_another_board_sees_no_test_and_cannot_stop_it(self):
        self.assertIsNone(self.mic_test())
        self.assertIsNone(self.stop().get_json()["test"])
        mictest._current = mictest.MicTest(1, YETI, "plughw:CARD=Nano,DEV=0", 48000, 2, 30)
        self.manager.current = FakeSession(2, self.transport)
        self.assertIsNone(self.mic_test())
        self.assertIsNone(self.stop().get_json()["test"])
        self.assertFalse(mictest._current.stop_requested)


    def test_another_board_cannot_download_the_recording(self):
        test = mictest._current = mictest.MicTest(1, YETI, "plughw:CARD=Nano,DEV=0", 48000, 2, 30)
        test.finish(wav=b"RIFF....")
        url = f"/api/peripherals/microphones/test/{test.token}.wav"
        self.assertEqual(self.client.get(url).status_code, 200)
        # Safari's audio element reads the recording in byte ranges.
        partial = self.client.get(url, headers={"Range": "bytes=0-3"})
        self.assertEqual((partial.status_code, partial.data, partial.mimetype), (206, b"RIFF", "audio/wav"))
        self.manager.current = FakeSession(2, self.transport)  # /api/board/select picked another board
        response = self.client.get(url)
        self.assertEqual((response.status_code, response.get_json()["code"]), (404, "not_found"))



class MicrophoneTestTests(unittest.TestCase):
    def setUp(self):
        patch(self, mictest, "_current", None)

    def bind(self, doc, scanned=None, mic_id=YETI):
        return mictest.bind_microphone(doc, scanned or doc, mic_id)

    def assert_refused(self, code, doc, **kwargs):
        with self.assertRaises(BoardError) as ctx:
            self.bind(doc, **kwargs)
        self.assertEqual(ctx.exception.code, code)

    def test_binding_uses_only_sentinel_selector_from_the_scanned_catalog(self):
        example = contract_catalog()
        self.assertEqual(self.bind(example, example, contract_microphone()["id"]),
                         {"selector": "plughw:CARD=C920,DEV=0", "node": "/dev/snd/pcmC0D0c", "rate": 32000, "channels": 2})
        self.assertEqual(self.bind(catalog(yeti())),
                         {"selector": "plughw:CARD=Nano,DEV=0", "node": "/dev/snd/pcmC2D0c", "rate": 48000, "channels": 2})
        # A replug that moved the card, or a restarted Sentinel routing the id elsewhere: Refresh first.
        moved = yeti()
        moved["capture_target"].update(card_id="Nano_1", selector="plughw:CARD=Nano_1,DEV=0")
        self.assert_refused("stale_snapshot", catalog(moved), scanned=catalog(yeti()))
        # Any other change, such as a camera's rate while it previews, leaves this microphone's test alone.
        busy_camera = catalog(dict(imx477(), max_fps=125.54), yeti(), revision=2)
        self.assertEqual(self.bind(busy_camera, scanned=catalog(imx477(), yeti()))["selector"], "plughw:CARD=Nano,DEV=0")
        self.assert_refused("not_found", catalog(c920_mic()))
        for selector in ("plughw:CARD=x;rm -rf /,DEV=0", "hw:2,0", "plughw:2,0", "plughw:CARD=1,DEV=0",
                         "plughw:CARD=12,DEV=0", None):
            hostile = yeti()
            hostile["capture_target"]["selector"] = selector
            with self.subTest(selector=selector):
                self.assert_refused("peripheral_response", catalog(hostile))
        # A three-digit id is a name, not a card number.
        named = yeti()
        named["capture_target"]["selector"] = "plughw:CARD=123,DEV=0"
        self.assertEqual(self.bind(catalog(named))["selector"], "plughw:CARD=123,DEV=0")
        # Sentinel's availability is not what decides: the live check at test start does (refuse_if_held).
        busy = yeti()
        busy["availability"].update(state="in_use", subdevices_available=0)
        self.assertEqual(self.bind(catalog(busy))["selector"], "plughw:CARD=Nano,DEV=0")

    def test_binding_refuses_data_sentinel_did_not_freshly_read(self):
        failed = {"provider": MIC_PROVIDER, "code": "peripherals.discovery_failed", "reason": "x"}
        self.assert_refused("stale_snapshot", catalog(yeti(), errors=[failed]))
        camera_failed = dict(failed, provider="camera.mipi")
        self.assertEqual(self.bind(catalog(yeti(), errors=[camera_failed]))["selector"], "plughw:CARD=Nano,DEV=0")

    def test_format_is_bounded_to_48_khz_stereo_for_every_device(self):
        self.assertEqual(mictest.choose_format(c920_mic()), {"rate": 32000, "channels": 2})
        self.assertEqual(mictest.choose_format(mono_mic()), {"rate": 48000, "channels": 1})
        self.assertEqual(mictest.choose_format(onboard_mic()), {"rate": 48000, "channels": 1})
        # A device that offers mono and stereo records stereo, as the approved build did.
        both = {"modes": [{"format": "S16_LE", "channels": 1, "rates_hz": [48000]},
                          {"format": "S16_LE", "channels": 2, "rates_hz": [44100]}]}
        self.assertEqual(mictest.choose_format(both), {"rate": 48000, "channels": 2})
        studio = {"modes": [{"format": "S32_LE", "channels": 8, "sample_bits": 32, "rate_range_hz": {"min": 96000, "max": 384000}},
                            {"format": "S32_LE", "channels": 4, "sample_bits": 32, "rates_hz": [192000]}]}
        chosen = mictest.choose_format(studio)
        self.assertEqual(chosen, {"rate": 48000, "channels": 2})
        self.assertLess(chosen["rate"] * chosen["channels"] * 2 * mictest.MAX_SECONDS, MAX_OUTPUT_BYTES)

    def test_level_measurement_ignores_one_open_click(self):
        click = [0] * 96000
        click[10] = 30000
        self.assertTrue(mictest.measure(struct.pack("<96000h", *click), 2)["silent"])
        self.assertFalse(mictest.measure(sine(0.5), 2)["silent"])
        self.assertEqual(mictest.measure(b"", 2), {"peak_dbfs": None, "rms_dbfs": None, "silent": True})

    def run_test(self, exec_, seconds=30, session=None):
        transport = SimpleNamespace(exec=exec_)
        session = session or FakeSession(1, transport)
        session.raw_transport = session.transport = transport
        status = mictest.start(session, YETI, {"selector": "plughw:CARD=Nano,DEV=0", "rate": 48000, "channels": 2}, seconds)
        return status, mictest._current

    def test_a_full_recording_becomes_a_wav_and_board_failures_become_errors(self):
        pcm = sine(0.5)

        def full(argv, *, timeout, on_stdout, cancel_event):
            on_stdout(pcm[:999])
            on_stdout(pcm[999:])
            return ExecResult(0, pcm, b"")

        status, test = self.run_test(full, seconds=1)
        self.assertEqual(status["format"]["seconds"], 1)
        test.thread.join(2)
        self.assertEqual(test.status()["state"], "ready")
        self.assertEqual(mictest.audio(test.token, 1)[:4], b"RIFF")
        self.assertEqual(len(test.pcm), 0, "the raw capture is dropped once the WAV is made")
        for result, code in ((ExecResult(127, b"", b"arecord: not found"), "tool_missing"),
                             (ExecResult(1, b"", b"arecord: main:831: audio open error: Device or resource busy"), "microphone_in_use"),
                             (ExecResult(1, b"", b"arecord: bad"), "command_failed")):
            with self.subTest(code=code):
                _, test = self.run_test(lambda argv, **kwargs: result)
                test.thread.join(2)
                self.assertEqual((test.status()["state"], test.status()["error"]["code"]), ("failed", code))
                self.assertIsNone(mictest.audio(test.token, 1))

    def test_stop_interrupts_a_stalled_capture_and_an_early_stop_is_reported(self):
        for chunk, state in ((sine(0.5), "ready"), (b"\0" * 100, "failed")):
            started = threading.Event()

            def stalled(argv, *, timeout, on_stdout, cancel_event):
                on_stdout(chunk)
                started.set()
                # A stalled arecord prints nothing more: only the cancel event can end it.
                self.assertTrue(cancel_event.wait(timeout))
                raise CommandCancelled()

            with self.subTest(state=state):
                _, test = self.run_test(stalled)
                self.assertTrue(started.wait(2))
                mictest.stop(1)
                test.thread.join(2)
                self.assertFalse(test.thread.is_alive())
                status = test.status()
                self.assertEqual(status["state"], state)
                if state == "failed":
                    self.assertEqual(status["error"]["code"], "stopped_early")

    def test_stop_also_ends_a_recording_through_its_output_callback(self):
        pcm = sine(0.5)

        def chatty(argv, *, timeout, on_stdout, cancel_event):
            while True:
                on_stdout(pcm)  # raises once Stop was pressed
                time.sleep(0.01)

        _, test = self.run_test(chatty)
        time.sleep(0.05)
        mictest.stop(1)
        test.thread.join(2)
        self.assertEqual(test.status()["state"], "ready")

    def test_a_recording_from_a_board_that_is_no_longer_selected_is_discarded(self):
        session = FakeSession(1, None)

        def switched(argv, *, timeout, on_stdout, cancel_event):
            session.stale = True
            return ExecResult(0, sine(0.5), b"")

        _, test = self.run_test(switched, session=session)
        test.thread.join(2)
        self.assertEqual((test.status()["state"], test.status()["error"]["code"]), ("failed", "stale_snapshot"))
if __name__ == "__main__":
    unittest.main()
