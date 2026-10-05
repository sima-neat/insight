"""Read the peripheral catalog from SiMa Sentinel on the selected board."""
import json
import re
from http.client import HTTPException
from pathlib import Path

from neat_insight.board import BoardError
from neat_insight.peripherals import socket_client

CLIENT_PATH = Path(socket_client.__file__)
DETAIL_LIMIT = 2000
# Sentinel's refresh waits up to 10 s for its scan; the socket gets more so Sentinel's own 504 arrives.
REFRESH_TIMEOUT_SEC = 20.0
# RFC 3339 in UTC, as Sentinel serializes `observed_at`.
_OBSERVED_AT = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z")
INSTALL_HINT = "Install or update it with `sima-cli neat install sentinel`, then check `systemctl status simaai-sentinel`."
STATUS_HINT = "Check `systemctl status simaai-sentinel` and `journalctl -u simaai-sentinel` on the board."

_SOCKET_ERRORS = {
    socket_client.MISSING: (
        "peripheral_missing",
        "SiMa Sentinel is not installed or not running on {label}: its socket {socket} does not exist.",
        INSTALL_HINT,
    ),
    socket_client.REFUSED: (
        "peripheral_refused",
        "SiMa Sentinel is not running on {label}: nothing is listening on {socket}.",
        "Start it with `sudo systemctl start simaai-sentinel`. " + INSTALL_HINT,
    ),
    socket_client.DENIED: (
        "peripheral_denied",
        "The SiMa Sentinel socket {socket} on {label} cannot be opened by this user.",
        "Check the service and socket permissions on the board.",
    ),
    socket_client.TIMED_OUT: (
        "timeout",
        "SiMa Sentinel on {label} did not answer before the request timed out.",
        STATUS_HINT,
    ),
    socket_client.FAILED: (
        "peripheral_unavailable",
        "The SiMa Sentinel socket {socket} on {label} could not be used.",
        STATUS_HINT,
    ),
    socket_client.PROTOCOL: (
        "peripheral_response",
        "SiMa Sentinel on {label} returned a malformed or incomplete HTTP response.",
        STATUS_HINT,
    ),
}


def _non_negative_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _object_or_none(value) -> bool:
    return value is None or isinstance(value, dict)


def _fraction(value) -> bool:
    return isinstance(value, dict) and _positive_int(value.get("numerator")) and _positive_int(value.get("denominator"))


# The fractions of each interval type that the snapshot divides by; Sentinel reports none of them as zero.
INTERVAL_FRACTIONS = {"stepwise": ("minimum", "maximum", "step"), "continuous": ("minimum", "maximum")}


def _valid_interval(interval) -> bool:
    if not isinstance(interval, dict):
        return False
    kind = interval.get("type")
    if kind == "discrete":
        return _fraction(interval)
    # The snapshot reads any other kind as a range, so an unknown or missing kind must not pass.
    if not isinstance(kind, str) or kind not in INTERVAL_FRACTIONS:
        return False
    return all(_fraction(interval.get(key)) for key in INTERVAL_FRACTIONS[kind])

