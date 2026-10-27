"""Install, prepare and start GenAI Studio on the selected board, from the GenAI tab.

The three steps run on the board as one detached job, so a closed page, a lost SSH
session or an Insight restart does not stop them. The job keeps its state in
`~/.neat-insight/genai-setup/` on the board (the steps it runs, the current one,
each step's log and exit status), and the status endpoint reads it back from there.

Apps is installed without its dependencies: the Insight running this already exists
on the board, and reinstalling it here would replace the server that started the job.
GenAI Studio needs the Neat Library (Core), so a board without it is told to install
Apps with its dependencies itself.
"""
import re
import threading

from flask import Blueprint, jsonify

from neat_insight.board.errors import BoardError
from neat_insight.board.manager import board_summary, get_board_manager

genai_setup_bp = Blueprint("genai_setup", __name__)

STEPS = ("install", "prepare", "start")
JOB_DIR = "~/.neat-insight/genai-setup"
STUDIO_DIR = "~/prebuilt-apps/examples/genai/neat-genai-studio"
STATUS_TIMEOUT_SEC = 20.0
LAUNCH_TIMEOUT_SEC = 20.0
LOG_BYTES = 6000
LOG_LINES = 30
# A running step with no new output for this long may be stuck. setup.sh is quiet for
# minutes while it builds the document database or downloads a large model.
STALL_AFTER_SEC = {"install": 300, "prepare": 600, "start": 180}

TITLES = {
    "install": "Install Neat Apps",
    "prepare": "Prepare GenAI Studio",
    "start": "Start GenAI Studio",
}
DESCRIPTIONS = {
    "install": "Downloads Neat Apps, which includes GenAI Studio, into ~/prebuilt-apps. Takes a few minutes.",
    "prepare": "Runs setup.sh once: the speech model, the voices and document search. Needs internet access "
    "on the board and takes about 15 minutes.",
    "start": "Runs GenAI Studio in the background. It keeps running after you close this page.",
}
# What to run in a shell on the board instead, the last resort a failure offers.
MANUAL_COMMANDS = {
    "install": "cd ~ && NEAT_APPS_SKIP_DEPENDENCIES=1 sima-cli neat install apps",
    "prepare": "cd {} && ./setup.sh".format(STUDIO_DIR),
    "start": "cd {} && ./run.sh".format(STUDIO_DIR),
}

_HOSTS = (
    "pypi.org, files.pythonhosted.org, download.pytorch.org, huggingface.co, raw.githubusercontent.com "
    "and docs.sima.ai"
)
_RETRY_KEEPS = "Then press Retry. Files already downloaded are kept."
_INSTALL_CORE = (
    "Install Neat Apps with its dependencies in a shell on the board: `sima-cli neat install apps`. It also "
    "installs the Neat Library and Insight, and may ask for your password."
)

# Recognised causes of a failed step, checked in order against its log: (pattern, message, fixes).
_CAUSES = (
    (
        r"Neat Python environment not found|pyneat is not importable",
        "The Neat Library (Core) is not installed on the board.",
        [_INSTALL_CORE, "Then press Retry."],
    ),
    (
        r"No space left on device",
        "The board ran out of disk space.",
        ["See what uses the space with `df -h` in a shell on the board, and free some. Models go to "
         "/media/nvme/llima/models.", _RETRY_KEEPS],
    ),
    (
        r"Could not resolve host|Temporary failure in name resolution|Name or service not known|"
        r"Network is unreachable|Connection refused|Connection timed out|Read timed out|Max retries exceeded|"
        r"SSLError|ConnectionError|Too Many Requests|429 Client Error|[0-9]{3} Server Error|curl: \([0-9]+\)",
        "The board could not download what this step needs.",
        ["Check the board's internet access: `curl -sI https://huggingface.co` in a shell on the board should "
         "answer.",
         "Behind a firewall or proxy, allow {}.".format(_HOSTS),
         _RETRY_KEEPS],
    ),
    (
        r"\b40[34]\b.*(latest\.tag|neat-apps)|(latest\.tag|neat-apps).*\b40[34]\b",
        "The Neat Apps package could not be downloaded.",
        ["Check the board's internet access, then press Retry.",
         "Run `sima-cli neat install apps` in a shell on the board to see the installer's full message."],
    ),
    (
        r"dispatcher_unavailable|accelerator runtime is not available",
        "The board's accelerator was busy or unavailable.",
        ["Stop other applications that use the accelerator, then press Retry.",
         "If it keeps failing, restart the board, then press Retry."],
    ),
)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


