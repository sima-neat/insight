"""The ``neat-insight`` command: runs the Insight server binary packaged next to this file.

The binary takes the same arguments (``--port``). It is exec'd, so the supervisor that started
``neat-insight`` (the SDK's) signals the server directly. ``NEAT_INSIGHT_PYTHON`` names this
interpreter, with which the server runs the old backend until the rewrite has replaced it.
"""

import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent / "bin" / "neat-insight"


def main():
    if not SERVER.is_file():
        sys.exit(f"neat-insight: the server binary {SERVER} is missing; build it with ./build.sh")
    env = dict(os.environ, NEAT_INSIGHT_PYTHON=sys.executable)
    os.execve(SERVER, [str(SERVER), *sys.argv[1:]], env)


if __name__ == "__main__":
    main()
