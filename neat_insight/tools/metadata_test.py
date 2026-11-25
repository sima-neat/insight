#!/usr/bin/env python3
"""A test feed for one Viewer channel: an H.264 or JPEG test pattern and metadata matched to its frames.

    neat-insight-metadata-test <channel> [--host <host>] [--types <type>,...] [--metadata-delay-ms <ms>]
                               [--codec h264|jpeg] [--size <width>x<height>] [--rate <fps>]

ffmpeg encodes `testsrc2` (640x480 at 15 fps by default; `--size` and `--rate` change both) with a
white square sweeping across it and sends it as RTP to a loopback socket of this program, which
forwards every packet to Insight's video port 9000+N: H.264 as payload type 96, or with
`--codec jpeg` RTP/JPEG (RFC 2435, payload type 26: MJPEG in 4:2:0, RFC 2435 type 1, with
ffmpeg's default Huffman tables, since RFC 2435 carries none; sizes in multiples of 8 up to 2040,
as RTP/JPEG carries them). For each frame (its RTP marker packet) it sends one message of each
type asked for (`--types`, object-detection by default) to Insight's metadata port 9100+N, each
drawn on the square: a box (and a rotated ship that stays put and turns), a track, a pose on its
corners, an elliptic RLE mask, and two classes.

Every message follows Insight's metadata contract (docs/contracts.md): its `timestamp` is the
frame's RTP timestamp in whole milliseconds, and Insight matches a timestamp of T ms to the frame
whose RTP timestamp is within 90 ticks of T*90. ffmpeg starts its RTP timestamps at a random value
and has no option to choose it, so reading them off the relayed packets is the one way to know
them. The overlays follow the square in the video, so one that leaves its square on screen shows a
frame-matching problem.

`--metadata-delay-ms` holds each message back, as a slow model would, to provoke the Viewer's
"Metadata late" notice. The feed runs until SIGINT or SIGTERM. It needs only ffmpeg (with libx264
for H.264) and Python 3, so `scripts/test-feed.sh` copies this file into the Neat SDK container and
runs it there.
"""

import argparse
import json
import math
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
CHANNELS = 80  # the most channels Insight serves

WIDTH, HEIGHT, FPS = 640, 480, 15  # the defaults of --size and --rate
SQUARE = 96
BOX_MARGIN = 4
RTP_CLOCK_RATE = 90_000
PAYLOAD_TYPES = {"h264": 96, "jpeg": 26}
# RTP/JPEG carries a frame's width and height in units of 8 pixels, one byte each (RFC 2435).
JPEG_SIZE_STEP, JPEG_MAX_SIDE = 8, 2040
# The relay socket's receive buffer. The kernel's default (about 208 KiB) overflowed above about
# 40 Mbit/s of video (a heavy JPEG feed) and dropped packets before this program could forward
# them, so Insight counted nearly every frame incomplete; 4 MiB took 92 Mbit/s without loss. The
# kernel holds the request to net.core.rmem_max, so a host whose limit is lower needs it raised.
RELAY_RECEIVE_BUFFER = 4 << 20

CODEC_NAMES = {"h264": "H.264", "jpeg": "RTP/JPEG"}

# The metadata types the feed can send, as the contract names them.
TYPES = ("object-detection", "classification", "tracking", "pose-estimation", "segmentation")

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


def frame_end(datagram: bytes, payload_type: int) -> Optional[int]:
    """The RTP timestamp of the video frame this packet ends (its marker packet), or None."""
    packet = parse_rtp(datagram)
    if packet is None or packet.payload_type != payload_type or not packet.marker:
        return None
    return packet.timestamp


def square_x(seconds: float, width: int = WIDTH) -> float:
    return (width - SQUARE) * abs((seconds / 2) % 2 - 1)