class PeripheralClient:
    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

    def catalog(self) -> dict:
        payload = self._call("GET", "/v1/peripherals")
        self._validate_catalog(payload)
        return payload

    def refresh(self) -> dict:
        """Rescan: Sentinel answers with the catalog of a scan that started after the request."""
        payload = self._call("POST", "/v1/peripherals/refresh", timeout=REFRESH_TIMEOUT_SEC)
        self._validate_catalog(payload)
        return payload

    def _call(self, method: str, path: str, body=None, timeout=socket_client.TIMEOUT_SEC) -> dict:
        if self.session.target.mode == "local":
            status, text = self._call_local(method, path, body, timeout)
        else:
            status, text = self._call_remote(method, path, body, timeout)
        self.session.require_current()
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if not 200 <= status < 300:
            detail = (parsed.get("reason") or parsed.get("error")) if isinstance(parsed, dict) else None
            detail = str(detail or text or "").strip()[:DETAIL_LIMIT]
            if status == 404:
                # Sentinel answers routes it does not know with 404, so it predates peripheral discovery.
                raise BoardError(
                    "peripheral_version",
                    f"SiMa Sentinel on {self.session.target.label} does not provide the peripheral catalog.",
                    hint=INSTALL_HINT,
                    detail=detail,
                    daemon_status=status,
                )
            # 504: the refresh's scan did not finish within Sentinel's limit; 429: too many refreshes wait.
            code = {400: "invalid_request", 504: "timeout"}.get(status, "peripheral_unavailable")
            hint = {
                400: "Correct the request and retry.",
                429: "Other refreshes are waiting on the board; retry in a moment.",
            }.get(status, STATUS_HINT)
            raise BoardError(
                code,
                detail or f"SiMa Sentinel rejected the request with HTTP {status}.",
                hint=hint,
                daemon_status=status,
            )
        if not isinstance(parsed, dict):
            raise self._response_error("SiMa Sentinel returned a response Insight cannot read.", text)
        return parsed

    def _call_local(self, method, path, body, timeout):
        try:
            return socket_client.request(method, path, body, socket_path=self.socket_path, timeout=timeout)
        except socket_client.ResponseTooLarge as exc:
            raise self._too_large(str(exc)) from exc
        except HTTPException as exc:
            raise self._socket_error(socket_client.PROTOCOL, str(exc)) from exc
        except OSError as exc:
            raise self._socket_error(socket_client.socket_failure(exc), str(exc)) from exc

    def _call_remote(self, method, path, body, timeout):
        argv = [
            "python3",
            "-",
            method,
            path,
            json.dumps(body) if body is not None else "",
            self.socket_path,
            str(timeout),
        ]
        result = self.session.transport.exec(
            argv,
            timeout=timeout + 15.0,
            stdin=CLIENT_PATH.read_bytes(),
        )
        if result.exit_code == 127:
            raise BoardError(
                "tool_missing",
                "python3 was not found on the board, so SiMa Sentinel cannot be reached.",
                hint="Install python3 (3.8 or newer) on the board, then retry.",
                tool="python3",
            )
        try:
            envelope = json.loads(result.stdout.decode("utf-8", errors="replace"))
        except ValueError:
            envelope = None
        if not isinstance(envelope, dict) or ("status" not in envelope and "failure" not in envelope):
            raise BoardError(
                "peripheral_response",
                f"The Sentinel socket client did not run on the board (python3 exited {result.exit_code}).",
                hint="Check that python3 on the board is 3.8 or newer; its error output is in detail.",
                detail=result.stderr.decode("utf-8", errors="replace").strip()[:DETAIL_LIMIT],
            )
        if envelope.get("failure") == socket_client.TOO_LARGE:
            raise self._too_large(envelope.get("detail", ""))
        if "failure" in envelope:
            raise self._socket_error(envelope["failure"], envelope.get("detail", ""))
        status, text = envelope.get("status"), envelope.get("text")
        if not _non_negative_int(status) or not 100 <= status <= 599 or not isinstance(text, str):
            raise self._response_error("The Sentinel socket client returned a malformed response envelope.", envelope)
        return status, text

    def _validate_catalog(self, payload: dict) -> None:
        observed_at = payload.get("observed_at", "")
        if (
            not _non_negative_int(payload.get("revision"))
            or not (observed_at is None or (isinstance(observed_at, str) and _OBSERVED_AT.fullmatch(observed_at)))
            or not all(isinstance(payload.get(key), list) for key in ("devices", "errors"))
        ):
            raise self._response_error("The Sentinel peripheral catalog does not match the v1 API.", payload)
        device_ids = set()
        for device in payload["devices"]:
            if not isinstance(device, dict) or not all(isinstance(device.get(key), str) and device[key] for key in ("id", "type")):
                raise self._response_error("SiMa Sentinel returned a malformed device record.", device)
            if device["id"] in device_ids:
                raise self._response_error("SiMa Sentinel returned duplicate device identities.", device)
            device_ids.add(device["id"])
            if device["type"] == "camera":
                self._validate_camera(device)
            elif device["type"] == "microphone":
                self._validate_microphone(device)
        for error in payload["errors"]:
            if not isinstance(error, dict) or not all(isinstance(error.get(key), str) and error[key] for key in ("provider", "code", "reason")):
                raise self._response_error("SiMa Sentinel returned a malformed provider error.", error)

    def _validate_camera(self, camera: dict) -> None:
        identity = camera.get("identity")
        if (
            not isinstance(camera.get("backend"), str)
            or not camera["backend"]
            or not isinstance(camera.get("modes"), list)
            or any(
                camera.get(key) is not None and not isinstance(camera.get(key), str)
                for key in (
                    "camera_name", "model", "media_device", "bus_info",
                    "csi_receiver", "device_path", "by_id_path",
                )
            )
            or any(
                camera.get(key) is not None and not isinstance(camera.get(key), dict)
                for key in ("identity", "availability", "isp")
            )
            or (
                isinstance(identity, dict)
                and (
                    any(
                        identity.get(key) is not None and not isinstance(identity.get(key), str)
                        for key in (
                            "stable_key", "topology", "interface", "vendor_id", "product_id",
                            "serial", "manufacturer", "speed",
                        )
                    )
                    or (
                        identity.get("node_index") is not None
                        and not (
                            isinstance(identity["node_index"], str)
                            or _non_negative_int(identity["node_index"])
                        )
                    )
                )
            )
        ):
            raise self._response_error("SiMa Sentinel returned malformed camera details.", camera)
        for mode in camera["modes"]:
            if (
                not isinstance(mode, dict)
                or not isinstance(mode.get("format"), str)
                or not mode["format"]
            ):
                raise self._response_error("SiMa Sentinel returned a malformed camera mode.", mode)
            if "width" in mode or "height" in mode:
                valid = "size_range" not in mode and all(_positive_int(mode.get(key)) for key in ("width", "height"))
            else:
                valid = self._valid_size_range(mode.get("size_range"))
            if not valid:
                raise self._response_error(
                    "A camera mode must contain exactly one discrete size or size range.", mode
                )
            if "frame_intervals" in mode and not self._valid_frame_intervals(mode["frame_intervals"]):
                raise self._response_error("SiMa Sentinel returned malformed frame intervals.", mode)

    def _validate_microphone(self, microphone: dict) -> None:
        """Sentinel's ALSA capture record; optional identity fields are omitted, never null."""
        target = microphone.get("capture_target")
        identity = microphone.get("identity")
        availability = microphone.get("availability")
        issues = microphone.get("issues", [])
        if (
            not isinstance(microphone.get("name"), str)
            or not microphone["name"]
            or microphone.get("backend") != "alsa"
            or microphone.get("connection") not in {"usb", "platform", "unknown"}
            or not isinstance(target, dict)
            or not _non_negative_int(target.get("device"))
            or not all(isinstance(target.get(key, ""), str) for key in ("card_id", "selector"))
            or not isinstance(identity, dict)
            or not isinstance(identity.get("stable_key"), str)
            or not identity["stable_key"]
            or ("card_index" in identity and not _non_negative_int(identity["card_index"]))
            or not all(
                isinstance(identity.get(key, ""), str)
                for key in ("card_id", "card_name", "card_driver", "pcm_name", "pcm_node", "by_path", "by_id")
            )
            or not _object_or_none(identity.get("usb"))
            or not isinstance(microphone.get("modes"), list)
            or not isinstance(availability, dict)
            or availability.get("state") not in {"available", "in_use", "unknown"}
            or not all(_non_negative_int(availability.get(key, 0)) for key in ("subdevices", "subdevices_available"))
            or not isinstance(issues, list)
        ):
            raise self._response_error("SiMa Sentinel returned malformed microphone details.", microphone)
        for mode in microphone["modes"]:
            if not self._valid_microphone_mode(mode):
                raise self._response_error("SiMa Sentinel returned a malformed microphone mode.", mode)
        for issue in issues:
            if not isinstance(issue, dict) or not all(
                isinstance(issue.get(key), str) and issue[key] for key in ("code", "reason")
            ):
                raise self._response_error("SiMa Sentinel returned a malformed microphone issue.", issue)

    @staticmethod
    def _valid_microphone_mode(mode) -> bool:
        """One capture mode: a format, optional counts, and discrete `rates_hz` or one `rate_range_hz`, not both."""
        if not isinstance(mode, dict) or not isinstance(mode.get("format"), str) or not mode["format"]:
            return False
        if "rates_hz" in mode and "rate_range_hz" in mode:
            return False
        rates, span = mode.get("rates_hz", [1]), mode.get("rate_range_hz", {"min": 1, "max": 1})
        return (
            all(_non_negative_int(mode.get(key, 0)) for key in ("interface", "altset"))
            and all(_positive_int(mode.get(key, 1)) for key in ("channels", "sample_bits"))
            and isinstance(rates, list)
            and bool(rates)
            and all(_positive_int(rate) for rate in rates)
            and isinstance(span, dict)
            and _positive_int(span.get("min"))
            and _positive_int(span.get("max"))
            and span["min"] <= span["max"]
            and isinstance(mode.get("channel_map", []), list)
            and all(isinstance(channel, str) for channel in mode.get("channel_map", []))
        )

    @staticmethod
    def _valid_frame_intervals(value) -> bool:
        """Each entry is one probed size with the list of intervals the device advertises for it; every
        fraction the snapshot divides by must be positive."""
        return isinstance(value, list) and all(
            isinstance(entry, dict)
            and isinstance(entry.get("intervals"), list)
            and all(_valid_interval(interval) for interval in entry["intervals"])
            for entry in value
        )

    @staticmethod
    def _valid_size_range(value) -> bool:
        if not isinstance(value, dict):
            return False
        keys = ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")
        if not all(_positive_int(value.get(key)) for key in keys):
            return False
        return value["min_width"] <= value["max_width"] and value["min_height"] <= value["max_height"]

    def _response_error(self, message: str, detail) -> BoardError:
        try:
            rendered = json.dumps(detail, separators=(",", ":"))
        except (TypeError, ValueError):
            rendered = str(detail)
        return BoardError("peripheral_response", message, hint=STATUS_HINT, detail=rendered[:DETAIL_LIMIT])

    def _too_large(self, detail: str) -> BoardError:
        return BoardError(
            "peripheral_response",
            f"The Sentinel response is larger than the {socket_client.MAX_BODY_BYTES // (1024 * 1024)} MiB Insight limit.",
            hint=STATUS_HINT,
            detail=detail[:DETAIL_LIMIT],
            limit_bytes=socket_client.MAX_BODY_BYTES,
        )

    def _socket_error(self, failure: str, detail: str) -> BoardError:
        code, message, hint = _SOCKET_ERRORS.get(failure, _SOCKET_ERRORS[socket_client.FAILED])
        return BoardError(
            code,
            message.format(socket=self.socket_path, label=self.session.target.label),
            hint=hint,
            detail=detail[:DETAIL_LIMIT],
        )
