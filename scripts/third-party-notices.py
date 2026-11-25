#!/usr/bin/env python3
"""Write THIRD_PARTY_NOTICES: the licenses of the Go modules linked into the Insight server and into
the MediaMTX binary the wheel ships.

Usage: scripts/third-party-notices.py [--check]

The server's modules are what `go list -deps` finds for its command on each platform the wheel is
built for (test-only and tool modules are not linked, so they are not listed). MediaMTX's are the
same for its main package, inside its module at the MTX_VERSION build.sh pins, which `go mod
download` fetches through the Go module proxy (so the result is the same on every machine). Each
module's license files are read from the Go module cache, with the Go standard library's from
GOROOT. Run it after a change to server/go.mod or to MTX_VERSION; CI runs it with --check, which
fails while the file is stale. Needs Go on PATH, network access to the module proxy unless the
modules are cached, and the server's modules downloaded (any build or `go mod download` in server/).
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server"
BUILD_SH = REPO / "build.sh"
MEDIAMTX_MODULE = "github.com/bluenviron/mediamtx"
OUTPUT = REPO / "THIRD_PARTY_NOTICES"
# The platforms build.sh builds the server for.
PLATFORMS = [("linux", "arm64"), ("linux", "amd64"), ("darwin", "arm64")]
# What a module calls its license files, at its root, and the REUSE folder of them.
LICENSE_PREFIXES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "PATENTS")
LICENSE_FOLDER = "LICENSES"
# A module that ships no license file, and the module whose license its own source files cite:
# benburkert/openpgp is a fork of golang.org/x/crypto/openpgp, and each file says "Copyright The
# Go Authors ... BSD-style license that can be found in the LICENSE file".
LICENSE_FROM = {"github.com/benburkert/openpgp": "golang.org/x/crypto"}

HEADER = """\
Third-party software in neat-insight

The server (neat_insight/bin/neat-insight) is built with Go and the Go modules of the first part
below, and MediaMTX (neat_insight/bin/mediamtx, version {mtx_version}) with the Go modules of
the second; each module's license follows. MediaMTX's own license, which covers its module
({mediamtx}), is neat_insight/bin/mediamtx.LICENSE, so that module is not
repeated here. Each part is complete by itself: a module both link (pion, golang.org/x/crypto
and others) appears in both, in the version each links. The Go standard library appears in
both parts too. The licenses of the web UI's packages are built into the server, which serves
them at /3rdpartylicenses.txt.

Written by scripts/third-party-notices.py from server/go.mod and MTX_VERSION in build.sh; do not
edit.
"""


def go(*args, cwd=SERVER, env=None):
    return subprocess.run(["go", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


def linked_modules(workdir, package):
    """The modules linked into `package` (as `go list` in workdir names it) on any platform:
    {path: (version, dir)}."""
    modules = {}
    for goos, goarch in PLATFORMS:
        env = {**os.environ, "GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0", "GOWORK": "off"}
        out = go("list", "-deps", "-json=Module", package, cwd=workdir, env=env)
        for pkg in _objects(out):
            module = pkg.get("Module")
            if not module or module.get("Main"):
                continue
            module = module.get("Replace") or module
            if not module.get("Dir"):
                sys.exit(f"{module['Path']} is not downloaded: run `go mod download` in {workdir}")
            modules[module["Path"]] = (module["Version"], Path(module["Dir"]))
    return modules


def mediamtx_version():
    """MTX_VERSION from build.sh, the one place that pins it."""
    found = re.search(r'^MTX_VERSION="([^"]+)"$', BUILD_SH.read_text(encoding="utf-8"), re.MULTILINE)
    if not found:
        sys.exit(f"no MTX_VERSION in {BUILD_SH}")
    return found.group(1)


def mediamtx_modules(version):
    """The modules linked into MediaMTX's main package at `version`: the module itself comes from
    the module proxy, and so does everything it needs."""
    info = json.loads(go("mod", "download", "-json", f"{MEDIAMTX_MODULE}@v{version}"))
    root = Path(info["Dir"])
    go("mod", "download", cwd=root)
    return linked_modules(root, ".")


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


def module_sections(modules):
    sections = []
    for path, (version, root) in sorted(modules.items()):
        files = license_files(root)
        if files:
            sections.append(section(f"{path} {version}", root, files))
            continue
        source = LICENSE_FROM.get(path)
        if source not in modules:
            sys.exit(f"{path} {version} has no license file in {root}")
        source_version, source_root = modules[source]
        note = f"{path} {version} (no license file of its own; its source files cite the license of {source})"
        sections.append(section(note, source_root, license_files(source_root)))
    return sections


def part(title):
    rule = "=" * 80
    return f"{rule}\n{title}\n{rule}\n"


def notices():
    goroot = Path(go("env", "GOROOT").strip())
    stdlib = section("Go (the standard library and runtime)", goroot, license_files(goroot))
    version = mediamtx_version()
    parts = [
        HEADER.format(mtx_version=version, mediamtx=MEDIAMTX_MODULE),
        part("Part 1: the Insight server"),
        stdlib,
        *module_sections(linked_modules(SERVER, "./cmd/neat-insight")),
        part(f"Part 2: MediaMTX {version}"),
        stdlib,
        *module_sections(mediamtx_modules(version)),
    ]
    return "\n".join(parts)


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