def _ellipse_rle(height: int, width: int) -> dict:
    """An ellipse filling a mask of this size, as the contract's uncompressed RLE: runs over the
    mask column by column, the first one background. A mask covers its segment's bbox, so one mask
    serves every position of the square."""
    counts, previous, run = [], 0, 0
    for x in range(width):
        for y in range(height):
            nx = (x + 0.5) / width * 2 - 1
            ny = (y + 0.5) / height * 2 - 1
            value = 1 if nx * nx + ny * ny <= 1.0 else 0
            if value == previous:
                run += 1
            else:
                counts.append(run)
                previous, run = value, 1
    counts.append(run)
    return {"size": [height, width], "counts": counts}


_ELLIPSE = _ellipse_rle(32, 32)

# The rotated ship of the object-detection feed: fixed above the square's lane, turning once
# every SHIP_TURN_SECONDS. Its upright extent never exceeds the half diagonal around its center.
SHIP_CENTER = (WIDTH // 2, 100)
SHIP_SIZE = (160, 50)
SHIP_TURN_SECONDS = 8


def ship_angle(seconds: float) -> float:
    """The ship's angle in radians, clockwise on screen, a full turn every SHIP_TURN_SECONDS."""
    return (seconds / SHIP_TURN_SECONDS * 2 * math.pi) % (2 * math.pi)


def ship(seconds: float) -> dict:
    """The ship at this time: its `oriented_bbox` and `bbox`, the upright extent of its corners."""
    (cx, cy), (width, height) = SHIP_CENTER, SHIP_SIZE
    angle = round(ship_angle(seconds), 4)  # the sent value, so the extent is of the box as sent
    cos, sin = math.cos(angle), math.sin(angle)
    # Half the extent of a rotated rectangle along each axis.
    half_x = (width * abs(cos) + height * abs(sin)) / 2
    half_y = (width * abs(sin) + height * abs(cos)) / 2
    # Rounded outward, so the whole-pixel box still contains the corners.
    left, top = math.floor(cx - half_x), math.floor(cy - half_y)
    right, bottom = math.ceil(cx + half_x), math.ceil(cy + half_y)
    return {
        "label": "ship",
        "confidence": 0.91,
        "bbox": [left, top, right - left, bottom - top],
        "oriented_bbox": [cx, cy, width, height, angle],
    }


def overlay_data(kind: str, box: list, seconds: float = 0.0) -> dict:
    """The `data` of a message of this type, drawn on the square inside `box` ([x, y, w, h]).

    `seconds` is the frame's time in the video; the object-detection ship turns with it.
    """
    left, top, width, height = box
    right, bottom = left + width, top + height
    if kind == "object-detection":
        return {"objects": [{"label": "square", "confidence": 0.99, "bbox": box}, ship(seconds)]}
    if kind == "tracking":
        return {"tracks": [{"id": "1", "label": "square", "confidence": 0.99, "bbox": box}]}
    if kind == "pose-estimation":
        # COCO names, so the Viewer links the four corners into the square's outline.
        corners = {
            "left_shoulder": (left, top),
            "right_shoulder": (right, top),
            "left_hip": (left, bottom),
            "right_hip": (right, bottom),
        }
        keypoints = [{"name": name, "x": x, "y": y, "confidence": 0.99} for name, (x, y) in corners.items()]
        return {"poses": [{"id": "1", "label": "square", "keypoints": keypoints}]}
    if kind == "segmentation":
        segment = {"label": "square", "confidence": 0.99, "bbox": box, "mask_format": "rle", "mask": _ELLIPSE}
        return {"segments": [segment]}
    if kind == "classification":
        return {"top_classes": [{"label": "test pattern", "confidence": 0.9}, {"label": "square", "confidence": 0.08}]}
    raise ValueError(f"unknown metadata type: {kind}")


def frame_messages(
    rtp_timestamp: int, first_timestamp: int, types=("object-detection",), width=WIDTH, height=HEIGHT, fps=FPS
) -> list:
    """The messages for the frame with this RTP timestamp, one per type in `types`.

    `first_timestamp` is the stream's first RTP timestamp, the frame at t = 0, from which the
    frame's time in the video follows. `width`, `height` and `fps` are the pattern's, as sent to ffmpeg.
    """
    # Modulo 2^32 ticks, so the time survives the RTP timestamp's wrap. After 2^32 ticks of feed
    # (about 13 h 15 min) it restarts at 0 while ffmpeg's t runs on: the overlays then sweep out of
    # phase with the square and frame_id starts again from 0, until the feed is restarted. The
    # `timestamp`, and so Insight's matching, does not depend on it.
    seconds = ((rtp_timestamp - first_timestamp) & 0xFFFFFFFF) / RTP_CLOCK_RATE
    # The overlay filter places the square at whole (even) pixels; the margin covers the rounding.
    x = round(square_x(seconds, width))
    y = (height - SQUARE) // 2
    left, top = max(0, x - BOX_MARGIN), max(0, y - BOX_MARGIN)
    right, bottom = min(width, x + SQUARE + BOX_MARGIN), min(height, y + SQUARE + BOX_MARGIN)
    box = [left, top, right - left, bottom - top]
    return [
        {
            "type": kind,
            # Whole ms rounded down: T*90 lands at most 89 ticks below the frame's RTP timestamp.
            "timestamp": rtp_timestamp // (RTP_CLOCK_RATE // 1000),
            "frame_id": round(seconds * fps),
            "data": overlay_data(kind, box, seconds),
        }
        for kind in types
    ]


def encode_message(message: dict) -> bytes:
    return json.dumps(message, separators=(",", ":")).encode("utf-8")


def _encoder_options(codec: str, fps: int) -> list:
    if codec == "jpeg":
        # The default Huffman tables, since RFC 2435 carries none and ffmpeg's RTP muxer refuses the
        # optimized ones. 4:2:0 (RFC 2435 type 1): ffmpeg 6.1's mjpeg encoder writes yuvj422p as
        # 2x2 luma over 1x2 chroma, which its RTP muxer refuses ("Only 1x1 chroma blocks are
        # supported"), so type 0 (4:2:2) cannot be sent with it.
        return ["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-huffman", "default"]
    return [
        # Constrained baseline without B-frames is what Insight offers browsers; a
        # keyframe with its SPS/PPS every second lets a viewer join at any time.
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-bf", "0",
        "-g", str(fps), "-keyint_min", str(fps), "-sc_threshold", "0",
        "-x264-params", "repeat-headers=1",
    ]


def ffmpeg_command(relay_port: int, codec: str, width: int, height: int, fps: int) -> list:
    graph = (
        f"testsrc2=size={width}x{height}:rate={fps}[pattern];"
        f"color=c=white:size={SQUARE}x{SQUARE}:rate={fps}[square];"
        f"[pattern][square]overlay=x='{_SQUARE_X_EXPR}':y='{_SQUARE_Y_EXPR}':shortest=1"
    )
    return [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-re", "-f", "lavfi", "-i", graph,
        *_encoder_options(codec, fps),
        # Plain UDP and no RTCP: the relay socket expects RTP packets only. A connected socket
        # makes ffmpeg fail and exit once the relay is gone, so a killed feed leaves no encoder.
        "-f", "rtp", "-payload_type", str(PAYLOAD_TYPES[codec]), "-rtpflags", "skip_rtcp",
        f"udp://127.0.0.1:{relay_port}?pkt_size=1200&connect=1",
    ]


def run_feed(
    video_address,
    metadata_address,
    metadata_delay_s: float,
    stop: threading.Event,
    types=("object-detection",),
    codec="h264",
    width=WIDTH,
    height=HEIGHT,
    fps=FPS,
) -> int:
    """Feeds the two addresses until `stop` is set (returns 0) or ffmpeg ends, which is a failure
    since the pattern never ends (returns ffmpeg's exit code, or 1 if that is 0)."""
    relay = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    relay.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, RELAY_RECEIVE_BUFFER)
    relay.bind(("127.0.0.1", 0))
    # The muxer prints an SDP description on stdout, which nobody here reads.
    ffmpeg = subprocess.Popen(ffmpeg_command(relay.getsockname()[1], codec, width, height, fps), stdout=subprocess.DEVNULL)
    payload_type = PAYLOAD_TYPES[codec]
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
            timestamp = frame_end(datagram, payload_type)
            if timestamp is None:
                continue
            if first_timestamp is None:
                first_timestamp = timestamp
            send_at = time.monotonic() + metadata_delay_s
            for message in frame_messages(timestamp, first_timestamp, types, width, height, fps):
                held.append((send_at, encode_message(message)))
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


