"""Bounded, token-owned microphone tests against daemon-discovered devices."""

import array
import io
import math
import re
import sys
import threading
import time
import uuid
import wave

from neat_insight.board import BoardError

MAX_SECONDS = 30
MAX_TESTS = 4
PREFERRED_RATE = 48000
MAX_CHANNELS = 2
LEVEL_BARS = 96
SILENT_DBFS = -60.0
DETAIL_LIMIT = 2000

_SELECTOR_RE = re.compile(r"^plughw:CARD=[A-Za-z0-9_-]{1,64},DEV=(?:0|[1-9][0-9]{0,2})$")
_BUSY_RE = re.compile(r"Device or resource busy|audio open error: Device", re.IGNORECASE)


def _integer(value, *, minimum=0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def parse_request(body) -> dict:
    if not isinstance(body, dict):
        raise BoardError("invalid_request", "The request body must be a JSON object.")
    for key in ("instance_id", "device_id"):
        if not isinstance(body.get(key), str) or not body[key] or len(body[key]) > 512:
            raise BoardError("invalid_request", f"`{key}` must be a non-empty string from the catalog.")
    if not all(_integer(body.get(key)) for key in ("board_generation", "revision")):
        raise BoardError(
            "invalid_request",
            "`board_generation` and `revision` must be non-negative integers from the catalog.",
        )
    seconds = body.get("seconds", MAX_SECONDS)
    if not _integer(seconds, minimum=1) or seconds > MAX_SECONDS:
        raise BoardError(
            "invalid_request",
            f"`seconds` must be a whole number from 1 to {MAX_SECONDS}.",
        )
    return {
        "board_generation": body["board_generation"],
        "instance_id": body["instance_id"],
        "revision": body["revision"],
        "device_id": body["device_id"],
        "seconds": seconds,
    }


def bind_microphone(catalog: dict, selection: dict) -> dict:
    if (
        catalog.get("instance_id") != selection["instance_id"]
        or catalog.get("revision") != selection["revision"]
    ):
        raise BoardError(
            "stale_snapshot",
            "The peripheral catalog changed since this microphone was selected.",
            hint="Refresh the catalog, select the microphone again, and retry.",
            current_instance_id=catalog.get("instance_id"),
            current_revision=catalog.get("revision"),
        )
    device = next(
        (item for item in catalog.get("devices", []) if item.get("id") == selection["device_id"]),
        None,
    )
    microphone = device.get("microphone") if device and device.get("type") == "microphone" else None
    if not isinstance(microphone, dict):
        raise BoardError(
            "not_found",
            "That microphone is no longer in the peripheral catalog.",
            hint="Refresh the catalog; it may have been unplugged.",
        )
    retained = any(
        issue.get("provider") == device.get("provider")
        and issue.get("retained_last_good") is True
        for issue in catalog.get("issues", [])
        if isinstance(issue, dict)
    )
    if catalog.get("error") is not None or retained:
        raise BoardError(
            "stale_snapshot",
            "The daemon has not freshly validated this microphone's provider.",
            hint="Resolve the provider error, refresh the catalog, and select the microphone again.",
        )
    selector = (microphone.get("capture_target") or {}).get("selector")
    if not isinstance(selector, str) or not _SELECTOR_RE.fullmatch(selector):
        raise BoardError(
            "peripheral_response",
            "The daemon did not provide a safe ALSA capture selector for this microphone.",
            hint="Update the Core peripheral daemon and retry.",
        )
    if (microphone.get("availability") or {}).get("state") == "in_use":
        raise BoardError(
            "microphone_in_use",
            "Another process has the microphone open.",
            hint="Stop the application that is recording from it, refresh the catalog, and retry. Insight never stops it for you.",
        )
    return {"device": device, "selector": selector, **choose_format(microphone)}


def choose_format(microphone: dict) -> dict:
    modes = microphone.get("modes") if isinstance(microphone.get("modes"), list) else []
    rates = []
    channels = []
    for mode in modes:
        if not isinstance(mode, dict):
            continue
        if _integer(mode.get("channels"), minimum=1):
            channels.append(mode["channels"])
        rates.extend(rate for rate in mode.get("rates_hz", []) if _integer(rate, minimum=1))
        rate_range = mode.get("rate_range_hz")
        if isinstance(rate_range, dict):
            low, high = rate_range.get("min"), rate_range.get("max")
            if _integer(low, minimum=1) and _integer(high, minimum=low):
                rates.extend((low, min(high, PREFERRED_RATE)))
                if low <= PREFERRED_RATE <= high:
                    rates.append(PREFERRED_RATE)
    rate = max((value for value in rates if value <= PREFERRED_RATE), default=PREFERRED_RATE)
    channel_count = min(min(channels, default=1), MAX_CHANNELS)
    return {"rate": rate, "channels": channel_count}


def _samples(pcm: bytes) -> array.array:
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _dbfs(value: float):
    return round(20 * math.log10(value / 32768), 1) if value > 0 else None


def _peak(samples) -> int:
    return max(abs(min(samples)), max(samples))


def measure(pcm: bytes, channels: int) -> dict:
    samples = _samples(pcm)
    if not samples:
        return {"peak_dbfs": None, "rms_dbfs": None, "silent": True}
    frames = len(samples) // channels
    bucket = max(1, math.ceil(frames / LEVEL_BARS))
    bars = sorted(
        _peak(samples[index * channels : (index + bucket) * channels])
        for index in range(0, frames, bucket)
    )
    typical = _dbfs(bars[len(bars) // 2])
    return {
        "peak_dbfs": _dbfs(_peak(samples)),
        "rms_dbfs": _dbfs(math.sqrt(sum(sample * sample for sample in samples) / len(samples))),
        "silent": typical is None or typical < SILENT_DBFS,
    }


class _Stopped(Exception):
    pass


class MicrophoneTest:
    def __init__(self, session, selection: dict, bound: dict):
        self.token = uuid.uuid4().hex
        self.created = time.monotonic()
        self.session = session
        self.board_generation = selection["board_generation"]
        self.instance_id = selection["instance_id"]
        self.revision = selection["revision"]
        self.device_id = selection["device_id"]
        self.selector = bound["selector"]
        self.rate = bound["rate"]
        self.channels = bound["channels"]
        self.seconds = selection["seconds"]
        self.state = "recording"
        self.level_dbfs = None
        self.level = None
        self.error = None
        self.wav = None
        self.stop_requested = False
        self.pcm = bytearray()
        self.bytes_received = 0
        self.lock = threading.Lock()
        self.thread = threading.Thread(
            target=self._record,
            name=f"microphone-test-{self.token[:8]}",
            daemon=True,
        )

    def start(self) -> None:
        self.thread.start()

    def request_stop(self) -> None:
        with self.lock:
            if self.state != "recording":
                raise BoardError(
                    "test_not_recording",
                    "This microphone test is no longer recording.",
                    hint="Start a new test to record again.",
                )
            self.stop_requested = True

    def on_chunk(self, chunk: bytes) -> None:
        with self.lock:
            self.pcm += chunk
            self.bytes_received += len(chunk)
            start = len(self.pcm) - len(chunk)
            samples = _samples(self.pcm[start - start % 2 :])
            self.level_dbfs = _dbfs(_peak(samples)) if samples else None
            if self.stop_requested:
                raise _Stopped()

    def status(self) -> dict:
        with self.lock:
            payload = {
                "token": self.token,
                "device_id": self.device_id,
                "board_generation": self.board_generation,
                "instance_id": self.instance_id,
                "revision": self.revision,
                "state": self.state,
                "format": {
                    "rate_hz": self.rate,
                    "channels": self.channels,
                    "sample_bits": 16,
                    "seconds": self.seconds,
                },
                "elapsed_ms": int(
                    self.bytes_received / (self.rate * self.channels * 2) * 1000
                ),
                "level_dbfs": self.level_dbfs if self.state == "recording" else None,
            }
            if self.state == "ready":
                payload.update(
                    level=self.level,
                    audio_url=f"/api/peripherals/microphones/test/{self.token}.wav",
                )
            if self.state == "failed":
                payload["error"] = self.error
            return payload

    def _record(self) -> None:
        command = [
            "arecord",
            "-q",
            "-D",
            self.selector,
            "-f",
            "S16_LE",
            "-r",
            str(self.rate),
            "-c",
            str(self.channels),
            "-d",
            str(self.seconds),
            "-F",
            "50000",
            "-t",
            "raw",
            "-",
        ]
        try:
            try:
                result = self.session.transport.exec(
                    command,
                    timeout=self.seconds + 10,
                    on_stdout=self.on_chunk,
                )
                pcm = _checked(result)
            except _Stopped:
                with self.lock:
                    pcm = bytes(self.pcm)
                if len(pcm) < self.rate * self.channels * 2 // 10:
                    raise BoardError(
                        "command_failed",
                        "The test was stopped before enough audio was recorded.",
                        hint="Start another test, speak, then stop it.",
                    )
            self.session.require_current()
            level = measure(pcm, self.channels)
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(self.channels)
                wav.setsampwidth(2)
                wav.setframerate(self.rate)
                frame_bytes = 2 * self.channels
                wav.writeframes(pcm[: len(pcm) - len(pcm) % frame_bytes])
            with self.lock:
                self.level = level
                self.wav = output.getvalue()
                self.pcm.clear()
                self.state = "ready"
        except BoardError as error:
            self._fail(error)
        except Exception as error:  # Keep the background worker from disappearing silently.
            self._fail(BoardError("command_failed", f"The microphone test failed: {error}"))

    def _fail(self, error: BoardError) -> None:
        with self.lock:
            self.error = error.to_dict()
            self.pcm.clear()
            self.state = "failed"


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
            hint="The board's arecord output is in detail.",
            detail=detail,
        )
    return result.stdout


class TestStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._tests = {}

    def start(self, session, selection: dict, bound: dict) -> dict:
        with self._lock:
            for test in self._tests.values():
                status = test.status()
                if (
                    status["state"] == "recording"
                    and test.board_generation == session.generation
                    and test.device_id == selection["device_id"]
                ):
                    raise BoardError(
                        "test_running",
                        "That microphone is already being tested.",
                        hint="Stop the existing test or wait for it to finish.",
                    )
            self._prune()
            if len(self._tests) >= MAX_TESTS:
                raise BoardError(
                    "test_running",
                    "Too many microphone tests are still active.",
                    hint="Wait for an active test to finish, then retry.",
                )
            test = MicrophoneTest(session, selection, bound)
            self._tests[test.token] = test
        test.start()
        return test.status()

    def status(self, token: str, generation: int) -> dict:
        return self._get(token, generation).status()

    def stop(self, token: str, generation: int) -> dict:
        test = self._get(token, generation)
        test.request_stop()
        return test.status()

    def audio(self, token: str, generation: int):
        test = self._get(token, generation)
        with test.lock:
            return test.wav if test.state == "ready" else None

    def _get(self, token: str, generation: int) -> MicrophoneTest:
        with self._lock:
            test = self._tests.get(token)
        if test is None:
            raise BoardError(
                "not_found",
                "This microphone test does not exist or has expired.",
                hint="Start a new microphone test.",
            )
        if test.board_generation != generation:
            raise BoardError(
                "stale_snapshot",
                "This microphone test belongs to a different selected board.",
                hint="Return to that board or start a new test on the current board.",
            )
        return test

    def _prune(self) -> None:
        completed = sorted(
            (test for test in self._tests.values() if test.status()["state"] != "recording"),
            key=lambda test: test.created,
        )
        while len(self._tests) >= MAX_TESTS and completed:
            del self._tests[completed.pop(0).token]


tests = TestStore()