# Where sima-cli's installer puts it: /data/sima-cli on a DevKit, ~/.sima-cli elsewhere. Only
# ~/.bashrc adds it to PATH, so Insight's own PATH often lacks it.
SIMA_CLI_PATHS = ("/data/sima-cli/.venv/bin/sima-cli", "$HOME/.sima-cli/.venv/bin/sima-cli")

# Every line is key=value, except each step's record, which starts at `@@<step>`.
_STATUS_SCRIPT = r"""
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
jobs="$HOME/.neat-insight/genai-setup"
cli=$(command -v sima-cli 2>/dev/null || true)
for c in SIMA_CLI_PATHS; do [ -n "$cli" ] || { [ -x "$c" ] && cli=$c; }; done
echo "sima_cli=$cli"
[ -x "$HOME/pyneat/bin/python" ] && echo core=yes || echo core=no
[ -x "$studio/run.sh" ] && echo installed=yes || echo installed=no
[ -x "$studio/.venv/bin/python" ] && [ -f "$studio/config.local.yaml" ] && echo prepared=yes || echo prepared=no
pid=$(cat "$studio/.neat-genai-studio.pid" 2>/dev/null || true)
[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo running=yes || echo running=no
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
[ -n "$runner" ] && kill -0 "$runner" 2>/dev/null && echo active=yes || echo active=no
echo "steps=$(cat "$jobs/steps" 2>/dev/null || true)"
echo "step=$(cat "$jobs/step" 2>/dev/null || true)"
echo "now=$(date +%s)"
for s in install prepare start; do
  [ -f "$jobs/$s.log" ] || [ -f "$jobs/$s.exit" ] || continue
  echo "@@$s"
  echo "exit=$(cat "$jobs/$s.exit" 2>/dev/null || true)"
  echo "mtime=$(date -r "$jobs/$s.log" +%s 2>/dev/null || true)"
  tail -c LOG_BYTES "$jobs/$s.log" 2>/dev/null || true
  echo
done
""".replace("LOG_BYTES", str(LOG_BYTES)).replace("SIMA_CLI_PATHS", " ".join('"{}"'.format(p) for p in SIMA_CLI_PATHS))

# Runs the steps named in $jobs/steps, in order, stopping at the first that fails.
# run.sh keeps running in the foreground, so the job lives as long as GenAI Studio.
_RUNNER_SCRIPT = r"""
jobs="$HOME/.neat-insight/genai-setup"
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
for s in $(cat "$jobs/steps"); do
  printf '%s\n' "$s" > "$jobs/step"
  case "$s" in
    install) cd "$HOME" && NEAT_APPS_SKIP_DEPENDENCIES=1 SIMA_CLI_CHECK_FOR_UPDATE=0 "$SIMA_CLI" neat install apps ;;
    prepare) cd "$studio" && ./setup.sh ;;
    start) cd "$studio" && ./run.sh ;;
  esac >"$jobs/$s.log" 2>&1 </dev/null
  code=$?
  printf '%s\n' "$code" > "$jobs/$s.exit"
  [ "$code" -eq 0 ] || exit "$code"
done
"""

# $1: the steps to run, $2: the sima-cli to install with. Detaches the runner from this
# shell (setsid, where the system has it) so it outlives the SSH session that started it.
_LAUNCH_SCRIPT = r"""
jobs="$HOME/.neat-insight/genai-setup"
mkdir -p "$jobs" || exit 1
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
if [ -n "$runner" ] && kill -0 "$runner" 2>/dev/null; then echo 'A setup job is already running.' >&2; exit 75; fi
for s in $1; do rm -f "$jobs/$s.exit" "$jobs/$s.log"; done
printf '%s\n' "$1" > "$jobs/steps"
rm -f "$jobs/step"
detach=
command -v setsid >/dev/null 2>&1 && detach=setsid
SIMA_CLI="$2" nohup $detach sh -c RUNNER genai-setup >/dev/null 2>&1 </dev/null &
printf '%s\n' "$!" > "$jobs/runner.pid"
"""

# Ends the job: run.sh stops GenAI Studio and its model server itself; any other step
# is ended with its whole process group. The step is recorded as stopped (143).
_STOP_SCRIPT = r"""
jobs="$HOME/.neat-insight/genai-setup"
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
step=$(cat "$jobs/step" 2>/dev/null || true)
[ -n "$runner" ] && kill -0 "$runner" 2>/dev/null || exit 0
if [ "$step" = start ] && [ -x "$studio/run.sh" ]; then (cd "$studio" && ./run.sh stop) >/dev/null 2>&1; fi
kill -TERM -- "-$runner" 2>/dev/null || kill -TERM "$runner" 2>/dev/null
[ -z "$step" ] || [ -f "$jobs/$step.exit" ] || printf '143\n' > "$jobs/$step.exit"
"""


