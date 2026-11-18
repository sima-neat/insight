import importlib.util
import json
import os
import select
import shutil
import socket
import threading
import time
import unittest
from pathlib import Path

# The feed is a standalone script copied into the SDK container, not part of the package.
_SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "test_feed_metadata.py"
_spec = importlib.util.spec_from_file_location("test_feed_metadata", _SCRIPT)
feed = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(feed)

HAVE_FFMPEG = bool(shutil.which("ffmpeg"))
if os.environ.get("NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS") and not HAVE_FFMPEG:
    raise RuntimeError("ffmpeg is required for tests.test_test_feed_metadata (NEAT_INSIGHT_REQUIRE_FFMPEG_TESTS is set)")


def rtp_header(timestamp, marker=False, payload_type=96, sequence=1):
    return bytes([0x80, (0x80 if marker else 0) | payload_type]) + sequence.to_bytes(2, "big") + timestamp.to_bytes(4, "big") + bytes(4)


def rtp_distance(a, b):
    """The distance the server's correlator measures between two RTP timestamps (server/internal/channels/correlate.go)."""
    delta = (a - b) & 0xFFFFFFFF
    return min(delta, 0x100000000 - delta)


class ParseRtpTests(unittest.TestCase):
    def test_reads_timestamp_marker_and_payload_type(self):
        packet = feed.parse_rtp(rtp_header(0xDEADBEEF, marker=True) + b"payload")
        self.assertEqual(packet, feed.RtpPacket(timestamp=0xDEADBEEF, marker=True, payload_type=96))

    def test_a_packet_without_the_marker_continues_its_frame(self):
        self.assertFalse(feed.parse_rtp(rtp_header(6000, marker=False)).marker)

    def test_rejects_what_is_not_an_rtp_packet(self):
        self.assertIsNone(feed.parse_rtp(rtp_header(6000)[:11]))
        self.assertIsNone(feed.parse_rtp(b"\x40" + rtp_header(6000)[1:]))  # version 1


class FrameEndTests(unittest.TestCase):
    """Which relayed packets end a video frame, and so get that frame's metadata."""

    def test_the_marker_packet_of_the_video_ends_its_frame(self):
        self.assertEqual(feed.frame_end(rtp_header(123_456, marker=True)), 123_456)

    def test_other_packets_end_nothing(self):
        self.assertIsNone(feed.frame_end(rtp_header(123_456, marker=False)))
        # A marker on another payload type is not the H.264 stream's frame boundary.
        self.assertIsNone(feed.frame_end(rtp_header(123_456, marker=True, payload_type=97)))
        self.assertIsNone(feed.frame_end(b"\x40" + rtp_header(123_456, marker=True)[1:]))
        self.assertIsNone(feed.frame_end(b""))


class DetectionMessageTests(unittest.TestCase):
    def test_timestamp_is_whole_ms_that_vf_matches_to_the_frame(self):
        for rtp_timestamp in (0, 89, 90, 6000, 1_234_567_891, 0xFFFFFFFF - 89, 0xFFFFFFFF):
            with self.subTest(rtp_timestamp=rtp_timestamp):
                message = feed.detection_message(rtp_timestamp, first_timestamp=0)
                self.assertIsInstance(message["timestamp"], int)
                self.assertGreaterEqual(message["timestamp"], 0)
                # The server: source = uint32(timestamp * 90), matched within ±90 ticks.
                source = (message["timestamp"] * 90) & 0xFFFFFFFF
                self.assertLessEqual(rtp_distance(source, rtp_timestamp), 90)

    def test_names_the_frame_by_its_index_across_a_timestamp_wrap(self):
        first = 0xFFFFFFFF - 5999
        self.assertEqual(feed.detection_message(first, first)["frame_id"], 0)
        self.assertEqual(feed.detection_message((first + 6000 * 31) & 0xFFFFFFFF, first)["frame_id"], 31)

    def test_one_box_around_the_square_the_video_shows_at_that_time(self):
        for seconds, square_x in ((0, 544), (1, 272), (2, 0), (3, 272), (4, 544)):
            with self.subTest(seconds=seconds):
                message = feed.detection_message(seconds * 90_000, first_timestamp=0)
                self.assertEqual(message["type"], "object-detection")
                [box] = message["data"]["objects"]
                x, y, width, height = box["bbox"]
                # The square is 96 px, vertically centred in the 640×480 frame.
                self.assertLessEqual(x, square_x)
                self.assertGreaterEqual(x + width, square_x + 96)
                self.assertLessEqual(y, 192)
                self.assertGreaterEqual(y + height, 192 + 96)
                self.assertTrue(0 <= x and x + width <= 640 and 0 <= y and y + height <= 480)

    def test_fits_one_legacy_metadata_datagram(self):
        # The server takes a datagram that does not start with the chunk magic as a whole JSON message.
        encoded = feed.encode_message(feed.detection_message(0xFFFFFFFF, 0))
        self.assertLess(len(encoded), 1200)
        self.assertNotEqual(encoded[0], 0x4E)
        self.assertEqual(json.loads(encoded), feed.detection_message(0xFFFFFFFF, 0))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg is not installed")
