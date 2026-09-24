from neat_insight.board import BoardError

# Sentinel's own failures, alongside the board codes. The daemon's HTTP status survives:
# 400/404/409/413 from the API keep their meaning instead of collapsing into 502.
_HTTP_STATUS = {
    "invalid_request": 400,
    "not_found": 404,
    "trace_conflict": 409,
    "already_installed": 409,
    "request_too_large": 413,
    "sentinel_missing": 502,
    "sentinel_denied": 502,
    "sentinel_schema": 502,
    "sentinel_failed": 502,
}
UPSTREAM_CODES = {400: "invalid_request", 404: "not_found", 409: "trace_conflict", 413: "request_too_large"}


class SentinelError(BoardError):
    """A Sentinel failure in the board error shape, carrying the status its code implies."""

    @property
    def status(self) -> int:
        return _HTTP_STATUS.get(self.code, 502)
