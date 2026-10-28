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
import time

from flask import Blueprint, jsonify, request

from neat_insight.board.errors import BoardError
from neat_insight.board.manager import board_summary, get_board_manager

genai_setup_bp = Blueprint("genai_setup", __name__)

STEPS = ("install", "prepare", "start")
JOB_DIR = "~/.neat-insight/genai-setup"
STUDIO_DIR = "~/prebuilt-apps/examples/genai/neat-genai-studio"
STATUS_TIMEOUT_SEC = 20.0
LAUNCH_TIMEOUT_SEC = 20.0
LOG_BYTES = 6000
WARNING_BYTES = 2000000
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
    "start": "Runs GenAI Studio in the background. It loads its voices first, which takes a few minutes, and keeps "
    "running after you close this page.",
}
# What to run in a shell on the board instead, the last resort a failure offers. An install
# or prepare run this way records its success, so the panel shows the step done instead of
# the earlier failure. {sima_cli} is the sima-cli the board has.
MANUAL_COMMANDS = {
    "install": "cd ~ && NEAT_APPS_SKIP_DEPENDENCIES=1 {sima_cli} neat install apps && echo 0 > " + JOB_DIR + "/install.exit",
    "prepare": "cd " + STUDIO_DIR + " && ./setup.sh && echo 0 > " + JOB_DIR + "/prepare.exit",
    "start": "cd " + STUDIO_DIR + " && ./run.sh",
}


def manual_command(step: str, sima_cli=None) -> str:
    return MANUAL_COMMANDS[step].format(sima_cli=sima_cli or "sima-cli")

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

# Warnings a step printed on its way to finishing: setup.sh marks its own with ⚠, GenAI
# Studio's log with WARNING. Each known one gets a plain message and the fix: (pattern,
# message or None to keep the line, fix).
WARNING_LIMIT = 6
_WARNINGS = (
    (
        r"Cannot compile .?Python\.h|Has header .?Python\.h.? with dependency python: NO",
        "The board has no Python headers (python3-dev), so packages that build from source could not be "
        "installed.",
        "Install them with `sudo apt-get install python3-dev` in a shell on the board, then press Run setup again.",
    ),
    (
        r"Supertonic (requirements failed|TTS skipped)",
        "The Supertonic voices were skipped.",
        "Read aloud uses the other voices. Fix the cause above, then press Run setup again.",
    ),
    (
        r"Could not verify .*accelerator busy",
        None,
        "Another application was using the accelerator during setup. If speech-to-text fails, stop that "
        "application and restart GenAI Studio.",
    ),
    (
        r"No server TTS voice installed for language: ?(\w+)",
        None,
        "Replies in this language can't be read aloud.",
    ),
)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


# Where sima-cli's installer puts it: /data/sima-cli on a DevKit, ~/.sima-cli elsewhere. Only
# ~/.bashrc adds it to PATH, so Insight's own PATH often lacks it.
SIMA_CLI_PATHS = ("/data/sima-cli/.venv/bin/sima-cli", "$HOME/.sima-cli/.venv/bin/sima-cli")

# Whether $1 is still the setup job's runner, not a later process that reused its pid
# (after a reboot, say). The runner's command line ends with its name, genai-setup.
_ALIVE = r"""
alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\000' ' ' < "/proc/$1/cmdline" | grep -q 'genai-setup *$'
}
# The same for GenAI Studio's pid file, which a reboot can leave behind: still run.sh?
studio_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -r "/proc/$1/cmdline" ] || return 0
  tr '\000' ' ' < "/proc/$1/cmdline" | grep -q 'run\.sh'
}
# Before `run.sh stop`: drop a pid file whose process is no longer run.sh, so run.sh
# signals nothing else.
forget_stale_studio() {
  _pid=$(cat "$1/.neat-genai-studio.pid" 2>/dev/null || true)
  [ -z "$_pid" ] || studio_alive "$_pid" || rm -f "$1/.neat-genai-studio.pid"
}
"""

