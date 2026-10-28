import fcntl
import os
import shutil
import socket
import subprocess
import threading
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from flask import Flask

from neat_insight import genai_setup
from neat_insight.board import BoardError, ExecResult, board_bp

_FAKE_SIMA_CLI = r"""#!/bin/sh
[ "$1 $2 $3" = "neat install apps" ] || { echo "unexpected: $*" >&2; exit 2; }
[ "${NEAT_APPS_SKIP_DEPENDENCIES:-}" = 1 ] || { echo "would reinstall Core and Insight" >&2; exit 3; }
[ "$PWD" = "$HOME" ] || { echo "not in the home directory: $PWD" >&2; exit 4; }
studio="$PWD/prebuilt-apps/examples/genai/neat-genai-studio"
mkdir -p "$studio"
cp "$FAKE_STUDIO/run.sh" "$FAKE_STUDIO/setup.sh" "$studio/"
chmod +x "$studio/run.sh" "$studio/setup.sh"
echo "Installed apps runtime under: $PWD/prebuilt-apps"
"""

_FAKE_SETUP = r"""#!/bin/sh
dir=$(cd "$(dirname "$0")" && pwd)
printf '\033[1mInstalling voices\033[0m\n'
[ -t 0 ] && echo "asked for languages" >&2
if [ -n "${FAKE_SETUP_FAIL:-}" ]; then echo "$FAKE_SETUP_FAIL" >&2; exit 1; fi
if [ -n "${FAKE_SETUP_WAIT:-}" ]; then echo $$ > "$dir/setup.waiting"; while :; do sleep 0.1; done; fi
if [ -n "${FAKE_SETUP_WARN:-}" ]; then
  echo 'Has header "Python.h" with dependency python: NO'
  echo "      ../meson.build:44:2: ERROR: Problem encountered: Cannot compile \`Python.h\`. Perhaps you need to install python-dev"
  printf '\033[33m⚠ Supertonic requirements failed to install; Supertonic TTS skipped.\033[0m\n'
fi
mkdir -p "$dir/.venv/bin"
printf '#!/bin/sh\n' > "$dir/.venv/bin/python"
chmod +x "$dir/.venv/bin/python"
touch "$dir/config.local.yaml"
echo "Install complete."
"""

_FAKE_RUN = r"""#!/bin/sh
dir=$(cd "$(dirname "$0")" && pwd)
pidf="$dir/.neat-genai-studio.pid"
if [ "${1:-}" = stop ]; then kill "$(cat "$pidf")" 2>/dev/null; exit 0; fi
echo "Neat GenAI Studio is starting up."
echo "2026-10-27 19:31:45,294 - root - WARNING - No server TTS voice installed for language: ja"
echo "2026-10-27 19:31:46,001 - root - WARNING - No server TTS voice installed for language: ja"
echo "2026-10-27 19:31:46,002 - werkzeug - INFO - GET /health 200"
echo "2026-10-27 19:31:46,003 - werkzeug - WARNING - WARNING: This is a development server. Do not use it in a production deployment."
trap 'rm -f "$pidf" "$dir/.neat-genai-studio.mode" "$dir/.neat-genai-studio.url"; exit 143' TERM INT
echo $$ > "$pidf"
# Like run.sh: the pid, the mode, then a moment later the URL it serves.
if [ -n "${FAKE_RUN_URL:-}" ]; then
  echo web > "$dir/.neat-genai-studio.mode"
  sleep 1
  echo "$FAKE_RUN_URL" > "$dir/.neat-genai-studio.url"
fi
while :; do sleep 0.1; done
"""


class ShellTransport:
    """Runs board commands as local processes, with HOME and PATH pointed at a fake board."""

    def __init__(self, env):
        self.env = env
        self.commands = []

    def exec(self, argv, *, timeout, stdin=None):
        self.commands.append(argv)
        done = subprocess.run(argv, env=self.env, capture_output=True, timeout=timeout)
        return ExecResult(done.returncode, done.stdout, done.stderr)


def session_for(transport, generation=1):
    target = SimpleNamespace(mode="ssh", source="manual", label="sima@192.168.2.2")
    return SimpleNamespace(transport=transport, target=target, generation=generation)


