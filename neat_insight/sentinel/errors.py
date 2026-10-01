from neat_insight.board import BoardError

_HTTP_STATUS = {
    "invalid_request": 400,
    "not_found": 404,
    "trace_conflict": 409,
    "already_installed": 409,
    "request_too_large": 413,
}
UPSTREAM_CODES = {400: "invalid_request", 404: "not_found", 409: "trace_conflict", 413: "request_too_large"}


class SentinelError(BoardError):
    @property
    def status(self) -> int:
        return _HTTP_STATUS.get(self.code, 502)