def _quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def launch_command(steps, sima_cli: str) -> list:
    """The board command that starts a detached job running ``steps`` in order."""
    script = _LAUNCH_SCRIPT.replace("RUNNER", _quote(_RUNNER_SCRIPT))
    return ["sh", "-c", script, "genai-setup", " ".join(steps), sima_cli or "sima-cli"]


def status_command() -> list:
    return ["sh", "-c", _STATUS_SCRIPT]


def stop_command() -> list:
    return ["sh", "-c", _STOP_SCRIPT]


def parse_status(text: str) -> dict:
    """The status script's output as fields, plus each step's record (exit, mtime, log)."""
    fields, records, current = {}, {}, None
    for line in text.split("\n"):
        if line.startswith("@@") and line[2:] in STEPS:
            current = records[line[2:]] = {"exit": None, "mtime": None, "log": []}
        elif current is None:
            key, sep, value = line.partition("=")
            if sep:
                fields[key.strip()] = value.strip()
        # A record's first two lines are always exit= and mtime=; the log follows.
        elif current["exit"] is None:
            current["exit"] = line.partition("=")[2].strip()
        elif current["mtime"] is None:
            current["mtime"] = line.partition("=")[2].strip()
        else:
            current["log"].append(line)
    for record in records.values():
        record["log"] = clean_log("\n".join(record["log"]))
    return {"fields": fields, "records": records}


def clean_log(text: str) -> str:
    """The last lines of a log as a terminal would show them: no colours, progress bars at their last state."""
    lines = []
    for line in _ANSI.sub("", text).split("\n"):
        line = line.rstrip("\r").split("\r")[-1].rstrip()
        if line:
            lines.append(line[-300:])
    return "\n".join(lines[-LOG_LINES:])


def diagnose(step: str, log: str, exit_code: str) -> dict:
    """Why a step failed and what to do about it, in plain words."""
    for pattern, message, fixes in _CAUSES:
        if re.search(pattern, log, re.IGNORECASE):
            return _problem(step, message, fixes)
    if exit_code == "143":
        return _problem(step, "The step was stopped before it finished.", ["Press Retry to run it again."])
    return _problem(
        step,
        "{} stopped with exit code {}.".format(TITLES[step], exit_code or "unknown"),
        ["Its last output is below: fix what it reports, then press Retry."],
    )


def _problem(step: str, message: str, fixes) -> dict:
    return {
        "message": message,
        "fixes": list(fixes) + [
            "The full log is on the board in `{}/{}.log`.".format(JOB_DIR, step),
        ],
        "command": MANUAL_COMMANDS[step],
    }


def _blocking_problem(step: str, fields: dict):
    """A missing prerequisite that stops ``step`` before it runs, or None."""
    if step == "install" and not fields.get("sima_cli"):
        return _problem(
            step,
            "`sima-cli` was not found on the board, so Neat Apps cannot be installed from here.",
            ["Install sima-cli on the board (https://developer.sima.ai/software/tools/sima-cli/), then press "
             "Retry."],
        )
    if step == "prepare" and fields.get("core") != "yes":
        return _problem(step, "The Neat Library (Core) is not installed on the board.", [_INSTALL_CORE, "Then press Retry."])
    return None


def _stall(step: str, idle: int) -> dict:
    minutes = idle // 60
    why = {
        "install": "sima-cli prints nothing while it downloads a large file.",
        "prepare": "setup.sh prints nothing while it builds the document database or downloads a large model.",
        "start": "GenAI Studio prints nothing while its model server loads.",
    }[step]
    return {
        "message": "No new output for {} minute{}.".format(minutes, "" if minutes == 1 else "s"),
        "fixes": [
            why + " Give it a few more minutes.",
            "If nothing changes, press Stop, then Retry. Files already downloaded are kept.",
            "The full log is on the board in `{}/{}.log`.".format(JOB_DIR, step),
        ],
    }


