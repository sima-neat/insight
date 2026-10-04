"""HTTP API for Sentinel telemetry on the selected board."""
from threading import Lock

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.board.manager import board_summary
from neat_insight.sentinel import cache_history, install, metrics as metric_view, runs as saved_runs
from neat_insight.sentinel.client import SCHEMA, SentinelClient
from neat_insight.sentinel.errors import SentinelError
from neat_insight.sentinel.state import DEFINITIONS_TTL_SEC, HISTORY_LIMIT, STATUS_TTL_SEC, BoardCache

sentinel_bp = Blueprint("sentinel", __name__)

MAX_COMPARE_RUNS = 8
MAX_TAGS = 16
NAME_LIMIT = 128
NOTE_LIMIT = 512

cache = BoardCache()
_TRACE_LOCK = Lock()


@sentinel_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


class _Context:
    """The selected board, its cache key, and a client for its Sentinel daemon."""

    def __init__(self):
        self.session = get_board_manager().session()
        self.identity = cache.identity(self.session)
        self.key = cache.key(self.session, self.identity)
        self.client = SentinelClient(self.session)

    def payload(self, **extra) -> dict:
        board = board_summary(self.session, self.identity)
        return dict({"board": board, "generation": self.session.generation}, **extra)

    def cached(self, name: str, ttl: float, read):
        """This board's cached `name`, read again once it is `ttl` seconds old."""
        value = cache.get(self.key, name)
        return value if value is not None else cache.record(self.key, name, read(), ttl)


def _invalid(message: str, hint: str) -> SentinelError:
    return SentinelError("invalid_request", message, hint=hint)


def _trace_request(body) -> dict:
    """Validate a start-trace request before it reaches the board."""
    if not isinstance(body, dict):
        raise _invalid("The request body must be a JSON object.", 'Send {"name": "<trace name>"}.')
    name = body.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > NAME_LIMIT:
        raise _invalid(
            "A trace needs a name of 1 to {} characters.".format(NAME_LIMIT),
            "Send a unique name; Sentinel rejects a name another run already uses.",
        )
    # /api/sentinel/compare takes its runs as one comma-separated list, so a run named
    # "before,after" could be recorded but never compared: it always reads as two runs.
    if "," in name:
        raise _invalid(
            "A trace name cannot contain a comma.",
            "Runs are compared by a comma-separated list of names; use another separator such as `-`.",
        )
    note = body.get("note")
    if note is not None and (not isinstance(note, str) or len(note) > NOTE_LIMIT):
        raise _invalid(
            "`note` must be text of at most {} characters.".format(NOTE_LIMIT), "Shorten the note, or omit it."
        )
    tags = body.get("tags")
    if tags is not None and (
        not isinstance(tags, list) or len(tags) > MAX_TAGS or not all(isinstance(tag, str) and tag for tag in tags)
    ):
        raise _invalid(
            "`tags` must be a list of at most {} non-empty strings.".format(MAX_TAGS),
            'Send tags like ["compiler-v2"], or omit them.',
        )
    return {"name": name.strip(), "note": note, "tags": tags}


def _history_limit(raw) -> int:
    if raw in (None, ""):
        return 0
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        raise _invalid("`history` must be a whole number of samples.", "Use `history=60`, or omit it.") from None
    if limit < 0:
        raise _invalid("`history` cannot be negative.", "Use `history=60`, or omit it.")
    return min(limit, HISTORY_LIMIT)


def _compare_runs(raw) -> list:
    runs = [run.strip() for run in (raw or "").split(",") if run.strip()]
    if len(runs) < 2:
        raise _invalid(
            "Comparing needs at least two runs.",
            "Pass `runs=<baseline>,<other>`; the first run is the baseline.",
        )
    if len(runs) > MAX_COMPARE_RUNS:
        raise _invalid(
            "At most {} runs can be compared at once.".format(MAX_COMPARE_RUNS),
            "Compare fewer runs.",
        )
    return runs


