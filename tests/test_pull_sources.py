import hashlib
import socket
import ssl
import threading
import unittest
from unittest import mock

from neat_insight import pull_sources


class NormalizeUrlTests(unittest.TestCase):
    def test_plain_rtsp_url_with_default_port(self):
        target = pull_sources.normalize_pull_url(" rtsp://192.168.1.10/stream1 ")
        self.assertEqual(target.url, "rtsp://192.168.1.10/stream1")
        self.assertEqual((target.scheme, target.host, target.path), ("rtsp", "192.168.1.10:554", "/stream1"))

    def test_explicit_port_and_query_are_kept(self):
        target = pull_sources.normalize_pull_url("rtsps://cam.local:8554/live?ch=1")
        self.assertEqual(target.url, "rtsps://cam.local:8554/live?ch=1")
        self.assertEqual((target.scheme, target.host, target.path), ("rtsps", "cam.local:8554", "/live?ch=1"))

    def test_form_credentials_are_embedded(self):
        target = pull_sources.normalize_pull_url("rtsp://10.0.0.5:554/h264", "admin", "secret")
        self.assertEqual(target.url, "rtsp://admin:secret@10.0.0.5:554/h264")
        self.assertEqual(target.host, "10.0.0.5:554")
        self.assertNotIn("admin", target.host + target.path)

    def test_form_credentials_win_over_userinfo(self):
        target = pull_sources.normalize_pull_url("rtsp://old:pw@10.0.0.5/x", "new", "npw")
        self.assertEqual(target.url, "rtsp://new:npw@10.0.0.5/x")

    def test_userinfo_in_url_is_accepted(self):
        target = pull_sources.normalize_pull_url("rtsp://u:p@10.0.0.5/x")
        self.assertEqual(target.url, "rtsp://u:p@10.0.0.5/x")
        self.assertEqual(target.host, "10.0.0.5:554")

    def test_credentials_with_reserved_characters_are_percent_encoded(self):
        target = pull_sources.normalize_pull_url("rtsp://10.0.0.5/x", "us er", "p@ss:w/rd#1")
        self.assertEqual(target.url, "rtsp://us%20er:p%40ss%3Aw%2Frd%231@10.0.0.5/x")

    def test_username_without_password_is_embedded_alone(self):
        target = pull_sources.normalize_pull_url("rtsp://10.0.0.5/x", "admin", "")
        self.assertEqual(target.url, "rtsp://admin@10.0.0.5/x")

    def test_rejects_other_schemes(self):
        for url in ("http://10.0.0.5/x.m3u8", "rtmp://10.0.0.5/live", "srt://10.0.0.5:9000", "10.0.0.5/x", ""):
            with self.subTest(url=url):
                with self.assertRaises(ValueError) as ctx:
                    pull_sources.normalize_pull_url(url)
                self.assertIn("rtsp://", str(ctx.exception))

    def test_rejects_missing_host(self):
        with self.assertRaises(ValueError) as ctx:
            pull_sources.normalize_pull_url("rtsp:///stream")
        self.assertIn("host", str(ctx.exception))

    def test_ipv6_host_is_bracketed(self):
        target = pull_sources.normalize_pull_url("rtsp://[fe80::1]:554/x")
        self.assertEqual(target.host, "[fe80::1]:554")
        self.assertEqual(target.url, "rtsp://[fe80::1]:554/x")