def parse_types(value: str) -> tuple:
    """`--types`: comma-separated names from `TYPES`, at least one."""
    names = tuple(name.strip() for name in value.split(",") if name.strip())
    if not names or any(name not in TYPES for name in names):
        raise argparse.ArgumentTypeError(f"give one or more of {','.join(TYPES)}")
    return names


def parse_size(value: str) -> tuple:
    """`--size`: `<width>x<height>`, two positive integers, as ffmpeg's lavfi graph takes them."""
    parts = value.split("x")
    if len(parts) != 2 or not all(part.isascii() and part.isdigit() and int(part) > 0 for part in parts):
        raise argparse.ArgumentTypeError("give <width>x<height> of positive whole numbers, such as 640x480")
    return int(parts[0]), int(parts[1])


def parse_rate(value: str) -> int:
    """`--rate`: frames per second, a positive whole number."""
    if not (value.isascii() and value.isdigit() and int(value) > 0):
        raise argparse.ArgumentTypeError("give a positive whole number of frames per second")
    return int(value)


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("channel", type=int, choices=range(CHANNELS), metavar="channel", help="Viewer channel, 0-79")
    parser.add_argument("--host", default="127.0.0.1", help="the machine Insight runs on (default 127.0.0.1)")
    parser.add_argument(
        "--types",
        type=parse_types,
        default=("object-detection",),
        help=f"comma-separated metadata types sent for every frame, of {','.join(TYPES)} (default object-detection)",
    )
    parser.add_argument(
        "--metadata-delay-ms",
        type=int,
        default=0,
        help="hold each metadata message back this long after its frame (default 0)",
    )
    parser.add_argument(
        "--codec", choices=tuple(PAYLOAD_TYPES), default="h264", help="the video's codec: h264 or RTP/JPEG (default h264)"
    )
    parser.add_argument(
        "--size", type=parse_size, default=(WIDTH, HEIGHT), metavar="WxH", help="the video's size (default 640x480)"
    )
    parser.add_argument("--rate", type=parse_rate, default=FPS, metavar="N", help="frames per second (default 15)")
    args = parser.parse_args(argv)
    args.width, args.height = args.size
    if args.codec == "jpeg" and not all(side % JPEG_SIZE_STEP == 0 and side <= JPEG_MAX_SIDE for side in args.size):
        parser.error(
            f"--size with --codec jpeg: RTP/JPEG carries widths and heights in multiples of {JPEG_SIZE_STEP} "
            f"up to {JPEG_MAX_SIDE}, such as 1280x720"
        )
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
        f"channel {args.channel}: {CODEC_NAMES[args.codec]} {args.width}x{args.height} at {args.rate} fps to {args.host}:{video_port}, "
        f"{', '.join(args.types)} to {args.host}:{metadata_port}"
        + (f" {args.metadata_delay_ms} ms after each frame" if args.metadata_delay_ms else ""),
        flush=True,
    )
    code = run_feed(
        (args.host, video_port),
        (args.host, metadata_port),
        args.metadata_delay_ms / 1000,
        stop,
        args.types,
        args.codec,
        args.width,
        args.height,
        args.rate,
    )
    if code != 0:
        print(f"channel {args.channel}: ffmpeg exited with code {code}", file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
