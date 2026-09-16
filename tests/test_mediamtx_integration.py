import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from neat_insight import mediamtx
from neat_insight.mediasrc import PUBLISHER_TAG

REPO = Path(__file__).resolve().parent.parent
MTX_BINARY = os.environ.get("NEAT_INSIGHT_MEDIAMTX") or str(REPO / "neat_insight" / "bin" / "mediamtx")
HAVE_TOOLS = os.path.isfile(MTX_BINARY) and shutil.which("ffmpeg")


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_until(predicate, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return False


def _wait_port(port, timeout=5.0):
    # Wait for a raw TCP connect before the first snapshot() call: if that first call
    # races mediamtx's listener and loses, MediamtxClient backs off for 10s (longer than
    # our polling window), so we'd time out even though the API comes up moments later.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return True
        except OSError:
            time.sleep(0.05)
    return False


@unittest.skipUnless(HAVE_TOOLS, "requires the bundled mediamtx binary (run ./build.sh) and ffmpeg")
class MediamtxIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rtsp_port, self.api_port = _free_port(), _free_port()
        base_cfg = (REPO / "webrtc" / "mediamtx.yml").read_text(encoding="utf-8")
        cfg = base_cfg.replace("rtspAddress: :8554", f"rtspAddress: :{self.rtsp_port}")
        cfg = cfg.replace("apiAddress: 127.0.0.1:9997", f"apiAddress: 127.0.0.1:{self.api_port}")
        # rtspTransports: [tcp] avoids binding UDP rtp/rtcp ports (mediamtx requires the
        # RTP port to be even; on some hosts ephemeral ports from _free_port() are always
        # odd, which would make mediamtx fail to start). The tests only publish over TCP.
        cfg = cfg.replace("api: yes", "api: yes\nrtspTransports: [tcp]\nwebrtc: no\nsrt: no")
        cfg_path = Path(self.tmp.name) / "mediamtx.yml"
        cfg_path.write_text(cfg, encoding="utf-8")
        self.mtx = subprocess.Popen([MTX_BINARY, str(cfg_path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs = [self.mtx]
        self.addCleanup(self._terminate_all)
        self.assertTrue(_wait_port(self.api_port), "mediamtx API port never opened")
        self.client = mediamtx.MediamtxClient(base_url=f"http://127.0.0.1:{self.api_port}/v3", probe_async=False)
        self.assertTrue(_wait_until(lambda: self.client.snapshot() is not None), "mediamtx API did not come up")

    def _terminate_all(self):
        for proc in reversed(self.procs):
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

    def _publish(self, query=""):
        url = f"rtsp://127.0.0.1:{self.rtsp_port}/src2" + (f"?{query}" if query else "")
        cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15",
               "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "15", "-pix_fmt", "yuv420p",
               "-f", "rtsp", "-rtsp_transport", "tcp", url]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(proc)
        return proc

    def _fresh(self):
        self.client._snapshot_at = None
        return self.client.snapshot()

    def test_first_publisher_holds_slot_and_second_is_rejected(self):
        first = self._publish()
        self.assertTrue(_wait_until(lambda: self._fresh().get("src2", mediamtx.PathInfo("src2")).ready))
        second = self._publish()
        self.assertIsNotNone(second.wait(timeout=6), "second publisher should be rejected")
        self.assertIsNone(first.poll(), "first publisher must keep running")

    def test_insight_tag_is_visible_and_untagged_publisher_is_external(self):
        self._publish(PUBLISHER_TAG)
        self.assertTrue(_wait_until(lambda: self._fresh().get("src2", mediamtx.PathInfo("src2")).ready))
        self.assertFalse(self._fresh()["src2"].external)

    def test_kick_frees_the_path_and_probe_reports_dimensions(self):
        proc = self._publish()
        self.assertTrue(_wait_until(lambda: self._fresh().get("src2", mediamtx.PathInfo("src2")).external))
        path = self._fresh()["src2"]
        mediamtx.RTSP_BASE_URL = f"rtsp://127.0.0.1:{self.rtsp_port}"
        try:
            info = self.client.external_info(path)
        finally:
            mediamtx.RTSP_BASE_URL = "rtsp://127.0.0.1:8554"
        self.assertEqual((info["width"], info["height"]), (320, 240))
        self.client.kick(path.source_type, path.source_id)
        self.assertIsNotNone(proc.wait(timeout=6))
        self.assertTrue(_wait_until(lambda: not self._fresh().get("src2", mediamtx.PathInfo("src2")).ready))


if __name__ == "__main__":
    unittest.main()
