"""Delete saved Sentinel runs with the daemon's CLI; its HTTP API has no delete route."""
import re
from typing import Tuple

from neat_insight.board import BoardError
from neat_insight.sentinel.errors import SentinelError

CLI = "simaai-sentinel"
DELETE_TIMEOUT_SEC = 30.0
DETAIL_LIMIT = 2000
MISSING_EXIT = 127

# Only the id Sentinel reported reaches the board, as "$1"; it is never part of the script text.
DELETE_SCRIPT = """
cli=$(command -v {cli} 2>/dev/null) || cli=/usr/local/bin/{cli}
[ -x "$cli" ] || {{ echo '{cli}: not found' >&2; exit {missing}; }}
exec "$cli" runs delete "$1"
""".format(
    cli=CLI, missing=MISSING_EXIT
)

_ERROR_LINE = re.compile(r"^\s*error:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_FAILURES = (
    ("cannot delete active run", "trace_conflict", "Stop the trace first, then delete the run."),
    ("unknown completed run", "not_found", "The run may have been deleted already, or it is still recording."),
    ("permission denied", "sentinel_denied", "The board user needs write access to /var/lib/simaai-sentinel/runs."),
    ("operation not permitted", "sentinel_denied", "The board user needs write access to /var/lib/simaai-sentinel/runs."),
)


def _runs_of(listing) -> list:
    runs = listing.get("runs") if isinstance(listing, dict) else None
    return [run for run in runs if isinstance(run, dict)] if isinstance(runs, list) else []


def _text(value) -> str:
    return "" if value is None else str(value)


def _resolve(listing, ref: str) -> dict:
    runs = _runs_of(listing)
    matches = [run for run in runs if _text(run.get("id")) == ref] or [run for run in runs if _text(run.get("name")) == ref]
    if len(matches) != 1:
        raise SentinelError(
            "not_found",
            "unknown run '{}'".format(ref) if not matches else "'{}' names {} runs.".format(ref, len(matches)),
            hint="List runs and delete the run by the id Sentinel reports.",
            run=ref,
        )
    return matches[0]


def delete(session, client, ref: str) -> Tuple[dict, dict]:
    run = _resolve(client.get("/v1/runs"), ref)
    field = "id" if _text(run.get("id")) else "name"
    target = _text(run.get(field))
    # A leading dash would be read as an option.
    if not target or target.startswith("-"):
        raise SentinelError(
            "invalid_request",
            "Run '{}' cannot be deleted from Insight because Sentinel reports no usable id for it.".format(ref),
            hint="Delete it in a shell on the board with `{} runs delete`.".format(CLI),
            run=ref,
        )
    result = session.transport.exec(["sh", "-c", DELETE_SCRIPT, "sh", target], timeout=DELETE_TIMEOUT_SEC)
    output = "\n".join(chunk.decode("utf-8", errors="replace").strip() for chunk in (result.stdout, result.stderr) if chunk)
    output = output.strip()[:DETAIL_LIMIT]
    lowered = output.lower()
    if result.exit_code == MISSING_EXIT:
        raise BoardError(
            "tool_missing",
            "`{}` was not found on the board, so run '{}' cannot be deleted from here.".format(CLI, ref),
            hint="Reinstall Sentinel with `sima-cli neat install sentinel`.",
            tool=CLI,
            detail=output,
            run=ref,
        )
    # The CLI can exit 0 on an error, so its output decides.
    error_line = _ERROR_LINE.search(output)
    if result.exit_code != 0 or error_line:
        code, hint = "sentinel_failed", "Run `{} runs delete` in a shell on the board to see more.".format(CLI)
        for needle, known_code, known_hint in _FAILURES:
            if needle in lowered:
                code, hint = known_code, known_hint
                break
        message = error_line.group(1).strip() if error_line else ""
        raise SentinelError(
            code,
            message or "`{} runs delete` failed on the board (exit {}).".format(CLI, result.exit_code),
            hint=hint,
            detail=output,
            run=ref,
        )
    listing = client.get("/v1/runs")
    if any(_text(other.get(field)) == target for other in _runs_of(listing)):
        raise SentinelError(
            "sentinel_failed",
            "`{} runs delete` reported no error, but Sentinel still lists run '{}'.".format(CLI, ref),
            hint="Check the run in a shell on the board with `{} runs list`.".format(CLI),
            detail=output,
            run=ref,
        )
    return {"id": _text(run.get("id")) or None, "name": _text(run.get("name")) or None}, listing
