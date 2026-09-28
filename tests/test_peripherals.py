import json
import os
import tempfile
import threading
import unittest
import unittest.mock as mock
from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from neat_insight.board import BoardError, ExecResult
from neat_insight.peripherals import api, cameras, export, probe
from neat_insight.peripherals.api import peripherals_bp

IMX477 = "imx477 5-001a"
DEVKIT_OF_NODE = "/base/i2cmux@0/i2c@0/imx477@1a"
MEDIA_CTL = (
    "bus info        platform:csi2video@1\n"
    "- entity 25: imx477 5-001a (1 pad, 1 link, 0 routes)\n"
    "             type V4L2 subdev subtype Sensor flags 0\n"
    "             device node name /dev/v4l-subdev0\n"
)
CAM_INFO = "0: 1920x1080-NV12/Unset\n * Pixelformat: NV12 (48x32)-(4056x3040)/(+2,+2)\n  - 1920x1080\n"
CAM_BUSY = "Failed to acquire camera imx477 5-001a\n"
GST_INSPECT = "Element Properties:\n  buffer-count        : depth\n  external-buffer-mode: mode\n"
V4L2_INFO = "Driver Info:\n\tDevice Caps      : 0x04200001\n\t\tVideo Capture\n\t\tStreaming\n"
V4L2_FORMATS = "\t[0]: 'MJPG' (Motion-JPEG, compressed)\n\t\tSize: Discrete 1280x720\n\t\t\tInterval: Discrete 0.033s (30.000 fps)\n"


class FakeBoard:
    """A temporary sysfs/proc/dev tree plus canned tool output for probe.collect()."""

    def __init__(self, root):
        self.root = Path(root)
        for sub in ("sys/class/video4linux", "sys/devices/platform", "proc", "dev"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        self.tools = {name: f"/usr/bin/{name}" for name in probe.TOOLS}
        self.outputs = {}
        self.calls = []
        self.command("gst-inspect-1.0", "libcamerasrc", out=GST_INSPECT)

    def command(self, *argv, code=0, out="", err=""):
        self.outputs[argv] = (code, out, err)

    def run(self, argv, timeout=probe.COMMAND_TIMEOUT):
        key = (os.path.basename(argv[0]),) + tuple(argv[1:])
        self.calls.append(key)
        return self.outputs.get(key, (1, "", f"unexpected command {key}"))

    def media(self, name: str, text: str):
        (self.root / "dev" / name).touch()
        self.command("media-ctl", "-d", f"/dev/{name}", "-p", out=text)

    def webcam(self, node: str, bus_path: str, serial: str = "A1B2C3D4"):
        usb = self.root / "sys/devices/platform/xhci-hcd.0.auto/usb1" / bus_path
        usb.mkdir(parents=True)
        for key, value in {"idVendor": "046d", "idProduct": "082d", "product": "HD Pro Webcam C920", "serial": serial}.items():
            (usb / key).write_text(f"{value}\n")
        (usb / f"{bus_path}:1.0").mkdir()
        entry = self.root / "sys/class/video4linux" / node
        entry.mkdir()
        (entry / "device").symlink_to(usb / f"{bus_path}:1.0")
        (entry / "index").write_text("0\n")
        self.command("v4l2-ctl", "-d", f"/dev/{node}", "--info", out=V4L2_INFO)
        self.command("v4l2-ctl", "-d", f"/dev/{node}", "--list-formats-ext", out=V4L2_FORMATS)

    def i2c_sensor(self, client: str, of_node, subdev=None, adapter="platform/sio@5/4059000.i2c/i2c-4"):
        """An I2C sensor client as the kernel links it: bus/i2c/devices/<client>, its of_node, its subdevice."""
        sys = self.root / "sys"
        device = sys / "devices" / adapter / f"i2c-{client.split('-')[0]}" / client
        device.mkdir(parents=True)
        links = sys / "bus" / "i2c" / "devices"
        links.mkdir(parents=True, exist_ok=True)
        (links / client).symlink_to(os.path.relpath(device, links))
        node = sys / "firmware" / "devicetree" / of_node.lstrip("/")
        node.mkdir(parents=True)
        (device / "of_node").symlink_to(os.path.relpath(node, device))
        if subdev:
            entry = sys / "class" / "video4linux" / subdev
            entry.mkdir()
            (entry / "device").symlink_to(os.path.relpath(device, entry))

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
            probe.os, "geteuid", return_value=0
        ):
            return json.loads(json.dumps(probe.collect()))