class BoardScriptTests(unittest.TestCase):
    """The status, launch and stop scripts, run for real by sh against a fake board in a temporary HOME."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.home, fake, bin_dir = root / "home", root / "studio", root / "bin"
        for path in (self.home, fake, bin_dir):
            path.mkdir()
        for path, text in ((bin_dir / "sima-cli", _FAKE_SIMA_CLI), (fake / "setup.sh", _FAKE_SETUP), (fake / "run.sh", _FAKE_RUN)):
            path.write_text(text)
            path.chmod(0o755)
        self.studio = self.home / "prebuilt-apps/examples/genai/neat-genai-studio"
        self.add_core()
        self.env = dict(os.environ, HOME=str(self.home), FAKE_STUDIO=str(fake),
                        PATH="{}:{}".format(bin_dir, os.environ.get("PATH", "")))
        self.transport = ShellTransport(self.env)
        self.session = session_for(self.transport)
        # Whatever a test leaves running on the fake board is stopped.
        self.addCleanup(lambda: subprocess.run(genai_setup.stop_command(), env=self.env, capture_output=True, timeout=20))
        self.addCleanup(lambda: subprocess.run(genai_setup.stop_studio_command(), env=self.env, capture_output=True, timeout=20))

    def add_core(self):
        python = self.home / "pyneat/bin/python"
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("#!/bin/sh\n")
        python.chmod(0o755)

    def status(self):
        return genai_setup.read_status(self.session)

    def states(self, status=None):
        return [step["state"] for step in (status or self.status())["steps"]]

    def start_by_hand(self):
        """Start GenAI Studio the way a shell on the board would, outside any setup job."""
        studio = subprocess.Popen(["./run.sh"], cwd=self.studio, env=self.env, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        self.addCleanup(lambda: studio.poll() is None and studio.kill())
        self.wait_for(lambda s: s["steps"][2]["state"] == "done")
        return studio

    def install_and_prepare(self):
        genai_setup.run(self.session)
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])
        genai_setup.stop_studio(self.session)

    def wait_until_ended(self, pid, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
        self.fail("process {} is still running after Stop".format(pid))

    def wait_for(self, check, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.status()
            if check(status):
                return status
            time.sleep(0.1)
        self.fail("the board never reached the expected state: {}".format(self.status()))

    def test_a_new_board_installs_prepares_and_starts_studio_in_one_job(self):
        status = self.status()
        self.assertEqual((status["active"], self.states(status)), (False, ["pending", "pending", "pending"]))
        self.assertTrue(status["simaCli"].endswith("/sima-cli"))
        status = genai_setup.run(self.session)
        self.assertTrue(status["active"])
        status = self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])
        # setup.sh ran without a terminal, so it took its default languages instead of asking.
        self.assertIn("Install complete.", status["steps"][1]["log"])
        self.assertNotIn("asked for languages", status["steps"][1]["log"])
        # Colours are dropped from the log the page shows.
        self.assertIn("Installing voices", status["steps"][1]["log"])
        self.assertNotIn("\x1b", status["steps"][1]["log"])
        self.assertTrue((self.studio / ".neat-genai-studio.pid").exists())
        # The job now only keeps GenAI Studio running: nothing is left to set up.
        with self.assertRaises(BoardError) as refused:
            genai_setup.run(self.session)
        self.assertEqual(refused.exception.code, "setup_done")

    def test_studio_keeps_running_after_the_command_that_started_it_returns(self):
        genai_setup.run(self.session)
        self.wait_for(lambda s: s["steps"][2]["state"] == "done")
        time.sleep(0.5)
        self.assertEqual(self.states(), ["done", "done", "done"])
        status = genai_setup.stop(self.session)
        self.assertFalse(status["active"])
        # run.sh exits 143 when stopped: the step waits to start again, it did not fail.
        status = self.wait_for(lambda s: s["steps"][2]["state"] == "pending")
        self.assertIsNone(status["steps"][2]["problem"])

    def test_stopping_studio_leaves_the_start_step_ready_to_run_again(self):
        genai_setup.run(self.session)
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])
        status = genai_setup.stop_studio(self.session)
        self.assertEqual((status["active"], self.states(status)), (False, ["done", "done", "pending"]))
        self.assertIsNone(status["steps"][2]["problem"], "a stop on purpose is not a failure")
        self.assertFalse((self.studio / ".neat-genai-studio.pid").exists())
        # Stopping again does nothing, and Start runs only the start step.
        self.assertEqual(self.states(genai_setup.stop_studio(self.session)), ["done", "done", "pending"])
        genai_setup.run(self.session)
        self.assertEqual(self.transport.commands[-2][4], "start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def free_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def serve_health(self, port):
        """GenAI Studio's web server coming up, once its voices have loaded."""
        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", port), Health)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def test_the_start_step_runs_until_studio_answers(self):
        port = self.free_port()
        self.env["FAKE_RUN_URL"] = "http://127.0.0.1:{}".format(port)
        genai_setup.run(self.session)
        url_file = self.studio / ".neat-genai-studio.url"
        # Before run.sh records its URL, and after, until the web server answers: still starting.
        seen = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not (url_file.exists() and len(seen) > 3):
            if (self.studio / ".neat-genai-studio.pid").exists():
                seen.append((url_file.exists(), self.states()[2]))
            time.sleep(0.05)
        self.assertIn((False, "running"), seen, "polled before the URL was recorded")
        self.assertNotIn("done", [state for _, state in seen])
        self.assertEqual(self.states(), ["done", "done", "running"])
        self.serve_health(port)
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_a_loading_studio_started_from_a_shell_is_not_started_twice_and_can_be_stopped(self):
        self.install_and_prepare()
        self.env["FAKE_RUN_URL"] = "http://127.0.0.1:{}".format(self.free_port())
        studio = subprocess.Popen(["./run.sh"], cwd=self.studio, env=self.env, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, start_new_session=True)
        self.addCleanup(lambda: studio.poll() is None and studio.kill())
        status = self.wait_for(lambda s: s["steps"][2]["state"] == "running")
        self.assertEqual((status["active"], status["steps"][2]["log"]), (False, ""))
        with self.assertRaises(BoardError) as refused:
            genai_setup.run(self.session)
        self.assertEqual(refused.exception.code, "setup_running")
        status = genai_setup.stop_studio(self.session)
        self.assertEqual(self.states(status), ["done", "done", "pending"])
        self.assertEqual(studio.wait(timeout=10), 143)

    def test_studio_started_from_a_shell_on_the_board_can_be_stopped_from_the_tab(self):
        self.install_and_prepare()
        studio = self.start_by_hand()
        self.assertFalse(self.status()["active"], "no setup job runs it")
        status = genai_setup.stop_studio(self.session)
        self.assertEqual(self.states(status), ["done", "done", "pending"])
        self.assertEqual(studio.wait(timeout=10), 143)

    def test_setup_runs_again_after_stopping_a_studio_started_from_a_shell(self):
        self.install_and_prepare()
        studio = self.start_by_hand()
        genai_setup.run(self.session, redo="prepare")
        self.assertEqual(studio.wait(timeout=10), 143, "the hand-started Studio was stopped before setup.sh ran")
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_studio_is_not_stopped_while_a_setup_step_runs(self):
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session)
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        with self.assertRaises(BoardError) as refused:
            genai_setup.stop_studio(self.session)
        self.assertEqual(refused.exception.code, "setup_running")

    def test_a_failed_step_says_why_and_a_retry_runs_only_what_is_left(self):
        self.env["FAKE_SETUP_FAIL"] = "OSError: Could not resolve host: huggingface.co"
        genai_setup.run(self.session)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        problem = status["steps"][1]["problem"]
        self.assertEqual(problem["message"], "The board could not download what this step needs.")
        self.assertTrue(any("huggingface.co" in fix for fix in problem["fixes"]))
        self.assertIn("~/.neat-insight/genai-setup/prepare.log", problem["fixes"][-1])
        self.assertEqual(problem["command"], genai_setup.manual_command("prepare"))
        self.assertIn("Could not resolve host", status["steps"][1]["log"])

        del self.env["FAKE_SETUP_FAIL"]
        genai_setup.run(self.session)
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_running_the_offered_command_by_hand_clears_the_failure(self):
        self.env["FAKE_SETUP_FAIL"] = "OSError: Could not resolve host: huggingface.co"
        genai_setup.run(self.session)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        del self.env["FAKE_SETUP_FAIL"]
        # The user fixes the network and pastes the panel's command into a shell on the board.
        done = subprocess.run(["bash", "-c", status["steps"][1]["problem"]["command"].replace("~", str(self.home))],
                              env=self.env, capture_output=True, timeout=20)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.states(), ["done", "done", "pending"])

    def test_stop_ends_a_step_and_marks_it_stopped(self):
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session)
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        self.assertEqual(self.states(), ["done", "running", "queued"])
        setup_pid = int((self.studio / "setup.waiting").read_text())
        status = genai_setup.stop(self.session)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        self.assertEqual(status["steps"][1]["problem"]["message"], "The step was stopped before it finished.")
        self.wait_until_ended(setup_pid)

    def test_a_pid_left_from_an_old_job_is_not_taken_for_the_runner(self):
        if not Path("/proc/self/cmdline").exists():
            self.skipTest("needs /proc, as on the board")
        jobs = self.home / ".neat-insight/genai-setup"
        jobs.mkdir(parents=True)
        (jobs / "runner.pid").write_text("{}\n".format(os.getpid()))
        (jobs / "steps").write_text("prepare start\n")
        (jobs / "step").write_text("prepare\n")
        self.assertFalse(self.status()["active"])
        genai_setup.stop(self.session)
        self.assertEqual(genai_setup.run(self.session)["active"], True)

    def test_a_board_without_core_is_told_how_to_install_it_before_anything_runs(self):
        for path in (self.home / "pyneat/bin/python",):
            path.unlink()
        status = self.status()
        self.assertEqual(self.states(status), ["pending", "blocked", "pending"])
        self.assertIn("sima-cli neat install apps", status["steps"][1]["problem"]["fixes"][0])
        with self.assertRaises(BoardError) as refused:
            genai_setup.run(self.session)
        self.assertEqual((refused.exception.code, refused.exception.extra["step"]), ("setup_blocked", "prepare"))
        self.assertFalse((self.home / "prebuilt-apps").exists(), "nothing was installed")

    def test_a_board_without_sima_cli_cannot_install_from_here(self):
        self.env["PATH"] = "/usr/bin:/bin"
        status = self.status()
        self.assertEqual(status["steps"][0]["state"], "blocked")
        self.assertIn("sima-cli", status["steps"][0]["problem"]["message"])

    def test_sima_cli_is_found_where_its_installer_puts_it_when_it_is_not_on_path(self):
        installed = self.home / ".sima-cli/.venv/bin/sima-cli"
        installed.parent.mkdir(parents=True)
        installed.write_text("#!/bin/sh\n")
        installed.chmod(0o755)
        self.env["PATH"] = "/usr/bin:/bin"
        self.assertEqual(self.status()["simaCli"], str(installed))
        # A DevKit's copy lives under /data, outside HOME.
        self.assertIn('"/data/sima-cli/.venv/bin/sima-cli"', genai_setup.status_command()[2])

    def test_warnings_show_under_a_finished_step_and_setup_can_run_again_after_the_fix(self):
        self.env["FAKE_SETUP_WARN"] = "1"
        genai_setup.run(self.session)
        status = self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])
        install, prepare, start = status["steps"]
        # The install job's own choices (no update check, dependencies skipped) are not warnings.
        self.assertEqual(install["warnings"], [])
        self.assertEqual([w["message"] for w in prepare["warnings"]], [
            "The board has no Python headers (python3-dev), so packages that build from source could not be installed.",
            "The Supertonic voices were skipped.",
        ])
        self.assertIn("sudo apt-get install python3-dev", prepare["warnings"][0]["fix"])
        # A warning logged again later, with another timestamp, is listed once, and Flask's
        # development-server notice is not a warning.
        self.assertEqual(start["warnings"], [{"message": "No server TTS voice installed for language: ja",
                                              "fix": "Replies in this language can't be read aloud."}])

        del self.env["FAKE_SETUP_WARN"]
        old_pid = (self.studio / ".neat-genai-studio.pid").read_text()
        status = genai_setup.run(self.session, redo="prepare")
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        status = self.wait_for(lambda s: self.states(s) == ["done", "done", "done"] and (self.studio / ".neat-genai-studio.pid").exists()
                               and (self.studio / ".neat-genai-studio.pid").read_text() != old_pid)
        self.assertEqual(status["steps"][1]["warnings"], [])

    def test_a_rerun_stopped_midway_is_not_reported_done_and_retry_runs_it_again(self):
        self.install_and_prepare()
        # The first run left setup.sh's files, so only the stopped run's exit code says it didn't finish.
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session, redo="prepare")
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        setup_pid = int((self.studio / "setup.waiting").read_text())
        status = genai_setup.stop(self.session)
        self.wait_until_ended(setup_pid)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        self.assertEqual(status["steps"][1]["problem"]["message"], "The step was stopped before it finished.")
        del self.env["FAKE_SETUP_WAIT"]
        (self.studio / "setup.waiting").unlink()
        # GenAI Studio running again before the Retry: Retry stops it, reruns prepare, starts it.
        studio = self.start_by_hand()
        self.assertEqual(self.states(), ["done", "failed", "done"])
        genai_setup.run(self.session)
        self.assertEqual(studio.wait(timeout=10), 143)
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_a_step_cut_off_without_an_exit_code_is_reported_and_retried(self):
        self.install_and_prepare()
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session, redo="prepare")
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        # As a board restart would: the runner and setup.sh die, and no exit code is written.
        jobs = self.home / ".neat-insight/genai-setup"
        for pid in (int((jobs / "runner.pid").read_text()), int((self.studio / "setup.waiting").read_text())):
            os.kill(pid, 9)
        status = self.wait_for(lambda s: not s["active"])
        self.assertFalse((jobs / "prepare.exit").exists())
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        self.assertIn("cut off before it finished", status["steps"][1]["problem"]["message"])
        del self.env["FAKE_SETUP_WAIT"]
        genai_setup.run(self.session)
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_a_studio_pid_left_by_a_reboot_is_not_taken_for_studio(self):
        if not Path("/proc/self/cmdline").exists():
            self.skipTest("needs /proc, as on the board")
        self.install_and_prepare()
        pid_file = self.studio / ".neat-genai-studio.pid"
        pid_file.write_text("{}\n".format(os.getpid()))   # reused by a process that isn't run.sh
        self.assertEqual(self.states(), ["done", "done", "pending"])
        genai_setup.stop_studio(self.session)
        self.assertEqual(self.states(), ["done", "done", "pending"])
        subprocess.run(genai_setup.stop_studio_command(), env=self.env, capture_output=True, timeout=20)
        self.assertFalse(pid_file.exists(), "the stale pid file is dropped before run.sh stop")

    def test_a_launch_from_another_insight_at_the_same_moment_is_refused(self):
        if not shutil.which("flock"):
            self.skipTest("needs flock, as on the board")
        jobs = self.home / ".neat-insight/genai-setup"
        jobs.mkdir(parents=True)
        with open(jobs / "launch.lock", "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.transport.exec(genai_setup.launch_command(["install"], "sima-cli"), timeout=20)
        self.assertEqual(result.exit_code, 75)
        self.assertFalse((jobs / "runner.pid").exists())

    def test_stop_waits_for_a_launch_in_progress(self):
        genai_setup._LAUNCH_LOCK.acquire()
        try:
            stopper = threading.Thread(target=genai_setup.stop, args=(self.session,))
            stopper.start()
            stopper.join(0.5)
            self.assertTrue(stopper.is_alive(), "Stop ran while a launch held the lock")
        finally:
            genai_setup._LAUNCH_LOCK.release()
        stopper.join(10)
        self.assertFalse(stopper.is_alive())

    def test_setup_is_not_run_again_while_a_step_is_running(self):
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session)
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        with self.assertRaises(BoardError) as refused:
            genai_setup.run(self.session, redo="prepare")
        self.assertEqual(refused.exception.code, "setup_running")
        with self.assertRaises(BoardError) as invalid:
            genai_setup.run(self.session, redo="install")
        self.assertEqual(invalid.exception.code, "invalid_request")

    def test_a_second_job_is_refused_by_the_board_too(self):
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session)
        result = self.transport.exec(genai_setup.launch_command(["prepare"], "sima-cli"), timeout=20)
        self.assertEqual(result.exit_code, 75)


