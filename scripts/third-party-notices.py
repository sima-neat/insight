#!/usr/bin/env python3
"""Write THIRD_PARTY_NOTICES: the licenses of the Go modules linked into the Insight server.

Usage: scripts/third-party-notices.py [--check]

The modules are what `go list -deps` finds for the server's command on each platform the wheel is
built for (test-only and tool modules are not linked, so they are not listed), and each one's
license files are read from the Go module cache, with the Go standard library's from GOROOT. Run
it after a change to server/go.mod; CI runs it with --check, which fails while the file is stale.
Needs Go on PATH and the modules downloaded (any build or `go mod download` in server/).
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server"
OUTPUT = REPO / "THIRD_PARTY_NOTICES"
# The platforms build.sh builds the server for.
PLATFORMS = [("linux", "arm64"), ("linux", "amd64"), ("darwin", "arm64")]
# What a module calls its license files, at its root, and the REUSE folder of them.
LICENSE_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "PATENTS")
LICENSE_FOLDER = "LICENSES"

HEADER = """\
Third-party software in neat-insight

The server (neat_insight/bin/neat-insight) is built with Go and the Go modules below; each one's
license follows. MediaMTX (neat_insight/bin/mediamtx) is MIT licensed: its license is
neat_insight/bin/mediamtx.LICENSE. Its binary links Go modules of its own (gortsplib,
mediacommon, pion and others, which `go version -m neat_insight/bin/mediamtx` lists); MediaMTX's
release ships its LICENSE only, with no notices of those modules. The licenses of the web UI's
packages are built into the server, which serves them at /3rdpartylicenses.txt.

Written by scripts/third-party-notices.py from server/go.mod; do not edit.
"""


def go(*args, env=None):
    return subprocess.run(["go", *args], cwd=SERVER, env=env, check=True, capture_output=True, text=True).stdout


def linked_modules():
    """The modules linked into the server on any platform: {path: (version, dir)}."""
    modules = {}
    for goos, goarch in PLATFORMS:
        env = {**os.environ, "GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0"}
        out = go("list", "-deps", "-json=Module", "./cmd/neat-insight", env=env)
        for package in _objects(out):
            module = package.get("Module")
            if not module or module.get("Main"):
                continue
            module = module.get("Replace") or module
            if not module.get("Dir"):
                sys.exit(f"{module['Path']} is not downloaded: run `go mod download` in server/")
            modules[module["Path"]] = (module["Version"], Path(module["Dir"]))
    return modules


def _objects(text):
    """The JSON objects go list writes one after another."""
    decoder, index = json.JSONDecoder(), 0
    while True:
        while index < len(text) and text[index].isspace():
            index += 1
        if index == len(text):
            return
        value, index = decoder.raw_decode(text, index)
        yield value


def license_files(root):
    found = sorted(p for p in root.iterdir() if p.is_file() and p.name.upper().startswith(LICENSE_PREFIXES))
    folder = root / LICENSE_FOLDER
    if folder.is_dir():
        found += sorted(p for p in folder.iterdir() if p.is_file())
    return found


def section(title, root, files):
    rule = "-" * 80
    parts = [rule, title, rule]
    for path in files:
        parts += [f"--- {path.relative_to(root)} ---", path.read_text(encoding="utf-8").strip(), ""]
    return "\n".join(parts) + "\n"


def notices():
    goroot = Path(go("env", "GOROOT").strip())
    sections = [section("Go (the standard library and runtime)", goroot, license_files(goroot))]
    for path, (version, root) in sorted(linked_modules().items()):
        files = license_files(root)
        if not files:
            sys.exit(f"{path} {version} has no license file in {root}")
        sections.append(section(f"{path} {version}", root, files))
    return HEADER + "\n" + "\n".join(sections)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when THIRD_PARTY_NOTICES is stale")
    args = parser.parse_args()
    text = notices()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != text:
            sys.exit("THIRD_PARTY_NOTICES is stale: run scripts/third-party-notices.py")
        return
    OUTPUT.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