# Every line is key=value, except each step's record, which starts at `@@<step>`.
_STATUS_SCRIPT = _ALIVE + r"""
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
jobs="$HOME/.neat-insight/genai-setup"
cli=$(command -v sima-cli 2>/dev/null || true)
for c in SIMA_CLI_PATHS; do [ -n "$cli" ] || { [ -x "$c" ] && cli=$c; }; done
echo "sima_cli=$cli"
[ -x "$HOME/pyneat/bin/python" ] && echo core=yes || echo core=no
[ -x "$studio/run.sh" ] && echo installed=yes || echo installed=no
[ -x "$studio/.venv/bin/python" ] && [ -f "$studio/config.local.yaml" ] && echo prepared=yes || echo prepared=no
pid=$(cat "$studio/.neat-genai-studio.pid" 2>/dev/null || true)
# Running once run.sh is; answering once its web server is up, after the voices load.
# run.sh writes its pid, then its mode, then (a moment later) the URL it serves: a web
# or backend-only mode without the URL yet is still starting. Without a mode (an older
# run.sh), in --cli mode or without curl, a running Studio counts as answering.
if [ -n "$pid" ] && studio_alive "$pid"; then
  echo running=yes
  url=$(cat "$studio/.neat-genai-studio.url" 2>/dev/null || true)
  mode=$(cat "$studio/.neat-genai-studio.mode" 2>/dev/null || true)
  if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
    code=$(curl -sk -m 2 -o /dev/null -w '%{http_code}' "$url/health" 2>/dev/null || true)
  elif [ -z "$mode" ] || [ "$mode" = cli ] || ! command -v curl >/dev/null 2>&1; then
    code=any
  else
    code=000
  fi
  [ "${code:-000}" != 000 ] && echo answering=yes || echo answering=no
else
  echo running=no
fi
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
alive "$runner" && echo active=yes || echo active=no
echo "steps=$(cat "$jobs/steps" 2>/dev/null || true)"
echo "step=$(cat "$jobs/step" 2>/dev/null || true)"
echo "now=$(date +%s)"
for s in install prepare start; do
  [ -f "$jobs/$s.log" ] || [ -f "$jobs/$s.exit" ] || continue
  echo "@@$s"
  echo "exit=$(cat "$jobs/$s.exit" 2>/dev/null || true)"
  echo "mtime=$(date -r "$jobs/$s.log" +%s 2>/dev/null || true)"
  # Warnings from the start of the log (start.log grows while GenAI Studio runs), without
  # timestamps so a repeated one is listed once. Dropped: this job's own choices, and the
  # notice Flask's built-in server prints every time it starts.
  head -c WARNING_BYTES "$jobs/$s.log" 2>/dev/null | grep -a -E '⚠|WARNING|Python\.h' \
    | grep -a -v -E 'SIMA_CLI_CHECK_FOR_UPDATE|Skipping Core and Insight dependency|development server|production deployment' \
    | sed -E 's/^[0-9-]+ [0-9:,.]+ - //' | awk '!seen[$0]++' | tail -n 20
  echo "@log"
  tail -c LOG_BYTES "$jobs/$s.log" 2>/dev/null || true
  echo
done
""".replace("LOG_BYTES", str(LOG_BYTES)).replace("WARNING_BYTES", str(WARNING_BYTES)).replace("SIMA_CLI_PATHS", " ".join('"{}"'.format(p) for p in SIMA_CLI_PATHS))

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
_LAUNCH_SCRIPT = _ALIVE + r"""
jobs="$HOME/.neat-insight/genai-setup"
mkdir -p "$jobs" || exit 1
# One launch at a time on the board, also from another Insight: the lock is held until
# this script ends, by when the new runner's pid is recorded.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$jobs/launch.lock"
  flock -n 9 || { echo 'A setup job is being started.' >&2; exit 75; }
fi
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
if alive "$runner"; then echo 'A setup job is already running.' >&2; exit 75; fi
for s in $1; do rm -f "$jobs/$s.exit" "$jobs/$s.log"; done
printf '%s\n' "$1" > "$jobs/steps"
rm -f "$jobs/step"
detach=
command -v setsid >/dev/null 2>&1 && detach=setsid
SIMA_CLI="$2" nohup $detach sh -c RUNNER genai-setup >/dev/null 2>&1 </dev/null 9>&- &
printf '%s\n' "$!" > "$jobs/runner.pid"
"""

# Ends the runner $1 and the step it runs, and waits up to 10 s for it: its process group
# (setsid made one; dash's kill names it -PID and rejects `--`), or without setsid its
# children, then the runner itself.
_END_JOB = r"""
end_job() {
  kill -TERM "-$1" 2>/dev/null || { pkill -TERM -P "$1" 2>/dev/null; kill -TERM "$1" 2>/dev/null; }
  i=0
  while alive "$1" && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
}
"""