def _expected_generation(raw, read: str = "the run list"):
    """The board generation the caller judged its request against, or None when it names none."""
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise _invalid(
            "`generation` must be the whole-number board generation.",
            "Send the `generation` of the payload {} came from, or omit it.".format(read),
        ) from None


def _same_board(
    context: "_Context",
    expected,
    message: str = "The selected board changed since this run list was read, so nothing was deleted.",
    hint: str = "Read the runs of the board selected now, then delete again.",
) -> None:
    """Refuse a destructive request aimed at a board that is no longer the selected one."""
    if expected is not None and expected != context.session.generation:
        raise BoardError("stale_snapshot", message, hint=hint, expected_generation=expected)


def _expected_trace(raw) -> str:
    """Stable id of the trace the caller intends to stop."""
    if not isinstance(raw, str) or not raw.strip():
        raise _invalid(
            "`trace_id` must name the active trace being stopped.",
            "Read the active trace again, then send its stable `id`.",
        )
    return raw.strip()


def _passthrough(body: dict) -> dict:
    """Sentinel's own response body, minus its schema marker; it is nested so no field of a
    run or comparison can shadow Insight's `board` and `generation`."""
    return {key: value for key, value in body.items() if key != "schema"}


# API: report whether Sentinel can be used on the selected board.
@sentinel_bp.get("/api/sentinel")
def get_sentinel():
    """Return Sentinel's availability, version and daemon health for the selected board."""
    context = _Context()
    daemon = context.cached("daemon", STATUS_TTL_SEC, lambda: install.status(context.session))
    problem = install.describe(daemon)
    health, state, error = None, "ready", None
    if problem:
        state, error = problem["code"].replace("sentinel_", ""), dict(problem)
    else:
        try:
            health = context.client.health()
        except SentinelError as err:
            state, error = "error", err.to_dict()
    return context.payload(
        available=health is not None,
        schema=SCHEMA,
        version=(health or {}).get("version"),
        status={"state": state, "error": error},
        daemon=daemon,
        health=_passthrough(health) if health else None,
    )


# API: install Sentinel on the selected board.
@sentinel_bp.post("/api/sentinel/install")
def install_sentinel():
    """Run `sima-cli neat install sentinel` on the board; refuses when Sentinel is already healthy."""
    expected = _expected_generation(request.args.get("generation"), read="the Sentinel state")
    context = _Context()
    _same_board(
        context,
        expected,
        "The selected board changed since its Sentinel state was read, so nothing was installed.",
        "Read Sentinel state for the board selected now, then install again.",
    )
    result = install.install(context.session)
    cache.record(context.key, "daemon", result["status"], STATUS_TTL_SEC)
    return context.payload(daemon=result["status"], log=result["log"])


# API: read the board's current telemetry.
@sentinel_bp.get("/api/sentinel/metrics")
def get_metrics():
    """Return Sentinel's metric definitions joined with the latest sample, and optional recent history."""
    limit = _history_limit(request.args.get("history"))
    context = _Context()
    # A restart invalidates every value read from Sentinel, not only the latest sample.
    # Retry once so one response always belongs to one daemon invocation.
    for _ in range(2):
        before = install.status(context.session)
        cache.observe_daemon(context.key, before.get("instance_id"))
        latest = context.client.latest()
        definitions = context.cached("definitions", DEFINITIONS_TTL_SEC, context.client.metrics)
        seed = cache_history.read(context.session) if cache.needs_seed(context.key) else None
        daemon = cache.record(context.key, "daemon", install.status(context.session), STATUS_TTL_SEC)
        if before.get("instance_id") == daemon.get("instance_id"):
            history = cache.add_sample(context.key, latest.get("sample"))
            if seed is not None:
                history = cache.seed(context.key, seed)
            return context.payload(**metric_view.build(definitions, latest, history, limit))
        cache.observe_daemon(context.key, daemon.get("instance_id"))
    raise SentinelError(
        "sentinel_failed",
        "Sentinel restarted repeatedly while telemetry was being read.",
        hint="Wait for Sentinel to finish restarting, then retry.",
    )