class FeedTests(unittest.TestCase):
    """The feed end to end: ffmpeg's RTP relayed to one socket, its metadata sent to another."""

    def run_feed(self, seconds, metadata_delay_s=0.0):
        video = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        metadata = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for sock in (video, metadata):
            sock.bind(("127.0.0.1", 0))
            sock.setblocking(False)
            self.addCleanup(sock.close)
        stop = threading.Event()
        result = {}
        thread = threading.Thread(
            target=lambda: result.setdefault(
                "code",
                feed.run_feed(video.getsockname(), metadata.getsockname(), metadata_delay_s, stop),
            )
        )
        thread.start()
        frames = {}  # RTP timestamp -> arrival of the frame's last packet
        messages = []  # (arrival, message)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            ready, _, _ = select.select([video, metadata], [], [], 0.05)
            # Drained as they arrive: a socket left to fill would drop packets and skew the arrivals.
            for sock in ready:
                while True:
                    try:
                        data = sock.recv(65536)
                    except BlockingIOError:
                        break
                    if sock is video:
                        # As the muxer was told: the server reads one RTP packet per datagram.
                        self.assertLessEqual(len(data), 1200)
                        packet = feed.parse_rtp(data)
                        self.assertIsNotNone(packet)
                        self.assertEqual(packet.payload_type, 96)
                        if packet.marker:
                            frames[packet.timestamp] = time.monotonic()
                    else:
                        messages.append((time.monotonic(), json.loads(data)))
        stop.set()
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive(), "the feed did not stop")
        self.assertEqual(result.get("code"), 0)
        return frames, messages

    def matching_frame(self, frames, message):
        source = (message["timestamp"] * 90) & 0xFFFFFFFF
        return next((ts for ts in frames if rtp_distance(ts, source) <= 90), None)

    def test_every_message_matches_a_frame_of_the_relayed_video(self):
        frames, messages = self.run_feed(seconds=2.5)

        self.assertGreaterEqual(len(frames), 15)
        self.assertGreaterEqual(len(messages), 15)
        for _, message in messages:
            self.assertIsNotNone(self.matching_frame(frames, message), message)
        frame_ids = [message["frame_id"] for _, message in messages]
        self.assertEqual(frame_ids, list(range(frame_ids[0], frame_ids[0] + len(frame_ids))))

    def test_a_metadata_delay_holds_each_message_back_from_its_frame(self):
        frames, messages = self.run_feed(seconds=2.5, metadata_delay_s=0.4)

        self.assertGreaterEqual(len(messages), 5)
        for arrival, message in messages:
            frame = self.matching_frame(frames, message)
            self.assertIsNotNone(frame, message)
            self.assertGreaterEqual(arrival - frames[frame], 0.3)


if __name__ == "__main__":
    unittest.main()
