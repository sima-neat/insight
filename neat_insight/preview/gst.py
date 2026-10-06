"""The board-side GStreamer pipeline of a camera preview, and the JPEG frames it writes to stdout."""
import re
import shlex
from fractions import Fraction
from typing import List, Optional

PREVIEW_WIDTH = 640
PREVIEW_FPS = Fraction(15)
JPEG_QUALITY = 70
BOUNDARY = "frame"
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_HEADER_BYTES = 1024
# V4L2 FourCCs Sentinel reports for USB cameras, by the format name v4l2src gives them in video/x-raw caps.
RAW_FORMATS = {
    "YUYV": "YUY2",
    "UYVY": "UYVY",
    "YVYU": "YVYU",
    "NV12": "NV12",
    "NV21": "NV21",
    "YU12": "I420",
    "YV12": "YV12",
    "GREY": "GRAY8",
    "RGB3": "RGB",
    "BGR3": "BGR",
}
_DELIMITER = b"--" + BOUNDARY.encode() + b"\r\n"
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_LENGTH = re.compile(rb"[0-9]{1,8}")


class FrameError(ValueError):
    """The board's output is not the multipart JPEG stream the pipeline writes."""


def preview_size(width: int, height: int) -> tuple:
    """The preview's size: at most PREVIEW_WIDTH wide (never upscaled), the camera's aspect ratio, both even."""
    preview_width = max(2, min(PREVIEW_WIDTH, width) // 2 * 2)
    # Round half up to the nearest even height.
    return preview_width, max(2, 2 * ((preview_width * height + width) // (2 * width)))


def fraction(rate: Fraction) -> str:
    return f"{rate.numerator}/{rate.denominator}"


def quoted(value: str) -> Optional[str]:
    """A GStreamer string property value, double-quoted so spaces, `!` and quotes stay part of it;
    None for a value with control characters, which no quoting carries."""
    if _CONTROL.search(value):
        return None
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def pipeline(connection: str, source: str, fmt: str, width: int, height: int, rate: Fraction) -> List[str]:
    """gst-launch-1.0 arguments that capture one mode and write it as multipart JPEG to stdout.

    `source` is a MIPI camera's libcamera name or a USB camera's device path, already passed through
    quoted(); `fmt` is NV12 for MIPI, and MJPG or a RAW_FORMATS key for USB."""
    caps = f"width={width},height={height},framerate={fraction(rate)}"
    if connection == "mipi":
        head = ["libcamerasrc", f"camera-name={source}", "!", f"video/x-raw,format=NV12,{caps}"]
    elif fmt == "MJPG":
        head = ["v4l2src", f"device={source}", "!", f"image/jpeg,{caps}", "!", "jpegdec"]
    else:
        head = ["v4l2src", f"device={source}", "!", f"video/x-raw,format={RAW_FORMATS[fmt]},{caps}", "!", "videoconvert"]
    preview_width, preview_height = preview_size(width, height)
    return head + [
        "!", "videoscale",
        "!", "videorate",
        "!", f"video/x-raw,width={preview_width},height={preview_height},framerate={fraction(min(rate, PREVIEW_FPS))}",
        "!", "jpegenc", f"quality={JPEG_QUALITY}",
        "!", "multipartmux", f"boundary={BOUNDARY}",
        "!", "fdsink", "fd=1",
    ]


def board_command(arguments: List[str]) -> List[str]:
    """The board command: the shell prints its PID to stderr, then becomes gst-launch-1.0 with that PID."""
    return ["sh", "-c", "echo $$ >&2; exec gst-launch-1.0 -q " + shlex.join(arguments)]


def part(frame: bytes) -> bytes:
    """One frame as a part of the `multipart/x-mixed-replace; boundary=frame` response."""
    head = f"Content-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode()
    return _DELIMITER + head + frame + b"\r\n"


class FrameParser:
    """Complete JPEG frames from multipartmux output: `--frame`, part headers, a blank line, then
    Content-Length bytes. The board's framing is checked, never trusted: header and frame sizes are
    bounded, and every frame must be a JPEG."""

    def __init__(self):
        self._buffer = bytearray()

    def feed(self, data: bytes) -> List[bytes]:
        self._buffer += data
        frames = []
        while True:
            frame = self._next()
            if frame is None:
                return frames
            frames.append(frame)

    def _next(self) -> Optional[bytes]:
        buffer = self._buffer
        start = buffer.find(_DELIMITER)
        if start < 0:
            # Keep only what could still be the start of a delimiter.
            del buffer[:max(0, len(buffer) - len(_DELIMITER) + 1)]
            return None
        del buffer[:start]  # The CRLF that ends the previous part, or bytes that are not a part.
        end = buffer.find(b"\r\n\r\n", len(_DELIMITER) - 2)
        if end < 0 or end > MAX_HEADER_BYTES:
            if end > MAX_HEADER_BYTES or len(buffer) > MAX_HEADER_BYTES:
                raise FrameError("A part's headers are longer than a JPEG part's.")
            return None
        length = self._length(bytes(buffer[len(_DELIMITER):end]))
        body = end + 4
        if len(buffer) < body + length:
            return None
        frame = bytes(buffer[body:body + length])
        del buffer[:body + length]
        if not frame.startswith(b"\xff\xd8"):
            raise FrameError("A part is not a JPEG image.")
        return frame

    @staticmethod
    def _length(block: bytes) -> int:
        headers = {}
        for line in block.split(b"\r\n") if block else []:
            name, colon, value = line.partition(b":")
            if not colon:
                raise FrameError("A part header is malformed.")
            headers[name.strip().lower()] = value.strip()
        if headers.get(b"content-type", b"image/jpeg") != b"image/jpeg":
            raise FrameError("A part is not a JPEG image.")
        length = headers.get(b"content-length", b"")
        if not _LENGTH.fullmatch(length) or not 0 < int(length) <= MAX_FRAME_BYTES:
            raise FrameError(f"A part's Content-Length is missing or over {MAX_FRAME_BYTES} bytes.")
        return int(length)
