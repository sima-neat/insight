import ast
import copy
import json
import os
import math
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult, board_bp
from neat_insight.board.transport import CommandCancelled, MAX_OUTPUT_BYTES
from neat_insight.peripherals import api, board_check, cameras, export, microphones, mictest
from neat_insight.peripherals.api import peripherals_bp
from neat_insight.peripherals.client import PeripheralClient

IMX477 = "camera:imx477 5-001a"
C920 = "camera:v4l2:421bbe426738013b"
BACKEND_REASON = "CameraInput currently accepts MIPI cameras only; direct V4L2 capture is not supported."
FORMAT_REASON = "CameraInput's current camera-memory path supports NV12 output only."
NOT_INSTALLED = "Neat Core is not installed, so CameraInput support for this mode is unknown."
TRACKED = " USB support is tracked in core#838."
ISP_NOTE = (
    "Only sizes the ISP can output (1920x1080, 2048x1080, 2432x2048) are offered; libcamera also advertises "
    "sizes the ISP cannot produce, which fail to start (core#883)."
)
NO_RATES_NOTE = "The camera reports no frame rates, so only CameraInput's default 30 fps is offered for those modes."
NO_BUFFER_COUNT = "Insight does not read libcamerasrc's properties on the board, so the code omits capture_buffer_count."
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


def catalog(*devices, **extra):
    return {"revision": 1791164913635, "observed_at": OBSERVED_AT, "devices": list(devices), "errors": [], **extra}


def _fastest(mode):
    """The fastest rate a mode advertises, as Core derives it; None when it advertises none."""
    rates = []
    for entry in mode.get("frame_intervals") or []:
        for interval in entry["intervals"]:
            period = interval if interval["type"] == "discrete" else interval["minimum"]
            rates.append(Fraction(period["denominator"], period["numerator"]))
    return max(rates, default=None)


def core_of(*catalogs):
    """Synthetic PyNeat verdicts, as board_check reports them (Core's classifier is not merged yet): CameraInput
    accepts NV12 on MIPI cameras and rejects USB cameras and other formats."""
    cameras = {}
    for doc in catalogs:
        for device in cameras_in(doc):
            for mode in device["modes"]:
                if device["backend"] != "mipi":
                    supported, reason = False, BACKEND_REASON
                else:
                    supported, reason = mode["format"] == "NV12", "" if mode["format"] == "NV12" else FORMAT_REASON
                rate = _fastest(mode)
                cameras.setdefault(device["id"], []).append({
                    "format": mode["format"], "width": mode.get("width", 0), "height": mode.get("height", 0),
                    "size_range": mode.get("size_range"),
                    "framerate_num": rate.numerator if rate else 0, "framerate_den": rate.denominator if rate else 1,
                    "supported": supported, "reason": reason,
                })
    return {"state": "ok", "cameras": cameras}


def cameras_in(doc):
    return [device for device in doc["devices"] if device["type"] == "camera"]


def check(**extra):
    """board_check output for a board where Insight runs as root, nothing holds a camera and PyNeat classifies
    the standard fixtures."""
    return {
        "tools": {"media-ctl": True, "fuser": True},
        "availability_method": "proc-root",
        "users": {IMX477: [], C920: []},
        "failures": [],
        "support": core_of(catalog(imx477(), c920())),
        **extra,
    }


BOARD = {"label": "sima@192.168.2.2", "source": "manual", "hostname": "modalix", "fingerprint": "fp-1"}


def snapshot_of(doc, board_facts=None, previous=None):
    facts = check(support=core_of(doc)) if board_facts is None else board_facts
    return cameras.build_snapshot(doc, facts, BOARD, 1, previous, 5)


def item(snapshot, item_id):
    return next(i for i in snapshot["items"] if i["id"] == item_id)


def fmt_of(camera, name):
    return next(f for f in camera["formats"] if f["format"] == name)


def size_of(fmt, width, height):
    return next(s for s in fmt["sizes"] if (s["width"], s["height"]) == (width, height))


def parse_yaml_block(text: str) -> dict:
    lines = [line for line in text.splitlines() if line and not line.startswith("#")]
    assert lines[0] == "camera:", lines[0]
    values = {}
    for line in lines[1:]:
        assert line.startswith("  ") and ": " in line, line
        key, raw = line[2:].split(": ", 1)
        values[key] = json.loads(raw)
    return values


