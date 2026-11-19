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
        self.assertEqual((target.scheme, target.host, target.path), ("rtsps", "cam.local:8554", "/live?ch=***"))

    def test_query_values_are_masked_in_the_shown_path(self):
        target = pull_sources.normalize_pull_url("rtsp://10.0.0.5/live?token=s3cret&ch=2&bare")
        self.assertEqual(target.url, "rtsp://10.0.0.5/live?token=s3cret&ch=2&bare")
        self.assertEqual(target.path, "/live?token=***&ch=***&***")
        self.assertNotIn("s3cret", target.host + target.path)

    def test_rtsps_defaults_to_port_322(self):
        target = pull_sources.normalize_pull_url("rtsps://cam.local/live")
        self.assertEqual(target.host, "cam.local:322")
        self.assertEqual(target.url, "rtsps://cam.local/live")

    def test_rejects_an_invalid_port(self):
        for url in ("rtsp://10.0.0.5:99999/x", "rtsp://10.0.0.5:abc/x", "rtsps://10.0.0.5:-1/x"):
            with self.subTest(url=url):
                with self.assertRaises(ValueError) as ctx:
                    pull_sources.normalize_pull_url(url)
                self.assertEqual(str(ctx.exception), pull_sources.INVALID_PORT_MESSAGE)

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

    def __init__(self, mode="ok", user="cam", password="pw", qop=None, algorithm=None):
        self.mode, self.user, self.password, self.qop, self.algorithm = mode, user, password, qop, algorithm
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
                challenges = "".join(f"WWW-Authenticate: {c}\r\n" for c in self._challenges())
                conn.sendall(f"RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\n{challenges}\r\n".encode())

    def _challenges(self):
        if self.mode == "basic":
            return ['Basic realm="ipcam"']
        qop = f', qop="{self.qop}"' if self.qop else ""
        algorithm = f", algorithm={self.algorithm}" if self.algorithm else ""
        digest = f'Digest realm="ipcam", nonce="abc123"{qop}{algorithm}'
        if self.mode == "digest+basic":  # e.g. Hikvision: Digest first, Basic last
            return [digest, 'Basic realm="ipcam"']
        return [digest]

    def _authorized(self, request):
        line = next((l for l in request.split("\r\n") if l.lower().startswith("authorization:")), None)
        if not line:
            return False
        value = line.split(":", 1)[1].strip()
        if self.mode == "basic":
            import base64
            return value == "Basic " + base64.b64encode(f"{self.user}:{self.password}".encode()).decode()
        if not value.startswith("Digest ") or self.algorithm or self.qop not in (None, "auth"):
            return False  # this fake only verifies plain MD5 Digest, with or without qop=auth
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

    def test_digest_is_preferred_over_a_basic_challenge_sent_last(self):
        server = self._server(mode="digest+basic")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "ok")
        self.assertIn("Authorization: Digest ", server.requests[1])

    def test_sha256_only_digest_is_left_to_mediamtx(self):
        # The probe cannot answer SHA-256; mediamtx can, so the probe must not veto the pull.
        server = self._server(mode="digest", algorithm="SHA-256")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual((result.status, result.error), ("ok", None))
        self.assertEqual(len(server.requests), 1)

    def test_auth_int_only_digest_is_left_to_mediamtx(self):
        server = self._server(mode="digest", qop="auth-int")
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual((result.status, result.error), ("ok", None))
        self.assertEqual(len(server.requests), 1)

    def test_md5_digest_is_answered_when_offered_next_to_sha256(self):
        server = self._server(mode="digest")
        server._challenges = lambda: ['Digest realm="ipcam", nonce="abc123", algorithm=SHA-256',
                                      'Digest realm="ipcam", nonce="abc123", algorithm=MD5']
        result = pull_sources.probe_rtsp(f"rtsp://cam:pw@127.0.0.1:{server.port}/live", timeout=2)
        self.assertEqual(result.status, "ok")

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

    def test_portless_rtsps_is_probed_on_322(self):
        with mock.patch.object(pull_sources.socket, "create_connection", side_effect=ConnectionRefusedError) as connect:
            result = pull_sources.probe_rtsp("rtsps://cam.local/x", timeout=1)
        self.assertEqual(connect.call_args.args[0], ("cam.local", 322))
        self.assertEqual(result.status, "unreachable")

    def test_invalid_port_is_unreachable(self):
        result = pull_sources.probe_rtsp("rtsp://10.0.0.5:99999/x", timeout=1)
        self.assertEqual((result.status, result.error), ("unreachable", pull_sources.INVALID_PORT_MESSAGE))

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

    def test_invalid_hostname_is_unreachable(self):
        host = "a" * 70 + ".example"
        result = pull_sources.probe_rtsp(f"rtsp://{host}/x", timeout=1)
        self.assertEqual(result.status, "unreachable")
        self.assertEqual(result.error, "Invalid host name in the stream URL")

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


