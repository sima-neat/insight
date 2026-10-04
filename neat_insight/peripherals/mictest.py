"""Record from a microphone on the board until Stop, with a live level, to play back in the browser.

The recording goes through the ALSA `plughw:` device that SiMa Sentinel names for the microphone,
which converts whatever the hardware captures to 16-bit PCM at the requested rate and channel
count. That makes one recording path work for every capture device, and gives the browser a WAV it
can always play. Before recording, Insight re-reads Sentinel's catalog and records only from the
device the scan showed; it never builds a device name from a card number.
"""
import array
import io
import math
import re
import sys
import threading
import uuid
import wave
from typing import Optional

from neat_insight.board import BoardError
from neat_insight.board.transport import CommandCancelled

# The longest a test records when nobody presses Stop.
DEFAULT_SECONDS = 30
MAX_SECONDS = 30
# At most 48 kHz, 2 channels, 16 bits and 30 s: about 5.5 MiB, well inside the transports' output limit.
PREFERRED_RATE = 48000
MAX_CHANNELS = 2
LEVEL_BARS = 96
# A recording is "nothing picked up" when its typical (median) 1/96th-slice peak is below this. Not the
# peak or RMS: a USB microphone can click when it is opened, and one click moves both. A quiet room
# measured about -48 dBFS RMS on a Yeti Nano.
SILENT_DBFS = -60.0
DETAIL_LIMIT = 2000
REFRESH_HINT = "Click Refresh, then test again."

# The only device names arecord is given: Sentinel's selector for a card with a safe stable id.
_SELECTOR_RE = re.compile(r"^plughw:CARD=[A-Za-z0-9_-]{1,64},DEV=(?:0|[1-9][0-9]{0,2})$")
_BUSY_RE = re.compile(r"Device or resource busy|audio open error: Device", re.IGNORECASE)

_lock = threading.Lock()