class BoardCheckTests(unittest.TestCase):
    def test_source_parses_as_python_38(self):
        ast.parse(Path(board_check.__file__).read_text(encoding="utf-8"), feature_version=(3, 8))

    def test_mipi_availability_checks_media_and_every_isp_output(self):
        camera = imx477()
        camera["isp"] = {
            "state": "available",
            "device_path": "/dev/video0out",
            "device_paths": ["/dev/video0out", "/dev/video1out"],
        }
        self.assertEqual(
            cameras.camera_nodes(camera),
            ["/dev/media0", "/dev/video0out", "/dev/video1out"],
        )

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
            availability = item(snapshot_of(catalog(imx477(), c920()), result), IMX477)["availability"]
            self.assertEqual(availability["state"], "unknown")

    def test_an_unreadable_proc_leaves_availability_unknown_not_available(self):
        # Codex 4188915681: root without a listable /proc used to report every camera as available.
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check.os, "listdir", side_effect=PermissionError("denied")):
            result = board_check.collect({"cameras": {C920: ["/dev/video97"]}})
        self.assertEqual(result["availability_method"], "proc-root")
        self.assertEqual(result["users"], {C920: None})
        availability = item(snapshot_of(catalog(imx477(), c920()), result), C920)["availability"]
        self.assertEqual(availability["state"], "unknown")

    def test_a_holder_of_the_media_device_is_reported_even_without_the_graph(self):
        held = {"/dev/media0": {4242}}
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check, "scan_proc", return_value=held), \
             mock.patch.object(board_check, "_read", return_value="neat-app"):
            result = board_check.collect({"cameras": {IMX477: ["/dev/media0"]}})
        self.assertEqual(result["users"], {IMX477: [{"pid": 4242, "command": "neat-app"}]})

    def test_runs_as_a_program_and_prints_json(self):
        request = json.dumps({"cameras": {"camera:x": ["/dev/no-such-node"]}, "support": True})
        env = dict(os.environ, PYNEAT_VENV_DIR="/nonexistent")
        env.pop("PYTHONPATH", None)
        done = subprocess.run(
            [sys.executable, "-I", "-", request], input=Path(board_check.__file__).read_bytes(),
            capture_output=True, timeout=60, env=env,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual(result["users"], {"camera:x": []})
        self.assertIn(result["availability_method"], ("proc-root", "sudo-fuser", "proc-user"))
        # This python has no PyNeat, so Neat Core's verdicts are unknown rather than a failed check.
        self.assertEqual(result["support"]["state"], "not_installed")

    def test_neat_core_is_asked_only_when_the_request_wants_support(self):
        with mock.patch.object(board_check, "core_support", return_value={"state": "ok", "cameras": {}}) as core, \
                mock.patch.object(board_check, "which", return_value=None):
            self.assertIsNone(board_check.collect({"cameras": {C920: ["/dev/no-such-node"]}})["support"])
            core.assert_not_called()
            self.assertEqual(board_check.collect({"cameras": {C920: ["/dev/no-such-node"]}, "support": True})["support"],
                             {"state": "ok", "cameras": {}})

    def core_probe(self, pyneat_source):
        """Run the Core probe against a stand-in pyneat package (synthetic; PyNeat's peripherals API is not merged)."""
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "pyneat.py").write_text(pyneat_source, encoding="utf-8")
            with mock.patch.object(board_check, "PYNEAT_PYTHON", "/nonexistent/bin/python"), \
                    mock.patch.dict(board_check.COMMAND_ENV, PYTHONPATH=tmp):
                return board_check.core_support()

    def test_core_probe_reports_pyneat_verdicts_per_camera_mode(self):
        result = self.core_probe(
            "from types import SimpleNamespace as N\n"
            "def _list():\n"
            "    discrete = N(format='NV12', width=1920, height=1080, size_range=None, framerate_num=0, framerate_den=1,"
            " supported=True, reason='')\n"
            "    ranged = N(format='YUYV', width=0, height=0, size_range=N(min_width=160, min_height=120, max_width=1920,"
            " max_height=1080, step_width=16, step_height=8), framerate_num=30, framerate_den=1, supported=False,"
            " reason='USB')\n"
            "    return [N(id='camera:imx477 5-001a', camera=N(modes=[discrete, ranged])),"
            " N(id='microphone:alsa:1', camera=None)]\n"
            "peripherals = N(list=_list)\n"
        )
        self.assertEqual(result, {"state": "ok", "cameras": {IMX477: [
            {"format": "NV12", "width": 1920, "height": 1080, "size_range": None, "framerate_num": 0,
             "framerate_den": 1, "supported": True, "reason": ""},
            {"format": "YUYV", "width": 0, "height": 0,
             "size_range": {"min_width": 160, "min_height": 120, "max_width": 1920, "max_height": 1080},
             "framerate_num": 30, "framerate_den": 1, "supported": False, "reason": "USB"},
        ]}})

    def test_core_probe_names_why_verdicts_are_unknown(self):
        cases = {
            "outdated": "__version__ = '0.4.0'\n",
            "failed": "class peripherals:\n    @staticmethod\n    def list():\n"
                      "        raise RuntimeError('SiMa Sentinel is not running')\n",
        }
        for state, source in cases.items():
            with self.subTest(state):
                self.assertEqual(self.core_probe(source)["state"], state)
        self.assertIn("SiMa Sentinel is not running", self.core_probe(cases["failed"])["reason"])
        with mock.patch.object(board_check, "run", return_value=(None, "", "")):
            self.assertEqual(board_check.core_support(), {"state": "failed", "reason": "timed out after 20 s"})
        with mock.patch.object(board_check, "run", return_value=(1, "", "Segmentation fault")):
            self.assertEqual(board_check.core_support(), {"state": "failed", "reason": "Segmentation fault"})


    def test_microphones_get_their_capture_node_checked_and_sound_servers_listed(self):
        held = {"/dev/snd/pcmC2D0c": {4242}, "/dev/snd/controlC2": {77}}
        comm = {"4242": "arecord", "77": "pulseaudio", "78": "pipewire-pulse", "79": "bash"}
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check, "scan_proc", return_value=held), \
             mock.patch.object(board_check.os.path, "isdir", return_value=True), \
             mock.patch.object(board_check.os, "listdir", return_value=["self", *comm]), \
             mock.patch.object(board_check, "_read", side_effect=lambda path: comm.get(path.split("/")[-2])):
            result = board_check.collect({"cameras": {}, "microphones": {YETI: ["/dev/snd/pcmC2D0c"], C920_MIC: []}})
        self.assertEqual(result["users"], {YETI: [{"pid": 4242, "command": "arecord"}], C920_MIC: None})
        self.assertEqual(result["sound_servers"], ["pipewire-pulse", "pulseaudio"])
        with mock.patch.object(board_check, "which", return_value=None):
            self.assertNotIn("sound_servers", board_check.collect({"cameras": {}}))

    def test_an_unlistable_proc_does_not_fail_the_cameras_checked_with_a_microphone(self):
        # Codex 4189093714: listing sound servers raised and discarded every check in the run.
        with mock.patch.object(board_check, "which", return_value=None), \
             mock.patch.object(board_check.os, "geteuid", return_value=0), \
             mock.patch.object(board_check, "scan_proc", return_value={"/dev/video97": {4242}}), \
             mock.patch.object(board_check, "_read", return_value="neat-app"), \
             mock.patch.object(board_check.os.path, "isdir", return_value=True), \
             mock.patch.object(board_check.os, "listdir", side_effect=PermissionError("denied")):
            result = board_check.collect({"cameras": {C920: ["/dev/video97"]}, "microphones": {YETI: []}})
        self.assertEqual(result["users"][C920], [{"pid": 4242, "command": "neat-app"}])
        self.assertEqual(result["sound_servers"], [])


    def test_a_capture_pcm_is_read_live_and_only_an_open_one_is_looked_up(self):
        with tempfile.TemporaryDirectory() as proc:
            for card, status in ((2, "closed"), (3, "state: RUNNING\nowner_pid   : 812")):
                sub = Path(proc, "asound", f"card{card}", "pcm0c", "sub0")
                sub.mkdir(parents=True)
                (sub / "status").write_text(status + "\n")
            looked_up = []

            def checker(method, tools):
                return lambda nodes: looked_up.append(sorted(nodes)) or [{"pid": 812, "command": "pulseaudio"}]

            with mock.patch.object(board_check, "PROC_ROOT", proc), \
                 mock.patch.object(board_check, "which", return_value=None), \
                 mock.patch.object(board_check.os, "geteuid", return_value=0), \
                 mock.patch.object(board_check, "user_checker", checker):
                result = board_check.collect({"microphones": {
                    YETI: ["/dev/snd/pcmC2D0c"], C920_MIC: ["/dev/snd/pcmC3D0c"], MONO_MIC: ["/dev/snd/pcmC9D0c"]}})
        self.assertEqual(result["capture_open"], {YETI: 0, C920_MIC: 1, MONO_MIC: None})
        self.assertEqual(result["users"][YETI], [])
        self.assertEqual(result["users"][C920_MIC], [{"pid": 812, "command": "pulseaudio"}])
        self.assertEqual(looked_up, [["/dev/snd/pcmC3D0c"], ["/dev/snd/pcmC9D0c"]])