class DescribeTests(unittest.TestCase):
    def describe(self, fields, records=None):
        base = {"sima_cli": "/usr/bin/sima-cli", "core": "yes", "installed": "no", "prepared": "no",
                "running": "no", "active": "no", "steps": "", "step": "", "now": "1000"}
        return genai_setup.describe({"fields": dict(base, **fields), "records": records or {}})

    def test_a_running_step_with_no_output_for_a_while_is_reported_as_possibly_stuck(self):
        record = {"exit": "", "mtime": str(1000 - 601), "log": "Building the document database"}
        fields = {"installed": "yes", "active": "yes", "steps": "prepare start", "step": "prepare"}
        prepare = self.describe(fields, {"prepare": record})["steps"][1]
        self.assertEqual(prepare["state"], "running")
        self.assertEqual(prepare["stall"]["message"], "No new output for 10 minutes.")
        self.assertIn("press Stop, then Retry", prepare["stall"]["fixes"][1])
        quiet = dict(record, mtime=str(1000 - 120))
        self.assertIsNone(self.describe(fields, {"prepare": quiet})["steps"][1]["stall"])

    def test_steps_a_job_runs_again_are_queued_even_when_done_before(self):
        fields = {"installed": "yes", "prepared": "yes", "active": "yes", "steps": "prepare start", "step": ""}
        self.assertEqual([s["state"] for s in self.describe(fields)["steps"]], ["done", "queued", "queued"])
        fields = dict(fields, step="prepare")
        self.assertEqual([s["state"] for s in self.describe(fields)["steps"]], ["done", "running", "queued"])
        fields = {"installed": "yes", "prepared": "yes", "active": "yes", "steps": "install prepare start", "step": "start"}
        self.assertEqual([s["state"] for s in self.describe(fields)["steps"]][:2], ["done", "done"])

    def test_studio_answering_finishes_the_start_step_while_its_job_still_runs(self):
        fields = {"installed": "yes", "prepared": "yes", "running": "yes", "active": "yes", "steps": "start",
                  "step": "start"}
        self.assertEqual([s["state"] for s in self.describe(fields)["steps"]], ["done", "done", "done"])
        loading = dict(fields, answering="no")
        self.assertEqual([s["state"] for s in self.describe(loading)["steps"]], ["done", "done", "running"])
        self.assertEqual(self.describe(dict(loading, active="no", steps="", step=""))["steps"][2]["state"], "running")

    def test_a_stopped_studio_waits_to_start_again_and_a_stopped_step_is_not_misdiagnosed(self):
        fields = {"installed": "yes", "prepared": "yes"}
        for code in ("143", "130", "stopped"):
            start = self.describe(fields, {"start": {"exit": code, "mtime": "", "log": "bye", "warnings": []}})["steps"][2]
            self.assertEqual((start["state"], start["problem"]), ("pending", None), code)
        crashed = self.describe(fields, {"start": {"exit": "1", "mtime": "", "log": "Traceback", "warnings": []}})
        self.assertEqual(crashed["steps"][2]["state"], "failed")
        stopped = genai_setup.diagnose("prepare", "requests.exceptions.ConnectionError: Connection refused", "143")
        self.assertEqual(stopped["message"], "The step was stopped before it finished.")

    def test_a_failed_step_is_failed_even_when_an_earlier_run_left_its_files(self):
        fields = {"installed": "yes", "prepared": "yes", "running": "yes"}
        records = {"install": {"exit": "1", "mtime": "", "log": "boom", "warnings": []},
                   "prepare": {"exit": "143", "mtime": "", "log": "Installing voices", "warnings": []},
                   "start": {"exit": "1", "mtime": "", "log": "Traceback", "warnings": []}}
        steps = self.describe(fields, records)["steps"]
        # A running GenAI Studio is what counts for the start step.
        self.assertEqual([s["state"] for s in steps], ["failed", "failed", "done"])
        self.assertEqual(steps[1]["problem"]["message"], "The step was stopped before it finished.")

    def test_an_ended_job_leaves_its_cut_off_step_failed_but_a_cut_off_studio_just_stopped(self):
        fields = {"installed": "yes", "prepared": "yes", "steps": "prepare start", "step": "prepare"}
        records = {"prepare": {"exit": "", "mtime": "", "log": "Installing voices", "warnings": []}}
        self.assertEqual([s["state"] for s in self.describe(fields, records)["steps"]], ["done", "failed", "pending"])
        fields = dict(fields, step="start")
        records = {"prepare": {"exit": "0", "mtime": "", "log": "", "warnings": []},
                   "start": {"exit": "", "mtime": "", "log": "Loaded Piper model", "warnings": []}}
        self.assertEqual([s["state"] for s in self.describe(fields, records)["steps"]], ["done", "done", "pending"])

    def test_the_install_command_offered_uses_the_sima_cli_the_board_has(self):
        fields = {"sima_cli": "/data/sima-cli/.venv/bin/sima-cli"}
        records = {"install": {"exit": "1", "mtime": "", "log": "boom", "warnings": []}}
        command = self.describe(fields, records)["steps"][0]["problem"]["command"]
        self.assertEqual(command, "cd ~ && NEAT_APPS_SKIP_DEPENDENCIES=1 /data/sima-cli/.venv/bin/sima-cli neat install apps "
                                  "&& echo 0 > ~/.neat-insight/genai-setup/install.exit")

    def test_known_causes_are_named_and_unknown_ones_point_at_the_log(self):
        cases = {
            "OSError: [Errno 28] No space left on device": "The board ran out of disk space.",
            "requests.exceptions.SSLError: EOF occurred": "The board could not download what this step needs.",
            "huggingface_hub.utils._errors.HfHubHTTPError: 429 Client Error": "The board could not download what this step needs.",
            "pyneat is not importable from /home/sima/pyneat/bin/python.": "The Neat Library (Core) is not installed on the board.",
            "curl: (22) The requested URL returned error: 403 latest.tag": "The board could not download what this step needs.",
            "Failed to fetch latest.tag: HTTP 403": "The Neat Apps package could not be downloaded.",
        }
        for log, message in cases.items():
            with self.subTest(log=log):
                self.assertEqual(genai_setup.diagnose("prepare", log, "1")["message"], message)
        unknown = genai_setup.diagnose("start", "Traceback: KeyError 'web'", "2")
        self.assertEqual(unknown["message"], "Start GenAI Studio stopped with exit code 2.")
        self.assertIn("./run.sh", unknown["command"])

    def test_logs_read_like_a_terminal(self):
        text = "\x1b[32mok\x1b[0m\nDownloading  10%\rDownloading  55%\rDownloading 100%\r\n\n" + "\n".join(
            "line {}".format(i) for i in range(50))
        log = genai_setup.clean_log(text)
        self.assertNotIn("\x1b", log)
        self.assertEqual(log.splitlines()[0], "line 20")
        self.assertEqual(len(log.splitlines()), genai_setup.LOG_LINES)
        self.assertIn("Downloading 100%", genai_setup.clean_log(text.split("\nline 0")[0]))
        self.assertNotIn("55%", genai_setup.clean_log(text.split("\nline 0")[0]))

    def test_the_status_output_is_parsed_with_each_steps_record(self):
        text = ("sima_cli=/usr/bin/sima-cli\ncore=yes\nactive=no\n@@install\nexit=0\nmtime=900\n@log\nInstalled\n"
                "@@prepare\nexit=1\nmtime=\n\x1b[33m⚠ Could not verify whisper (accelerator busy or no runtime)\x1b[0m\n"
                "root - WARNING - something odd\n@log\nboom\n")
        parsed = genai_setup.parse_status(text)
        self.assertEqual(parsed["fields"]["sima_cli"], "/usr/bin/sima-cli")
        self.assertEqual(parsed["records"]["install"], {"exit": "0", "mtime": "900", "warnings": [], "log": "Installed"})
        self.assertEqual(parsed["records"]["prepare"]["log"], "boom")
        warnings = parsed["records"]["prepare"]["warnings"]
        self.assertEqual(warnings[0]["message"], "Could not verify whisper (accelerator busy or no runtime)")
        self.assertIn("Another application was using the accelerator", warnings[0]["fix"])
        self.assertEqual(warnings[1], {"message": "something odd", "fix": None})


