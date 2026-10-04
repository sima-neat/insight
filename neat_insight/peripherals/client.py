"""Read the peripheral catalog from SiMa Sentinel on the selected board."""
import json
import time
from http.client import HTTPException
from pathlib import Path

from neat_insight.board import BoardError
from neat_insight.peripherals import socket_client

SCHEMA_VERSION = 1
CLIENT_PATH = Path(socket_client.__file__)
DETAIL_LIMIT = 2000
REFRESH_TIMEOUT_SEC = 45.0
REFRESH_POLL_SEC = 0.2
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
    if interval.get("type") == "discrete":
        return _fraction(interval)
    return all(_fraction(interval.get(key)) for key in INTERVAL_FRACTIONS.get(interval.get("type"), ()))


class PeripheralClient:
    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

    def catalog(self) -> dict:
        payload = self._call("GET", "/v1/peripherals")
        self._validate_catalog(payload)
        return payload

    def refresh(self) -> dict:
        expected_instance_id = self.catalog()["instance_id"]
        accepted = self._call("POST", "/v1/peripherals/refresh")
        target = accepted.get("target_scan_sequence")
        if accepted.get("accepted") is not True or not _non_negative_int(target):
            raise self._response_error("SiMa Sentinel returned an invalid refresh acknowledgement.", accepted)

        deadline = time.monotonic() + REFRESH_TIMEOUT_SEC
        while True:
            catalog = self.catalog()
            if catalog["instance_id"] != expected_instance_id:
                raise BoardError(
                    "stale_snapshot",
                    "SiMa Sentinel restarted while refreshing its peripheral catalog.",
                    hint="Retry the refresh against the restarted Sentinel.",
                    expected_instance_id=expected_instance_id,
                    observed_instance_id=catalog["instance_id"],
                )
            if catalog["scan_sequence"] >= target:
                return catalog
            if time.monotonic() >= deadline:
                raise BoardError(
                    "timeout",
                    "SiMa Sentinel accepted the refresh but did not finish it within 45 seconds.",
                    hint=STATUS_HINT,
                    target_scan_sequence=target,
                    observed_scan_sequence=catalog["scan_sequence"],
                )
            time.sleep(min(REFRESH_POLL_SEC, max(deadline - time.monotonic(), 0)))

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
            code = "invalid_request" if status == 400 else "peripheral_unavailable"
            raise BoardError(
                code,
                detail or f"SiMa Sentinel rejected the request with HTTP {status}.",
                hint="Correct the request and retry." if status == 400 else STATUS_HINT,
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
        result = self.session.transport.exec(argv, timeout=timeout + 15.0, stdin=CLIENT_PATH.read_bytes())
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

    def _validate_schema(self, payload: dict) -> None:
        version = payload.get("schema_version")
        if version != SCHEMA_VERSION:
            raise BoardError(
                "peripheral_version",
                f"SiMa Sentinel speaks schema {version!r}; Insight understands schema {SCHEMA_VERSION}.",
                hint="Update Insight and SiMa Sentinel to compatible versions.",
                daemon_schema_version=version,
                insight_schema_version=SCHEMA_VERSION,
            )

    def _validate_catalog(self, payload: dict) -> None:
        self._validate_schema(payload)
        if (
            not isinstance(payload.get("instance_id"), str)
            or not payload["instance_id"]
            or payload.get("state") not in {"starting", "ready", "degraded"}
            or not isinstance(payload.get("ready"), bool)
            or not isinstance(payload.get("stale"), bool)
            or not all(_non_negative_int(payload.get(key)) for key in ("revision", "sequence", "scan_sequence"))
            or not isinstance(payload.get("devices"), list)
            or not (payload.get("error") is None or isinstance(payload.get("error"), dict))
            or not isinstance(payload.get("issues", []), list)
            or not self._valid_support(payload.get("support"))
        ):
            raise self._response_error("The Sentinel peripheral catalog does not match the v1 schema.", payload)
        device_ids = set()
        for device in payload["devices"]:
            if (
                not isinstance(device, dict)
                or not all(isinstance(device.get(key), str) and device[key] for key in ("id", "type", "provider"))
                or not isinstance(device.get(device.get("type")), dict)
            ):
                raise self._response_error("SiMa Sentinel returned a malformed device record.", device)
            if device["id"] in device_ids:
                raise self._response_error("SiMa Sentinel returned duplicate device identities.", device)
            device_ids.add(device["id"])
            if device["type"] == "camera":
                self._validate_camera(device)
        for issue in payload.get("issues", []):
            if (
                not isinstance(issue, dict)
                or not all(isinstance(issue.get(key), str) and issue[key] for key in ("provider", "code", "reason"))
                or not isinstance(issue.get("retained_last_good"), bool)
            ):
                raise self._response_error("SiMa Sentinel returned a malformed provider issue.", issue)

    def _validate_camera(self, device: dict) -> None:
        camera = device["camera"]
        if (
            not isinstance(camera.get("backend"), str)
            or not camera["backend"]
            or not isinstance(camera.get("modes"), list)
            or not (camera.get("camera_name") is None or isinstance(camera.get("camera_name"), str))
            or not (camera.get("model") is None or isinstance(camera.get("model"), str))
            # The snapshot reads fields of these objects, so a non-object would fail outside this check.
            or not all(_object_or_none(camera.get(key)) for key in ("identity", "availability", "isp"))
        ):
            raise self._response_error("SiMa Sentinel returned malformed camera details.", device)
        for mode in camera["modes"]:
            if (
                not isinstance(mode, dict)
                or not isinstance(mode.get("format"), str)
                or not mode["format"]
                or not _positive_int(mode.get("framerate_num"))
                or not _positive_int(mode.get("framerate_den"))
                or not isinstance(mode.get("supported"), bool)
                or not isinstance(mode.get("reason"), str)
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
    def _valid_support(value) -> bool:
        """The snapshot looks up the support rules' state in a table, so it must be a string when present."""
        return value is None or (isinstance(value, dict) and (value.get("state") is None or isinstance(value["state"], str)))

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