class ScriptedSocket:
    """A connected socket whose recv() returns the scripted chunks in order, then end of stream.

    A chunk may be an exception instance, which recv() raises instead. Each sendall() is recorded.
    """

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.sent = []
        self.closed = False

    def settimeout(self, value):
        pass

    def sendall(self, data):
        self.sent.append(data.decode())

    def recv(self, size):
        if not self.chunks:
            return b""
        chunk = self.chunks.pop(0)
        if isinstance(chunk, BaseException):
            raise chunk
        if len(chunk) > size:
            self.chunks.insert(0, chunk[size:])
            chunk = chunk[:size]
        return chunk

    def close(self):
        self.closed = True


BASIC_401_HEAD = b'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="ipcam"\r\n'
OK_200 = b"RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: 0\r\n\r\n"
REJECTED_401 = b'RTSP/1.0 401 Unauthorized\r\nCSeq: 2\r\nWWW-Authenticate: Basic realm="ipcam"\r\n\r\n'


class ProbeResponseBodyTests(unittest.TestCase):
    """Issue #215: a 401 body must be consumed before the authenticated DESCRIBE reuses the connection."""

    def _probe(self, chunks):
        sock = ScriptedSocket(chunks)
        with mock.patch.object(pull_sources.socket, "create_connection", return_value=sock):
            result = pull_sources.probe_rtsp("rtsp://cam:pw@10.0.0.5/live", timeout=2)
        self.assertTrue(sock.closed)
        return result, sock

    def test_401_body_arriving_after_its_headers_then_accepted_credentials_is_ok(self):
        result, sock = self._probe([BASIC_401_HEAD + b"Content-Length: 4\r\n\r\n", b"deny", OK_200])
        self.assertEqual((result.status, result.error), ("ok", None))
        self.assertIn("Authorization: Basic ", sock.sent[1])

    def test_401_body_arriving_after_its_headers_then_rejected_credentials_is_auth_failed(self):
        result, _ = self._probe([BASIC_401_HEAD + b"Content-Length: 4\r\n\r\n", b"deny", REJECTED_401])
        self.assertEqual((result.status, result.error), ("auth_failed", pull_sources.AUTH_REJECTED_MESSAGE))

    def test_401_body_split_over_several_reads(self):
        body = b"<html>401 Unauthorized</html>"
        chunks = [BASIC_401_HEAD + b"Content-Length: %d\r\n\r\n<ht" % len(body), b"ml>401 Unau", b"thorized</html>", OK_200]
        result, _ = self._probe(chunks)
        self.assertEqual(result.status, "ok")

    def test_401_body_coalesced_with_its_headers(self):
        result, _ = self._probe([BASIC_401_HEAD + b"Content-Length: 4\r\n\r\ndeny", REJECTED_401])
        self.assertEqual(result.status, "auth_failed")

    def test_401_without_content_length_has_no_body(self):
        result, _ = self._probe([BASIC_401_HEAD + b"\r\n", OK_200])
        self.assertEqual(result.status, "ok")

    def test_connection_closed_inside_the_401_body_is_unreachable(self):
        result, sock = self._probe([BASIC_401_HEAD + b"Content-Length: 10\r\n\r\n", b"den"])
        self.assertEqual((result.status, result.error), ("unreachable", "The camera closed the connection"))
        self.assertEqual(len(sock.sent), 1)  # no authenticated DESCRIBE after a truncated body

    def test_timeout_inside_the_401_body_is_unreachable(self):
        result, _ = self._probe([BASIC_401_HEAD + b"Content-Length: 10\r\n\r\n", b"den", socket.timeout()])
        self.assertEqual((result.status, result.error), ("unreachable", "Timed out after 2 s"))

    def test_malformed_content_length_is_an_invalid_response(self):
        for value in (b"abc", b"-4", b"4, 5", b"+4", b""):
            with self.subTest(value=value):
                result, sock = self._probe([BASIC_401_HEAD + b"Content-Length: " + value + b"\r\n\r\n", b"deny", OK_200])
                self.assertEqual((result.status, result.error), ("unreachable", pull_sources.INVALID_RESPONSE_MESSAGE))
                self.assertEqual(len(sock.sent), 1)

    def test_conflicting_content_length_headers_are_an_invalid_response(self):
        head = BASIC_401_HEAD + b"Content-Length: 4\r\nContent-Length: 5\r\n\r\n"
        result, _ = self._probe([head, b"deny", OK_200])
        self.assertEqual((result.status, result.error), ("unreachable", pull_sources.INVALID_RESPONSE_MESSAGE))

    def test_repeated_equal_content_length_headers_are_accepted(self):
        head = BASIC_401_HEAD + b"Content-Length: 4\r\nContent-Length: 4\r\n\r\n"
        result, _ = self._probe([head, b"deny", OK_200])
        self.assertEqual(result.status, "ok")

    def test_content_length_too_long_for_int_is_an_invalid_response(self):
        head = BASIC_401_HEAD + b"Content-Length: " + b"4" * 5000 + b"\r\n\r\n"
        result, sock = self._probe([head, b"deny", OK_200])
        self.assertEqual((result.status, result.error), ("unreachable", pull_sources.INVALID_RESPONSE_MESSAGE))
        self.assertEqual(len(sock.sent), 1)

    def test_oversized_401_body_is_refused_without_reading_it(self):
        length = pull_sources.MAX_RESPONSE_BODY_BYTES + 1
        result, sock = self._probe([BASIC_401_HEAD + b"Content-Length: %d\r\n\r\n" % length, b"x" * 4096, OK_200])
        self.assertEqual((result.status, result.error), ("unreachable", pull_sources.INVALID_RESPONSE_MESSAGE))
        self.assertEqual(len(sock.chunks), 2)  # neither the body nor the next response was read


