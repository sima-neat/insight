"""The ``neat-insight`` command: runs the Insight server binary packaged next to this file.

The binary takes the same arguments (``--port``). It is exec'd, so the supervisor that started
``neat-insight`` (the SDK's) signals the server directly.
"""

import os
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent / "bin" / "neat-insight"


def main():
    if not SERVER.is_file():
        sys.exit(f"neat-insight: the server binary {SERVER} is missing; build it with ./build.sh")
    os.execv(SERVER, [str(SERVER), *sys.argv[1:]])


if __name__ == "__main__":
    main()
