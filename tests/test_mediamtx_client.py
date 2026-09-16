import logging
import unittest

from neat_insight import mediamtx

# Shapes captured from mediamtx v1.12.1 /v3 API on 2026-09-16.
PATHS = [
    {"name": "src1", "confName": "src1", "source": {"type": "rtspSession", "id": "pub-1"}, "ready": True,
     "readyTime": "2026-09-16T13:09:59.424615217Z", "tracks": ["H264"], "bytesReceived": 1_000_000, "bytesSent": 0,
     "readers": [{"type": "rtspSession", "id": "read-1"}, {"type": "rtspSession", "id": "probe-1"}, {"type": "rtspSession", "id": "prev-1"}]},
    {"name": "src2", "confName": "src2", "source": {"type": "rtspSession", "id": "pub-2"}, "ready": True,
     "readyTime": "2026-09-16T13:10:00.000000000Z", "tracks": ["H264"], "bytesReceived": 468_305, "bytesSent": 0, "readers": []},
    {"name": "src3", "confName": "src3", "source": {"type": "srtConn", "id": "pub-3"}, "ready": True,
     "readyTime": "2026-09-16T13:11:00.000000000Z", "tracks": ["H264"], "bytesReceived": 5_000, "bytesSent": 0, "readers": []},
    {"name": "src4", "confName": "src4", "source": {"type": "webRTCSession", "id": "pub-4"}, "ready": True,
     "readyTime": "2026-09-16T13:12:00.000000000Z", "tracks": ["VP8", "Opus"], "bytesReceived": 5_000, "bytesSent": 0, "readers": []},
    {"name": "src5", "confName": "src5", "source": None, "ready": False, "readyTime": None, "tracks": [], "bytesReceived": 0, "bytesSent": 0, "readers": []},
    {"name": "src6", "confName": "src6", "source": {"type": "rtspSession", "id": "pub-6"}, "ready": True,
     "readyTime": "2026-09-16T13:13:00.000000000Z", "tracks": ["Opus"], "bytesReceived": 100, "bytesSent": 0, "readers": []},
]
SESSIONS = {
    "rtspsessions": [
        {"id": "pub-1", "remoteAddr": "127.0.0.1:40968", "state": "publish", "path": "src1", "query": "publisher=insight", "transport": "TCP"},
        {"id": "read-1", "remoteAddr": "172.19.0.1:49878", "state": "read", "path": "src1", "query": "", "transport": "TCP"},
        {"id": "probe-1", "remoteAddr": "127.0.0.1:50001", "state": "read", "path": "src1", "query": "reader=insight-probe", "transport": "TCP"},
        {"id": "prev-1", "remoteAddr": "127.0.0.1:50002", "state": "read", "path": "src1", "query": "reader=insight-preview", "transport": "TCP"},
        {"id": "pub-2", "remoteAddr": "172.19.0.1:47168", "state": "publish", "path": "src2", "query": "", "transport": "TCP"},
        {"id": "pub-6", "remoteAddr": "172.19.0.1:47170", "state": "publish", "path": "src6", "query": "", "transport": "TCP"},
    ],
    "rtspssessions": [],
    "webrtcsessions": [{"id": "pub-4", "remoteAddr": "172.19.0.5:51000", "state": "publish", "path": "src4", "query": ""}],
    "srtconns": [{"id": "pub-3", "remoteAddr": "10.0.0.5:59399", "state": "publish", "path": "src3", "query": ""}],
    "rtmpconns": [],
    "rtmpsconns": [],
}


class SnapshotParsingTests(unittest.TestCase):
    def setUp(self):
        self.snap = mediamtx.build_snapshot(PATHS, SESSIONS)

    def test_untagged_rtsp_publisher_is_external(self):
        src2 = self.snap["src2"]
        self.assertTrue(src2.external)
        self.assertEqual((src2.protocol, src2.address, src2.codec), ("rtsp", "172.19.0.1", "h264"))
        self.assertEqual(src2.since, "2026-09-16T13:10:00.000000000Z")
        self.assertEqual(src2.source_id, "pub-2")

    def test_insight_tagged_publisher_is_not_external(self):
        self.assertTrue(self.snap["src1"].ready)
        self.assertTrue(self.snap["src1"].owned_by_insight)
        self.assertFalse(self.snap["src1"].external)

    def test_idle_path_is_neither_ready_nor_external(self):
        self.assertFalse(self.snap["src5"].ready)
        self.assertFalse(self.snap["src5"].external)
        self.assertEqual(self.snap["src5"].readers, [])

    def test_readers_hide_probe_and_label_preview(self):
        self.assertEqual(self.snap["src1"].readers, [
            {"protocol": "rtsp", "address": "172.19.0.1"},
            {"protocol": "rtsp", "address": "127.0.0.1", "label": "insight preview"},
        ])

    def test_srt_and_webrtc_publishers_map_protocol(self):
        self.assertEqual((self.snap["src3"].protocol, self.snap["src3"].address), ("srt", "10.0.0.5"))
        self.assertEqual((self.snap["src4"].protocol, self.snap["src4"].codec), ("webrtc", "vp8"))

    def test_audio_only_path_has_codec_none(self):
        self.assertEqual(self.snap["src6"].codec, "none")

    def test_track_codec_mapping(self):
        self.assertEqual(mediamtx.track_codec(["Opus", "H265"]), "h265")
        self.assertEqual(mediamtx.track_codec(["M-JPEG"]), "mjpeg")
        self.assertEqual(mediamtx.track_codec(["AV1"]), "av1")
        self.assertEqual(mediamtx.track_codec([]), "none")

    def test_unknown_source_type_is_external_with_raw_protocol(self):
        paths = [dict(PATHS[1], source={"type": "futureConn", "id": "x"})]
        snap = mediamtx.build_snapshot(paths, SESSIONS)
        self.assertTrue(snap["src2"].external)
        self.assertEqual(snap["src2"].protocol, "futureConn")
        self.assertIsNone(snap["src2"].address)


if __name__ == "__main__":
    unittest.main()
