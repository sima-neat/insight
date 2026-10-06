import io
import json
import tempfile
import threading
import unittest
import unittest.mock as mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from flask import Flask

from neat_insight import genai_relay as relay


class _FakeStudio(BaseHTTPRequestHandler):
    """A stand-in for the board's GenAI Studio backend (plain HTTP)."""

    protocol_version = "HTTP/1.1"
    requests = []
    release_second_chunk = threading.Event()

    def log_message(self, *args):
        pass

    def _record(self, body=b""):
        type(self).requests.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
        )

    def _send_json(self, status, payload, extra_headers=None):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._record()
        if self.path == "/health":
            self._send_json(200, {"ok": True, "mode": "backend-only"})
        elif self.path.startswith("/models/logs/stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for event in (b"data: first\n\n", b"data: second\n\n"):
                if event == b"data: second\n\n":
                    type(self).release_second_chunk.wait(5)
                self.wfile.write(b"%x\r\n%s\r\n" % (len(event), event))
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        else:
            self._send_json(404, {"error": "unknown"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        self._record(body)
        if self.path == "/v1/audio/transcriptions":
            self._send_json(
                200,
                {"bytes": len(body), "type": self.headers.get("Content-Type")},
                {"X-ASR-Model": "whisper-small", "X-Elapsed-Time": "0.4"},
            )
        elif self.path == "/models/load":
            self._send_json(409, {"error": "Another model is loading"})
        else:
            self._send_json(200, {"echo": json.loads(body or b"{}")})


class GenaiRelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeStudio)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.board = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _FakeStudio.requests = []
        _FakeStudio.release_second_chunk.clear()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.cfg = Path(self.tmpdir.name) / "cfg.json"
        patches = [
            mock.patch.object(relay, "_cfg_path", lambda: self.cfg),
            mock.patch.object(relay, "is_sima_board", lambda: False),
            mock.patch.object(relay, "get_devkit_sync_devkit_ip", lambda: ""),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(self.tmpdir.cleanup)

        app = Flask(__name__)
        app.register_blueprint(relay.genai_bp)
        self.client = app.test_client()

    def _configure(self, **settings):
        response = self.client.post("/api/genai/settings", json=settings)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    # --- settings -----------------------------------------------------------

    def test_default_address_is_the_board_itself_or_the_paired_devkit(self):
        with mock.patch.object(relay, "is_sima_board", lambda: True):
            self.assertEqual(relay.default_board_url(), "https://127.0.0.1:5000")
        with mock.patch.object(relay, "get_devkit_sync_devkit_ip", lambda: "192.168.2.3"):
            self.assertEqual(relay.default_board_url(), "https://192.168.2.3:5000")
        self.assertEqual(relay.default_board_url(), "")

    def test_settings_round_trip_keeps_other_config(self):
        self.cfg.write_text(json.dumps({"remote-devkit": {"ip": "10.0.0.9"}}))

        body = self._configure(url="https://192.168.2.3:5000/")

        self.assertEqual(body["url"], "https://192.168.2.3:5000")
        self.assertEqual(body["configuredUrl"], "https://192.168.2.3:5000")
        stored = json.loads(self.cfg.read_text())
        self.assertEqual(stored["remote-devkit"], {"ip": "10.0.0.9"})
        self.assertEqual(stored["genai"]["url"], "https://192.168.2.3:5000")

        cleared = self._configure(url="")
        self.assertIsNone(cleared["configuredUrl"])

    def test_settings_reject_addresses_that_are_not_a_plain_origin(self):
        for bad in ("ftp://board", "board:5000", "https://board:5000/v1", "https://user@board", 5):
            with self.subTest(url=bad):
                response = self.client.post("/api/genai/settings", json={"url": bad})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["reason"], "bad-request")

    # --- relay --------------------------------------------------------------

    def test_relays_health_from_the_board(self):
        self._configure(url=self.board)

        response = self.client.get("/api/genai/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"ok": True, "mode": "backend-only"})
        self.assertEqual(_FakeStudio.requests[-1]["path"], "/health")

    def test_refuses_shutdown_and_paths_outside_the_studio_api(self):
        self._configure(url=self.board)
        for path in ("shutdown", "playground/", "static/newui.js", "models/../shutdown", "settingsx"):
            with self.subTest(path=path):
                response = self.client.post(f"/api/genai/{path}")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.get_json()["reason"], "not-relayed")
        self.assertEqual(_FakeStudio.requests, [])

    def test_streams_server_sent_events_without_buffering(self):
        self._configure(url=self.board)

        response = self.client.get("/api/genai/models/logs/stream?after=3", buffered=False)
        self.addCleanup(response.close)
        chunks = iter(response.response)

        # The first event must arrive while the board is still holding back the second.
        first = next(chunks)
        self.assertIn(b"data: first", first)
        self.assertNotIn(b"data: second", first)
        _FakeStudio.release_second_chunk.set()
        rest = b"".join(chunks)

        self.assertIn(b"data: second", rest)
        self.assertEqual(response.headers["Content-Type"], "text/event-stream")
        self.assertEqual(response.headers["X-Accel-Buffering"], "no")
        self.assertEqual(_FakeStudio.requests[-1]["path"], "/models/logs/stream?after=3")

    def test_forwards_multipart_uploads_and_keeps_studio_headers(self):
        self._configure(url=self.board)
        audio = b"RIFF" + b"\x00" * 4096

        response = self.client.post(
            "/api/genai/v1/audio/transcriptions",
            data={"file": (io.BytesIO(audio), "clip.wav"), "response_format": "json"},
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-ASR-Model"], "whisper-small")
        self.assertEqual(response.headers["X-Elapsed-Time"], "0.4")
        sent = _FakeStudio.requests[-1]
        self.assertTrue(sent["headers"]["Content-Type"].startswith("multipart/form-data; boundary="))
        self.assertIn(audio, sent["body"])

    def test_passes_the_board_status_through(self):
        self._configure(url=self.board)

        response = self.client.post("/api/genai/models/load", json={"name": "m"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json(), {"error": "Another model is loading"})

    def test_reports_an_unreachable_board(self):
        with socket_closed_port() as port:
            self._configure(url=f"http://127.0.0.1:{port}")
            response = self.client.get("/api/genai/health")

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json()["reason"], "unreachable")

    def test_reports_when_no_board_is_configured(self):
        response = self.client.get("/api/genai/health")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()["reason"], "not-configured")


class socket_closed_port:
    """A local port with nothing listening on it."""

    def __enter__(self):
        import socket

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.port = sock.getsockname()[1]
        sock.close()
        return self.port

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
