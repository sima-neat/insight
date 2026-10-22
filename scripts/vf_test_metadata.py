#!/usr/bin/env python3
"""A test feed for one vf channel: an H.264 test pattern and object-detection metadata matched to it.

    python3 vf_test_metadata.py <channel> [--metadata-delay-ms <ms>]

ffmpeg encodes `testsrc2` (640x480 at 15 fps) with a white square sweeping across it and sends it
as RTP (payload type 96) to a loopback socket of this script, which forwards every packet to vf's
video port 9000+N. For each frame (its RTP marker packet) it sends one object-detection message
with a box around the square to vf's metadata port 9100+N.

The message's `timestamp` comes from the RTP timestamp of the frame it describes: vf matches a
producer timestamp of T ms to the frame whose RTP timestamp is within 90 ticks of T*90 (Inv §2c).
ffmpeg starts its RTP timestamps at a random value and has no option to choose it, so reading them
off the relayed packets is the one way to know them. The box follows the square in the video, so a
box that leaves its square on screen shows a frame-matching problem.

`--metadata-delay-ms` holds each message back, as a slow model would, to provoke the Viewer's
"Metadata late" notice. The feed runs until SIGINT or SIGTERM. Normally `vf-test-feed.sh` beside it
starts and stops it inside the Neat SDK container; it needs only ffmpeg (with libx264) and Python 3.
"""

import argparse
import json
import signal
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from typing import NamedTuple, Optional

VIDEO_BASE_PORT = 9000
METADATA_BASE_PORT = 9100
CHANNELS = 80  # vf's channel slots

WIDTH, HEIGHT, FPS = 640, 480, 15
SQUARE = 96
BOX_MARGIN = 4
RTP_CLOCK_RATE = 90_000
PAYLOAD_TYPE = 96

# The square's position as ffmpeg's overlay filter computes it per frame, t in seconds: a sweep
# from the right edge to the left and back every 4 s. `square_x` below is the same formula; they
# must change together.
_SQUARE_X_EXPR = "(W-w)*abs(mod(t/2,2)-1)"
_SQUARE_Y_EXPR = "(H-h)/2"


class RtpPacket(NamedTuple):
    timestamp: int
    marker: bool
    payload_type: int


def parse_rtp(datagram: bytes) -> Optional[RtpPacket]:
    """The header fields of an RTP packet (RFC 3550), or None for anything else."""
    if len(datagram) < 12 or datagram[0] >> 6 != 2:
        return None
    return RtpPacket(
        timestamp=int.from_bytes(datagram[4:8], "big"),
        marker=bool(datagram[1] & 0x80),
        payload_type=datagram[1] & 0x7F,
    )


def frame_end(datagram: bytes) -> Optional[int]:
    """The RTP timestamp of the video frame this packet ends (its marker packet), or None."""
    packet = parse_rtp(datagram)
    if packet is None or packet.payload_type != PAYLOAD_TYPE or not packet.marker:
        return None
    return packet.timestamp


def square_x(seconds: float) -> float:
    return (WIDTH - SQUARE) * abs((seconds / 2) % 2 - 1)


def detection_message(rtp_timestamp: int, first_timestamp: int) -> dict:
    """The object-detection message for the frame with this RTP timestamp.

    `first_timestamp` is the stream's first RTP timestamp, the frame at t = 0, from which the
    frame's time in the video follows.
    """
    # Modulo 2^32 ticks, so the time survives the RTP timestamp's wrap. After 2^32 ticks of feed
    # (about 13 h 15 min) it restarts at 0 while ffmpeg's t runs on: the box then sweeps out of
    # phase with the square and frame_id starts again from 0, until the feed is restarted. The
    # `timestamp`, and so vf's matching, does not depend on it.
    seconds = ((rtp_timestamp - first_timestamp) & 0xFFFFFFFF) / RTP_CLOCK_RATE
    # The overlay filter places the square at whole (even) pixels; the margin covers the rounding.
    x = round(square_x(seconds))
    y = (HEIGHT - SQUARE) // 2
    left, top = max(0, x - BOX_MARGIN), max(0, y - BOX_MARGIN)
    right, bottom = min(WIDTH, x + SQUARE + BOX_MARGIN), min(HEIGHT, y + SQUARE + BOX_MARGIN)
    return {
        "type": "object-detection",
        # Whole ms rounded down: T*90 lands at most 89 ticks below the frame's RTP timestamp.
        "timestamp": rtp_timestamp // (RTP_CLOCK_RATE // 1000),
        "frame_id": round(seconds * FPS),
        "data": {
            "objects": [
                {"label": "square", "confidence": 0.99, "bbox": [left, top, right - left, bottom - top]},
            ]
        },
    }


