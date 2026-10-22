import io
import os
import socket
import ssl
import unittest
import unittest.mock as mock
import urllib.error
from email.message import Message

os.environ.setdefault("NEAT_METRICS_ZMQ_ENDPOINT", "tcp://127.0.0.1:55583")

from neat_insight import app as app_module

OFFER = b'{"type":"offer","sdp":"v=0\\r\\n"}'
ANSWER = b'{"type":"answer","sdp":"v=0\\r\\n"}'


def vf_answer(status=200, body=ANSWER, content_type="application/json"):
    """What urlopen returns for a 2xx reply from vf."""
    headers = Message()
    headers["Content-Type"] = content_type
    response = mock.MagicMock()
    response.__enter__.return_value = response
    response.status = status
    response.headers = headers
    response.read.return_value = body
    return response


def vf_error(status, text, content_type="text/plain; charset=utf-8", body=None):
    """What urlopen raises when vf replies 4xx or 5xx through http.Error."""
    headers = Message()
    if content_type:
        headers["Content-Type"] = content_type
    return urllib.error.HTTPError(
        "https://127.0.0.1:8081/offer", status, text, headers, body or io.BytesIO(f"{text}\n".encode())
    )


class VfOfferProxyTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()

    def post(self, urlopen, query="channel=3", body=OFFER, content_type="application/json"):
        with mock.patch.object(app_module.urllib.request, "urlopen", urlopen):
            return self.client.post(f"/api/vf/offer?{query}", data=body, content_type=content_type)

    def test_offer_proxy_passes_vf_status_and_body_through(self):
        cases = (
            (vf_answer(), 200, ANSWER, "application/json"),
            (vf_error(503, "Video codec not available"), 503, b"Video codec not available\n", "text/plain"),
            (vf_error(415, "Browser does not support the channel codec"), 415,
             b"Browser does not support the channel codec\n", "text/plain"),
            (vf_error(400, "Invalid SDP offer"), 400, b"Invalid SDP offer\n", "text/plain"),
            (vf_error(500, "PeerConnection failed"), 500, b"PeerConnection failed\n", "text/plain"),
        )
        for outcome, status, body, mimetype in cases:
            with self.subTest(status=status):
                urlopen = mock.Mock(side_effect=outcome) if isinstance(outcome, Exception) \
                    else mock.Mock(return_value=outcome)
                response = self.post(urlopen)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.get_data(), body)
                self.assertEqual(response.mimetype, mimetype)

    def test_offer_proxy_labels_a_vf_error_without_content_type_as_text(self):
        response = self.post(mock.Mock(side_effect=vf_error(503, "Video codec changed", content_type=None)))

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.mimetype, "text/plain")
        self.assertEqual(response.get_data(), b"Video codec changed\n")

    def test_offer_proxy_maps_a_stall_while_reading_a_vf_error_to_504(self):
        stalled = mock.Mock()
        stalled.read.side_effect = TimeoutError("timed out")
        response = self.post(mock.Mock(side_effect=vf_error(503, "Video codec changed", body=stalled)))

        self.assertEqual(response.status_code, 504)

    def test_offer_proxy_forwards_the_offer_byte_for_byte_as_json(self):
        urlopen = mock.Mock(return_value=vf_answer())
        self.post(urlopen, body=OFFER)

        forwarded = urlopen.call_args.args[0]
        self.assertEqual(forwarded.get_method(), "POST")
        self.assertEqual(forwarded.data, OFFER)
        self.assertEqual(forwarded.get_header("Content-type"), "application/json")

    def test_offer_proxy_accepts_json_with_or_without_a_charset(self):
        for content_type in ("application/json", "application/json; charset=utf-8", "Application/JSON"):
            with self.subTest(content_type=content_type):
                urlopen = mock.Mock(return_value=vf_answer())
                self.assertEqual(self.post(urlopen, content_type=content_type).status_code, 200)
                urlopen.assert_called_once()

    def test_offer_proxy_rejects_a_body_that_is_not_json_without_calling_vf(self):
        # A cross-site form or text/plain POST needs no CORS preflight; only JSON can come from the viewer.
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data", None):
            with self.subTest(content_type=content_type):
                urlopen = mock.Mock()
                response = self.post(urlopen, content_type=content_type)
                self.assertEqual(response.status_code, 415)
                self.assertEqual(response.mimetype, "text/plain")
                self.assertIn("application/json", response.get_data(as_text=True))
                urlopen.assert_not_called()

    def test_offer_proxy_rejects_bad_channel_without_calling_vf(self):
        for channel in ("x", "-1", "80", "", "1.5", "+3", "٣", "007", "9" * 5000):
            with self.subTest(channel=channel):
                urlopen = mock.Mock()
                response = self.post(urlopen, query=f"channel={channel}")
                self.assertEqual(response.status_code, 400)
                urlopen.assert_not_called()

        urlopen = mock.Mock()
        self.assertEqual(self.post(urlopen, query="").status_code, 400)
        urlopen.assert_not_called()

    def test_offer_proxy_accepts_the_first_and_last_channel(self):
        for channel in (0, 79):
            with self.subTest(channel=channel):
                urlopen = mock.Mock(return_value=vf_answer())
                self.assertEqual(self.post(urlopen, query=f"channel={channel}").status_code, 200)
                self.assertEqual(
                    urlopen.call_args.args[0].full_url, f"https://127.0.0.1:8081/offer?channel={channel}"
                )

    def test_offer_proxy_rejects_bodies_over_64_kib(self):
        limit = 64 * 1024
        urlopen = mock.Mock(return_value=vf_answer())
        self.assertEqual(self.post(urlopen, body=b"x" * limit).status_code, 200)

        urlopen = mock.Mock()
        response = self.post(urlopen, body=b"x" * (limit + 1))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.mimetype, "text/plain")
        urlopen.assert_not_called()

    def test_offer_proxy_rejects_an_oversized_body_that_declares_no_length(self):
        # A chunked upload has no Content-Length to check up front, so the proxy must stop reading at the limit.
        limit = 64 * 1024
        urlopen = mock.Mock()
        with mock.patch.object(app_module.urllib.request, "urlopen", urlopen):
            response = self.client.post(
                "/api/vf/offer?channel=3",
                input_stream=io.BytesIO(b"x" * (limit + 1)),
                content_type="application/json",
                headers={"Transfer-Encoding": "chunked"},
                environ_overrides={"wsgi.input_terminated": True},
            )
        self.assertEqual(response.status_code, 413)
        urlopen.assert_not_called()

    def test_offer_proxy_maps_refused_to_502_and_timeout_to_504(self):
        cases = (
            ("refused", urllib.error.URLError(ConnectionRefusedError(111, "Connection refused")), 502),
            ("reset", ConnectionResetError(104, "Connection reset by peer"), 502),
            ("tls", urllib.error.URLError(ssl.SSLError(1, "handshake failure")), 502),
            ("connect timeout", urllib.error.URLError(socket.timeout("timed out")), 504),
            ("read timeout", TimeoutError("timed out"), 504),
        )
        for name, failure, status in cases:
            with self.subTest(name):
                response = self.post(mock.Mock(side_effect=failure))
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.mimetype, "text/plain")
                self.assertTrue(response.get_data(as_text=True).strip())

    def test_offer_proxy_uses_container_port_8081_and_8_second_timeout(self):
        urlopen = mock.Mock(return_value=vf_answer())
        self.post(urlopen, query="channel=07")

        forwarded = urlopen.call_args.args[0]
        self.assertEqual(forwarded.full_url, "https://127.0.0.1:8081/offer?channel=7")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 8.0)
        # vf presents Insight's own certificate, which need not name 127.0.0.1.
        context = urlopen.call_args.kwargs["context"]
        self.assertFalse(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_NONE)

    def test_stats_proxy_shares_the_vf_address_and_keeps_its_2_second_timeout(self):
        urlopen = mock.Mock(return_value=vf_answer(body=b"{}"))
        with mock.patch.object(app_module.urllib.request, "urlopen", urlopen):
            response = self.client.get("/api/ingest/stats?all=1&verbose=1&ignored=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(urlopen.call_args.args[0].full_url, "https://127.0.0.1:8081/ingest/stats?all=1&verbose=1")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 2.0)
        self.assertEqual(urlopen.call_args.kwargs["context"].verify_mode, ssl.CERT_NONE)


if __name__ == "__main__":
    unittest.main()