class FakeManager:
    def __init__(self, session=None, error=None):
        self.current, self.error = session, error

    def session(self):
        if self.error:
            raise self.error
        return self.current


class ApiTests(unittest.TestCase):
    def setUp(self):
        app = Flask(__name__)
        app.register_blueprint(board_bp)
        app.register_blueprint(genai_setup.genai_setup_bp)
        self.manager = FakeManager()
        app.extensions["neat_board"] = self.manager
        self.client = app.test_client()

    def answer(self, *outputs):
        replies = list(outputs)

        class Transport:
            commands = []

            def exec(self, argv, *, timeout, stdin=None):
                self.commands.append(argv)
                return replies.pop(0)

        self.manager.current = session_for(Transport(), generation=4)
        return self.manager.current.transport

    @staticmethod
    def status(**fields):
        base = {"sima_cli": "/usr/bin/sima-cli", "core": "yes", "installed": "no", "prepared": "no",
                "running": "no", "active": "no", "steps": "", "step": "", "now": "1000"}
        base.update(fields)
        return ExecResult(0, "\n".join("{}={}".format(k, v) for k, v in base.items()).encode(), b"")

    def test_status_names_the_board_and_each_step(self):
        self.answer(self.status(installed="yes"))
        body = self.client.get("/api/genai-setup").get_json()
        self.assertEqual(body["board"]["label"], "sima@192.168.2.2")
        self.assertEqual(body["generation"], 4)
        self.assertEqual([s["id"] for s in body["steps"]], ["install", "prepare", "start"])
        self.assertEqual([s["state"] for s in body["steps"]], ["done", "pending", "pending"])
        self.assertEqual(body["steps"][1]["title"], "Prepare GenAI Studio")

    def test_run_launches_only_the_steps_left(self):
        transport = self.answer(self.status(installed="yes"), ExecResult(0, b"", b""),
                                self.status(installed="yes", active="yes", steps="prepare start", step="prepare"))
        body = self.client.post("/api/genai-setup/run").get_json()
        self.assertEqual(transport.commands[1][4:], ["prepare start", "/usr/bin/sima-cli"])
        self.assertEqual([s["state"] for s in body["steps"]], ["done", "running", "queued"])

    def test_run_refusals_say_what_to_do(self):
        self.answer(self.status(active="yes", steps="prepare", step="prepare"))
        response = self.client.post("/api/genai-setup/run")
        self.assertEqual((response.status_code, response.get_json()["code"]), (409, "setup_running"))
        self.answer(self.status(core="no"))
        body = self.client.post("/api/genai-setup/run").get_json()
        self.assertEqual((body["code"], body["step"]), ("setup_blocked", "prepare"))
        self.assertIn("sima-cli neat install apps", body["hint"])
        self.answer(self.status(installed="yes", prepared="yes", running="yes"))
        self.assertEqual(self.client.post("/api/genai-setup/run").get_json()["code"], "setup_done")
        self.answer(self.status(), ExecResult(1, b"", b"mkdir: Permission denied"))
        body = self.client.post("/api/genai-setup/run").get_json()
        self.assertEqual(body["code"], "command_failed")
        self.assertIn("Permission denied", body["detail"])

    def test_run_again_takes_only_the_prepare_step(self):
        self.answer(self.status(installed="yes"))
        body = self.client.post("/api/genai-setup/run", json={"redo": "start"}).get_json()
        self.assertEqual(body["code"], "invalid_request")

    def test_stop_studio_runs_run_sh_stop_and_reports_the_start_step_waiting(self):
        up = self.status(installed="yes", prepared="yes", running="yes")
        down = ExecResult(0, up.stdout.replace(b"running=yes", b"running=no") + b"\n@@start\nexit=stopped\nmtime=\n@log\n", b"")
        transport = self.answer(up, ExecResult(0, b"", b""), down)
        body = self.client.post("/api/genai-setup/stop-studio").get_json()
        self.assertIn("./run.sh stop", transport.commands[1][2])
        self.assertEqual([s["state"] for s in body["steps"]], ["done", "done", "pending"])
        self.assertEqual(body["generation"], 4)
        self.answer(self.status(installed="yes", active="yes", steps="prepare start", step="prepare"))
        self.assertEqual(self.client.post("/api/genai-setup/stop-studio").get_json()["code"], "setup_running")

    def test_an_action_for_a_board_that_is_no_longer_selected_is_refused(self):
        transport = self.answer(self.status(installed="yes"), ExecResult(0, b"", b""),
                                self.status(installed="yes", active="yes", steps="prepare start", step="prepare"))
        for path in ("/api/genai-setup/run", "/api/genai-setup/stop", "/api/genai-setup/stop-studio"):
            response = self.client.post(path + "?generation=3")
            body = response.get_json()
            self.assertEqual((response.status_code, body["code"], body["current_generation"]), (409, "stale_snapshot", 4), path)
        self.assertEqual(transport.commands, [], "nothing ran on the board")
        self.assertEqual(self.client.post("/api/genai-setup/run?generation=x").get_json()["code"], "invalid_request")
        self.assertEqual(self.client.post("/api/genai-setup/run?generation=4").status_code, 200)

    def test_without_a_board_the_tab_is_told_how_to_choose_one(self):
        self.manager.error = BoardError("no_target", "No board is selected.", hint="Enter the board's address.")
        response = self.client.get("/api/genai-setup")
        self.assertEqual((response.status_code, response.get_json()["hint"]), (409, "Enter the board's address."))


if __name__ == "__main__":
    unittest.main()