class RegistryTests(unittest.TestCase):
    def _record(self, index=3, **kwargs):
        base = dict(index=index, url="rtsp://u:p@10.0.0.5:554/x", scheme="rtsp", host="10.0.0.5:554", path="/x", started_at=100.0)
        base.update(kwargs)
        return pull_sources.PullRecord(**base)

    def test_put_get_remove(self):
        registry = pull_sources.PullRegistry()
        record = self._record()
        registry.put(record)
        self.assertIs(registry.get(3), record)
        self.assertEqual(registry.indexes(), [3])
        self.assertIs(registry.remove(3), record)
        self.assertIsNone(registry.get(3))
        self.assertIsNone(registry.remove(3))

    def test_due_for_probe_marks_records_and_skips_auth_failed_and_in_flight(self):
        registry = pull_sources.PullRegistry()
        due = self._record(index=1, probed_at=0.0)
        recent = self._record(index=2, probed_at=95.0)
        failed = self._record(index=4, status="auth_failed", probed_at=0.0)
        for record in (due, recent, failed):
            registry.put(record)
        self.assertEqual(registry.due_for_probe(now=100.0, interval=10.0), [due])
        self.assertTrue(due.probing)
        self.assertEqual(registry.due_for_probe(now=100.0, interval=10.0), [])  # in flight now

    def test_apply_probe_writes_status_and_clears_in_flight(self):
        registry = pull_sources.PullRegistry()
        record = self._record(probing=True)
        registry.put(record)
        ok = registry.apply_probe(record, pull_sources.ProbeResult("unreachable", "Connection refused"), now=120.0)
        self.assertTrue(ok)
        self.assertEqual((record.status, record.error, record.probed_at, record.probing), ("unreachable", "Connection refused", 120.0, False))
        registry.apply_probe(record, pull_sources.ProbeResult("ok"), now=130.0)
        self.assertEqual((record.status, record.error), ("connecting", None))

    def test_apply_probe_ignores_a_replaced_record(self):
        registry = pull_sources.PullRegistry()
        old = self._record(probing=True)
        registry.put(old)
        new = self._record(host="10.0.0.9:554")
        registry.put(new)
        self.assertFalse(registry.apply_probe(old, pull_sources.ProbeResult("auth_failed", "x"), now=1.0))
        self.assertEqual(new.status, "connecting")

    def test_status_from_probe(self):
        self.assertEqual(pull_sources.status_from_probe(pull_sources.ProbeResult("ok")), "connecting")
        self.assertEqual(pull_sources.status_from_probe(pull_sources.ProbeResult("auth_failed", "x")), "auth_failed")


if __name__ == "__main__":
    unittest.main()