class SnapshotTests(unittest.TestCase):
    def test_imx477_tiers_formats_and_default_come_from_neat_core(self):
        camera = item(snapshot_of(catalog(imx477())), IMX477)
        self.assertEqual((camera["connection"], camera["name"], camera["model"]), ("mipi", "imx477 5-001a", "imx477"))
        self.assertEqual(camera["support"]["tier"], "verified")
        self.assertEqual(camera["support"]["links"], [cameras.CORE_883])
        self.assertEqual(camera["device"], {
            "camera_name": "imx477 5-001a", "camera_name_source": "media-graph",
            "media_device": "/dev/media0", "bus_info": "platform:csi2video@1",
        })
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual((nv12["label"], nv12["exportable"], nv12["support"]["tier"]), ("NV12 (YUV 4:2:0)", True, "verified"))
        self.assertEqual([(s["width"], s["height"]) for s in nv12["sizes"]], [(1920, 1080), (2048, 1080), (2432, 2048)])
        self.assertEqual(size_of(nv12, 1920, 1080)["fps"], [{"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": "verified"}])
        rgb = fmt_of(camera, "RGB3")
        self.assertEqual((rgb["exportable"], rgb["support"]["tier"], rgb["support"]["reason"]), (False, "unsupported", FORMAT_REASON))
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(camera["availability"], {"state": "available", "users": [], "reason": None})
        self.assertEqual(camera["modes_source"], "live")
        self.assertEqual(camera["notes"], [NO_RATES_NOTE, ISP_NOTE])

    def test_sentinels_contract_example_lists_both_cameras_with_neat_core_verdicts(self):
        doc = contract_catalog()
        snapshot = snapshot_of(doc)
        self.assertEqual(snapshot["scan_id"], f"{doc['revision']}:{doc['observed_at']}")
        mic_id = doc["devices"][2]["id"]
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920, mic_id])
        self.assertEqual(snapshot["issues"], [])
        mic = item(snapshot, mic_id)
        self.assertEqual((mic["kind"], mic["connection"], mic["name"]), ("microphone", "usb", "HD Pro Webcam C920"))
        self.assertEqual(mic["device"]["part_of"], {"id": C920, "name": "HD Pro Webcam C920"})
        self.assertEqual(mic["device"]["alsa_name"], "hw:CARD=C920,DEV=0")
        self.assertEqual(mic["availability"], {"state": "available", "users": [], "reason": None})
        self.assertEqual([m["format"] for m in mic["capture"]], [m["format"] for m in doc["devices"][2]["modes"]])

        mipi = item(snapshot, IMX477)
        self.assertEqual((mipi["connection"], mipi["support"]["tier"]), ("mipi", "verified"))
        self.assertEqual(mipi["device"]["csi"], "csidev-40c3000.csi")
        self.assertEqual([(f["format"], f["exportable"], f["support"]["tier"]) for f in mipi["formats"]],
                         [("AR24", False, "unsupported"), ("NV12", True, "verified"), ("RGB3", False, "unsupported")])
        nv12 = fmt_of(mipi, "NV12")
        self.assertEqual([(s["width"], s["height"]) for s in nv12["sizes"]], [(1920, 1080), (2048, 1080), (2432, 2048)])
        for size in nv12["sizes"]:
            self.assertEqual(size["fps"], [{"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": "verified"}])
        self.assertEqual(mipi["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(mipi["notes"], [
            "The sensor reports 66.18 fps for its fastest mode. The delivered frame rate follows the sensor mode "
            "libcamera picks and can differ from the requested rate.",
            ISP_NOTE,
        ])

        usb = item(snapshot, C920)
        self.assertEqual((usb["connection"], usb["name"], usb["support"]["tier"]), ("usb", "HD Pro Webcam C920", "unsupported"))
        self.assertEqual(usb["device"]["usb"]["bus_path"], doc["devices"][1]["identity"]["topology"])
        self.assertEqual([(f["format"], len(f["sizes"])) for f in usb["formats"]], [("MJPG", 1), ("YUYV", 1)])
        self.assertEqual([c["value"] for c in size_of(fmt_of(usb, "MJPG"), 1920, 1080)["fps"]], [30, 24, 20, 15, 10, 7.5, 5])
        self.assertEqual([c["value"] for c in size_of(fmt_of(usb, "YUYV"), 2560, 1472)["fps"]], [2])
        self.assertEqual(usb["default_selection"], {"format": "MJPG", "width": 1920, "height": 1080, "fps": 30})

    def test_without_a_neat_core_verdict_support_is_unknown_and_the_page_says_why(self):
        unknown = {
            "not_installed": NOT_INSTALLED,
            "outdated": cameras.SUPPORT_UNKNOWN["outdated"][2],
            "failed": cameras.SUPPORT_UNKNOWN["failed"][2],
        }
        for state, reason in unknown.items():
            with self.subTest(state):
                snapshot = snapshot_of(catalog(imx477()), check(support={"state": state, "reason": "Sentinel is down."}))
                camera = item(snapshot, IMX477)
                self.assertEqual(camera["support"], {"tier": "", "reason": reason, "links": []})
                # Unknown is not "not usable": every format stays selectable, but nothing is verified to export.
                self.assertTrue(all(f["exportable"] and f["support"]["tier"] == "" for f in camera["formats"]))
                self.assertEqual(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"], [
                    {"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": "", "reason": reason},
                ])
                self.assertIsNone(camera["default_selection"])
                issue = next(i for i in snapshot["issues"] if i["code"] == "support_unknown")
                # Only a failure carries a detail worth showing; the other states say all there is.
                detail = " Sentinel is down." if state == "failed" else ""
                self.assertEqual((issue["severity"], issue["message"]), ("warning", cameras.SUPPORT_UNKNOWN[state][0] + detail))
        missed = snapshot_of(catalog(imx477()), check(support={"state": "ok", "cameras": {}}))
        self.assertEqual(item(missed, IMX477)["support"]["reason"], cameras.UNCLASSIFIED_REASON)
        self.assertNotIn("support_unknown", [i["code"] for i in missed["issues"]])

    def test_usb_camera_is_unsupported_with_core_reason_and_every_advertised_rate(self):
        camera = item(snapshot_of(catalog(c920())), C920)
        self.assertEqual((camera["connection"], camera["name"]), ("usb", "HD Pro Webcam C920"))
        self.assertEqual(
            camera["support"], {"tier": "unsupported", "reason": BACKEND_REASON + TRACKED, "links": [cameras.CORE_838]}
        )
        self.assertEqual(camera["device"], {
            "video_node": "/dev/video97",
            "by_id": C920_BY_ID,
            "usb": {"vendor_id": "046d", "product_id": "08e5", "serial": "BE998CAF",
                    "product": "HD Pro Webcam C920", "bus_path": "1-3.1", "speed_mbps": 480},
        })
        mjpg = fmt_of(camera, "MJPG")
        self.assertEqual((mjpg["label"], mjpg["exportable"]), ("MJPG (Motion-JPEG)", True))
        self.assertEqual(mjpg["support"]["links"], [cameras.CORE_838, cameras.CORE_903])
        self.assertIn("core#903", mjpg["support"]["reason"])
        yuyv = fmt_of(camera, "YUYV")
        self.assertEqual(yuyv["label"], "YUYV (YUYV 4:2:2)")
        self.assertEqual(yuyv["support"]["links"], [cameras.CORE_838, cameras.INTERNALS_244])
        fps = size_of(mjpg, 640, 480)["fps"]
        self.assertEqual([c["value"] for c in fps], [30, 24, 20, 15, 10, 7.5, 5])
        self.assertEqual({(c["tier"], c["reason"]) for c in fps}, {("unsupported", BACKEND_REASON)})
        self.assertEqual(camera["default_selection"], {"format": "MJPG", "width": 1280, "height": 720, "fps": 30})
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
        """A USB mode exports as a V4L2 descriptor, so a mode without frame intervals offers no rate."""
        usb = c920()
        usb["modes"] = [{"format": "MJPG", "width": 640, "height": 480}]
        mjpg = fmt_of(item(snapshot_of(catalog(usb)), C920), "MJPG")
        self.assertEqual(size_of(mjpg, 640, 480)["fps"], [])
        unknown = item(snapshot_of(catalog(usb), check(support={"state": "not_installed", "reason": "x"})), C920)
        self.assertEqual(size_of(fmt_of(unknown, "MJPG"), 640, 480)["fps"], [])
        mipi = item(snapshot_of(catalog(imx477())), IMX477)
        self.assertEqual([c["value"] for c in size_of(fmt_of(mipi, "NV12"), 1920, 1080)["fps"]], [30])

    def test_isp_rates_offer_the_rate_core_classified_as_verified_and_the_rest_as_unknown(self):
        doc = imx477()
        doc["modes"] = [dict(mipi_mode("NV12", 1920, 1080), frame_intervals=[{"width": 1920, "height": 1080, "intervals": [
            {"type": "discrete", "numerator": 1, "denominator": 60}, {"type": "discrete", "numerator": 1, "denominator": 30},
        ]}])]
        camera = item(snapshot_of(catalog(doc)), IMX477)
        self.assertEqual(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"], [
            {"value": 60, "framerate_num": 60, "framerate_den": 1, "tier": "verified"},
            {"value": 30, "framerate_num": 30, "framerate_den": 1, "tier": ""},
        ])
        self.assertEqual(camera["notes"], [
            "Only sizes the ISP can output (1920x1080) are offered; libcamera also advertises sizes the ISP "
            "cannot produce, which fail to start (core#883).",
        ])

    def test_unreadable_isp_leaves_no_modes_and_says_why(self):
        doc = imx477()
        doc.update(modes=[], isp={"state": "unavailable", "reason": "no ISP output node was found"})
        camera = item(snapshot_of(catalog(doc)), IMX477)
        self.assertEqual((camera["modes_source"], camera["formats"], camera["default_selection"]), ("unavailable", [], None))
        self.assertIn("no ISP output node was found", camera["errors"][0]["message"])
        self.assertEqual(camera["support"]["tier"], "unsupported")

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

    def test_availability_names_holders_and_degrades_to_unknown(self):
        holder = [{"pid": 4242, "command": "gst-launch-1.0"}]
        busy = item(snapshot_of(catalog(imx477()), check(users={IMX477: holder})), IMX477)["availability"]
        self.assertEqual(busy, {"state": "in_use", "users": holder, "reason": "Open in gst-launch-1.0 (pid 4242)."})

        snapshot = snapshot_of(catalog(imx477()), check(availability_method="proc-user"))
        self.assertEqual(item(snapshot, IMX477)["availability"]["reason"], cameras.UNKNOWN_USERS_REASON)
        self.assertIn(("info", "availability_limited"), [(i["severity"], i["code"]) for i in snapshot["issues"]])

        unchecked = cameras.build_snapshot(catalog(imx477()), None, BOARD, 1, None, 5)
        self.assertEqual(item(unchecked, IMX477)["availability"],
                         {"state": "unknown", "users": [], "reason": "Discovery never opens a stream."})
        self.assertIn("availability_limited", [i["code"] for i in unchecked["issues"]])
        self.assertNotIn("libcamerasrc", unchecked["platform"])

    def test_missing_board_tools_are_reported(self):
        facts = check(tools={"media-ctl": False, "fuser": True})
        codes = [(i["severity"], i["code"]) for i in snapshot_of(catalog(imx477()), facts)["issues"]]
        self.assertEqual(codes, [("warning", "tool_missing")])
        # Tool issues are about MIPI cameras; a USB-only board does not need them.
        self.assertEqual(snapshot_of(catalog(c920()), facts)["issues"], [])

    def test_changes_are_reported_against_the_previous_refresh(self):
        first = snapshot_of(catalog(imx477(), c920()))
        second = snapshot_of(catalog(imx477()), previous=first)
        self.assertEqual(second["changes"], {"added": [], "removed": [{"id": C920, "name": "HD Pro Webcam C920"}]})
        self.assertIsNone(first["changes"])

    def test_only_cameras_and_microphones_are_listed(self):
        other = {"id": "future:1", "type": "future_sensor", "backend": "future"}
        self.assertEqual([i["id"] for i in snapshot_of(catalog(other, yeti(), imx477()))["items"]], [IMX477, YETI])


