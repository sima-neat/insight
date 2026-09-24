"""HTTP API for Sentinel telemetry on the selected board."""
from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
from neat_insight.sentinel import install, metrics as metric_view, runs as saved_runs
from neat_insight.sentinel.client import SCHEMA, SentinelClient
from neat_insight.sentinel.errors import SentinelError
from neat_insight.sentinel.state import DEFINITIONS_TTL_SEC, HISTORY_LIMIT, STATUS_TTL_SEC, BoardCache

sentinel_bp = Blueprint("sentinel", __name__)

MAX_COMPARE_RUNS = 8
MAX_TAGS = 16
NAME_LIMIT = 128
NOTE_LIMIT = 512

cache = BoardCache()


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

    @property
    def board(self) -> dict:
        return {
            "label": self.session.target.label,
            "source": self.session.target.source,
            **{key: self.identity.get(key) for key in ("hostname", "machine", "build_version", "fingerprint")},
        }

    def payload(self, **extra) -> dict:
        return dict({"board": self.board, "generation": self.session.generation}, **extra)

    def daemon(self) -> dict:
        state = cache.get(self.key, "daemon")
        if state is None:
            state = cache.record(self.key, "daemon", install.status(self.session), STATUS_TTL_SEC)
        return state

    def definitions(self) -> dict:
        definitions = cache.get(self.key, "definitions")
        if definitions is None:
            definitions = cache.record(self.key, "definitions", self.client.metrics(), DEFINITIONS_TTL_SEC)
        return definitions


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


def _expected_generation(raw):
    """The board generation the caller judged its request against, or None when it names none."""
    if raw in (None, ""):
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise _invalid(
            "`generation` must be the whole-number board generation.",
            "Send the `generation` of the payload the run list came from, or omit it.",
        ) from None


def _same_board(context: "_Context", expected) -> None:
    """Refuse a destructive request aimed at a board that is no longer the selected one."""
    if expected is not None and expected != context.session.generation:
        raise BoardError(
            "stale_snapshot",
            "The selected board changed since this run list was read, so nothing was deleted.",
            hint="Read the runs of the board selected now, then delete again.",
            expected_generation=expected,
        )


def _passthrough(body: dict) -> dict:
    """Sentinel's own response body, minus its schema marker; it is nested so no field of a
    run or comparison can shadow Insight's `board` and `generation`."""
    return {key: value for key, value in body.items() if key != "schema"}


# API: report whether Sentinel can be used on the selected board.
@sentinel_bp.get("/api/sentinel")
def get_sentinel():
    """Return Sentinel's availability, version and daemon health for the selected board."""
    try:
        context = _Context()
        daemon = context.daemon()
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
    except BoardError as err:
        return err.to_dict(), err.status


# API: install Sentinel on the selected board.
@sentinel_bp.post("/api/sentinel/install")
def install_sentinel():
    """Run `sima-cli neat install sentinel` on the board; refuses when Sentinel is already healthy."""
    try:
        context = _Context()
        result = install.install(context.session)
        cache.record(context.key, "daemon", result["status"], STATUS_TTL_SEC)
        return context.payload(daemon=result["status"], log=result["log"])
    except BoardError as err:
        return err.to_dict(), err.status


# API: read the board's current telemetry.
@sentinel_bp.get("/api/sentinel/metrics")
def get_metrics():
    """Return Sentinel's metric definitions joined with the latest sample, and optional recent history."""
    try:
        limit = _history_limit(request.args.get("history"))
        context = _Context()
        latest = context.client.latest()
        history = cache.add_sample(context.key, latest.get("sample"))
        return context.payload(**metric_view.build(context.definitions(), latest, history, limit))
    except BoardError as err:
        return err.to_dict(), err.status


# API: report the trace Sentinel is recording, if any.
@sentinel_bp.get("/api/sentinel/traces")
def get_traces():
    """Return the active trace and its running summary, or nulls when nothing is being recorded."""
    try:
        context = _Context()
        return context.payload(sentinel=_passthrough(context.client.active_trace()))
    except BoardError as err:
        return err.to_dict(), err.status


# API: start a named trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces")
def start_trace():
    """Start recording a named trace; 409 when another trace is active or the name is taken."""
    try:
        wanted = _trace_request(request.get_json(silent=True))
        context = _Context()
        started = context.client.start_trace(wanted["name"], wanted["note"], wanted["tags"])
        return context.payload(sentinel=_passthrough(started))
    except BoardError as err:
        return err.to_dict(), err.status


# API: stop the active trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces/stop")
def stop_trace():
    """Stop and persist the active trace; 409 when no trace is active."""
    try:
        context = _Context()
        return context.payload(sentinel=_passthrough(context.client.stop_trace()))
    except BoardError as err:
        return err.to_dict(), err.status


# API: list the runs saved on the selected board.
@sentinel_bp.get("/api/sentinel/runs")
def get_runs():
    """Return summaries of the recording and completed runs Sentinel holds."""
    try:
        context = _Context()
        return context.payload(sentinel=_passthrough(context.client.runs()))
    except BoardError as err:
        return err.to_dict(), err.status


# API: read one saved run.
@sentinel_bp.get("/api/sentinel/runs/<path:run_id>")
def get_run(run_id):
    """Return one run by name or id, with its metadata and samples; 404 when it is unknown."""
    try:
        context = _Context()
        return context.payload(sentinel=_passthrough(context.client.run(run_id)))
    except BoardError as err:
        return err.to_dict(), err.status


# API: delete one saved run.
@sentinel_bp.delete("/api/sentinel/runs/<path:run_id>")
def delete_run(run_id):
    """Delete one completed run by name or id and return Sentinel's run list afterwards.

    404 for a run Sentinel does not list, 409 for a run still recording or a board that
    changed since `generation`. The daemon's API has no delete, so this runs
    `simaai-sentinel runs delete` on the board with the id the daemon reported.
    """
    try:
        expected = _expected_generation(request.args.get("generation"))
        context = _Context()
        _same_board(context, expected)
        deleted, listing = saved_runs.delete(context.session, context.client, run_id)
        return context.payload(deleted=deleted, sentinel=_passthrough(listing))
    except BoardError as err:
        return err.to_dict(), err.status


# API: compare saved runs against a baseline.
@sentinel_bp.get("/api/sentinel/compare")
def compare_runs():
    """Compare two or more runs, the first as baseline; `raw=1` adds timestamped samples."""
    try:
        runs = _compare_runs(request.args.get("runs"))
        raw = request.args.get("raw") in ("1", "true", "yes")
        context = _Context()
        return context.payload(sentinel=_passthrough(context.client.compare(runs, raw)))
    except BoardError as err:
        return err.to_dict(), err.status
