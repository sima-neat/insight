# Copyright (c) 2025 SiMa.ai
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import subprocess
import threading
import queue
import time
import os
import logging
import signal

class ProcessManager(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.command_queue = queue.Queue()
        self.current_process = None
        self.lock = threading.Lock()
        self.log_buffer = []
        self.max_log_lines = 500
        self.state = "idle"
        self.last_exit_code = None

    def run(self):
        while True:
            try:
                command, env, _ = self.command_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            with self.lock:
                self.stop_pipeline()
                self.log_buffer = []

                if command != "STOP":
                    logging.info(f"🚀 Executing pipeline command: {command}")

                    self.current_process = subprocess.Popen(
                        command,
                        shell=True,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        env=env,
                        text=True,
                        preexec_fn=os.setsid
                    )

                    # Start a background thread to handle output
                    threading.Thread(
                        target=self._read_stdout,
                        args=(self.current_process,),
                        daemon=True
                    ).start()
                else:
                    self.state = "idle"

    def _monitor_exit(self, process):
        code = process.wait()
        logging.info(f"[PIPELINE] Process exited with code {code}")
        self.last_exit_code = code
        self.state = "exited"

    def get_status(self):
        return {
            "exit_code": self.last_exit_code,
            "is_running": self.current_process and self.current_process.poll() is None
        }

    def _read_stdout(self, process):
        for line in process.stdout:
            logging.info(f"[PIPELINE] {line.strip()}")
            self.log_buffer.append(line)
            if len(self.log_buffer) > self.max_log_lines:
                self.log_buffer.pop(0)

    def submit_command(self, command, env):
        self.command_queue.put((command, env, None))

    def stop_pipeline(self):
        if self.current_process and self.current_process.poll() is None:
            try:
                pgid = os.getpgid(self.current_process.pid)
                logging.warning(f"Killing process group with PGID: {pgid} (SIGTERM)")
                os.killpg(pgid, signal.SIGTERM)

                self.current_process.wait(timeout=5)
                logging.info("Pipeline terminated with SIGTERM.")
            except subprocess.TimeoutExpired:
                logging.warning("SIGTERM timed out — escalating to SIGKILL.")
                try:
                    os.killpg(pgid, signal.SIGKILL)
                    time.sleep(1)
                    logging.info("Pipeline force-killed with SIGKILL.")
                except Exception as kill_error:
                    logging.error(f"SIGKILL failed: {kill_error}")
            except Exception as e:
                logging.error(f"Failed to terminate pipeline: {e}")

    def stream_logs(self):
        for line in self.log_buffer:
            yield line