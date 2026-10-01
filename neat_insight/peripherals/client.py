"""Reach the authoritative peripheral catalog on the selected board."""
import json
import time
import urllib.parse
from http.client import HTTPException
from pathlib import Path

from neat_insight.board import BoardError
from neat_insight.peripherals import socket_client

SCHEMA_VERSION = 1
CLIENT_PATH = Path(socket_client.__file__)
DETAIL_LIMIT = 2000
REFRESH_TIMEOUT_SEC = 45.0
REFRESH_POLL_SEC = 0.2
STATUS_HINT = "Check `systemctl status simaai-peripherals` on the board."

_SOCKET_ERRORS = {
    socket_client.MISSING: (
        "peripheral_missing",
        "The peripheral daemon socket {socket} does not exist on {label}.",
        "Install the Core peripheral daemon on the board, then retry.",
    ),
    socket_client.REFUSED: (
        "peripheral_refused",
        "Nothing is listening on the peripheral daemon socket {socket} on {label}.",
        "Start it with `sudo systemctl start simaai-peripherals`, then retry.",
    ),
    socket_client.DENIED: (
        "peripheral_denied",
        "The peripheral daemon socket {socket} on {label} cannot be opened by this user.",
        "Check the service and socket permissions on the board.",
    ),
    socket_client.TIMED_OUT: (
        "timeout",
        "The peripheral daemon on {label} did not answer before the request timed out.",
        STATUS_HINT,
    ),
    socket_client.FAILED: (
        "peripheral_unavailable",
        "The peripheral daemon socket {socket} on {label} could not be used.",
        STATUS_HINT,
    ),
    socket_client.PROTOCOL: (
        "peripheral_response",
        "The peripheral daemon on {label} returned a malformed or incomplete HTTP response.",
        STATUS_HINT,
    ),
}


def _non_negative_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _positive_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