def camera_board(root, camera_id: str = IMX477, cam_list: str = None, cam_info: str = CAM_INFO) -> FakeBoard:
    """An imx477 on CSI that libcamera lists as `camera_id`."""
    board = FakeBoard(root)
    board.media("media0", MEDIA_CTL)
    board.command("cam", "-l", out=cam_list or f"Available cameras:\n1: 'imx477' ({camera_id})\n")
    board.command("cam", "-c", camera_id, "-I", out=cam_info)
    return board


BOARD = {"label": "sima@192.168.2.2", "source": "manual", "fingerprint": "fp-1"}


def snapshot_of(probe_output: dict) -> dict:
    return cameras.build_snapshot(probe_output, BOARD, 1, None, 5)[0]


def item(snapshot: dict, item_id: str) -> dict:
    return next(entry for entry in snapshot["items"] if entry["id"] == item_id)


def nv12(camera: dict) -> dict:
    return next(entry for entry in camera["formats"] if entry["format"] == "NV12")


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_usb_nodes_are_not_guessed_without_v4l2_ctl(self):
        board = FakeBoard(self.tmp.name)
        board.webcam("video2", "1-1.2")
        board.tools["v4l2-ctl"] = None
        self.assertEqual(board.collect()["usb"], [])

    def test_usb_node_is_not_guessed_when_capabilities_cannot_be_read(self):
        board = FakeBoard(self.tmp.name)
        board.webcam("video2", "1-1.2")
        board.command("v4l2-ctl", "-d", "/dev/video2", "--info", code=1, err="Cannot open device /dev/video2: Permission denied")
        output = board.collect()
        self.assertEqual(output["usb"], [])
        failure = next(f for f in output["failures"] if f["tool"] == "v4l2-ctl")
        self.assertIn("Permission denied", failure["detail"])

    def test_usb_ids_include_topology_when_serials_are_cloned(self):
        board = FakeBoard(self.tmp.name)
        board.webcam("video2", "1-1.2")
        board.webcam("video4", "1-1.3")
        ids = [entry["id"] for entry in snapshot_of(board.collect())["items"]]
        self.assertEqual(ids, ["usb:046d:082d:A1B2C3D4:1-1.2", "usb:046d:082d:A1B2C3D4:1-1.3"])

    def test_stepwise_usb_intervals_offer_and_export_only_rates_on_the_step(self):
        board = FakeBoard(self.tmp.name)
        board.webcam("video2", "1-1.2")
        board.command(
            "v4l2-ctl", "-d", "/dev/video2", "--list-formats-ext",
            out="\t[0]: 'MJPG' (Motion-JPEG, compressed)\n"
            "\t\tSize: Discrete 1280x720\n\t\t\tInterval: Continuous 0.017s - 1.000s (1.000-60.000 fps)\n"
            "\t\tSize: Discrete 640x480\n\t\t\tInterval: Stepwise 0.033s - 0.200s with step 0.033s (5.000-30.000 fps)\n",
        )
        snapshot = snapshot_of(board.collect())
        camera = snapshot["items"][0]
        rates = {(s["width"], s["height"]): [c["value"] for c in s["fps"]] for s in camera["formats"][0]["sizes"]}
        self.assertEqual(rates, {(1280, 720): [60, 30, 25, 20, 15, 10, 5], (640, 480): [30, 15, 10, 5]})
        request = {"id": camera["id"], "format": "MJPG", "width": 640, "height": 480}
        self.assertEqual(export.render(snapshot, {**request, "fps": 15})["selection"]["fps"], 15)
        with self.assertRaises(BoardError) as ctx:
            export.render(snapshot, {**request, "fps": 25})
        self.assertEqual(ctx.exception.code, "invalid_request")

    def test_process_holding_the_camera_skips_cam_info(self):
        board = camera_board(self.tmp.name)
        board.hold(4321, "gst-launch-1.0", "/dev/media0", "/dev/null")
        output = board.collect()
        self.assertEqual(output["mipi"][0]["acquire"], "skipped")
        self.assertNotIn(("cam", "-c", IMX477, "-I"), board.calls)
        self.assertEqual(item(snapshot_of(output), "mipi:" + IMX477)["availability"]["state"], "in_use")

    def test_device_tree_path_id_is_one_item_with_the_entity_placement_and_holder_check(self):
        board = camera_board(self.tmp.name, camera_id=DEVKIT_OF_NODE)
        board.i2c_sensor("5-001a", of_node=DEVKIT_OF_NODE, subdev="v4l-subdev0")
        output = board.collect()
        (camera,) = output["mipi"]
        self.assertEqual((camera["id"], camera["sensor"], camera["sensor_match"]), (DEVKIT_OF_NODE, IMX477, "firmware-node"))
        (entry,) = snapshot_of(output)["items"]
        self.assertEqual((entry["id"], entry["device"]["media_device"]), ("mipi:" + DEVKIT_OF_NODE, "/dev/media0"))

        board.hold(4321, "gst-launch-1.0", "/dev/v4l-subdev0")
        board.calls.clear()
        output = board.collect()
        self.assertNotIn(("cam", "-c", DEVKIT_OF_NODE, "-I"), board.calls)
        self.assertEqual(item(snapshot_of(output), "mipi:" + DEVKIT_OF_NODE)["availability"]["state"], "in_use")

    def test_two_identical_sensors_on_different_buses_match_by_full_path(self):
        # Two imx477 at address 0x1a behind different mux channels share the leaf "imx477@1a".
        board = FakeBoard(self.tmp.name)
        second = "imx477 6-001a"
        paths = {IMX477: DEVKIT_OF_NODE, second: "/base/i2cmux@0/i2c@1/imx477@1a"}
        board.media("media0", MEDIA_CTL)
        board.media("media1", MEDIA_CTL.replace(IMX477, second).replace("subdev0", "subdev3").replace("video@1", "video@2"))
        # No subdevice links: the I2C client named in the entity is the route to the of_node.
        board.i2c_sensor("5-001a", of_node=paths[IMX477])
        board.i2c_sensor("6-001a", of_node=paths[second])
        board.command("cam", "-l", out=f"Available cameras:\n1: 'imx477' ({paths[second]})\n2: 'imx477' ({paths[IMX477]})\n")
        for path in paths.values():
            board.command("cam", "-c", path, "-I", out=CAM_INFO)
        board.hold(4321, "gst-launch-1.0", "/dev/v4l-subdev3")
        output = board.collect()
        placed = {c["id"]: (c["sensor"], c["media_device"]) for c in output["mipi"]}
        self.assertEqual(placed, {paths[IMX477]: (IMX477, "/dev/media0"), paths[second]: (second, "/dev/media1")})
        snapshot = snapshot_of(output)
        self.assertEqual(len(snapshot["items"]), 2)
        self.assertEqual(item(snapshot, "mipi:" + paths[second])["availability"]["state"], "in_use")
        self.assertEqual(item(snapshot, "mipi:" + paths[IMX477])["availability"]["state"], "available")

    def test_a_verified_sensor_named_by_device_tree_path_stays_verified(self):
        path_id = "/base/axi/pcie@120000/rp1/i2c@88000/imx477@1a"
        board = camera_board(self.tmp.name, camera_id=path_id, cam_list=f"Available cameras:\n1: {path_id}\n")
        snapshot = snapshot_of(board.collect())
        self.assertEqual(item(snapshot, "mipi:" + path_id)["support"]["tier"], "verified")
        request = {"id": "mipi:" + path_id, "format": "NV12", "width": 1920, "height": 1080, "fps": 30}
        self.assertEqual(export.render(snapshot, request)["support"]["tier"], "verified")

    def test_neat_version_is_read_from_the_venv_insight_will_run(self):
        venv = Path(self.tmp.name) / "venv"
        (venv / "bin").mkdir(parents=True)
        (venv / "bin" / "python").touch(mode=0o755)
        (venv / "lib" / "python3.11" / "site-packages" / "pyneat-0.4.0.dist-info").mkdir(parents=True)
        cases = [
            (str(venv), {"version": "0.4.0", "python": str(venv / "bin" / "python")}),
            (str(venv / "missing"), {"version": None, "python": None}),
        ]
        for venv_dir, expected in cases:
            with self.subTest(venv_dir=venv_dir), mock.patch.dict(os.environ, {"PYNEAT_VENV_DIR": venv_dir}):
                self.assertEqual(probe.probe_neat(), expected)


