# neat-insight

[![CI/CD](https://github.com/sima-neat/insight/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/sima-neat/insight/actions/workflows/build-wheels.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

`neat-insight` is a web app for inspecting NEAT apps and helping to setup test for vision ML apps.

It provides:
- Multi-channel WebRTC video viewer
- RTSP source control and preview
- System and application metrics dashboard

## Install

### Option 1: Install from PyPI (official release)

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install neat-insight
```

### Option 2: Install using the hosted build installer

Linux/macOS:
```bash
curl -fsSL https://apps.sima-neat.com/tools/install-neat-insight.py -o /tmp/install-neat-insight.py
python3 /tmp/install-neat-insight.py
```

Optional:
- `python3 /tmp/install-neat-insight.py <branch> latest`
- `python3 /tmp/install-neat-insight.py <branch> <git-short-hash>`

Windows (PowerShell):
```powershell
Invoke-WebRequest https://apps.sima-neat.com/tools/install-neat-insight.py -OutFile $env:TEMP\install-neat-insight.py
py $env:TEMP\install-neat-insight.py
```

## Run

```bash
source .venv/bin/activate
neat-insight --port 9900
```

Then open:
- `https://127.0.0.1:9900`

Notes:
- The app serves over HTTPS and generates a local self-signed certificate.
- Browser trust warnings on first launch are expected for local development.

## Basic usage

1. Open the Viewer tab to monitor active channels.
2. Open RTSP Control to assign/start/stop input sources.
3. Open Stats to watch system load and runtime metrics.

## Build from source

Use this when you need to modify functionality.

Prerequisites:
- Python 3.8+
- Node.js 20+ and npm
- Go 1.24+

Build and install into your current virtualenv:

```bash
python3 -m venv .venv
source .venv/bin/activate
./build.sh --install
```

Run:

```bash
neat-insight --port 9900
```

Useful build options:
- `--target-platform <host|all|linux-aarch64|linux-amd64|macos-arm64|windows-amd64>`
- `--skip-frontend`
