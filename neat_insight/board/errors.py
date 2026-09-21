from typing import Optional

_HTTP_STATUS = {
    "invalid_request": 400,
    "not_found": 404,
    "no_target": 409,
    "host_key_changed": 409,
    "stale_snapshot": 409,
    "unreachable": 502,
    "auth_failed": 502,
    "tool_missing": 502,
    "permission_denied": 502,
    "command_failed": 502,
    "timeout": 504,
}


class BoardError(Exception):
    """A board-access failure with a stable code and a recovery hint for the UI."""

    def __init__(self, code: str, message: str, hint: Optional[str] = None, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.extra = extra

    @property
    def status(self) -> int:
        return _HTTP_STATUS.get(self.code, 502)

    def to_dict(self) -> dict:
        payload = {"error": self.message, "code": self.code, "hint": self.hint}
        payload.update(self.extra)
        return payload