class FakeSession:
    def __init__(self, generation: int, transport, fingerprint: str = "fp-1"):
        self.generation = generation
        self.transport = transport
        self.target = SimpleNamespace(mode="ssh", source="manual", label="sima@192.168.2.2")
        self.fingerprint = fingerprint

    def identity(self):
        return {"hostname": "modalix", "machine": "modalix", "build_version": "2.1.3", "fingerprint": self.fingerprint}


class ProbeTransport:
    """Answers `python3 -` with queued probe output."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def exec(self, argv, *, timeout, stdin=None):
        self.calls.append(argv)
        return ExecResult(0, json.dumps(self.responses.pop(0)).encode(), b"")


class PeripheralsApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        scans = mock.patch.object(api, "scans", cameras.ScanCache())
        scans.start()
        self.addCleanup(scans.stop)
        self.manager = SimpleNamespace(current=None)
        self.manager.session = lambda: self.manager.current
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
        body = {
            "id": "mipi:" + IMX477,
            "format": "NV12",
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "generation": self.manager.current.generation,
            **body,
        }
        return self.client.post("/api/peripherals/cameras/export", json=body)

    def test_cached_modes_follow_current_libcamerasrc_support(self):
        first = self.board("a")
        missing = self.board("b", cam_info=CAM_BUSY)
        missing["libcamerasrc"] = {"present": False, "external_buffer_mode": False, "buffer_count": False}
        unchecked = self.board("c", cam_info=CAM_BUSY)
        unchecked["libcamerasrc"] = None
        self.use(first, missing, unchecked)
        self.refresh()
        for tier in ("unsupported", "advertised"):
            with self.subTest(tier=tier):
                camera = self.refresh().get_json()["items"][0]
                self.assertEqual(camera["modes_source"], "previous-scan")
                self.assertEqual((camera["support"]["tier"], nv12(camera)["support"]["tier"]), (tier, tier))
                self.assertEqual({choice["tier"] for size in nv12(camera)["sizes"] for choice in size["fps"]}, {tier})
                self.assertEqual(self.export().get_json()["support"]["tier"], tier)

    def test_modes_are_not_carried_across_boards(self):
        self.use(self.board("a"))
        self.refresh()
        self.use(self.board("b", cam_info=CAM_BUSY), fingerprint="fp-2")
        snapshot = self.refresh().get_json()
        self.assertEqual(snapshot["items"][0]["modes_source"], "unavailable")
        self.assertIsNone(snapshot["changes"])

    def test_export_escapes_device_strings_and_follows_libcamerasrc_features(self):
        output = self.board("a")
        hostile = 'cam"\n\\ 5-001a'
        output["mipi"][0].update(id=hostile, model=None)
        output["libcamerasrc"].update(external_buffer_mode=False, buffer_count=False)
        self.use(output)
        self.refresh()
        body = self.export(id="mipi:" + hostile).get_json()
        exports = {e["id"]: e["content"] for e in body["exports"]}
        # Apps has no capture_buffers value meaning "unset", so no YAML without buffer-count.
        self.assertEqual(list(exports), ["python", "cpp", "json"])
        namespace = {}
        code = compile(exports["python"].replace("import pyneat", ""), "export", "exec")
        exec(code, {"pyneat": _FakePyneat()}, namespace)
        self.assertEqual(namespace["camera"].camera_name, hostile)
        self.assertNotIn("\n\\ 5", exports["cpp"])

    def test_export_is_stale_after_the_board_changes(self):
        self.use()
        self.assertEqual(self.export().status_code, 409)
        self.use(self.board("a"))
        self.refresh()
        self.use(generation=2)
        response = self.export()
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "stale_snapshot"))
        self.assertEqual(self.client.get("/api/peripherals").get_json()["scanned_at"], None)

    def test_export_is_bound_to_the_generation_of_its_source_scan(self):
        self.use(self.board("a"), generation=1, fingerprint="fp-1")
        self.refresh()
        self.use(self.board("b"), generation=2, fingerprint="fp-2")
        self.refresh()

        response = self.export(generation=1)
        body = response.get_json()
        self.assertEqual((response.status_code, body["code"], body["expected_generation"]), (409, "stale_snapshot", 1))
        for generation in (None, "1", True, -1):
            with self.subTest(generation=generation):
                response = self.export(generation=generation)
                self.assertEqual((response.status_code, response.get_json()["code"]), (400, "invalid_request"))

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
