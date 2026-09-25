import unittest

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


if __name__ == "__main__":
    unittest.main()
