import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

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
if [ -n "${FAKE_SETUP_WAIT:-}" ]; then touch "$dir/setup.waiting"; while :; do sleep 0.1; done; fi
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
echo $$ > "$pidf"
trap 'rm -f "$pidf"; exit 0' TERM INT
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

    def add_core(self):
        python = self.home / "pyneat/bin/python"
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("#!/bin/sh\n")
        python.chmod(0o755)

    def status(self):
        return genai_setup.read_status(self.session)

    def states(self, status=None):
        return [step["state"] for step in (status or self.status())["steps"]]

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
        with self.assertRaises(BoardError) as refused:
            genai_setup.run(self.session)
        self.assertEqual(refused.exception.code, "setup_running")

    def test_studio_keeps_running_after_the_command_that_started_it_returns(self):
        genai_setup.run(self.session)
        self.wait_for(lambda s: s["steps"][2]["state"] == "done")
        time.sleep(0.5)
        self.assertEqual(self.states(), ["done", "done", "done"])
        status = genai_setup.stop(self.session)
        self.assertFalse(status["active"])
        self.wait_for(lambda s: s["steps"][2]["state"] != "done")

    def test_a_failed_step_says_why_and_a_retry_runs_only_what_is_left(self):
        self.env["FAKE_SETUP_FAIL"] = "OSError: Could not resolve host: huggingface.co"
        genai_setup.run(self.session)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        problem = status["steps"][1]["problem"]
        self.assertEqual(problem["message"], "The board could not download what this step needs.")
        self.assertTrue(any("huggingface.co" in fix for fix in problem["fixes"]))
        self.assertIn("~/.neat-insight/genai-setup/prepare.log", problem["fixes"][-1])
        self.assertEqual(problem["command"], genai_setup.MANUAL_COMMANDS["prepare"])
        self.assertIn("Could not resolve host", status["steps"][1]["log"])

        del self.env["FAKE_SETUP_FAIL"]
        genai_setup.run(self.session)
        self.assertEqual(self.transport.commands[-2][4], "prepare start")
        self.wait_for(lambda s: self.states(s) == ["done", "done", "done"])

    def test_stop_ends_a_step_and_marks_it_stopped(self):
        self.env["FAKE_SETUP_WAIT"] = "1"
        genai_setup.run(self.session)
        self.wait_for(lambda s: (self.studio / "setup.waiting").exists())
        self.assertEqual(self.states(), ["done", "running", "queued"])
        status = genai_setup.stop(self.session)
        status = self.wait_for(lambda s: not s["active"])
        self.assertEqual(self.states(status), ["done", "failed", "pending"])
        self.assertEqual(status["steps"][1]["problem"]["message"], "The step was stopped before it finished.")

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

    def test_studio_answering_finishes_the_start_step_while_its_job_still_runs(self):
        fields = {"installed": "yes", "prepared": "yes", "running": "yes", "active": "yes", "steps": "start",
                  "step": "start"}
        self.assertEqual([s["state"] for s in self.describe(fields)["steps"]], ["done", "done", "done"])

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
        text = "sima_cli=/usr/bin/sima-cli\ncore=yes\nactive=no\n@@install\nexit=0\nmtime=900\nInstalled\n@@prepare\nexit=1\nmtime=\nboom\n"
        parsed = genai_setup.parse_status(text)
        self.assertEqual(parsed["fields"]["sima_cli"], "/usr/bin/sima-cli")
        self.assertEqual(parsed["records"]["install"], {"exit": "0", "mtime": "900", "log": "Installed"})
        self.assertEqual(parsed["records"]["prepare"]["log"], "boom")


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

    def test_without_a_board_the_tab_is_told_how_to_choose_one(self):
        self.manager.error = BoardError("no_target", "No board is selected.", hint="Enter the board's address.")
        response = self.client.get("/api/genai-setup")
        self.assertEqual((response.status_code, response.get_json()["hint"]), (409, "Enter the board's address."))


if __name__ == "__main__":
    unittest.main()