def mic_check(**extra):
    """board_check output with microphones requested: root, nobody holds anything, no sound server."""
    return check(**{"users": {}, "sound_servers": [], **extra})


def contract_microphone():
    return next(device for device in contract_catalog()["devices"] if device["type"] == "microphone")


class MicrophoneSnapshotTests(unittest.TestCase):
    def test_sentinels_contract_microphone_maps_to_the_approved_page_fields(self):
        record = contract_microphone()
        mic = item(snapshot_of(contract_catalog(), mic_check()), record["id"])
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
        mic = item(snapshot_of(catalog(yeti()), mic_check()), YETI)
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
        snapshot = snapshot_of(catalog(c920(), c920_mic()), mic_check())
        mic = item(snapshot, C920_MIC)
        self.assertEqual((mic["name"], mic["device"]["part_of"]), ("HD Pro Webcam C920", {"id": C920, "name": "HD Pro Webcam C920"}))
        self.assertEqual(mic["capture"][0]["rates"], [16000, 24000, 32000])
        # Sentinel's real camera topology is a sysfs path; ALSA names the USB device by its last part.
        camera = c920()
        camera["identity"]["topology"] = "devices/platform/xhci-hcd.1.auto/usb1/1-3/1-3.1"
        self.assertEqual(item(snapshot_of(catalog(camera, c920_mic()), mic_check()), C920_MIC)["device"]["part_of"]["id"], C920)
        self.assertNotIn("part_of", item(snapshot_of(catalog(c920_mic()), mic_check()), C920_MIC)["device"])

    def test_a_mono_microphone_keeps_its_continuous_rate_range_and_degrades_without_usb_strings(self):
        mic = item(snapshot_of(catalog(mono_mic()), mic_check()), MONO_MIC)
        self.assertEqual(mic["name"], "USB PnP Sound Device")
        self.assertEqual(mic["capture"], [{"format": "S16_LE", "channels": 1, "bits": 16, "rates": [],
                                           "rate_range": {"min": 8000, "max": 48000}, "channel_map": None}])
        self.assertNotIn("by_id", mic["device"])

    def test_an_onboard_device_without_formats_says_so_once(self):
        mic = item(snapshot_of(catalog(onboard_mic()), None), ONBOARD_MIC)
        self.assertEqual((mic["connection"], mic["capture"]), ("onboard", None))
        self.assertEqual(mic["notes"], [microphones.NO_CAPABILITIES_NOTE,
                                        "ALSA did not report valid capture subdevice availability."])
        self.assertEqual(mic["availability"], {"state": "unknown", "users": [], "reason": cameras.UNCHECKED_REASON})
        self.assertNotIn("usb", mic["device"])

    def test_availability_combines_the_kernel_counts_with_insight_process_check(self):
        holder = [{"pid": 4242, "command": "arecord"}]
        busy = yeti()
        busy["availability"] = {"state": "in_use", "subdevices": 1, "subdevices_available": 0}
        named = item(snapshot_of(catalog(busy), mic_check(users={YETI: holder})), YETI)["availability"]
        self.assertEqual(named, {"state": "in_use", "users": holder, "reason": "Open in arecord (pid 4242)."})
        hidden = item(snapshot_of(catalog(busy), mic_check(availability_method="proc-user", users={YETI: []})), YETI)
        self.assertEqual(hidden["availability"], {"state": "in_use", "users": [], "reason": microphones.KERNEL_IN_USE_REASON})
        # The live substream count wins over Sentinel's counts from its last scan.
        live_free = item(snapshot_of(catalog(busy), mic_check(users={YETI: []}, capture_open={YETI: 0})), YETI)
        self.assertEqual(live_free["availability"], {"state": "available", "users": [], "reason": None})
        # Free by the kernel's counts needs no process check, even when that check could not run.
        self.assertEqual(item(snapshot_of(catalog(yeti()), None), YETI)["availability"]["state"], "available")

    def test_sound_servers_and_a_failed_provider_are_noted(self):
        snapshot = snapshot_of(
            catalog(yeti(), errors=[{"provider": MIC_PROVIDER, "code": "peripherals.discovery_failed",
                                     "reason": "ALSA scan failed"}]),
            mic_check(sound_servers=["pipewire", "pipewire-pulse", "pulseaudio"]),
        )
        notes = item(snapshot, YETI)["notes"]
        self.assertIn(f"its {MIC_PROVIDER} provider failed", notes[0])
        self.assertTrue(notes[1].startswith("PipeWire is running") and notes[2].startswith("PulseAudio is running"))
        self.assertEqual(len(notes), 3)

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
            "issues": lambda mic: mic.update(issues=[None]),
        }
        # A backend or connection Sentinel may add later is not a malformed record.
        validate(catalog(dict(contract_microphone(), backend="pipewire", connection="bluetooth")))
        for name, mutate in malformed.items():
            doc = catalog(contract_microphone())
            mutate(doc["devices"][0])
            with self.subTest(name), self.assertRaises(BoardError) as ctx:
                validate(doc)
            self.assertEqual(ctx.exception.code, "peripheral_response")

    def test_changes_include_microphones(self):
        first = snapshot_of(catalog(imx477(), yeti()), mic_check())
        second = snapshot_of(catalog(imx477()), mic_check(), previous=first)
        self.assertEqual(second["changes"]["removed"], [{"id": YETI, "name": "Yeti Nano"}])


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

    def use(self, *catalogs, checks=(), generation: int = 1, fingerprint: str = "fp-1") -> CheckTransport:
        self.catalogs = list(catalogs) or [catalog(imx477(), c920())]
        known = [doc for doc in self.catalogs if isinstance(doc, dict)]
        transport = CheckTransport(*checks, default=check(support=core_of(*known)))
        self.manager.current = FakeSession(generation, transport, fingerprint)
        return transport

    def refresh(self):
        response = self.client.post("/api/peripherals/refresh")
        if response.status_code == 200:
            self.scan_id = response.get_json()["scan_id"]
        return response

    def export(self, **body):
        body = {
            "generation": self.manager.current.generation,
            "scan_id": self.scan_id,
            "id": IMX477,
            "format": "NV12",
            "width": 1920,
            "height": 1080,
            "fps": 30,
            **body,
        }
        return self.client.post("/api/peripherals/cameras/export", json=body)

    def test_scan_responses_are_not_cached(self):
        self.use()
        self.assertEqual(self.client.get("/api/peripherals").headers["Cache-Control"], "no-store")

    def test_get_before_refresh_is_empty_and_never_connects(self):
        transport = self.use()
        response = self.client.get("/api/peripherals")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(
            (body["scan_id"], body["scanned_at"], body["items"], body["changes"], body["platform"]),
            (None, None, [], None, None),
        )
        self.assertEqual(body["board"]["label"], "sima@192.168.2.2")
        self.assertEqual(transport.calls, [])
        self.sentinel.assert_not_called()

    def test_refresh_asks_sentinel_then_runs_one_board_check(self):
        transport = self.use()
        response = self.refresh()
        self.assertEqual(response.status_code, 200)
        self.sentinel.assert_called_once()
        self.assertEqual(len(transport.calls), 1)
        argv, timeout, stdin = transport.calls[0]
        self.assertEqual(argv[:2], ["python3", "-"])
        self.assertEqual(
            json.loads(argv[2]),
            {"cameras": {IMX477: ["/dev/media0", "/dev/video0out"], C920: ["/dev/video97"]}, "support": True},
        )
        self.assertEqual(stdin, Path(board_check.__file__).read_bytes())
        snapshot = response.get_json()
        self.assertEqual(snapshot["board"]["fingerprint"], "fp-1")
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920])
        self.assertIsNone(snapshot["changes"])
        self.assertEqual(self.client.get("/api/peripherals").get_json(), snapshot)

    def test_sentinels_contract_example_refreshes_and_exports_both_cameras(self):
        self.use(contract_catalog())
        snapshot = self.refresh().get_json()
        self.assertEqual([i["id"] for i in snapshot["items"]], [IMX477, C920, contract_microphone()["id"]])
        mipi = self.export().get_json()
        self.assertEqual(json.loads(mipi["exports"][2]["content"])["options"]["camera_name"], "imx477 5-001a")
        usb = self.export(id=C920, format="MJPG", width=1920, height=1080, fps=30).get_json()
        self.assertEqual(json.loads(usb["exports"][1]["content"])["device"],
                         "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_BE998CAF-video-index0")

    def test_a_board_without_cameras_needs_no_board_check(self):
        transport = self.use(catalog())
        self.assertEqual(self.refresh().get_json()["items"], [])
        self.assertEqual(transport.calls, [])

    def test_a_failed_board_check_degrades_availability_instead_of_failing(self):
        for failure in (ExecResult(127, b"", b"sh: python3: not found"), ExecResult(0, b"Traceback", b""),
                        BoardError("timeout", "timed out")):
            with self.subTest(failure=failure):
                self.use(checks=[failure])
                response = self.refresh()
                self.assertEqual(response.status_code, 200)
                camera = response.get_json()["items"][0]
                self.assertEqual(camera["availability"]["state"], "unknown")

    def test_a_failed_board_check_does_not_use_the_status_reporting_transport(self):
        raw = self.use(checks=[BoardError("timeout", "timed out")])
        reporting = mock.Mock()
        self.manager.current.transport = reporting
        self.assertEqual(self.refresh().status_code, 200)
        self.assertEqual(len(raw.calls), 1)
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

    def test_in_use_warning_names_the_holding_processes(self):
        holder = [{"pid": 4242, "command": "gst-launch-1.0"}]
        self.use(checks=[check(users={IMX477: holder, C920: []})])
        self.assertEqual(self.refresh().get_json()["items"][0]["availability"]["state"], "in_use")
        self.assertIn(
            "The camera is in use by gst-launch-1.0 (pid 4242); CameraInput cannot acquire it until it is released.",
            self.export().get_json()["warnings"],
        )

    def test_export_mipi_renders_core_shapes(self):
        self.use()
        self.refresh()
        response = self.export()
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(body["support"]["tier"], "verified")
        self.assertIn("Validated with Core CameraInput", body["support"]["reason"])
        warnings = body["warnings"]
        self.assertIn("delivered about 66 fps", warnings[0])
        self.assertEqual(warnings[1:], [NO_BUFFER_COUNT])
        exports = {e["id"]: e for e in body["exports"]}
        self.assertEqual(list(exports), ["python", "cpp", "json"])

        python = exports["python"]["content"]
        compile(python, "camera_input.py", "exec")
        for line in (
            "camera.camera_name = 'imx477 5-001a'",
            "camera.framerate_num = 30",
            "camera.framerate_den = 1",
            "camera.buffer_name = 'camera0'",
            "camera.allow_cpu_fallback = True",
            "graph.add(pyneat.nodes.camera_input(camera))",
        ):
            self.assertIn(line, python)

        cpp = exports["cpp"]["content"]
        self.assertEqual(cpp.count("{"), cpp.count("}"))
        self.assertIn('camera.camera_name = "imx477 5-001a";', cpp)
        self.assertIn("graph.add(neat::nodes::CameraInput(camera));", cpp)
        descriptor = json.loads(exports["json"]["content"])
        self.assertEqual((descriptor["kind"], descriptor["version"], descriptor["camera_id"]), ("neat.camera-input", 1, IMX477))
        self.assertEqual(descriptor["options"]["camera_name"], "imx477 5-001a")
        self.assertEqual((descriptor["support_tier"], descriptor["capture_buffer_count"]), ("verified", 0))

    def test_export_of_a_supported_mode_without_evidence_has_no_measured_rate(self):
        self.use()
        self.refresh()
        body = self.export(width=2048).get_json()
        self.assertEqual(body["support"], {"tier": "verified", "reason": "Neat Core accepts this mode.", "links": []})
        self.assertEqual(body["warnings"], [NO_BUFFER_COUNT])

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
        self.assertEqual(self.export(id=C920, format="YUYV", width=640, height=480, fps=25).status_code, 400)

    def test_export_keeps_a_fractional_catalog_rate_exact(self):
        mipi = imx477()
        for mode in mipi["modes"]:
            mode["frame_intervals"] = [{"width": mode["width"], "height": mode["height"], "intervals": [
                {"type": "discrete", "numerator": 1001, "denominator": 30000}]}]
        usb = c920()
        usb["modes"] = [usb_mode("YUYV", 640, 480, [(1001, 30000), (1, 15)])]
        self.use(catalog(mipi, usb))
        self.refresh()
        descriptor = json.loads(self.export(fps=29.97).get_json()["exports"][2]["content"])
        self.assertEqual((descriptor["options"]["framerate_num"], descriptor["options"]["framerate_den"]), (30000, 1001))
        body = self.export(id=C920, format="YUYV", width=640, height=480, fps=29.97).get_json()
        descriptor = json.loads(body["exports"][1]["content"])
        self.assertEqual((descriptor["framerate_num"], descriptor["framerate_den"]), (30000, 1001))

    def test_export_escapes_device_strings(self):
        doc = imx477()
        hostile = 'cam"\n\\ 5-001a'
        doc.update(camera_name=hostile, model=None)
        self.use(catalog(doc))
        self.refresh()
        body = self.export().get_json()
        exports = {e["id"]: e["content"] for e in body["exports"]}
        self.assertEqual(list(exports), ["python", "cpp", "json"])
        namespace = {}
        code = compile(exports["python"].replace("import pyneat", ""), "export", "exec")
        exec(code, {"pyneat": _FakePyneat()}, namespace)
        self.assertEqual(namespace["camera"].camera_name, hostile)
        self.assertTrue(namespace["camera"].allow_cpu_fallback)
        self.assertIn("neat::nodes::CameraInput(camera)", exports["cpp"])
        self.assertNotIn("\n\\ 5", exports["cpp"])

    def test_export_usb_emits_descriptors_only(self):
        self.use()
        self.refresh()
        response = self.export(id=C920, format="MJPG", width=1280, height=720, fps=7.5)
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual([e["id"] for e in body["exports"]], ["yaml", "json"])
        self.assertEqual(body["support"]["tier"], "unsupported")
        descriptor = json.loads(body["exports"][1]["content"])
        self.assertEqual((descriptor["kind"], descriptor["core_support"]), ("v4l2-camera", "unsupported"))
        self.assertEqual(descriptor["device"], C920_BY_ID)
        self.assertEqual((descriptor["vendor_id"], descriptor["product_id"], descriptor["serial"]), ("046d", "08e5", "BE998CAF"))
        self.assertEqual((descriptor["framerate_num"], descriptor["framerate_den"]), (15, 2))
        yaml_values = parse_yaml_block(body["exports"][0]["content"])
        self.assertEqual((yaml_values["core_support"], yaml_values["format"]), ("unsupported", "MJPG"))
        self.assertTrue(any("core#903" in w for w in body["warnings"]))
        self.assertFalse(any("not stable" in w for w in body["warnings"]))

        doc = c920()
        doc.pop("by_id_path")
        self.use(catalog(doc))
        self.refresh()
        body = self.export(id=C920, format="YUYV", width=640, height=480, fps=30).get_json()
        self.assertEqual(json.loads(body["exports"][1]["content"])["device"], "/dev/video97")
        self.assertTrue(any("internals#244" in w for w in body["warnings"]))
        self.assertTrue(any("not stable" in w for w in body["warnings"]))

        # Codex 4189173487: with neither path the descriptor's device was null, which nothing can open.
        doc.pop("device_path")
        self.use(catalog(doc))
        self.refresh()
        response = self.export(id=C920, format="YUYV", width=640, height=480, fps=30)
        self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))
        self.assertIn("no device path", response.get_json()["error"])

    def test_export_refuses_modes_sentinel_did_not_report_or_core_did_not_verify(self):
        self.use()
        self.refresh()
        for width, height in ((1280, 720), (3840, 2160)):
            with self.subTest(size=f"{width}x{height}"):
                response = self.export(width=width, height=height)
                self.assertEqual(response.status_code, 400)
                body = response.get_json()
                self.assertEqual((body["code"], body["hint"]), ("invalid_request", export.MODE_HINT))
                self.assertIn(f"{width}x{height} at 30 fps is not a mode this camera reported", body["error"])
        self.assertIn(FORMAT_REASON, self.export(format="RGB3").get_json()["error"])
        self.use(checks=[check(support={"state": "not_installed", "reason": "No module named 'pyneat'"})])
        self.refresh()
        response = self.export()
        self.assertEqual(response.status_code, 400)
        self.assertIn(f"at 30 fps cannot be exported: {NOT_INSTALLED}", response.get_json()["error"])

    def test_export_rejects_invalid_requests(self):
        self.use()
        self.refresh()
        cases = (
            ({"generation": 0}, 400),
            ({"scan_id": ""}, 400),
            ({"scan_id": 7}, 400),
            ({"generation": True}, 400),
            ({"generation": 1.5}, 400),
            ({"fps": None}, 400),
            ({"width": True}, 400),
            ({"format": "AR24"}, 400),
            ({"width": 1234}, 400),
            ({"fps": 60}, 400),
            ({"id": "camera:nope"}, 404),
        )
        for body, status in cases:
            with self.subTest(body=body):
                response = self.export(**body)
                self.assertEqual(response.status_code, status)
                self.assertIn(response.get_json()["code"], {"invalid_request", "not_found"})
        self.assertEqual(self.export(generation=1.0).status_code, 200)

    def test_export_rejects_a_frame_rate_that_is_not_a_finite_number(self):
        # Codex 4188993845: an integer too large for a float overflowed against a fractional rate (a 500).
        from neat_insight.peripherals import export

        page = {"id": C920, "format": "MJPG", "width": 1920, "height": 1080}
        for fps in (10**400, float("nan"), float("inf")):
            with self.subTest(fps=str(fps)[:12]), self.assertRaises(BoardError) as ctx:
                export.parse_request(dict(page, fps=fps))
            self.assertEqual(ctx.exception.code, "invalid_request")
        self.assertEqual(export.parse_request(dict(page, fps=7.5))["fps"], 7.5)

    def test_the_pages_export_request_without_scan_tokens_uses_the_current_scan(self):
        """The Peripherals page sends only the mode; the optional tokens are checked only when sent."""
        self.use(catalog(imx477()), catalog(imx477(), observed_at="2026-10-05T01:49:00Z"))
        page = {"id": IMX477, "format": "NV12", "width": 1920, "height": 1080, "fps": 30}
        post = lambda: self.client.post("/api/peripherals/cameras/export", json=page)
        self.assertEqual((post().status_code, post().get_json()["code"]), (409, "stale_snapshot"))
        self.refresh()
        self.assertEqual(post().status_code, 200)
        self.refresh()
        self.assertEqual(post().status_code, 200, "a later scan of the same board still serves the page")
        self.use(generation=2)
        self.assertEqual(post().status_code, 409, "a newly selected board without a scan has nothing to export")

    def test_export_is_stale_after_another_scan_of_the_same_board(self):
        self.use(catalog(imx477()), catalog(imx477(), observed_at="2026-10-05T01:49:00Z"))
        first = self.refresh().get_json()
        old_scan_id = first["scan_id"]
        self.refresh()
        response = self.export(scan_id=old_scan_id)
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

    def test_export_is_stale_after_the_board_changes(self):
        self.use()
        self.assertEqual(self.export().status_code, 409)
        self.refresh()
        self.use(generation=2)
        response = self.export()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.client.get("/api/peripherals").get_json()["scanned_at"], None)

    def test_export_rejects_an_old_tab_after_the_new_board_is_scanned(self):
        self.use()
        old_generation = self.refresh().get_json()["generation"]
        self.use(generation=2)
        self.refresh()
        response = self.export(generation=old_generation)
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

    def test_export_is_refused_when_the_board_changes_before_it_returns(self):
        self.use()
        self.refresh()
        self.manager.current.stale = True
        response = self.export()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))

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