# Ends the job: run.sh stops GenAI Studio and its model server itself; any other step
# is ended with its whole process group. The step is recorded as stopped (143).
_STOP_SCRIPT = _ALIVE + _END_JOB + r"""
jobs="$HOME/.neat-insight/genai-setup"
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
step=$(cat "$jobs/step" 2>/dev/null || true)
alive "$runner" || exit 0
if [ "$step" = start ] && [ -x "$studio/run.sh" ]; then forget_stale_studio "$studio"; (cd "$studio" && ./run.sh stop) >/dev/null 2>&1; fi
end_job "$runner"
[ -z "$step" ] || [ -s "$jobs/$step.exit" ] || printf '143\n' > "$jobs/$step.exit"
"""

# Stops GenAI Studio however it was started: run.sh stops it and its model server. A setup
# job that only kept it running then ends, and the start step is recorded as stopped on
# purpose, so it waits to be started again instead of reporting a failure.
_STOP_STUDIO_SCRIPT = _ALIVE + _END_JOB + r"""
jobs="$HOME/.neat-insight/genai-setup"
studio="$HOME/prebuilt-apps/examples/genai/neat-genai-studio"
runner=$(cat "$jobs/runner.pid" 2>/dev/null || true)
step=$(cat "$jobs/step" 2>/dev/null || true)
forget_stale_studio "$studio"
[ -x "$studio/run.sh" ] && (cd "$studio" && ./run.sh stop) >/dev/null 2>&1
if [ "$step" = start ] && alive "$runner"; then end_job "$runner"; fi
[ -f "$jobs/start.log" ] && printf 'stopped\n' > "$jobs/start.exit"
exit 0
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


def stop_studio_command() -> list:
    return ["sh", "-c", _STOP_STUDIO_SCRIPT]


def parse_status(text: str) -> dict:
    """The status script's output as fields, plus each step's record (exit, mtime, log)."""
    fields, records, current = {}, {}, None
    for line in text.split("\n"):
        if line.startswith("@@") and line[2:] in STEPS:
            current = records[line[2:]] = {"exit": None, "mtime": None, "warnings": [], "log": None}
        elif current is None:
            key, sep, value = line.partition("=")
            if sep:
                fields[key.strip()] = value.strip()
        # A record is exit=, mtime=, its warning lines up to @log, then the log's tail.
        elif current["exit"] is None:
            current["exit"] = line.partition("=")[2].strip()
        elif current["mtime"] is None:
            current["mtime"] = line.partition("=")[2].strip()
        elif current["log"] is None:
            if line == "@log":
                current["log"] = []
            else:
                current["warnings"].append(line)
        else:
            current["log"].append(line)
    for record in records.values():
        record["log"] = clean_log("\n".join(record["log"] or []))
        record["warnings"] = describe_warnings(record["warnings"])
    return {"fields": fields, "records": records}


def describe_warnings(lines) -> list:
    """A step's warning lines as [{message, fix}], known ones in plain words, each listed once."""
    found = []
    for raw in lines:
        line = _ANSI.sub("", raw).split("\r")[-1].strip()
        line = re.sub(r"^.*?\bWARNING\b\s*[-:]\s*", "", line)
        line = line.lstrip("⚠️ ").strip()
        if not line:
            continue
        message, fix = line[:300], None
        for pattern, known, known_fix in _WARNINGS:
            if re.search(pattern, line, re.IGNORECASE):
                message, fix = known or message, known_fix
                break
        if all(w["message"] != message for w in found):
            found.append({"message": message, "fix": fix})
    return found[:WARNING_LIMIT]


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
    # A stopped step's log ends wherever it was cut off, so it says nothing about a cause.
    if exit_code == "143":
        return _problem(step, "The step was stopped before it finished.", ["Press Retry to run it again."])
    if exit_code == INTERRUPTED:
        return _problem(step, "The step was cut off before it finished, for example by a board restart.",
                        ["Press Retry to run it again."])
    for pattern, message, fixes in _CAUSES:
        if re.search(pattern, log, re.IGNORECASE):
            return _problem(step, message, fixes)
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
        "command": manual_command(step),
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
    current = fields.get("step", "") if active else ""
    planned = fields.get("steps", "").split() if active else []
    # The job's steps still ahead of the one running: they run again even if done before.
    queued = planned[planned.index(current) + 1:] if current in planned else planned
    running = fields.get("running") == "yes"
    # GenAI Studio is started once it answers; until then it is still loading its voices.
    loading = running and fields.get("answering", "yes") != "yes"
    done = {"install": fields.get("installed") == "yes", "prepare": fields.get("prepared") == "yes",
            "start": running and not loading}
    now = _int(fields.get("now"))
    steps = []
    for step in STEPS:
        record = records.get(step) or {"exit": "", "mtime": "", "log": "", "warnings": []}
        record = dict(record, exit=record["exit"] or "")
        # The job is gone, but this install or prepare was its step and never recorded an
        # exit code: it was cut off. (An ended start step is just a stopped Studio.)
        if (not active and step != "start" and step in records and not record["exit"]
                and fields.get("step") == step):
            record["exit"] = INTERRUPTED
        failed = record["exit"] not in ("", "0") and not _stopped_studio(step, record["exit"])
        entry = {"id": step, "title": TITLES[step], "description": DESCRIPTIONS[step], "log": record["log"],
                 "problem": None, "stall": None, "warnings": []}
        if step == current and not (step == "start" and done["start"]):
            entry["state"] = "running"
            mtime = _int(record["mtime"])
            idle = max(0, now - mtime) if now and mtime else 0
            if idle >= STALL_AFTER_SEC[step]:
                entry["stall"] = _stall(step, idle)
        elif step == "start" and loading:
            # Started from a shell on the board: still loading, and the job's log is an old one.
            entry["state"], entry["log"] = "running", ""
        elif step in queued:
            entry["state"] = "queued"
        # A failed or stopped install or prepare counts even when an earlier run left its
        # files: the step did not finish, so Retry runs it again. A running Studio is done.
        elif failed and step != "start":
            entry["state"] = "failed"
            entry["problem"] = diagnose(step, record["log"], record["exit"])
        elif done[step]:
            entry["state"] = "done"
        elif failed:
            entry["state"] = "failed"
            entry["problem"] = diagnose(step, record["log"], record["exit"])
        else:
            entry["state"] = "pending"
        if entry["state"] in ("pending", "failed"):
            blocked = _blocking_problem(step, fields)
            if blocked:
                entry["state"], entry["problem"] = "blocked", blocked
        if entry["problem"]:
            entry["problem"]["command"] = manual_command(step, fields.get("sima_cli"))
        if entry["state"] in ("done", "running", "failed"):
            entry["warnings"] = record.get("warnings") or []
        steps.append(entry)
    return {"active": active, "steps": steps, "logDir": JOB_DIR}