class PeripheralClient:
    def __init__(self, session, socket_path: str = socket_client.SOCKET_PATH):
        self.session = session
        self.socket_path = socket_path

    def catalog(self) -> dict:
        payload = self._call("GET", "/v1/catalog")
        self._validate_catalog(payload)
        return payload

    def events(self, after_sequence: int, wait_ms: int, instance_id=None) -> dict:
        if not _non_negative_int(after_sequence) or not _non_negative_int(wait_ms) or wait_ms > 30000:
            raise BoardError("invalid_request", "Event cursors and wait times must be non-negative integers; wait_ms cannot exceed 30000.")
        if instance_id is not None and (not isinstance(instance_id, str) or len(instance_id) > 256):
            raise BoardError("invalid_request", "`instance_id` must be a string no longer than 256 characters.")
        query = {"after_sequence": after_sequence, "wait_ms": wait_ms}
        if instance_id:
            query["instance_id"] = instance_id
        path = "/v1/events?" + urllib.parse.urlencode(query)
        payload = self._call("GET", path, timeout=max(socket_client.TIMEOUT_SEC, wait_ms / 1000.0 + 5.0))
        self._validate_events(payload)
        return payload

    def refresh(self) -> dict:
        expected_instance_id = self.catalog()["instance_id"]
        accepted = self._call("POST", "/v1/refresh")
        target = accepted.get("target_scan_sequence") if isinstance(accepted, dict) else None
        if accepted.get("accepted") is not True or not _non_negative_int(target):
            raise self._response_error("The peripheral daemon returned an invalid refresh acknowledgement.", accepted)

        deadline = time.monotonic() + REFRESH_TIMEOUT_SEC
        while True:
            catalog = self.catalog()
            if catalog["instance_id"] != expected_instance_id:
                raise BoardError(
                    "stale_snapshot",
                    "The peripheral daemon restarted while refreshing its catalog.",
                    hint="Retry the refresh against the new daemon instance.",
                    expected_instance_id=expected_instance_id,
                    observed_instance_id=catalog["instance_id"],
                )
            if catalog["scan_sequence"] >= target:
                return catalog
            if time.monotonic() >= deadline:
                raise BoardError(
                    "timeout",
                    "The peripheral daemon accepted the refresh but did not finish it within 45 seconds.",
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
            code = "invalid_request" if status == 400 else "peripheral_unavailable"
            raise BoardError(
                code,
                detail or f"The peripheral daemon rejected the request with HTTP {status}.",
                hint="Correct the request and retry." if status == 400 else STATUS_HINT,
                daemon_status=status,
            )
        if not isinstance(parsed, dict):
            raise self._response_error("The peripheral daemon returned a response Insight cannot read.", text)
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
                "python3 was not found on the board, so the peripheral daemon cannot be reached.",
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
                f"The peripheral daemon client did not run on the board (python3 exited {result.exit_code}).",
                hint="Check that python3 on the board is 3.8 or newer; its error output is in detail.",
                detail=result.stderr.decode("utf-8", errors="replace").strip()[:DETAIL_LIMIT],
            )
        if envelope.get("failure") == socket_client.TOO_LARGE:
            raise self._too_large(envelope.get("detail", ""))
        if "failure" in envelope:
            raise self._socket_error(envelope["failure"], envelope.get("detail", ""))
        status, text = envelope.get("status"), envelope.get("text")
        if not _non_negative_int(status) or not 100 <= status <= 599 or not isinstance(text, str):
            raise self._response_error("The peripheral daemon client returned a malformed response envelope.", envelope)
        return status, text

    def _validate_schema(self, payload: dict) -> None:
        version = payload.get("schema_version")
        if version != SCHEMA_VERSION:
            raise BoardError(
                "peripheral_version",
                f"The peripheral daemon speaks schema {version!r}; Insight understands schema {SCHEMA_VERSION}.",
                hint="Update Insight and Core to compatible versions.",
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
        ):
            raise self._response_error("The peripheral daemon catalog does not match the v1 schema.", payload)
        device_ids = set()
        for device in payload["devices"]:
            if (
                not isinstance(device, dict)
                or not all(isinstance(device.get(key), str) and device[key] for key in ("id", "type", "provider"))
                or not isinstance(device.get(device.get("type")), dict)
            ):
                raise self._response_error("The peripheral daemon returned a malformed device record.", device)
            if device["id"] in device_ids:
                raise self._response_error("The peripheral daemon returned duplicate device identities.", device)
            device_ids.add(device["id"])
            if device["type"] == "camera":
                self._validate_camera(device)
            elif device["type"] == "microphone":
                self._validate_microphone(device)
        for issue in payload.get("issues", []):
            if (
                not isinstance(issue, dict)
                or not all(isinstance(issue.get(key), str) and issue[key] for key in ("provider", "code", "reason"))
                or not isinstance(issue.get("retained_last_good"), bool)
            ):
                raise self._response_error("The peripheral daemon returned a malformed provider issue.", issue)

    def _validate_camera(self, device: dict) -> None:
        camera = device["camera"]
        if (
            not isinstance(camera.get("backend"), str)
            or not camera["backend"]
            or not isinstance(camera.get("modes"), list)
            or not (camera.get("camera_name") is None or isinstance(camera.get("camera_name"), str))
            or not (camera.get("model") is None or isinstance(camera.get("model"), str))
        ):
            raise self._response_error("The peripheral daemon returned malformed camera details.", device)
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
                raise self._response_error("The peripheral daemon returned a malformed camera mode.", mode)
            has_discrete = "width" in mode or "height" in mode
            has_range = "size_range" in mode
            discrete = (
                has_discrete
                and _positive_int(mode.get("width"))
                and _positive_int(mode.get("height"))
            )
            ranged = has_range and self._valid_size_range(mode.get("size_range"))
            if (
                has_discrete == has_range
                or (has_discrete and not discrete)
                or (has_range and not ranged)
            ):
                raise self._response_error(
                    "A camera mode must contain exactly one discrete size or size range.", mode
                )

    def _validate_microphone(self, device: dict) -> None:
        microphone = device["microphone"]
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
            or ("card_id" in target and not isinstance(target["card_id"], str))
            or (
                "selector" in target
                and (not isinstance(target["selector"], str) or not target["selector"])
            )
            or not isinstance(identity, dict)
            or not isinstance(identity.get("stable_key"), str)
            or not identity["stable_key"]
            or not isinstance(microphone.get("modes"), list)
            or not isinstance(availability, dict)
            or availability.get("state") not in {"available", "in_use", "unknown"}
            or not isinstance(issues, list)
        ):
            raise self._response_error(
                "The peripheral daemon returned malformed microphone details.", device
            )
        for mode in microphone["modes"]:
            rates = mode.get("rates_hz") if isinstance(mode, dict) else None
            rate_range = mode.get("rate_range_hz") if isinstance(mode, dict) else None
            has_rates = "rates_hz" in mode if isinstance(mode, dict) else False
            has_range = "rate_range_hz" in mode if isinstance(mode, dict) else False
            valid_rates = (
                isinstance(rates, list)
                and bool(rates)
                and all(_positive_int(rate) for rate in rates)
            )
            valid_range = (
                isinstance(rate_range, dict)
                and _positive_int(rate_range.get("min"))
                and _positive_int(rate_range.get("max"))
                and rate_range["min"] <= rate_range["max"]
            )
            if (
                not isinstance(mode, dict)
                or not isinstance(mode.get("format"), str)
                or not mode["format"]
                or ("interface" in mode and not _non_negative_int(mode["interface"]))
                or ("altset" in mode and not _non_negative_int(mode["altset"]))
                or ("channels" in mode and not _positive_int(mode["channels"]))
                or ("sample_bits" in mode and not _positive_int(mode["sample_bits"]))
                or (has_rates and not valid_rates)
                or (has_range and not valid_range)
                or (has_rates and has_range)
                or (
                    "channel_map" in mode
                    and (
                        not isinstance(mode["channel_map"], list)
                        or not all(isinstance(channel, str) for channel in mode["channel_map"])
                    )
                )
            ):
                raise self._response_error(
                    "The peripheral daemon returned a malformed microphone mode.", mode
                )
        for issue in issues:
            if (
                not isinstance(issue, dict)
                or not isinstance(issue.get("code"), str)
                or not issue["code"]
                or not isinstance(issue.get("reason"), str)
                or not issue["reason"]
            ):
                raise self._response_error(
                    "The peripheral daemon returned a malformed microphone issue.", issue
                )
        for key in ("subdevices", "subdevices_available"):
            if key in availability and not _non_negative_int(availability[key]):
                raise self._response_error(
                    "The peripheral daemon returned malformed microphone availability.",
                    availability,
                )

    @staticmethod
    def _valid_size_range(value) -> bool:
        if not isinstance(value, dict):
            return False
        keys = ("min_width", "min_height", "max_width", "max_height", "step_width", "step_height")
        if not all(_positive_int(value.get(key)) for key in keys):
            return False
        return value["min_width"] <= value["max_width"] and value["min_height"] <= value["max_height"]

    def _validate_events(self, payload: dict) -> None:
        self._validate_schema(payload)
        if (
            not isinstance(payload.get("instance_id"), str)
            or not payload["instance_id"]
            or not all(_non_negative_int(payload.get(key)) for key in ("revision", "sequence", "scan_sequence"))
            or not isinstance(payload.get("resync_required"), bool)
            or not isinstance(payload.get("shutting_down"), bool)
            or not isinstance(payload.get("events"), list)
        ):
            raise self._response_error("The peripheral daemon event response does not match the v1 schema.", payload)
        for event in payload["events"]:
            if (
                not isinstance(event, dict)
                or not _non_negative_int(event.get("sequence"))
                or not _non_negative_int(event.get("revision"))
                or not isinstance(event.get("kind"), str)
                or not event["kind"]
            ):
                raise self._response_error("The peripheral daemon returned a malformed event record.", event)

    def _response_error(self, message: str, detail) -> BoardError:
        try:
            rendered = json.dumps(detail, separators=(",", ":"))
        except (TypeError, ValueError):
            rendered = str(detail)
        return BoardError("peripheral_response", message, hint=STATUS_HINT, detail=rendered[:DETAIL_LIMIT])

    def _too_large(self, detail: str) -> BoardError:
        return BoardError(
            "peripheral_response",
            f"The peripheral daemon response is larger than the {socket_client.MAX_BODY_BYTES // (1024 * 1024)} MiB Insight limit.",
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