def _integer(value, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def parse_request(body) -> tuple:
    if not isinstance(body, dict) or not isinstance(body.get("id"), str) or not body["id"]:
        raise BoardError("invalid_request", "Name the microphone to test with `id`.", hint="Send the id from the scan.")
    seconds = body.get("seconds", DEFAULT_SECONDS)
    if not _integer(seconds, 1) or seconds > MAX_SECONDS:
        raise BoardError(
            "invalid_request",
            f"`seconds` must be a whole number from 1 to {MAX_SECONDS}.",
            hint=f"Omit it to record until stopped, at most {DEFAULT_SECONDS} seconds.",
        )
    return body["id"], seconds


def find_microphone(snapshot: dict, mic_id: str) -> dict:
    for item in snapshot.get("items") or []:
        if item.get("id") == mic_id and item.get("kind") == "microphone":
            return item
    raise BoardError(
        "not_found",
        f"The last scan lists no microphone `{mic_id}`.",
        hint="Click Refresh; the microphone may have been unplugged.",
    )


def bind_microphone(catalog: dict, scanned: dict, mic_id: str) -> dict:
    """The selector and format to record with, from Sentinel's current catalog.

    `scanned` is the `instance_id` and `revision` of the catalog the last scan showed: a restarted
    Sentinel or a changed catalog can route the same id elsewhere, so either one means Refresh first.
    """
    if (catalog.get("instance_id"), catalog.get("revision")) != (scanned["instance_id"], scanned["revision"]):
        raise BoardError(
            "stale_snapshot",
            "SiMa Sentinel's peripheral catalog changed since the last scan.",
            hint=REFRESH_HINT,
            current_instance_id=catalog.get("instance_id"),
            current_revision=catalog.get("revision"),
        )
    device = next((item for item in catalog.get("devices", []) if item.get("id") == mic_id), None)
    microphone = device.get("microphone") if device and device.get("type") == "microphone" else None
    if not isinstance(microphone, dict):
        raise BoardError(
            "not_found",
            "That microphone is no longer in SiMa Sentinel's catalog.",
            hint="Click Refresh; the microphone may have been unplugged.",
        )
    retained = any(
        issue.get("provider") == device.get("provider") and issue.get("retained_last_good") is True
        for issue in catalog.get("issues", [])
    )
    if catalog.get("error") is not None or retained:
        raise BoardError(
            "stale_snapshot",
            "SiMa Sentinel could not freshly read this microphone; its details are from an earlier scan.",
            hint="Resolve the problem the page reports, then click Refresh and test again.",
        )
    selector = (microphone.get("capture_target") or {}).get("selector")
    if not isinstance(selector, str) or not _SELECTOR_RE.fullmatch(selector):
        raise BoardError(
            "peripheral_response",
            "SiMa Sentinel did not name a safe ALSA capture device for this microphone.",
            hint="Click Refresh once the device has finished initializing; if this persists, update SiMa Sentinel "
            "with `sima-cli neat install sentinel`.",
        )
    if (microphone.get("availability") or {}).get("state") == "in_use":
        raise BoardError(
            "microphone_in_use",
            "Another process has the microphone open.",
            hint="Stop the application that is recording from it, then test again. Insight never stops it for you.",
        )
    return {"selector": selector, **choose_format(microphone)}


def choose_format(microphone: dict) -> dict:
    """The rate and channels to record at: 48 kHz when the hardware has it, else its nearest rate below
    (plughw resamples a device that only offers higher rates); at most two channels."""
    rates, channels = [], []
    for mode in microphone.get("modes") or []:
        if _integer(mode.get("channels"), 1):
            channels.append(mode["channels"])
        rates += [rate for rate in mode.get("rates_hz") or [] if _integer(rate, 1)]
        span = mode.get("rate_range_hz")
        if isinstance(span, dict) and _integer(span.get("min"), 1) and _integer(span.get("max"), span["min"]):
            rates += [span["min"], min(span["max"], PREFERRED_RATE)]
    rate = max((value for value in rates if value <= PREFERRED_RATE), default=PREFERRED_RATE)
    return {"rate": rate, "channels": min(min(channels, default=1), MAX_CHANNELS)}


def record_command(device: str, rate: int, channels: int, seconds: int) -> list:
    # 50 ms periods: arecord hands over audio that often, which is what the live meter shows.
    return ["arecord", "-q", "-D", device, "-f", "S16_LE", "-r", str(rate), "-c", str(channels),
            "-d", str(seconds), "-F", "50000", "-t", "raw", "-"]


def _samples(pcm: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _dbfs(value: float):
    return round(20 * math.log10(value / 32768), 1) if value > 0 else None


def measure(pcm: bytes, channels: int) -> dict:
    """Peak and RMS in dBFS (None for digital silence), and whether anything was picked up."""
    samples = _samples(pcm)
    if not samples:
        return {"peak_dbfs": None, "rms_dbfs": None, "silent": True}
    peak = max(abs(min(samples)), max(samples))
    rms = math.sqrt(sum(s * s for s in samples) / len(samples))
    frames = len(samples) // channels
    bucket = max(1, math.ceil(frames / LEVEL_BARS))
    bars = sorted(
        max(abs(min(chunk)), max(chunk))
        for chunk in (samples[i * channels:(i + bucket) * channels] for i in range(0, frames, bucket))
    )
    typical = _dbfs(bars[len(bars) // 2])
    return {"peak_dbfs": _dbfs(peak), "rms_dbfs": _dbfs(rms), "silent": typical is None or typical < SILENT_DBFS}


def chunk_level(pcm: bytes):
    """Peak of one chunk in dBFS, for the live meter; None for digital silence."""
    samples = _samples(pcm)
    return _dbfs(max(abs(min(samples)), max(samples))) if samples else None


def wav_bytes(pcm: bytes, rate: int, channels: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(pcm[: len(pcm) - len(pcm) % (2 * channels)])
    return out.getvalue()


class _Stopped(Exception):
    """Raised from the output callback to end a recording the user stopped."""


class MicTest:
    """One recording: its live level while arecord runs, then the WAV or the error."""

    def __init__(self, generation: int, mic_id: str, device: str, rate: int, channels: int, seconds: int):
        self.token = uuid.uuid4().hex
        self.generation = generation
        self.mic_id = mic_id
        self.device = device
        self.rate, self.channels, self.seconds = rate, channels, seconds
        self.state = "recording"
        self.level_dbfs = None
        self.received = 0
        self.level = None
        self.error = None
        self.wav = None
        self.thread = None
        self.stop_requested = False
        # Set on Stop: the transport then ends arecord even while it prints nothing (a stalled capture).
        self.cancel_event = threading.Event()
        self.lock = threading.Lock()
        self.pcm = bytearray()
        self._carry = b""

    def on_chunk(self, chunk: bytes) -> None:
        with self.lock:
            self.pcm += chunk
            data = self._carry + chunk
            whole = len(data) - len(data) % 2
            self._carry = data[whole:]
            self.received += len(chunk)
            self.level_dbfs = chunk_level(data[:whole])
            # Stopping aborts the command: the transport closes its channel or kills the process,
            # so arecord ends within one 50 ms period, and what arrived so far is the recording.
            if self.stop_requested:
                raise _Stopped()

    def request_stop(self) -> None:
        with self.lock:
            if self.state == "recording":
                self.stop_requested = True
                self.cancel_event.set()

    def finish(self, level: Optional[dict] = None, wav: Optional[bytes] = None, error: Optional[BoardError] = None):
        with self.lock:
            self.pcm = bytearray()
            if error is None:
                self.level, self.wav, self.state = level, wav, "ready"
            else:
                self.error, self.state = error.to_dict(), "failed"

    def status(self) -> dict:
        with self.lock:
            status = {
                "token": self.token,
                "id": self.mic_id,
                "state": self.state,
                "device": self.device,
                "format": {"rate": self.rate, "channels": self.channels, "bits": 16, "seconds": self.seconds},
                "elapsed_ms": int(self.received / (self.rate * self.channels * 2) * 1000),
                "level_dbfs": self.level_dbfs if self.state == "recording" else None,
            }
            if self.state == "ready":
                status["level"] = self.level
                status["audio_url"] = f"/api/peripherals/microphones/test/{self.token}.wav"
            if self.state == "failed":
                status["error"] = self.error
            return status


_current: Optional[MicTest] = None


def start(session, mic_id: str, bound: dict, seconds: int) -> dict:
    """Start recording in the background and return at once; poll `current()` for the level.

    One test records at a time, so the board runs at most one arecord for Insight.
    """
    global _current
    with _lock:
        if _current is not None and _current.status()["state"] == "recording":
            raise BoardError("test_running", "A microphone test is already recording.", hint="Wait for it to finish.")
        test = MicTest(session.generation, mic_id, bound["selector"], bound["rate"], bound["channels"], seconds)
        test.thread = threading.Thread(target=_record, args=(session, test), name="mic-test", daemon=True)
        _current = test
    test.thread.start()
    return test.status()


def stop(generation: int) -> Optional[dict]:
    """Ask the recording on the selected board to end now; the result follows as for a full one."""
    test = _current
    if test is None or test.generation != generation:
        return None
    test.request_stop()
    return test.status()


def current(generation: int) -> Optional[dict]:
    test = _current
    return test.status() if test is not None and test.generation == generation else None


def audio(token: str) -> Optional[bytes]:
    test = _current
    if test is None or test.token != token:
        return None
    with test.lock:
        return test.wav if test.state == "ready" else None


def _record(session, test: MicTest) -> None:
    command = record_command(test.device, test.rate, test.channels, test.seconds)
    try:
        try:
            result = session.transport.exec(
                command, timeout=test.seconds + 10, on_stdout=test.on_chunk, cancel_event=test.cancel_event
            )
            pcm = _checked(result)
        except (_Stopped, CommandCancelled):
            with test.lock:
                pcm = bytes(test.pcm)
            if len(pcm) < test.rate * test.channels * 2 // 10:
                raise BoardError(
                    "stopped_early", "The test was stopped before anything was recorded.", hint="Test again and speak."
                ) from None
        # A recording from a board that is no longer selected is not this board's result.
        session.require_current()
        test.finish(measure(pcm, test.channels), wav_bytes(pcm, test.rate, test.channels))
    except BoardError as err:
        test.finish(error=err)
    except Exception as exc:  # the page is polling; it must learn that the recording ended
        test.finish(error=BoardError("command_failed", f"The microphone test failed: {exc}"))


def _checked(result) -> bytes:
    detail = result.stderr.decode("utf-8", errors="replace").strip()[-DETAIL_LIMIT:]
    if result.exit_code == 127:
        raise BoardError(
            "tool_missing",
            "arecord was not found on the board.",
            hint="Install alsa-utils on the board, then test again.",
            tool="arecord",
        )
    if _BUSY_RE.search(detail):
        raise BoardError(
            "microphone_in_use",
            "Another process has the microphone open.",
            hint="Stop the application that is recording from it, then test again. Insight never stops it for you.",
            detail=detail,
        )
    if result.exit_code != 0 or not result.stdout:
        raise BoardError(
            "command_failed",
            "Recording from the microphone failed on the board.",
            hint="The board's output is in detail.",
            detail=detail,
        )
    return result.stdout
