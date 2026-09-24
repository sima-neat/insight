import ast
import json
import os
import tempfile
import threading
import time
import unittest
import unittest.mock as mock
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult
from neat_insight.peripherals import api, cameras, export, probe
from neat_insight.peripherals.api import peripherals_bp

FIXTURES = Path(__file__).parent / "fixtures" / "peripherals"
IMX477 = "imx477 5-001a"
ISP_QUERY = ("v4l2-ctl", "-d", "/dev/video0out", "--info", "--list-formats-ext")


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def split_log(text: str):
    """Split a captured terminal transcript into (stdout, stderr); libcamera logs start with '['."""
    lines = text.splitlines()
    out = "\n".join(line for line in lines if not line.startswith("[")) + "\n"
    err = "\n".join(line for line in lines if line.startswith("[")) + "\n"
    return out, err


def parse_yaml_block(text: str) -> dict:
    lines = [line for line in text.splitlines() if line and not line.startswith("#")]
    assert lines[0] == "camera:", lines[0]
    values = {}
    for line in lines[1:]:
        assert line.startswith("  ") and ": " in line, line
        key, raw = line[2:].split(": ", 1)
        values[key] = json.loads(raw)
    return values


class FakeBoard:
    """A temporary sysfs/proc/dev tree plus canned tool output for probe.collect()."""

    def __init__(self, root):
        self.root = Path(root)
        for sub in ("sys/class/video4linux", "sys/devices/platform", "proc", "dev/v4l/by-id"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self.tools = {name: f"/usr/bin/{name}" for name in probe.TOOLS}
        self.euid = 0
        self.outputs = {}
        self.calls = []

    def command(self, *argv, code=0, out="", err="", text=None):
        if text is not None:
            out, err = split_log(text)
        self.outputs[argv] = (code, out, err)

    def run(self, argv, timeout=probe.COMMAND_TIMEOUT):
        key = (os.path.basename(argv[0]),) + tuple(argv[1:])
        self.calls.append(key)
        return self.outputs.get(key, (1, "", f"unexpected command {key}"))

    def media(self, name: str, text: str):
        (self.root / "dev" / name).touch()
        self.command("media-ctl", "-d", f"/dev/{name}", "-p", out=text)

    def video_node(self, name: str, device_dir: str, index: int, label: str):
        device = self.root / "sys" / "devices" / device_dir
        device.mkdir(parents=True, exist_ok=True)
        entry = self.root / "sys" / "class" / "video4linux" / name
        entry.mkdir()
        (entry / "device").symlink_to(device)
        (entry / "index").write_text(f"{index}\n")
        (entry / "name").write_text(f"{label}\n")

    def usb_device(self, bus_path: str, **attrs) -> str:
        usb = self.root / "sys" / "devices" / "platform" / "xhci-hcd.0.auto" / "usb1" / bus_path
        usb.mkdir(parents=True, exist_ok=True)
        for key, value in attrs.items():
            (usb / key).write_text(f"{value}\n")
        return f"platform/xhci-hcd.0.auto/usb1/{bus_path}/{bus_path}:1.0"

    def by_id(self, name: str, node: str):
        (self.root / "dev" / "v4l" / "by-id" / name).symlink_to(f"../../{node}")

    def hold(self, pid: int, command: str, *nodes):
        proc = self.root / "proc" / str(pid)
        (proc / "fd").mkdir(parents=True)
        (proc / "comm").write_text(f"{command}\n")
        for fd, node in enumerate(nodes, start=3):
            (proc / "fd" / str(fd)).symlink_to(node)

    def collect(self) -> dict:
        roots = {
            "SYSFS_ROOT": str(self.root / "sys"),
            "PROC_ROOT": str(self.root / "proc"),
            "DEV_ROOT": str(self.root / "dev"),
        }
        with mock.patch.multiple(probe, run=self.run, which=self.tools.get, **roots), mock.patch.object(
            probe.os, "geteuid", return_value=self.euid
        ):
            return json.loads(json.dumps(probe.collect()))


def devkit_board(root) -> FakeBoard:
    """The real DevKit today: one CSI media device, no sensor, ISP video nodes, no USB camera."""
    board = FakeBoard(root)
    board.media("media0", fixture("media_ctl_no_sensor.txt"))
    board.command("cam", "-l", text=fixture("cam_list_no_sensor.txt"))
    board.command("gst-inspect-1.0", "libcamerasrc", out=fixture("gst_inspect_libcamerasrc.txt"))
    board.video_node("video0", "platform/csi2video@1", 0, "raw-capture.1.0")
    board.video_node("video0raw", "platform/4220000.isp", 0, "isp_v4l2-vid-cap-raw")
    board.video_node("video0out", "platform/4220000.isp", 1, "isp_v4l2-vid-cap-out")
    board.command(*ISP_QUERY, out=fixture("v4l2_isp_out_real.txt"))
    board.video_node("video5", "platform/4220000.isp", 4, "modalix-isp-stats-ctx0")
    return board


def camera_board(root, cam_info: str = "cam_info_imx477_synthetic.txt", usb: bool = True) -> FakeBoard:
    """The DevKit with an imx477 on CSI and a C920-style UVC webcam."""
    board = devkit_board(root)
    board.media("media0", fixture("media_ctl_imx477_synthetic.txt"))
    board.command("cam", "-l", text=fixture("cam_list_imx477_synthetic.txt"))
    board.command("cam", "-c", IMX477, "-I", text=fixture(cam_info))
    if usb:
        interface = board.usb_device(
            "1-1.2",
            idVendor="046d",
            idProduct="082d",
            manufacturer="Logitech",
            product="HD Pro Webcam C920",
            serial="A1B2C3D4",
            speed="480",
        )
        board.video_node("video2", interface, 0, "HD Pro Webcam C920")
        board.video_node("video3", interface, 1, "HD Pro Webcam C920")
        board.by_id("usb-046d_HD_Pro_Webcam_C920_A1B2C3D4-video-index0", "video2")
        board.by_id("usb-046d_HD_Pro_Webcam_C920_A1B2C3D4-video-index1", "video3")
        board.command("v4l2-ctl", "-d", "/dev/video2", "--info", out=fixture("v4l2_info_c920_synthetic.txt"))
        board.command(
            "v4l2-ctl", "-d", "/dev/video2", "--list-formats-ext", out=fixture("v4l2_formats_c920_synthetic.txt")
        )
        board.command("v4l2-ctl", "-d", "/dev/video3", "--info", out=fixture("v4l2_info_uvc_meta_synthetic.txt"))
    return board


def real_imx477_board(root) -> FakeBoard:
    """The DevKit with the imx477 as captured on it: libcamera lists 49 NV12 sizes, the ISP outputs three."""
    board = devkit_board(root)
    board.media("media0", fixture("media_ctl_imx477_real.txt"))
    board.command("cam", "-l", text=fixture("cam_list_imx477_real.txt"))
    board.command("cam", "-c", IMX477, "-I", text=fixture("cam_info_imx477_real.txt"))
    return board


BOARD = {
    "label": "sima@192.168.2.2",
    "source": "manual",
    "hostname": "modalix",
    "machine": "modalix",
    "build_version": "2.1.3",
    "fingerprint": "fp-1",
}


def snapshot_of(probe_output: dict) -> dict:
    return cameras.build_snapshot(probe_output, BOARD, 1, None, 5)[0]


def item(snapshot: dict, item_id: str) -> dict:
    return next(entry for entry in snapshot["items"] if entry["id"] == item_id)


def fmt_of(camera: dict, name: str) -> dict:
    return next(entry for entry in camera["formats"] if entry["format"] == name)


def size_of(fmt: dict, width: int, height: int) -> dict:
    return next(size for size in fmt["sizes"] if (size["width"], size["height"]) == (width, height))


class ProbeParsingTests(unittest.TestCase):
    def test_media_ctl_without_sensor_lists_capture_path_only(self):
        graph = probe.parse_media_ctl(fixture("media_ctl_no_sensor.txt"))
        self.assertEqual(graph["driver"], "simaai-v4l2-vid")
        self.assertEqual(graph["bus_info"], "platform:csi2video@1")
        self.assertEqual([e["name"] for e in graph["entities"]], ["raw-capture.1.0", "vdma.1", "csidev-40c3000.csi"])
        self.assertEqual(graph["entities"][0]["node"], "/dev/video0")
        self.assertFalse(any("subtype Sensor" in e["type"] for e in graph["entities"]))

    def test_media_ctl_with_sensor_names_the_libcamera_id(self):
        graph = probe.parse_media_ctl(fixture("media_ctl_imx477_synthetic.txt"))
        sensor = next(e for e in graph["entities"] if "subtype Sensor" in e["type"])
        self.assertEqual((sensor["name"], sensor["node"]), (IMX477, "/dev/v4l-subdev0"))

    def test_cam_list_without_sensor_reports_the_zombie_media_device(self):
        listing = probe.parse_cam_list(fixture("cam_list_no_sensor.txt"))
        self.assertEqual(listing, {"cameras": [], "no_sensor": ["/dev/media0"], "rates": {}})

    def test_cam_list_accepts_quoted_model_and_bare_id_lines(self):
        text = (
            "Available cameras:\n"
            "1: 'imx477' (imx477 5-001a)\n"
            "2: imx219 6-0010\n"
            "3: Internal front camera (/base/ov5647@36)\n"
        )
        cameras_found = probe.parse_cam_list(text)["cameras"]
        self.assertEqual(
            [(c["index"], c["model"], c["id"]) for c in cameras_found],
            [(1, "imx477", IMX477), (2, None, "imx219 6-0010"), (3, None, "/base/ov5647@36")],
        )

    def test_cam_info_parses_formats_sizes_and_rate_limit(self):
        text = fixture("cam_info_imx568.txt")
        formats = probe.parse_cam_info(text)
        self.assertEqual([f["format"] for f in formats], ["SRGGB10", "SRGGB12", "NV12", "BGR888", "RGB888", "YUYV"])
        nv12 = formats[2]
        self.assertEqual(list(nv12["range"].values()), [48, 32, 2432, 2048, 2, 2])
        self.assertEqual(len(nv12["sizes"]), 36)
        self.assertEqual(nv12["sizes"][0], {"width": 160, "height": 120})
        self.assertEqual(probe.parse_rate_limits(text), {"econ-imx568-fpga 5-0042": 29.9742})
        self.assertFalse(probe.acquire_failed(text))
        self.assertTrue(probe.acquire_failed(fixture("cam_info_busy_synthetic.txt")))

    def test_commands_past_the_time_budget_are_skipped(self):
        with mock.patch.object(probe, "_deadline", time.monotonic() - 1):
            self.assertEqual(probe.run(["true"]), (None, "", "skipped: the probe's time budget was used up"))

    def test_budget_skips_are_not_reported_as_timeouts(self):
        self.assertEqual(probe._failure("cam", None, probe.OUT_OF_TIME)["reason"], "out_of_time")
        self.assertEqual(probe._failure("cam", None, "timed out after 10 s")["reason"], "timeout")

    def test_real_imx477_output_from_the_devkit(self):
        listing = probe.parse_cam_list(fixture("cam_list_imx477_real.txt"))
        self.assertEqual([(c["index"], c["model"], c["id"]) for c in listing["cameras"]], [(1, None, IMX477)])
        self.assertEqual(listing["rates"], {IMX477: 66.1857})
        formats = {f["format"]: f for f in probe.parse_cam_info(fixture("cam_info_imx477_real.txt"))}
        self.assertEqual(set(formats), {"SRGGB10", "SRGGB12", "SRGGB8", "NV12", "BGR888", "RGB888", "YUYV"})
        self.assertEqual(list(formats["NV12"]["range"].values()), [48, 32, 4056, 3040, 2, 2])
        self.assertEqual(len(formats["NV12"]["sizes"]), 49)
        graph = probe.parse_media_ctl(fixture("media_ctl_imx477_real.txt"))
        sensor = next(e for e in graph["entities"] if "subtype Sensor" in e["type"])
        self.assertEqual((sensor["name"], sensor["node"]), (IMX477, "/dev/v4l-subdev2"))
        self.assertEqual(graph["bus_info"], "platform:csi2video@1")

    def test_gst_inspect_reports_element_properties_only(self):
        properties = probe.parse_gst_properties(fixture("gst_inspect_libcamerasrc.txt"))
        self.assertIn("external-buffer-mode", properties)
        self.assertIn("buffer-count", properties)
        self.assertNotIn("stream-role", properties)

    def test_v4l2_info_reads_device_caps_not_driver_caps(self):
        capture = probe.parse_device_caps(fixture("v4l2_info_c920_synthetic.txt"))
        self.assertEqual(capture, ["Video Capture", "Streaming", "Extended Pix Format"])
        meta = probe.parse_device_caps(fixture("v4l2_info_uvc_meta_synthetic.txt"))
        self.assertEqual(meta, ["Metadata Capture", "Streaming", "Extended Pix Format"])

    def test_v4l2_formats_discrete(self):
        formats = probe.parse_v4l2_formats(fixture("v4l2_formats_c920_synthetic.txt"))
        self.assertEqual([f["format"] for f in formats], ["YUYV", "MJPG"])
        self.assertEqual(formats[1]["description"], "Motion-JPEG, compressed")
        mjpg_720 = formats[1]["sizes"][1]
        self.assertEqual((mjpg_720["width"], mjpg_720["height"]), (1280, 720))
        self.assertEqual(mjpg_720["fps"], [30.0, 24.0, 20.0, 15.0, 10.0, 7.5, 5.0])

    def test_v4l2_formats_stepwise_and_continuous(self):
        yuyv, nv12, mjpg = probe.parse_v4l2_formats(fixture("v4l2_formats_stepwise_synthetic.txt"))
        self.assertEqual(yuyv["sizes"], [])
        self.assertEqual(list(yuyv["range"].values()), [16, 16, 1920, 1080, 16, 16])
        self.assertEqual((nv12["range"]["max_width"], nv12["range"]["step_width"]), (1280, 1))
        self.assertEqual([s["fps_range"] for s in mjpg["sizes"]], [[1.0, 60.0], [5.0, 30.0]])

    def test_fuser_output_ignores_access_letters(self):
        self.assertEqual(probe.parse_fuser_pids(" 1234m  5678\n"), [1234, 5678])

    def test_probe_source_parses_as_python_38(self):
        ast.parse(Path(probe.__file__).read_text(encoding="utf-8"), feature_version=(3, 8))


class ProbeCollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_devkit_without_sensor(self):
        output = devkit_board(self.tmp.name).collect()
        self.assertEqual(output["schema"], 1)
        self.assertEqual((output["mipi"], output["usb"]), ([], []))
        self.assertEqual(output["libcamerasrc"], {"present": True, "external_buffer_mode": True, "buffer_count": True})
        self.assertEqual(output["availability_method"], "proc-root")
        snapshot = snapshot_of(output)
        self.assertEqual(snapshot["items"], [])
        self.assertEqual(
            [(i["severity"], i["code"], i["message"]) for i in snapshot["issues"]],
            [("info", "no_sensor", "No MIPI sensor detected on /dev/media0 (platform:csi2video@1).")],
        )
        self.assertIn("ribbon cable", snapshot["issues"][0]["hint"])

    def test_real_devkit_probe_output_builds_an_empty_snapshot(self):
        snapshot = snapshot_of(json.loads(fixture("probe_devkit_no_sensor.json")))
        self.assertEqual(snapshot["platform"]["availability_method"], "sudo-fuser")
        self.assertEqual([i["code"] for i in snapshot["issues"]], ["no_sensor"])

    def test_isp_nodes_and_uvc_metadata_node_are_not_cameras(self):
        board = camera_board(self.tmp.name)
        output = board.collect()
        self.assertEqual([c["node"] for c in output["usb"]], ["/dev/video2"])
        probed = {call for call in board.calls if call[0] == "v4l2-ctl"}
        usb_queries = {("v4l2-ctl", "-d", "/dev/video2", "--info"), ("v4l2-ctl", "-d", "/dev/video2", "--list-formats-ext")}
        # The ISP output node is read once, for its output sizes, never probed as a camera.
        self.assertEqual(probed, usb_queries | {ISP_QUERY})
        usb = output["usb"][0]
        self.assertEqual(usb["by_id"], "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_A1B2C3D4-video-index0")
        self.assertEqual(usb["usb"]["bus_path"], "1-1.2")
        self.assertEqual(usb["usb"]["speed_mbps"], 480)

    def test_uvc_metadata_node_at_index_zero_is_dropped_by_caps(self):
        board = camera_board(self.tmp.name)
        (board.root / "sys/class/video4linux/video3/index").write_text("0\n")
        self.assertEqual([c["node"] for c in board.collect()["usb"]], ["/dev/video2"])

    def test_mipi_camera_is_enumerated_with_media_graph_placement(self):
        output = camera_board(self.tmp.name).collect()
        (camera,) = output["mipi"]
        self.assertEqual((camera["id"], camera["source"], camera["acquire"]), (IMX477, "libcamera", "ok"))
        self.assertEqual(camera["media_device"], "/dev/media0")
        self.assertEqual(camera["max_fps"], 30.0)
        self.assertEqual([f["format"] for f in camera["formats"]], ["SRGGB12", "NV12", "RGB888"])

    def test_process_holding_the_camera_skips_cam_info(self):
        board = camera_board(self.tmp.name, usb=False)
        board.hold(4321, "gst-launch-1.0", "/dev/media0", "/dev/null")
        output = board.collect()
        camera = output["mipi"][0]
        self.assertEqual(camera["users"], [{"pid": 4321, "command": "gst-launch-1.0"}])
        self.assertEqual(camera["acquire"], "skipped")
        self.assertNotIn(("cam", "-c", IMX477, "-I"), board.calls)
        availability = item(snapshot_of(output), "mipi:" + IMX477)["availability"]
        self.assertEqual(availability["state"], "in_use")
        self.assertIn("gst-launch-1.0 (pid 4321)", availability["reason"])

    def test_acquire_failure_is_authoritative_in_use(self):
        output = camera_board(self.tmp.name, cam_info="cam_info_busy_synthetic.txt", usb=False).collect()
        self.assertEqual(output["mipi"][0]["acquire"], "busy")
        camera = item(snapshot_of(output), "mipi:" + IMX477)
        self.assertEqual(camera["availability"]["state"], "in_use")
        self.assertEqual((camera["modes_source"], camera["errors"][0]["code"]), ("unavailable", "camera_in_use"))

    def test_sudo_fuser_reports_users_of_other_accounts(self):
        board = camera_board(self.tmp.name)
        board.euid = 1000
        board.command("sudo", "-n", "true")
        board.command("sudo", "-n", "/usr/bin/fuser", "/dev/video2", out=" 777m", err="/dev/video2:")
        board.hold(777, "ffmpeg")
        output = board.collect()
        self.assertEqual(output["availability_method"], "sudo-fuser")
        self.assertEqual(output["usb"][0]["users"], [{"pid": 777, "command": "ffmpeg"}])

    def test_without_root_or_sudo_idle_cameras_are_unknown(self):
        board = camera_board(self.tmp.name)
        board.euid = 1000
        board.command("sudo", "-n", "true", code=1, err="sudo: a password is required")
        output = board.collect()
        self.assertEqual(output["availability_method"], "proc-user")
        snapshot = snapshot_of(output)
        usb = item(snapshot, "usb:046d:082d:A1B2C3D4")["availability"]
        self.assertEqual((usb["state"], usb["reason"]), ("unknown", cameras.UNKNOWN_USERS_REASON))
        # cam -I still acquired the MIPI camera, which proves nobody holds it.
        self.assertEqual(item(snapshot, "mipi:" + IMX477)["availability"]["state"], "available")
        self.assertIn("availability_limited", [i["code"] for i in snapshot["issues"]])

    def test_sensor_in_media_graph_without_cam_tool(self):
        board = camera_board(self.tmp.name, usb=False)
        board.tools["cam"] = None
        snapshot = snapshot_of(board.collect())
        camera = item(snapshot, "mipi:" + IMX477)
        self.assertEqual(camera["device"]["camera_name_source"], "media-graph")
        self.assertEqual(camera["device"]["csi"], "csidev-40c3000.csi")
        self.assertEqual((camera["modes_source"], camera["errors"][0]["code"]), ("unavailable", "tool_missing"))
        self.assertIn("tool_missing", [i["code"] for i in snapshot["issues"]])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_imx477_tiers_formats_and_default(self):
        camera = item(snapshot_of(camera_board(self.tmp.name).collect()), "mipi:" + IMX477)
        self.assertEqual(camera["support"]["tier"], "verified")
        self.assertEqual((camera["model"], camera["device"]["bus_info"]), ("imx477", "platform:csi2video@1"))
        nv12 = fmt_of(camera, "NV12")
        self.assertTrue(nv12["exportable"])
        fps_1080 = size_of(nv12, 1920, 1080)["fps"]
        self.assertEqual([c["value"] for c in fps_1080], [30, 25, 20, 15, 10, 5])
        self.assertEqual(fps_1080[0], {"value": 30, "tier": "verified"})
        # The ISP outputs 1920x1080 and 2048x1080 only; the synthetic sensor lists just the first.
        self.assertEqual([(s["width"], s["height"]) for s in nv12["sizes"]], [(1920, 1080)])
        rgb = fmt_of(camera, "RGB888")
        self.assertEqual((rgb["exportable"], rgb["support"]["tier"]), (False, "unsupported"))
        self.assertIn("NV12 only", rgb["support"]["reason"])
        self.assertEqual(fmt_of(camera, "SRGGB12")["support"]["reason"], cameras.RAW_REASON)
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})

    def test_unvalidated_sensor_is_advertised(self):
        board = camera_board(self.tmp.name, usb=False)
        board.media("media0", fixture("media_ctl_imx477_synthetic.txt").replace(IMX477, "econ-imx568-fpga 5-0042"))
        board.command("cam", "-l", out="Available cameras:\n1: 'econ-imx568-fpga' (econ-imx568-fpga 5-0042)\n")
        board.command("cam", "-c", "econ-imx568-fpga 5-0042", "-I", text=fixture("cam_info_imx568.txt"))
        camera = item(snapshot_of(board.collect()), "mipi:econ-imx568-fpga 5-0042")
        self.assertEqual(camera["support"]["tier"], "advertised")
        self.assertEqual(camera["support"]["links"][0]["url"], "https://github.com/sima-neat/core/issues/883")
        nv12 = fmt_of(camera, "NV12")
        self.assertEqual({c["tier"] for s in nv12["sizes"] for c in s["fps"]}, {"advertised"})
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertIn("29.9742 fps", camera["notes"][0])

    def test_real_imx477_rate_limit_is_described_as_the_fastest_mode(self):
        snapshot = snapshot_of(real_imx477_board(self.tmp.name).collect())
        camera = item(snapshot, "mipi:" + IMX477)
        self.assertEqual((camera["support"]["tier"], camera["default_selection"]["fps"]), ("verified", 30))
        self.assertIn("66.1857 fps for the sensor's fastest mode", camera["notes"][0])
        largest = max(fmt_of(camera, "NV12")["sizes"], key=lambda s: s["width"] * s["height"])
        request = {"id": camera["id"], "format": "NV12", "width": largest["width"], "height": largest["height"]}
        rendered = export.render(snapshot, dict(request, fps=60))
        self.assertEqual(rendered["support"]["tier"], "advertised")
        # The tier says "advertised" on its own; the export adds no paragraph repeating it.
        self.assertFalse(any("advertised by libcamera" in warning for warning in rendered["warnings"]))

    def test_real_imx477_offers_only_sizes_the_isp_outputs(self):
        board = real_imx477_board(self.tmp.name)
        output = board.collect()
        self.assertEqual(board.calls.count(ISP_QUERY), 1)
        isp = output["isp"]
        self.assertEqual((isp["nodes"], isp["reason"], isp["differs"]), (["/dev/video0out"], None, False))
        self.assertEqual([(s["width"], s["height"]) for s in isp["sizes"]], [(1920, 1080), (2048, 1080), (2432, 2048)])
        snapshot = snapshot_of(output)
        camera = item(snapshot, "mipi:" + IMX477)
        for name in ("NV12", "BGR888", "RGB888", "YUYV"):
            sizes = {(s["width"], s["height"]) for s in fmt_of(camera, name)["sizes"]}
            self.assertEqual(sizes, {(1920, 1080), (2048, 1080)}, name)
        # Raw Bayer is captured before the ISP, so its sensor sizes stay as reported.
        self.assertEqual(len(fmt_of(camera, "SRGGB12")["sizes"]), 20)
        fps = [c["value"] for c in size_of(fmt_of(camera, "NV12"), 2048, 1080)["fps"]]
        self.assertEqual(fps, cameras.fps_choices(66.1857))
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertIn("Only sizes the ISP can output (1920x1080, 2048x1080, 2432x2048)", camera["notes"][1])
        self.assertNotIn("isp_sizes_unavailable", [i["code"] for i in snapshot["issues"]])

    def test_isp_nodes_that_disagree_offer_the_sizes_common_to_all(self):
        board = real_imx477_board(self.tmp.name)
        board.video_node("video1out", "platform/4220000.isp", 7, "isp_v4l2-vid-cap-out")
        only_1080p = "\n".join(
            line for line in fixture("v4l2_isp_out_real.txt").splitlines() if "2048x1080" not in line
        )
        board.command("v4l2-ctl", "-d", "/dev/video1out", "--info", "--list-formats-ext", out=only_1080p)
        output = board.collect()
        self.assertEqual((output["isp"]["nodes"], output["isp"]["differs"]), (["/dev/video0out", "/dev/video1out"], True))
        camera = item(snapshot_of(output), "mipi:" + IMX477)
        self.assertEqual([(s["width"], s["height"]) for s in fmt_of(camera, "NV12")["sizes"]], [(1920, 1080)])

    def test_default_is_an_offered_size_when_the_isp_drops_1080p(self):
        board = real_imx477_board(self.tmp.name)
        no_1080p = "\n".join(line for line in fixture("v4l2_isp_out_real.txt").splitlines() if "1920x1080" not in line)
        board.command(*ISP_QUERY, out=no_1080p)
        camera = item(snapshot_of(board.collect()), "mipi:" + IMX477)
        self.assertEqual([(s["width"], s["height"]) for s in fmt_of(camera, "NV12")["sizes"]], [(2048, 1080)])
        self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 2048, "height": 1080, "fps": 66})

    def test_unreadable_isp_sizes_fall_back_to_libcamera_sizes_with_a_warning(self):
        info_only = fixture("v4l2_isp_out_real.txt").split("ioctl:")[0]
        other_card = fixture("v4l2_isp_out_real.txt").replace("arm-isp-out", "arm-isp-raw")
        cases = {
            "tool_missing": ("`v4l2-ctl` was not found", None),
            "no_nodes": ("no ISP output node (arm-isp-out) was found", other_card),
            "failed": ("failed: Cannot open device /dev/video0out: Permission denied", "denied"),
            "timeout": ("timed out", "timeout"),
            "unparseable": ("listed no discrete sizes", info_only),
        }
        for reason, (cause, answer) in cases.items():
            with self.subTest(reason=reason):
                root = Path(self.tmp.name) / reason
                root.mkdir()
                board = real_imx477_board(root)
                if reason == "tool_missing":
                    board.tools["v4l2-ctl"] = None
                elif answer == "denied":
                    board.command(*ISP_QUERY, code=2, err="Cannot open device /dev/video0out: Permission denied")
                elif answer == "timeout":
                    board.command(*ISP_QUERY, code=None, err="timed out after 10 s")
                else:
                    board.command(*ISP_QUERY, out=answer)
                output = board.collect()
                self.assertEqual((output["isp"]["reason"], output["isp"]["sizes"]), (reason, None))
                snapshot = snapshot_of(output)
                camera = item(snapshot, "mipi:" + IMX477)
                self.assertEqual(camera["modes_source"], "live")
                self.assertEqual(len(fmt_of(camera, "NV12")["sizes"]), 49)
                self.assertEqual(len(camera["notes"]), 1)
                self.assertEqual(camera["default_selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
                issue = next(i for i in snapshot["issues"] if i["code"] == "isp_sizes_unavailable")
                self.assertEqual(issue["severity"], "warning")
                self.assertIn(cause, issue["message"])
                self.assertIn("offer every size libcamera advertises", issue["message"])

    def test_isp_is_not_read_without_camera_modes(self):
        board = devkit_board(self.tmp.name)
        output = board.collect()
        self.assertIsNone(output["isp"])
        self.assertNotIn(ISP_QUERY, board.calls)
        busy = camera_board(Path(self.tmp.name) / "busy", cam_info="cam_info_busy_synthetic.txt", usb=False)
        self.assertIsNone(busy.collect()["isp"])

    def test_permission_failures_name_the_video_group(self):
        board = camera_board(self.tmp.name, usb=False)
        board.media("media0", fixture("media_ctl_imx477_synthetic.txt"))
        board.command("media-ctl", "-d", "/dev/media0", "-p", code=1, err="Failed to open /dev/media0: Permission denied")
        board.command("cam", "-c", IMX477, "-I", code=1, err="Failed to open /dev/video0: Permission denied")
        snapshot = snapshot_of(board.collect())
        issue = next(i for i in snapshot["issues"] if i["code"] == "permission_denied")
        self.assertEqual(issue["hint"], cameras.PERMISSION_HINT)
        self.assertEqual(item(snapshot, "mipi:" + IMX477)["errors"][0]["code"], "permission_denied")

    def test_out_of_time_camera_and_tool_point_at_slow_tools(self):
        output = camera_board(self.tmp.name, usb=False).collect()
        output["mipi"][0].update(acquire="out_of_time", formats=[])
        output["failures"] = [{"tool": "cam", "reason": "out_of_time", "detail": probe.OUT_OF_TIME}]
        snapshot = snapshot_of(output)
        error = item(snapshot, "mipi:" + IMX477)["errors"][0]
        self.assertEqual((error["code"], error["hint"]), ("timeout", cameras.OUT_OF_TIME_HINT))
        issue = next(i for i in snapshot["issues"] if i["code"] == "timeout")
        self.assertIn("ran out of time", issue["message"])
        self.assertNotIn("reboot", issue["hint"] + error["hint"])

    def test_unchecked_libcamerasrc_is_unknown_not_absent(self):
        output = camera_board(self.tmp.name, usb=False).collect()
        output["libcamerasrc"] = None
        snapshot = snapshot_of(output)
        self.assertIsNone(snapshot["platform"]["libcamerasrc"])
        request = {"id": "mipi:" + IMX477, "format": "NV12", "width": 1920, "height": 1080, "fps": 30}
        rendered = export.render(snapshot, request)
        descriptor = json.loads(next(e for e in rendered["exports"] if e["id"] == "json")["content"])
        self.assertEqual(descriptor["capture_buffer_count"], 0)
        self.assertIn(cameras.UNCHECKED_LIBCAMERASRC_REASON, rendered["warnings"])
        self.assertNotIn("missing", cameras.UNCHECKED_LIBCAMERASRC_REASON)

    def test_usb_modes_skipped_by_the_time_budget_point_at_slow_tools(self):
        output = camera_board(self.tmp.name).collect()
        output["usb"][0].update(formats=None, detail=probe.OUT_OF_TIME)
        camera = next(entry for entry in snapshot_of(output)["items"] if entry["connection"] == "usb")
        self.assertEqual((camera["errors"][0]["code"], camera["errors"][0]["hint"]), ("timeout", cameras.OUT_OF_TIME_HINT))

    def test_fps_choices_follow_the_rate_limit(self):
        self.assertEqual(cameras.fps_choices(59.94), [60, 30, 25, 20, 15, 10, 5])
        self.assertEqual(cameras.fps_choices(29.9742)[0], 30)
        self.assertEqual(cameras.fps_choices(24.0), [24, 20, 15, 10, 5])
        self.assertEqual(cameras.fps_choices(66.1857)[:3], [66, 60, 30])
        self.assertEqual(cameras.fps_choices(None), [30])

    def test_unknown_max_fps_offers_30_with_a_note(self):
        output = camera_board(self.tmp.name, usb=False).collect()
        output["mipi"][0]["max_fps"] = None
        camera = item(snapshot_of(output), "mipi:" + IMX477)
        self.assertEqual([c["value"] for c in size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"]], [30])
        self.assertIn("did not report a maximum frame rate", camera["notes"][0])

    def test_missing_libcamerasrc_makes_mipi_unsupported(self):
        board = camera_board(self.tmp.name, usb=False)
        board.command("gst-inspect-1.0", "libcamerasrc", code=1, err="No such element or plugin 'libcamerasrc'")
        snapshot = snapshot_of(board.collect())
        camera = item(snapshot, "mipi:" + IMX477)
        self.assertEqual(camera["support"]["tier"], "unsupported")
        self.assertEqual(size_of(fmt_of(camera, "NV12"), 1920, 1080)["fps"][0]["tier"], "unsupported")
        self.assertIn(("error", "tool_missing"), [(i["severity"], i["code"]) for i in snapshot["issues"]])

    def test_usb_camera_is_unsupported_with_format_notes(self):
        camera = item(snapshot_of(camera_board(self.tmp.name).collect()), "usb:046d:082d:A1B2C3D4")
        self.assertEqual((camera["connection"], camera["name"]), ("usb", "HD Pro Webcam C920"))
        self.assertEqual(camera["support"]["tier"], "unsupported")
        self.assertEqual(camera["support"]["links"], [cameras.CORE_838])
        mjpg = fmt_of(camera, "MJPG")
        self.assertTrue(mjpg["exportable"])
        self.assertIn(cameras.CORE_903, mjpg["support"]["links"])
        self.assertIn(cameras.INTERNALS_244, fmt_of(camera, "YUYV")["support"]["links"])
        self.assertEqual([c["value"] for c in size_of(mjpg, 640, 480)["fps"]], [30, 24, 20, 15, 10, 7.5, 5])
        self.assertEqual(camera["default_selection"], {"format": "MJPG", "width": 1280, "height": 720, "fps": 30})
        self.assertEqual(camera["availability"]["state"], "available")

    def test_usb_camera_without_serial_or_by_id(self):
        board = camera_board(self.tmp.name)
        (board.root / "sys/devices/platform/xhci-hcd.0.auto/usb1/1-1.2/serial").unlink()
        for link in (board.root / "dev/v4l/by-id").iterdir():
            link.unlink()
        camera = snapshot_of(board.collect())["items"][1]
        self.assertEqual(camera["id"], "usb:046d:082d:1-1.2")
        self.assertNotIn("by_id", camera["device"])
        self.assertIn("/dev/videoN numbering", camera["notes"][0])


class FakeSession:
    def __init__(self, generation: int, transport, fingerprint: str = "fp-1"):
        self.generation = generation
        self.transport = transport
        self.target = SimpleNamespace(mode="ssh", source="manual", label="sima@192.168.2.2")
        self.fingerprint = fingerprint

    def identity(self):
        return {"hostname": "modalix", "machine": "modalix", "build_version": "2.1.3", "fingerprint": self.fingerprint}


class FakeManager:
    def __init__(self):
        self.current = None
        self.error = None

    def session(self):
        if self.error:
            raise self.error
        return self.current


class ProbeTransport:
    """Answers `python3 -` with queued probe output, ExecResults, or errors."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append((argv, timeout, stdin))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, ExecResult):
            return response
        return ExecResult(0, json.dumps(response).encode(), b"")


class PeripheralsApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        scans = mock.patch.object(api, "scans", cameras.ScanCache())
        scans.start()
        self.addCleanup(scans.stop)
        self.manager = FakeManager()
        app = Flask(__name__)
        app.register_blueprint(peripherals_bp)
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def use(self, *responses, generation: int = 1, fingerprint: str = "fp-1") -> ProbeTransport:
        transport = ProbeTransport(*responses)
        self.manager.current = FakeSession(generation, transport, fingerprint)
        return transport

    def board(self, name: str, **kwargs) -> dict:
        root = Path(self.tmp.name) / name
        root.mkdir()
        return camera_board(root, **kwargs).collect()

    def refresh(self):
        return self.client.post("/api/peripherals/refresh")

    def export(self, **body):
        body = {"id": "mipi:" + IMX477, "format": "NV12", "width": 1920, "height": 1080, "fps": 30, **body}
        return self.client.post("/api/peripherals/cameras/export", json=body)

    def test_scan_responses_are_not_cached(self):
        self.use()
        self.assertEqual(self.client.get("/api/peripherals").headers["Cache-Control"], "no-store")

    def test_get_before_refresh_is_empty_and_never_connects(self):
        transport = self.use()
        response = self.client.get("/api/peripherals")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual((body["scanned_at"], body["items"], body["changes"], body["platform"]), (None, [], None, None))
        self.assertEqual(body["board"]["label"], "sima@192.168.2.2")
        self.assertEqual(transport.calls, [])

    def test_refresh_runs_the_probe_over_the_board_transport(self):
        transport = self.use(self.board("a"))
        response = self.refresh()
        self.assertEqual(response.status_code, 200)
        argv, timeout, stdin = transport.calls[0]
        self.assertEqual((argv, timeout), (["python3", "-"], 90))
        self.assertEqual(stdin, Path(probe.__file__).read_bytes())
        snapshot = response.get_json()
        self.assertEqual(snapshot["board"]["fingerprint"], "fp-1")
        self.assertEqual([i["id"] for i in snapshot["items"]], ["mipi:" + IMX477, "usb:046d:082d:A1B2C3D4"])
        self.assertIsNone(snapshot["changes"])
        self.assertEqual(self.client.get("/api/peripherals").get_json(), snapshot)

    def test_refresh_reflects_removal_and_reconnection(self):
        present = self.board("a", usb=False)
        absent = dict(present, mipi=[])
        self.use(present, absent, present)
        self.refresh()
        removed = self.refresh().get_json()["changes"]
        self.assertEqual(removed, {"added": [], "removed": [{"id": "mipi:" + IMX477, "name": IMX477}]})
        added = self.refresh().get_json()["changes"]
        self.assertEqual(added, {"added": [{"id": "mipi:" + IMX477, "name": IMX477}], "removed": []})

    def test_busy_camera_keeps_modes_from_the_previous_scan(self):
        self.use(self.board("a", usb=False), self.board("b", usb=False, cam_info="cam_info_busy_synthetic.txt"))
        first = self.refresh().get_json()["items"][0]
        second = self.refresh().get_json()["items"][0]
        self.assertEqual(second["modes_source"], "previous-scan")
        self.assertEqual(second["formats"], first["formats"])
        self.assertEqual(second["default_selection"], first["default_selection"])
        self.assertEqual(second["availability"]["state"], "in_use")
        self.assertIn("could not be read during this refresh", second["notes"][0])
        warnings = self.export().get_json()["warnings"]
        self.assertTrue(any("earlier scan" in w for w in warnings))
        self.assertIn("The camera is in use by another process; CameraInput cannot acquire it until it is released.", warnings)

    def test_in_use_warning_names_the_holding_processes(self):
        self.use(self.board("a", usb=False))
        snapshot = self.refresh().get_json()
        snapshot["items"][0]["availability"] = {
            "state": "in_use",
            "users": [{"pid": 4242, "command": "gst-launch-1.0"}],
            "reason": "Open in gst-launch-1.0 (pid 4242).",
        }
        request = {"id": "mipi:" + IMX477, "format": "NV12", "width": 1920, "height": 1080, "fps": 30}
        warnings = export.render(snapshot, request)["warnings"]
        self.assertIn(
            "The camera is in use by gst-launch-1.0 (pid 4242); CameraInput cannot acquire it until it is released.",
            warnings,
        )

    def test_modes_are_not_carried_across_boards(self):
        self.use(self.board("a", usb=False))
        self.refresh()
        self.use(self.board("b", usb=False, cam_info="cam_info_busy_synthetic.txt"), fingerprint="fp-2")
        snapshot = self.refresh().get_json()
        self.assertEqual(snapshot["items"][0]["modes_source"], "unavailable")
        self.assertIsNone(snapshot["changes"])

    def test_export_mipi_renders_core_shapes(self):
        self.use(self.board("a"))
        self.refresh()
        response = self.export()
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["selection"], {"format": "NV12", "width": 1920, "height": 1080, "fps": 30})
        self.assertEqual(body["support"]["tier"], "verified")
        warnings = body["warnings"]
        # A board that can do zero-copy, on a verified mode, has nothing to warn about beyond the
        # measured rate: the advertised-mode and CPU-fallback paragraphs were noise on every export.
        self.assertIn("delivered about 66 fps", warnings[0])
        self.assertEqual(len(warnings), 1)
        exports = {e["id"]: e for e in body["exports"]}
        self.assertEqual(list(exports), ["python", "cpp", "yaml", "json"])

        python = exports["python"]["content"]
        compile(python, "camera_input.py", "exec")
        for line in (
            "camera.camera_name = 'imx477 5-001a'",
            "camera.framerate_num = 30",
            "camera.framerate_den = 1",
            "camera.buffer_name = 'camera0'",
            "camera.allow_cpu_fallback = True",
            "graph.add(pyneat.nodes.camera_input(camera, capture_buffer_count=32))",
        ):
            self.assertIn(line, python)

        cpp = exports["cpp"]["content"]
        self.assertEqual(cpp.count("{"), cpp.count("}"))
        self.assertIn('camera.camera_name = "imx477 5-001a";', cpp)
        self.assertIn("graph.add(neat::nodes::CameraInputWithCaptureBuffers(camera, 32));", cpp)

        self.assertEqual(
            parse_yaml_block(exports["yaml"]["content"]),
            {
                "name": IMX477,
                "width": 1920,
                "height": 1080,
                "fps_num": 30,
                "fps_den": 1,
                "format": "NV12",
                "capture_buffers": 32,
                "strict_zero_copy": False,
                "queue_depth": 2,
            },
        )
        descriptor = json.loads(exports["json"]["content"])
        self.assertEqual((descriptor["kind"], descriptor["version"]), ("neat.camera-input", 1))
        self.assertEqual(descriptor["options"]["camera_name"], IMX477)

    def test_export_escapes_device_strings_and_follows_libcamerasrc_features(self):
        output = self.board("a", usb=False)
        hostile = 'cam"\n\\ 5-001a'
        output["mipi"][0]["id"] = hostile
        output["libcamerasrc"].update(external_buffer_mode=False, buffer_count=False)
        self.use(output)
        self.refresh()
        body = self.export(id="mipi:" + hostile).get_json()
        exports = {e["id"]: e["content"] for e in body["exports"]}
        self.assertEqual(list(exports), ["python", "cpp", "json"])
        namespace = {}
        code = compile(exports["python"].replace("import pyneat", ""), "export", "exec")
        exec(code, {"pyneat": _FakePyneat()}, namespace)
        self.assertEqual(namespace["camera"].camera_name, hostile)
        self.assertTrue(namespace["camera"].allow_cpu_fallback)
        self.assertIn("neat::nodes::CameraInput(camera)", exports["cpp"])
        self.assertNotIn("\n\\ 5", exports["cpp"])
        self.assertEqual(body["support"]["tier"], "advertised")
        self.assertEqual(len(body["warnings"]), 2)
        self.assertTrue(any("strict zero-copy is unavailable" in w for w in body["warnings"]))

    def test_export_for_media_graph_name_warns_to_confirm_it(self):
        root = Path(self.tmp.name) / "a"
        root.mkdir()
        board = camera_board(root, usb=False)
        board.tools["cam"] = None
        self.use(self.board("b", usb=False), board.collect())
        self.refresh()
        self.refresh()
        warnings = self.export().get_json()["warnings"]
        self.assertTrue(any("cam -l" in w for w in warnings))

    def test_export_usb_emits_descriptors_only(self):
        self.use(self.board("a"))
        self.refresh()
        response = self.export(id="usb:046d:082d:A1B2C3D4", format="MJPG", width=1280, height=720, fps=7.5)
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual([e["id"] for e in body["exports"]], ["yaml", "json"])
        self.assertEqual(body["support"]["tier"], "unsupported")
        descriptor = json.loads(body["exports"][1]["content"])
        self.assertEqual((descriptor["kind"], descriptor["core_support"]), ("v4l2-camera", "unsupported"))
        self.assertEqual(descriptor["device"], "/dev/v4l/by-id/usb-046d_HD_Pro_Webcam_C920_A1B2C3D4-video-index0")
        self.assertEqual((descriptor["framerate_num"], descriptor["framerate_den"]), (15, 2))
        yaml_values = parse_yaml_block(body["exports"][0]["content"])
        self.assertEqual((yaml_values["core_support"], yaml_values["format"]), ("unsupported", "MJPG"))
        self.assertTrue(any("core#903" in w for w in body["warnings"]))

    def test_export_usb_without_by_id_warns_about_node_numbering(self):
        output = self.board("a")
        output["usb"][0]["by_id"] = None
        self.use(output)
        self.refresh()
        body = self.export(id="usb:046d:082d:A1B2C3D4", format="YUYV", width=640, height=480, fps=30).get_json()
        self.assertEqual(json.loads(body["exports"][1]["content"])["device"], "/dev/video2")
        self.assertTrue(any("not stable" in w for w in body["warnings"]))

    def test_export_refuses_sizes_the_isp_cannot_output(self):
        root = Path(self.tmp.name) / "real"
        root.mkdir()
        self.use(real_imx477_board(root).collect())
        self.refresh()
        self.assertEqual(self.export(width=2048, height=1080).status_code, 200)
        for width, height in ((1280, 720), (3840, 2160)):
            with self.subTest(size=f"{width}x{height}"):
                response = self.export(width=width, height=height)
                self.assertEqual(response.status_code, 400)
                body = response.get_json()
                self.assertEqual((body["code"], body["hint"]), ("invalid_request", export.MODE_HINT))
                self.assertIn(f"{width}x{height} at 30 fps is not a mode this camera reported", body["error"])

    def test_export_rejects_invalid_requests(self):
        self.use(self.board("a"))
        self.refresh()
        cases = (
            ({"fps": None}, 400),
            ({"width": True}, 400),
            ({"format": "RGB888"}, 400),
            ({"width": 1234}, 400),
            ({"fps": 60}, 400),
            ({"id": "mipi:nope"}, 404),
        )
        for body, status in cases:
            with self.subTest(body=body):
                response = self.export(**body)
                self.assertEqual(response.status_code, status)
                self.assertIn(response.get_json()["code"], {"invalid_request", "not_found"})
        self.assertIn("NV12 only", self.export(format="RGB888").get_json()["error"])

    def test_export_is_stale_after_the_board_changes(self):
        self.use()
        self.assertEqual(self.export().status_code, 409)
        self.use(self.board("a"))
        self.refresh()
        self.use(generation=2)
        response = self.export()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.client.get("/api/peripherals").get_json()["scanned_at"], None)

    def test_board_errors_pass_through(self):
        self.use(BoardError("unreachable", "Cannot reach sima@192.168.2.2.", hint="Check the cable."))
        response = self.refresh()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.get_json(),
            {"error": "Cannot reach sima@192.168.2.2.", "code": "unreachable", "hint": "Check the cable."},
        )
        self.manager.error = BoardError("no_target", "No board is selected.")
        self.assertEqual(self.client.get("/api/peripherals").status_code, 409)

    def test_missing_python3_and_unreadable_output(self):
        self.use(ExecResult(127, b"", b"sh: python3: not found"), ExecResult(0, b"Traceback", b""))
        missing = self.refresh()
        self.assertEqual(missing.status_code, 502)
        self.assertEqual((missing.get_json()["code"], missing.get_json()["tool"]), ("tool_missing", "python3"))
        self.assertEqual(self.refresh().get_json()["code"], "command_failed")

    def test_concurrent_refreshes_share_one_probe_run(self):
        started, release = threading.Event(), threading.Event()
        output = self.board("a")

        class SlowTransport(ProbeTransport):
            def exec(self, argv, *, timeout, stdin=None):
                started.set()
                release.wait(5)
                return super().exec(argv, timeout=timeout, stdin=stdin)

        transport = SlowTransport(output, output)
        self.manager.current = FakeSession(1, transport)
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
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(results[0], results[1])


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
