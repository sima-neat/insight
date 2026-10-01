"""HTTP API for Sentinel telemetry on the selected board."""
from urllib.parse import quote

from flask import Blueprint, request

from neat_insight.board import BoardError, get_board_manager
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


@sentinel_bp.after_request
def _no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@sentinel_bp.errorhandler(BoardError)
def _board_error(err: BoardError):
    return err.to_dict(), err.status


class _Context:
    def __init__(self, expected_generation=None):
        self.session = get_board_manager().session()
        if expected_generation is not None and expected_generation != self.session.generation:
            raise BoardError(
                "stale_snapshot",
                "The selected board changed since this was read, so nothing was changed.",
                hint="Read the board selected now, then try again.",
                expected_generation=expected_generation,
            )
        self.identity = cache.identity(self.session)
        self.key = cache.key(self.session, self.identity)
        self.client = SentinelClient(self.session)

    def payload(self, **extra) -> dict:
        self.session.require_current()
        board = {"label": self.session.target.label, "source": self.session.target.source}
        board.update({key: self.identity.get(key) for key in ("hostname", "machine", "build_version", "fingerprint")})
        return dict({"board": board, "generation": self.session.generation}, **extra)

    def passthrough(self, body: dict) -> dict:
        return self.payload(sentinel={key: value for key, value in body.items() if key != "schema"})

    def cached(self, name: str, ttl: float, read):
        value = cache.get(self.key, name)
        return value if value is not None else cache.record(self.key, name, read(), ttl)


def _invalid(message: str, hint: str) -> SentinelError:
    return SentinelError("invalid_request", message, hint=hint)


def _generation(required: bool = False):
    raw = request.args.get("generation")
    if raw in (None, ""):
        if required:
            raise _invalid("`generation` is required for this operation.", "Send the `generation` of the payload you read.")
        return None
    try:
        return int(raw)
    except ValueError:
        raise _invalid("`generation` must be a whole number.", "Send the `generation` of the payload you read.") from None


def _trace_request(body) -> dict:
    if not isinstance(body, dict):
        raise _invalid("The request body must be a JSON object.", 'Send {"name": "<trace name>"}.')
    name = body.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > NAME_LIMIT:
        raise _invalid("A trace needs a name of 1 to {} characters.".format(NAME_LIMIT), "Send a unique name.")
    # Compare takes runs as one comma-separated list, so such a name could never be compared.
    if "," in name:
        raise _invalid("A trace name cannot contain a comma.", "Use another separator such as `-`.")
    note = body.get("note")
    if note is not None and (not isinstance(note, str) or len(note) > NOTE_LIMIT):
        raise _invalid("`note` must be text of at most {} characters.".format(NOTE_LIMIT), "Shorten the note, or omit it.")
    tags = body.get("tags")
    if tags is not None and (
        not isinstance(tags, list) or len(tags) > MAX_TAGS or not all(isinstance(tag, str) and tag for tag in tags)
    ):
        raise _invalid("`tags` must be a list of at most {} non-empty strings.".format(MAX_TAGS), "Omit them.")
    wanted = {"name": name.strip()}
    if note:
        wanted["note"] = note
    if tags:
        wanted["tags"] = tags
    return wanted


# API: report whether Sentinel can be used on the selected board.
@sentinel_bp.get("/api/sentinel")
def get_sentinel():
    """Return Sentinel's availability, version and daemon health for the selected board."""
    context = _Context()
    daemon = context.cached("daemon", STATUS_TTL_SEC, lambda: install.status(context.session))
    problem = install.describe(daemon)
    health, state, error = None, "ready", None
    if problem:
        state, error = problem["code"].replace("sentinel_", ""), problem
    else:
        try:
            health = context.client.get("/v1/health")
        except SentinelError as err:
            state, error = "error", err.to_dict()
    return context.payload(
        available=health is not None,
        schema=SCHEMA,
        version=(health or {}).get("version"),
        status={"state": state, "error": error},
        daemon=daemon,
        health={key: value for key, value in health.items() if key != "schema"} if health else None,
    )