class FakeRtspServer:
    """Answers one DESCRIBE per connection the way a camera would. `mode` selects the behaviour."""

    def __init__(self, mode="ok", user="cam", password="pw", qop=None):
        self.mode, self.user, self.password, self.qop = mode, user, password, qop
        self.requests = []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def close(self):
        self.sock.close()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn):
        with conn:
            if self.mode == "hang":
                threading.Event().wait(5)
                return
            if self.mode == "close":
                return
            for _ in range(2):
                data = b""
                while b"\r\n\r\n" not in data:
                    chunk = conn.recv(4096)
                    if not chunk:
                        return
                    data += chunk
                self.requests.append(data.decode())
                if self.mode == "404":
                    conn.sendall(b"RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n")
                    return
                if self.mode == "302":
                    conn.sendall(b"RTSP/1.0 302 Found\r\nCSeq: 1\r\nLocation: rtsp://elsewhere/x\r\n\r\n")
                    return
                if self.mode == "ok" or self._authorized(data.decode()):
                    conn.sendall(b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: 0\r\n\r\n")
                    return
                challenge = self._challenge()
                conn.sendall(f"RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: {challenge}\r\n\r\n".encode())

    def _challenge(self):
        if self.mode == "basic":
            return 'Basic realm="ipcam"'
        qop = f', qop="{self.qop}"' if self.qop else ""
        return f'Digest realm="ipcam", nonce="abc123"{qop}'

    def _authorized(self, request):
        line = next((l for l in request.split("\r\n") if l.lower().startswith("authorization:")), None)
        if not line:
            return False
        value = line.split(":", 1)[1].strip()
        if self.mode == "basic":
            import base64
            return value == "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        params = dict(p.strip().split("=", 1) for p in value[len("Digest "):].split(","))
        params = {k: v.strip('"') for k, v in params.items()}
        ha1 = hashlib.md5(f"{self.user}:ipcam:{self.password}".encode()).hexdigest()
        ha2 = hashlib.md5(f"DESCRIBE:{params['uri']}".encode()).hexdigest()
        if self.qop:
            expected = hashlib.md5(f"{ha1}:abc123:{params['nc']}:{params['cnonce']}:auth:{ha2}".encode()).hexdigest()
        else:
            expected = hashlib.md5(f"{ha1}:abc123:{ha2}".encode()).hexdigest()
        return params.get("username") == self.user and params.get("response") == expected


class ProbeTests(unittest.TestCase):
    def _server(self, **kwargs):
        server = FakeRtspServer(**kwargs)
        self.addCleanup(server.close)
        return server

    def test_open_stream_is_ok(self):
        server = self._server(mode="ok")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual((result.status, result.error), ("ok", None))
        self.assertTrue(server.requests[0].startswith(f"DESCRIBE rtsp://127.0.0.1:{server.port}/live RTSP/1.0\r\n"))

    def test_basic_credentials_are_answered(self):
        server = self._server(mode="basic")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "ok")
        self.assertNotIn("cam:pw@", server.requests[1])  # userinfo is stripped from the request URI

    def test_digest_credentials_are_answered(self):
        server = self._server(mode="digest")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "ok")

    def test_digest_with_qop_auth(self):
        server = self._server(mode="digest", qop="auth")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "ok")

    def test_digest_uses_raw_password(self):
        server = self._server(mode="digest", user="us er", password="p@ss:w/rd#1")
        url = pull_sources.normalize_pull_url(f"rtsp://127.0.0.1:{server.port}/live", "us er", "p@ss:w/rd#1").url
        self.assertEqual(pull_sources.probe_rtsp(url, timeout=2).status, "ok")

    def test_wrong_credentials_are_auth_failed(self):
        server = self._server(mode="digest")
        result = pull_sources.probe_rtsp(f"rtsp://cam:WRONG@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "auth_failed")
        self.assertEqual(result.error, "The camera rejected the username or password")

    def test_missing_credentials_are_auth_failed_with_hint(self):
        server = self._server(mode="digest")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "auth_failed")
        self.assertEqual(result.error, "The camera requires a username and password")

    def test_not_found_is_unreachable_with_status(self):
        server = self._server(mode="404")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/nope", timeout=2)
        self.assertEqual((result.status, result.error), ("unreachable", "Camera answered 404 Not Found"))

    def test_other_status_is_unreachable(self):
        server = self._server(mode="302")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/x", timeout=2)
        self.assertEqual((result.status, result.error), ("unreachable", "Camera answered 302 Found"))

    def test_closed_connection_is_unreachable(self):
        server = self._server(mode="close")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/x", timeout=2)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.error, "The camera closed the connection")

    def test_timeout_is_unreachable(self):
        server = self._server(mode="hang")
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{server.port}/x", timeout=0.3)
        self.assertEqual((result.status, result.error), ("unreachable", "Timed out after 0.3 s"))

    def test_refused_is_unreachable(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        result = pull_sources.probe_rtsp(f"rtsp://127.0.0.1:{port}/x", timeout=1)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.error, "Connection refused")

    def test_unknown_host_is_unreachable(self):
        result = pull_sources.probe_rtsp("rtsp://no-such-host.invalid/x", timeout=1)
        self.assertEqual(result.status, "unreachable")
        self.assertIn("resolve", result.error)

    def test_rtsps_untrusted_certificate_is_unreachable(self):
        # A plain TCP fake behind rtsps:// fails the TLS handshake; the message names the certificate/TLS.
        server = self._server(mode="ok")
        result = pull_sources.probe_rtsp(f"rtsps://127.0.0.1:{server.port}/x", timeout=1)
        self.assertEqual(result.status, "unreachable")
        self.assertIn("TLS", result.error)

    def test_rtsps_closes_the_socket_returned_by_wrap_socket(self):
        # wrap_socket() rebinds the local `sock` variable; whichever object ends up live must
        # still be closed deterministically (not just the pre-wrap object the with-block saw).
        server = self._server(mode="ok")
        closed = []

        class FakeTlsSocket:
            def __init__(self, raw):
                self._raw = raw

            def settimeout(self, value):
                self._raw.settimeout(value)

            def sendall(self, data):
                self._raw.sendall(data)

            def recv(self, size):
                return self._raw.recv(size)

            def close(self):
                closed.append(True)
                self._raw.close()

        def fake_wrap_socket(self, sock, server_hostname=None, **kwargs):
            return FakeTlsSocket(sock)

        with mock.patch.object(ssl.SSLContext, "wrap_socket", fake_wrap_socket):
            result = pull_sources.probe_rtsp(f"rtsps://127.0.0.1:{server.port}/live", timeout=2)

        self.assertEqual(result.status, "ok")
        self.assertEqual(closed, [True])

if __name__ == "__main__":
    unittest.main()