def encode_message(message: dict) -> bytes:
    return json.dumps(message, separators=(",", ":")).encode("utf-8")


def ffmpeg_command(relay_port: int) -> list:
    graph = (
        f"testsrc2=size={WIDTH}x{HEIGHT}:rate={FPS}[pattern];"
        f"color=c=white:size={SQUARE}x{SQUARE}:rate={FPS}[square];"
        f"[pattern][square]overlay=x='{_SQUARE_X_EXPR}':y='{_SQUARE_Y_EXPR}':shortest=1"
    )
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-re", "-f", "lavfi", "-i", graph,
        # Constrained baseline without B-frames is what vf negotiates with browsers (Inv §2a); a
        # keyframe with its SPS/PPS every second lets a viewer join at any time.
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-bf", "0",
        "-g", str(FPS), "-keyint_min", str(FPS), "-sc_threshold", "0",
        "-x264-params", "repeat-headers=1",
        # Plain UDP and no RTCP: the relay socket expects RTP packets only. A connected socket
        # makes ffmpeg fail and exit once the relay is gone, so a killed feed leaves no encoder.
        "-f", "rtp", "-payload_type", str(PAYLOAD_TYPE), "-rtpflags", "skip_rtcp",
        f"udp://127.0.0.1:{relay_port}?pkt_size=1200&connect=1",
    ]


def run_feed(video_address, metadata_address, metadata_delay_s: float, stop: threading.Event) -> int:
    """Feeds the two addresses until `stop` is set (returns 0) or ffmpeg ends, which is a failure
    since the pattern never ends (returns ffmpeg's exit code, or 1 if that is 0)."""
    relay = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    relay.bind(("127.0.0.1", 0))
    # The muxer prints an SDP description on stdout, which nobody here reads.
    ffmpeg = subprocess.Popen(ffmpeg_command(relay.getsockname()[1]), stdout=subprocess.DEVNULL)
    first_timestamp = None
    held = deque()  # (send at, encoded message), in send order: the delay is the same for all
    try:
        while not stop.is_set():
            if ffmpeg.poll() is not None:
                return ffmpeg.returncode or 1
            now = time.monotonic()
            while held and held[0][0] <= now:
                sender.sendto(held.popleft()[1], metadata_address)
            # Short enough to notice `stop` and a dead ffmpeg promptly, and wake for held messages.
            relay.settimeout(min(0.2, held[0][0] - now) if held else 0.2)
            try:
                datagram = relay.recv(65536)
            except socket.timeout:
                continue
            sender.sendto(datagram, video_address)
            timestamp = frame_end(datagram)
            if timestamp is None:
                continue
            if first_timestamp is None:
                first_timestamp = timestamp
            message = encode_message(detection_message(timestamp, first_timestamp))
            held.append((time.monotonic() + metadata_delay_s, message))
        return 0
    finally:
        ffmpeg.terminate()
        try:
            ffmpeg.wait(timeout=5)
        except subprocess.TimeoutExpired:
            ffmpeg.kill()
            ffmpeg.wait()
        relay.close()
        sender.close()


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("channel", type=int, choices=range(CHANNELS), metavar="channel", help="vf channel, 0-79")
    parser.add_argument(
        "--metadata-delay-ms",
        type=int,
        default=0,
        help="hold each metadata message back this long after its frame (default 0)",
    )
    args = parser.parse_args(argv)
    if args.metadata_delay_ms < 0:
        parser.error("--metadata-delay-ms must not be negative")
    return args


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    video_port = VIDEO_BASE_PORT + args.channel
    metadata_port = METADATA_BASE_PORT + args.channel
    print(
        f"channel {args.channel}: H.264 {WIDTH}x{HEIGHT} at {FPS} fps to UDP {video_port}, "
        f"object-detection to UDP {metadata_port}"
        + (f" {args.metadata_delay_ms} ms after each frame" if args.metadata_delay_ms else ""),
        flush=True,
    )
    code = run_feed(
        ("127.0.0.1", video_port), ("127.0.0.1", metadata_port), args.metadata_delay_ms / 1000, stop
    )
    if code != 0:
        print(f"channel {args.channel}: ffmpeg exited with code {code}", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