# API: install Sentinel on the selected board.
@sentinel_bp.post("/api/sentinel/install")
def install_sentinel():
    """Run `sima-cli neat install sentinel` on the board; refuses when Sentinel is already healthy."""
    context = _Context(_generation(required=True))
    result = install.install(context.session)
    cache.record(context.key, "daemon", result["status"], STATUS_TTL_SEC)
    return context.payload(daemon=result["status"], log=result["log"])


# API: read the board's current telemetry.
@sentinel_bp.get("/api/sentinel/metrics")
def get_metrics():
    """Return Sentinel's metric definitions joined with the latest sample, and optional recent history."""
    raw = request.args.get("history")
    try:
        limit = int(raw) if raw not in (None, "") else 0
    except ValueError:
        limit = -1
    if limit < 0:
        raise _invalid("`history` must be a whole number of samples.", "Use `history=60`, or omit it.")
    context = _Context()
    latest = context.client.get("/v1/samples/latest")
    history = cache.add_sample(context.key, latest.get("sample"))
    if cache.needs_seed(context.key):
        history = cache.seed(context.key, cache_history.read(context.session))
    definitions = context.cached("definitions", DEFINITIONS_TTL_SEC, lambda: context.client.get("/v1/metrics"))
    return context.payload(**metric_view.build(definitions, latest, history, min(limit, HISTORY_LIMIT)))


# API: report the trace Sentinel is recording, if any.
@sentinel_bp.get("/api/sentinel/traces")
def get_traces():
    """Return the active trace and its running summary, or nulls when nothing is being recorded."""
    context = _Context()
    return context.passthrough(context.client.get("/v1/traces/active"))


# API: start a named trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces")
def start_trace():
    """Start recording a named trace; 409 when another trace is active or the name is taken."""
    wanted = _trace_request(request.get_json(silent=True))
    context = _Context(_generation(required=True))
    return context.passthrough(context.client.post("/v1/traces", wanted))


# API: stop the active trace on the selected board.
@sentinel_bp.post("/api/sentinel/traces/stop")
def stop_trace():
    """Stop and persist the active trace; 409 when no trace is active or the board changed since `generation`."""
    context = _Context(_generation(required=True))
    return context.passthrough(context.client.post("/v1/traces/stop"))


# API: list the runs saved on the selected board.
@sentinel_bp.get("/api/sentinel/runs")
def get_runs():
    """Return summaries of the recording and completed runs Sentinel holds."""
    context = _Context()
    return context.passthrough(context.client.get("/v1/runs"))


# API: read one saved run.
@sentinel_bp.get("/api/sentinel/runs/<path:run_id>")
def get_run(run_id):
    """Return one run by name or id, with its metadata and samples; 404 when it is unknown."""
    context = _Context()
    return context.passthrough(context.client.get("/v1/runs/" + quote(run_id, safe="")))


# API: delete one saved run.
@sentinel_bp.delete("/api/sentinel/runs/<path:run_id>")
def delete_run(run_id):
    """Delete one completed run by name or id and return Sentinel's run list afterwards."""
    context = _Context(_generation(required=True))
    deleted, listing = saved_runs.delete(context.session, context.client, run_id)
    return dict(context.passthrough(listing), deleted=deleted)


# API: compare saved runs against a baseline.
@sentinel_bp.get("/api/sentinel/compare")
def compare_runs():
    """Compare two or more runs, the first as baseline; `raw=1` adds timestamped samples."""
    runs = [run.strip() for run in (request.args.get("runs") or "").split(",") if run.strip()]
    if not 2 <= len(runs) <= MAX_COMPARE_RUNS:
        raise _invalid(
            "Compare 2 to {} runs.".format(MAX_COMPARE_RUNS),
            "Pass `runs=<baseline>,<other>`; the first run is the baseline.",
        )
    raw = request.args.get("raw") in ("1", "true", "yes")
    context = _Context()
    query = "?runs=" + quote(",".join(runs), safe=",") + ("&raw=1" if raw else "")
    return context.passthrough(context.client.get("/v1/compare" + query))
