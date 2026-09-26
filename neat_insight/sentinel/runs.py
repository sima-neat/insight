"""Delete saved Sentinel runs on the selected board.

Sentinel's HTTP API has no delete route (checked against sentinel main:80ab7de4da31), so a
run is deleted with the daemon's own CLI, ``simaai-sentinel runs delete <run>``, run over
the board transport as the board user. Runs are JSON files in
``/var/lib/simaai-sentinel/runs`` (``root:sima 0775``), so no sudo is needed.

Nothing the browser sends reaches the board. The reference is first resolved against the
daemon's own run list, and only the id Sentinel reported for that run is passed on, as a
positional argument to a fixed script (``sh -c SCRIPT sh <id>``), never interpolated into
it. The CLI's exit status is not trusted either: it exited 0 on an error in testing, so
its output is read for ``Error:``, and the run list is read again to confirm the run is gone.
"""
import re
from typing import Tuple

from neat_insight.board import BoardError
from neat_insight.sentinel.errors import SentinelError

CLI = "simaai-sentinel"
# Where the Sentinel installer puts the CLI; a non-login PATH may not include it.
FALLBACK_CLI = "/usr/local/bin/simaai-sentinel"
RUNS_DIR = "/var/lib/simaai-sentinel/runs"
DELETE_TIMEOUT_SEC = 30.0
DETAIL_LIMIT = 2000
MISSING_EXIT = 127
# A run in one of these states is still being written; the CLI refuses it, and so does Insight.
RECORDING_STATES = {"recording", "active", "running"}
STOP_HINT = "Stop the trace first, then delete the run."

# The run id arrives as "$1". It is never part of the script text.
DELETE_SCRIPT = """
cli=$(command -v {cli} 2>/dev/null) || cli=
[ -n "$cli" ] || cli={fallback}
[ -x "$cli" ] || {{ echo '{cli}: not found' >&2; exit {missing}; }}
exec "$cli" runs delete "$1"
""".format(
    cli=CLI, fallback=FALLBACK_CLI, missing=MISSING_EXIT
)

_ERROR_LINE = re.compile(r"^\s*error:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _runs_of(listing) -> list:
    runs = listing.get("runs") if isinstance(listing, dict) else None
    return [run for run in runs if isinstance(run, dict)] if isinstance(runs, list) else []


def _text(value) -> str:
    return "" if value is None else str(value)


def resolve(listing, ref: str) -> dict:
    """The one run in Sentinel's list that `ref` names, by id first and then by name."""
    runs = _runs_of(listing)
    matches = [run for run in runs if _text(run.get("id")) == ref]
    if not matches:
        matches = [run for run in runs if _text(run.get("name")) == ref]
    if not matches:
        raise SentinelError(
            "not_found",
            "unknown run '{}'".format(ref),
            hint="List runs and use a name or id Sentinel reports; the run may already have been deleted.",
            run=ref,
        )
    if len(matches) > 1:
        raise SentinelError(
            "not_found",
            "'{}' names {} runs, so Insight cannot tell which one to delete.".format(ref, len(matches)),
            hint="Delete the run by its id instead.",
            run=ref,
        )
    return matches[0]


def _target(run: dict, ref: str) -> str:
    """The reference passed to the CLI: the id Sentinel reported, or its name when it has none."""
    target = _text(run.get("id")) or _text(run.get("name"))
    # A leading dash would be read as an option. Sentinel's ids start with a timestamp, so
    # this is a run the CLI cannot be told about safely, not one to guess at.
    if not target or target.startswith("-"):
        raise SentinelError(
            "invalid_request",
            "Run '{}' cannot be deleted from Insight because Sentinel reports no usable id for it.".format(ref),
            hint="Delete it in a shell on the board with `{} runs delete`.".format(CLI),
            run=ref,
        )
    return target


def _output(result) -> str:
    chunks = (result.stdout, result.stderr)
    text = "\n".join(chunk.decode("utf-8", errors="replace").strip() for chunk in chunks if chunk)
    return text.strip()[:DETAIL_LIMIT]


def _failure(ref: str, result, output: str) -> BoardError:
    """What a failed `runs delete` means, in the board error taxonomy; None when it did not fail."""
    lowered = output.lower()
    error_line = _ERROR_LINE.search(output)
    message = error_line.group(1).strip() if error_line else ""
    if result.exit_code == MISSING_EXIT or "{}: not found".format(CLI) in lowered:
        return BoardError(
            "tool_missing",
            "`{}` was not found on the board, so run '{}' cannot be deleted from here.".format(CLI, ref),
            hint="Reinstall Sentinel with `sima-cli neat install sentinel`, or delete the run in a shell on the board.",
            tool=CLI,
            detail=output,
            run=ref,
        )
    if "cannot delete active run" in lowered:
        return SentinelError(
            "trace_conflict",
            message or "Run '{}' is still recording and cannot be deleted.".format(ref),
            hint=STOP_HINT,
            detail=output,
            run=ref,
        )
    if "unknown completed run" in lowered:
        return SentinelError(
            "not_found",
            message or "unknown completed run '{}'".format(ref),
            hint="The run may have been deleted already, or it is still recording. List runs again.",
            detail=output,
            run=ref,
        )
    if "permission denied" in lowered or "operation not permitted" in lowered:
        return SentinelError(
            "sentinel_denied",
            "The board user may not delete run '{}'.".format(ref),
            hint="Runs are files in {}; the board user needs write access to that directory.".format(RUNS_DIR),
            detail=output,
            run=ref,
        )
    if result.exit_code != 0 or error_line:
        return SentinelError(
            "sentinel_failed",
            message or "`{} runs delete` failed on the board (exit {}).".format(CLI, result.exit_code),
            hint="The CLI's output is in detail; run `{} runs delete` in a shell on the board to see more.".format(CLI),
            detail=output,
            run=ref,
        )
    return None


def delete(session, client, ref: str, timeout: float = DELETE_TIMEOUT_SEC) -> Tuple[dict, dict]:
    """Delete one completed run and return it with Sentinel's run list afterwards."""
    run = resolve(client.runs(), ref)
    if _text(run.get("state") or run.get("status")).lower() in RECORDING_STATES:
        raise SentinelError(
            "trace_conflict",
            "Run '{}' is still recording and cannot be deleted.".format(ref),
            hint=STOP_HINT,
            run=ref,
        )
    target = _target(run, ref)
    result = session.transport.exec(["sh", "-c", DELETE_SCRIPT, "sh", target], timeout=timeout)
    output = _output(result)
    failure = _failure(ref, result, output)
    if failure is not None:
        raise failure
    listing = client.runs()
    identity_field = "id" if _text(run.get("id")) else "name"
    if any(_text(other.get(identity_field)) == target for other in _runs_of(listing)):
        raise SentinelError(
            "sentinel_failed",
            "`{} runs delete` reported no error, but Sentinel still lists run '{}'.".format(CLI, ref),
            hint="Check the run in a shell on the board with `{} runs list`.".format(CLI),
            detail=output,
            run=ref,
        )
    return {"id": _text(run.get("id")) or None, "name": _text(run.get("name")) or None}, listing