# A step the job was running when it ended without recording an exit code (the board
# restarted, or the job was killed).
INTERRUPTED = "interrupted"


def _stopped_studio(step: str, exit_code: str) -> bool:
    """GenAI Studio was stopped, not broken: from the tab ("stopped"), with `run.sh stop` or by its
    own shutdown (run.sh exits 143), or with Ctrl+C (130). Its step waits to run again."""
    return step == "start" and exit_code in ("stopped", "143", "130")


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
    return dict(describe(parsed), simaCli=parsed["fields"].get("sima_cli") or None,
                core=parsed["fields"].get("core") == "yes")


# One launch at a time per Insight; the board refuses a second job too (exit 75).
_LAUNCH_LOCK = threading.Lock()
# How long a redo waits for the running GenAI Studio to stop before setup runs again.
STOP_WAIT_SEC = 30.0


def _busy() -> BoardError:
    return BoardError("setup_running", "GenAI Studio is already being set up on this board.",
                      hint="Wait for the running step to finish, or press Stop first.")


def _studio_running(state: dict) -> bool:
    """GenAI Studio runs: it answers, or it is still starting."""
    return state["steps"][2]["state"] in ("done", "running")


def _step_in_progress(state: dict) -> bool:
    """Install or prepare runs or waits to; a starting GenAI Studio is stopped like a running one."""
    return any(s["state"] in ("running", "queued") for s in state["steps"][:2]) or state["steps"][2]["state"] == "queued"


def _stop_studio(session) -> dict:
    """Stop GenAI Studio, whether this tab or a shell on the board started it, and wait until it has ended."""
    session.transport.exec(stop_studio_command(), timeout=STATUS_TIMEOUT_SEC + STOP_WAIT_SEC)
    deadline = time.monotonic() + STOP_WAIT_SEC
    while True:
        state = read_status(session)
        if not state["active"] and not _studio_running(state):
            return state
        if time.monotonic() > deadline:
            raise BoardError("timeout", "GenAI Studio did not stop within {:g} s.".format(STOP_WAIT_SEC),
                             hint="Stop it in a shell on the board: `cd {} && ./run.sh stop`.".format(STUDIO_DIR))
        time.sleep(0.5)


def stop_studio(session) -> dict:
    """Stop a running GenAI Studio; refuse while a setup step is in progress (Stop ends that)."""
    with _LAUNCH_LOCK:
        state = read_status(session)
        if _step_in_progress(state):
            raise _busy()
        if not _studio_running(state):
            return state
        return _stop_studio(session)


