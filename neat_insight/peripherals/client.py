"""Read the peripheral catalog from SiMa Sentinel on the selected board."""
import json
import math
import re

from neat_insight.board import BoardError
from neat_insight.sentinel import socket_client
from neat_insight.sentinel.client import DETAIL_LIMIT, NOT_RUN, RESPONSE, TOOL_MISSING, SentinelSocket

MAX_BODY_BYTES = 4 * 1024 * 1024
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
_CLIENT_ERRORS = {
    TOOL_MISSING: (
        "tool_missing",
        "python3 was not found on the board, so SiMa Sentinel cannot be reached.",
        "Install python3 (3.8 or newer) on the board, then retry.",
    ),
    NOT_RUN: (
        "peripheral_response",
        "The Sentinel socket client did not run on the board (python3 exited {exit_code}).",
        "Check that python3 on the board is 3.8 or newer; its error output is in detail.",
    ),
    RESPONSE: (
        "peripheral_response",
        "The Sentinel socket client returned a malformed response envelope.",
        STATUS_HINT,
    ),
    socket_client.TOO_LARGE: (
        "peripheral_response",
        "The Sentinel response is larger than the {limit_mib} MiB Insight limit.",
        STATUS_HINT,
    ),
}


def _non_negative_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


# V4L2 frame intervals are __u32 fractions; a larger value would overflow when the snapshot turns it into a float.
U32_MAX = 2**32 - 1


def _fraction(value) -> bool:
    return isinstance(value, dict) and all(
        _positive_int(value.get(key)) and value[key] <= U32_MAX for key in ("numerator", "denominator")
    )


def _finite_positive(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(float(value)) and value > 0
    except OverflowError:
        return False


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

class PeripheralClient(SentinelSocket):
    socket_errors = _SOCKET_ERRORS
    client_errors = _CLIENT_ERRORS
    too_large_detail = "The Sentinel response is larger than {limit} bytes."
    max_body_bytes = MAX_BODY_BYTES

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
        status, text = self.request(method, path, body, timeout)
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
            or (camera.get("max_fps") is not None and not _finite_positive(camera["max_fps"]))
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