class MicrophoneApiTests(unittest.TestCase):
    def setUp(self):
        for target, name, value in ((api, "scans", cameras.ScanCache()), (mictest, "_current", None)):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.sentinel = catalog(imx477(), yeti())
        self.reads = {}
        for method in ("refresh", "catalog"):
            patcher = mock.patch.object(api.PeripheralClient, method, autospec=True,
                                        side_effect=lambda client: copy.deepcopy(self.sentinel))
            self.reads[method] = patcher.start()
            self.addCleanup(patcher.stop)
        self.manager = FakeManager()
        self.transport = CheckTransport(mic_check(users={IMX477: []}))
        self.manager.current = FakeSession(1, self.transport)
        app = Flask(__name__)
        app.register_blueprint(board_bp)
        app.register_blueprint(peripherals_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def start(self, mic_id=YETI, **body):
        return self.client.post("/api/peripherals/microphones/test", json={"id": mic_id, **body})

    def test_refresh_checks_every_microphone_live(self):
        self.sentinel = catalog(yeti(), c920_mic(), onboard_mic())
        self.assertEqual(self.client.post("/api/peripherals/refresh").status_code, 200)
        argv, _, _ = self.transport.calls[0]
        self.assertEqual(json.loads(argv[2]), {"cameras": {}, "support": True, "microphones": {
            YETI: ["/dev/snd/pcmC2D0c"], C920_MIC: ["/dev/snd/pcmC3D0c"], ONBOARD_MIC: ["/dev/snd/pcmC0D0c"]}})

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
        self.assertEqual(len(self.transport.calls), 1)

    def test_a_changed_sentinel_catalog_never_starts_arecord(self):
        self.client.post("/api/peripherals/refresh")
        self.sentinel = catalog(imx477(), yeti(), revision=2)
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
                    cache.record(1, BOARD, refreshed, mic_check(), 5)
                    return value
                return read

        self.sentinel = catalog(imx477(), yeti(), revision=2)  # Sentinel now serves the newer catalog
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

        def record(argv, on_stdout, cancel_event):
            on_stdout(sine(0.5))
            recording.set()
            cancel_event.wait(30)
            raise CommandCancelled()

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
        self.assertEqual(self.client.get("/api/peripherals/microphones/test").get_json()["test"]["token"], first["token"])
        self.client.post("/api/peripherals/microphones/test/stop")
        mictest._current.thread.join(2)

    def test_start_records_with_sentinel_selector_then_poll_stop_and_audio_follow_the_reference_contract(self):
        self.client.post("/api/peripherals/refresh")
        pcm = sine(0.5)
        recording = threading.Event()

        def record(argv, on_stdout, cancel_event):
            on_stdout(pcm)
            recording.set()
            cancel_event.wait(30)
            raise CommandCancelled()

        self.answer_checks(mic_check(users={YETI: []}, capture_open={YETI: 0}), record)
        response = self.start()
        self.assertEqual(response.status_code, 202)
        test = response.get_json()["test"]
        self.assertEqual((test["id"], test["state"], test["device"]), (YETI, "recording", "plughw:CARD=Nano,DEV=0"))
        self.assertEqual(test["format"], {"rate": 48000, "channels": 2, "bits": 16, "seconds": 30})
        self.assertTrue(recording.wait(2))
        self.assertEqual(self.transport.calls[-1][0][:4], ["arecord", "-q", "-D", "plughw:CARD=Nano,DEV=0"])
        self.assertEqual(self.start().get_json()["code"], "test_running")
        live = self.client.get("/api/peripherals/microphones/test").get_json()["test"]
        self.assertEqual((live["token"], live["elapsed_ms"]), (test["token"], 100))
        self.assertIsNotNone(live["level_dbfs"])
        self.assertEqual(self.client.post("/api/peripherals/microphones/test/stop").status_code, 200)
        mictest._current.thread.join(2)
        done = self.client.get("/api/peripherals/microphones/test").get_json()["test"]
        self.assertEqual(done["state"], "ready")
        self.assertFalse(done["level"]["silent"])
        wav = self.client.get(done["audio_url"])
        self.assertEqual((wav.status_code, wav.mimetype, wav.data[:4]), (200, "audio/wav", b"RIFF"))
        self.assertEqual(self.client.get("/api/peripherals/microphones/test/other.wav").status_code, 404)

    def test_another_board_sees_no_test_and_cannot_stop_it(self):
        self.assertIsNone(self.client.get("/api/peripherals/microphones/test").get_json()["test"])
        self.assertIsNone(self.client.post("/api/peripherals/microphones/test/stop").get_json()["test"])
        mictest._current = mictest.MicTest(1, YETI, "plughw:CARD=Nano,DEV=0", 48000, 2, 30)
        self.manager.current = FakeSession(2, self.transport)
        self.assertIsNone(self.client.get("/api/peripherals/microphones/test").get_json()["test"])
        self.assertIsNone(self.client.post("/api/peripherals/microphones/test/stop").get_json()["test"])
        self.assertFalse(mictest._current.stop_requested)


    def test_another_board_cannot_download_the_recording(self):
        test = mictest._current = mictest.MicTest(1, YETI, "plughw:CARD=Nano,DEV=0", 48000, 2, 30)
        test.finish(wav=b"RIFF....")
        url = f"/api/peripherals/microphones/test/{test.token}.wav"
        self.assertEqual(self.client.get(url).status_code, 200)
        self.manager.current = FakeSession(2, self.transport)  # /api/board/select picked another board
        response = self.client.get(url)
        self.assertEqual((response.status_code, response.get_json()["code"]), (404, "not_found"))

def sine(amplitude: float, frames: int = 4800, channels: int = 2) -> bytes:
    values = [int(amplitude * 32767 * math.sin(2 * math.pi * 440 * i / 48000)) for i in range(frames)]
    return struct.pack("<%dh" % (channels * frames), *[v for v in values for _ in range(channels)])


class MicrophoneTestTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(mictest, "_current", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def bind(self, doc, scanned=None, mic_id=YETI):
        return mictest.bind_microphone(doc, scanned or {"revision": catalog()["revision"]}, mic_id)

    def assert_refused(self, code, doc, **kwargs):
        with self.assertRaises(BoardError) as ctx:
            self.bind(doc, **kwargs)
        self.assertEqual(ctx.exception.code, code)

    def test_binding_uses_only_sentinel_selector_from_the_scanned_catalog(self):
        example = contract_catalog()
        self.assertEqual(self.bind(example, {"revision": example["revision"]}, contract_microphone()["id"]),
                         {"selector": "plughw:CARD=C920,DEV=0", "node": "/dev/snd/pcmC0D0c", "rate": 32000, "channels": 2})
        self.assertEqual(self.bind(catalog(yeti())),
                         {"selector": "plughw:CARD=Nano,DEV=0", "node": "/dev/snd/pcmC2D0c", "rate": 48000, "channels": 2})
        self.assert_refused("stale_snapshot", catalog(yeti(), revision=2))
        self.assert_refused("not_found", catalog(c920_mic()))
        for selector in ("plughw:CARD=x;rm -rf /,DEV=0", "hw:2,0", "plughw:2,0", None):
            hostile = yeti()
            hostile["capture_target"]["selector"] = selector
            with self.subTest(selector=selector):
                self.assert_refused("peripheral_response", catalog(hostile))
        # Sentinel's availability is only shown: the live check at test start decides (refuse_if_held).
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
        session.transport = transport
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


class _FakePyneat:
    """Just enough of pyneat to execute the exported Python."""

    class CameraInputOptions(SimpleNamespace):
        pass

    class Graph:
        def __init__(self, name):
            self.nodes = []

        def add(self, node):
            self.nodes.append(node)

    nodes = SimpleNamespace(camera_input=lambda options, capture_buffer_count=0: (options, capture_buffer_count))


if __name__ == "__main__":
    unittest.main()