def run(session, redo=None) -> dict:
    """Start a job running every step that is not done yet; refuse while one runs or one is blocked.

    ``redo="prepare"`` runs setup.sh again and restarts GenAI Studio, after fixing what it warned about."""
    if redo not in (None, "prepare"):
        raise BoardError("invalid_request", "Only the prepare step can be run again.", hint='Send {"redo": "prepare"}.')
    with _LAUNCH_LOCK:
        state = read_status(session)
        if redo:
            if state["steps"][0]["state"] != "done":
                raise BoardError("setup_blocked", "Neat Apps is not installed on this board yet.",
                                 hint="Press Install and start GenAI Studio instead.", step="install")
            if _step_in_progress(state):
                raise _busy()
            remaining = ["prepare", "start"]
            for step in remaining:
                blocked = _blocking_problem(step, {"core": "yes" if state.get("core") else "no",
                                                   "sima_cli": state["simaCli"]})
                if blocked:
                    raise BoardError("setup_blocked", blocked["message"], hint=blocked["fixes"][0], step=step)
            if state["active"] or _studio_running(state):
                state = _stop_studio(session)
            return _launch(session, remaining, state["simaCli"])
        if _step_in_progress(state) or state["steps"][2]["state"] == "running":
            raise _busy()
        remaining = [s for s in state["steps"] if s["state"] != "done"]
        if not remaining:
            raise BoardError("setup_done", "GenAI Studio is already installed and running on this board.",
                             hint="Nothing to do: the GenAI tab connects to it.")
        blocked = next((s for s in remaining if s["state"] == "blocked"), None)
        if blocked:
            problem = blocked["problem"]
            raise BoardError("setup_blocked", problem["message"], hint=" ".join(problem["fixes"][:1]),
                             step=blocked["id"])
        # GenAI Studio still runs although an earlier step failed or was stopped (a Retry
        # after a stopped Run setup again): stop it, and start it again after that step.
        if state["active"] or _studio_running(state):
            state = _stop_studio(session)
            remaining = [s for s in state["steps"] if s["state"] != "done"]
        return _launch(session, [s["id"] for s in remaining], state["simaCli"])


def _launch(session, steps, sima_cli) -> dict:
    """Start the detached job running ``steps`` on the board."""
    result = session.transport.exec(launch_command(steps, sima_cli), timeout=LAUNCH_TIMEOUT_SEC)
    if result.exit_code == 75:
        raise _busy()
    if result.exit_code != 0:
        raise BoardError(
            "command_failed",
            "The setup job could not be started on the board (exit {}).".format(result.exit_code),
            hint="Check that {} on the board is writable, then retry.".format(JOB_DIR),
            detail=result.stderr.decode("utf-8", errors="replace").strip()[-2000:],
        )
    return read_status(session)


def stop(session) -> dict:
    # Under the launch lock, so a Stop can't run between another request's check and its launch.
    with _LAUNCH_LOCK:
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


def _action_session():
    """The selected board's session and the request body. A request naming the board
    `generation` its panel showed is refused once another board is selected, so a click
    never acts on a board the panel does not show."""
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    raw = request.args.get("generation")
    session = get_board_manager().session()
    if raw not in (None, ""):
        try:
            expected = int(raw)
        except ValueError:
            raise BoardError("invalid_request", "`generation` must be the whole-number board generation.",
                             hint="Send the `generation` of the setup state the panel shows, or omit it.") from None
        if expected != session.generation:
            raise BoardError("stale_snapshot", "The selected board changed since this panel was shown, so nothing was done.",
                             hint="The panel now shows the selected board: check it, then press the button again.",
                             expected_generation=expected, current_generation=session.generation)
    return session, body


# API: install, prepare and start GenAI Studio on the board, as far as it still needs.
@genai_setup_bp.post("/api/genai-setup/run")
def setup_run():
    """Start a detached job on the board running every step that is not done yet, or {"redo": "prepare"}."""
    session, body = _action_session()
    return jsonify(_payload(session, run(session, body.get("redo"))))


# API: stop GenAI Studio on the board.
@genai_setup_bp.post("/api/genai-setup/stop-studio")
def setup_stop_studio():
    """Stop GenAI Studio, whether the setup job or a shell on the board started it."""
    session, _ = _action_session()
    return jsonify(_payload(session, stop_studio(session)))


# API: stop the setup job.
@genai_setup_bp.post("/api/genai-setup/stop")
def setup_stop():
    """Stop the running setup step; during the start step this stops GenAI Studio."""
    session, _ = _action_session()
    return jsonify(_payload(session, stop(session)))