def describe(parsed: dict) -> dict:
    """Each step's state for the GenAI tab: done, running, queued, failed, blocked or pending."""
    fields, records = parsed["fields"], parsed["records"]
    active = fields.get("active") == "yes"
    queued = fields.get("steps", "").split() if active else []
    current = fields.get("step", "") if active else ""
    done = {"install": fields.get("installed") == "yes", "prepare": fields.get("prepared") == "yes",
            "start": fields.get("running") == "yes"}
    now = _int(fields.get("now"))
    steps = []
    for step in STEPS:
        record = records.get(step) or {"exit": "", "mtime": "", "log": ""}
        record = dict(record, exit=record["exit"] or "")
        entry = {"id": step, "title": TITLES[step], "description": DESCRIPTIONS[step], "log": record["log"],
                 "problem": None, "stall": None}
        if step == current and not (step == "start" and done["start"]):
            entry["state"] = "running"
            mtime = _int(record["mtime"])
            idle = max(0, now - mtime) if now and mtime else 0
            if idle >= STALL_AFTER_SEC[step]:
                entry["stall"] = _stall(step, idle)
        elif done[step]:
            entry["state"] = "done"
        elif step in queued:
            entry["state"] = "queued"
        elif record["exit"] not in ("", "0"):
            entry["state"] = "failed"
            entry["problem"] = diagnose(step, record["log"], record["exit"])
        else:
            entry["state"] = "pending"
        if entry["state"] in ("pending", "failed"):
            blocked = _blocking_problem(step, fields)
            if blocked:
                entry["state"], entry["problem"] = "blocked", blocked
        steps.append(entry)
    return {"active": active, "steps": steps, "logDir": JOB_DIR}


def _int(value) -> int:
    try:
        return int(str(value).strip())
    except ValueError:
        return 0


def read_status(session) -> dict:
    result = session.transport.exec(status_command(), timeout=STATUS_TIMEOUT_SEC)
    if result.exit_code != 0:
        raise BoardError(
            "command_failed",
            "Insight could not read GenAI Studio's setup state on the board (exit {}).".format(result.exit_code),
            hint="Check that the board's shell works over SSH, then reload this page.",
        )
    parsed = parse_status(result.stdout.decode("utf-8", errors="replace"))
    return dict(describe(parsed), simaCli=parsed["fields"].get("sima_cli") or None)


# One launch at a time per Insight; the board refuses a second job too (exit 75).
_LAUNCH_LOCK = threading.Lock()


def run(session) -> dict:
    """Start a job running every step that is not done yet; refuse while one runs or one is blocked."""
    with _LAUNCH_LOCK:
        state = read_status(session)
        if state["active"]:
            raise BoardError("setup_running", "GenAI Studio is already being set up on this board.",
                             hint="Wait for the running step to finish, or press Stop first.")
        remaining = [s for s in state["steps"] if s["state"] != "done"]
        if not remaining:
            raise BoardError("setup_done", "GenAI Studio is already installed and running on this board.",
                             hint="Nothing to do: the GenAI tab connects to it.")
        blocked = next((s for s in remaining if s["state"] == "blocked"), None)
        if blocked:
            problem = blocked["problem"]
            raise BoardError("setup_blocked", problem["message"], hint=" ".join(problem["fixes"][:1]),
                             step=blocked["id"])
        result = session.transport.exec(launch_command([s["id"] for s in remaining], state["simaCli"]),
                                        timeout=LAUNCH_TIMEOUT_SEC)
        if result.exit_code == 75:
            raise BoardError("setup_running", "GenAI Studio is already being set up on this board.",
                             hint="Wait for the running step to finish, or press Stop first.")
        if result.exit_code != 0:
            raise BoardError(
                "command_failed",
                "The setup job could not be started on the board (exit {}).".format(result.exit_code),
                hint="Check that {} on the board is writable, then retry.".format(JOB_DIR),
                detail=result.stderr.decode("utf-8", errors="replace").strip()[-2000:],
            )
        return read_status(session)


def stop(session) -> dict:
    session.transport.exec(stop_command(), timeout=STATUS_TIMEOUT_SEC)
    return read_status(session)


def _payload(session, state: dict) -> dict:
    return dict(state, board=board_summary(session), generation=session.generation)


# API: what is installed, prepared and running on the board, and the setup job's progress.
@genai_setup_bp.get("/api/genai-setup")
def setup_status():
    """Report each setup step's state on the selected board, with the cause and fixes of a failed step."""
    session = get_board_manager().session()
    return jsonify(_payload(session, read_status(session)))


# API: install, prepare and start GenAI Studio on the board, as far as it still needs.
@genai_setup_bp.post("/api/genai-setup/run")
def setup_run():
    """Start a detached job on the board running every step that is not done yet."""
    session = get_board_manager().session()
    return jsonify(_payload(session, run(session)))


# API: stop the setup job.
@genai_setup_bp.post("/api/genai-setup/stop")
def setup_stop():
    """Stop the running setup step; during the start step this stops GenAI Studio."""
    session = get_board_manager().session()
    return jsonify(_payload(session, stop(session)))