# API: report the trace Sentinel is recording, if any.
@sentinel_bp.get("/api/sentinel/traces")
def get_traces():
    """Return the active trace and its running summary, or nulls when nothing is being recorded."""
    context = _Context()
    return context.payload(sentinel=_passthrough(context.client.active_trace()))


# API: start a named trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces")
def start_trace():
    """Start recording a named trace; 409 when another trace is active or the name is taken."""
    wanted = _trace_request(request.get_json(silent=True))
    expected = _expected_generation(request.args.get("generation"), read="the active trace")
    context = _Context()
    _same_board(
        context,
        expected,
        "The selected board changed since its active trace was read, so no trace was started.",
        "Read the active trace of the board selected now, then start again.",
    )
    with _TRACE_LOCK:
        started = context.client.start_trace(wanted["name"], wanted["note"], wanted["tags"])
    return context.payload(sentinel=_passthrough(started))


# API: stop the active trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces/stop")
def stop_trace():
    """Stop and persist the active trace; 409 when no trace is active or the board changed since `generation`."""
    expected = _expected_generation(request.args.get("generation"), read="the active trace")
    expected_trace = _expected_trace(request.args.get("trace_id"))
    context = _Context()
    _same_board(
        context,
        expected,
        "The selected board changed since this trace was read, so no trace was stopped.",
        "Read the active trace of the board selected now, then stop it again.",
    )
    with _TRACE_LOCK:
        active = context.client.active_trace().get("trace")
        active_id = active.get("id") if isinstance(active, dict) else None
        if not active_id or str(active_id) != expected_trace:
            raise SentinelError(
                "trace_conflict",
                "The active trace changed since it was read, so no trace was stopped.",
                hint="Read the active trace again, then stop that trace.",
                expected_trace_id=expected_trace,
                active_trace_id=active_id,
            )
        stopped = context.client.stop_trace()
    return context.payload(sentinel=_passthrough(stopped))


# API: list the runs saved on the selected board.
@sentinel_bp.get("/api/sentinel/runs")
def get_runs():
    """Return summaries of the recording and completed runs Sentinel holds."""
    context = _Context()
    return context.payload(sentinel=_passthrough(context.client.runs()))


# API: read one saved run.
@sentinel_bp.get("/api/sentinel/runs/<path:run_id>")
def get_run(run_id):
    """Return one run by name or id, with its metadata and samples; 404 when it is unknown."""
    context = _Context()
    return context.payload(sentinel=_passthrough(context.client.run(run_id)))


# API: delete one saved run.
@sentinel_bp.delete("/api/sentinel/runs/<path:run_id>")
def delete_run(run_id):
    """Delete one completed run by name or id and return Sentinel's run list afterwards.

    404 for a run Sentinel does not list, 409 for a run still recording or a board that
    changed since `generation`. The daemon's API has no delete, so this runs
    `simaai-sentinel runs delete` on the board with the id the daemon reported.
    """
    expected = _expected_generation(request.args.get("generation"))
    context = _Context()
    _same_board(context, expected)
    deleted, listing = saved_runs.delete(context.session, context.client, run_id)
    return context.payload(deleted=deleted, sentinel=_passthrough(listing))


# API: compare saved runs against a baseline.
@sentinel_bp.get("/api/sentinel/compare")
def compare_runs():
    """Compare two or more runs, the first as baseline; `raw=1` adds timestamped samples."""
    runs = _compare_runs(request.args.get("runs"))
    raw = request.args.get("raw") in ("1", "true", "yes")
    context = _Context()
    return context.payload(sentinel=_passthrough(context.client.compare(runs, raw)))
