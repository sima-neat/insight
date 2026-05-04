# neat-insight

[![CI/CD](https://github.com/sima-neat/insight/actions/workflows/build-wheels.yml/badge.svg)](https://github.com/sima-neat/insight/actions/workflows/build-wheels.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

`neat-insight` is a web app for inspecting NEAT apps and helping to setup test for vision ML apps.

It provides:
- Multi-channel WebRTC video viewer with MetadataReceiver support
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
curl -fsSL https://apps.sima-neat.com/tools/install-neat-insight.py -o /tmp/install-neat-insight.py && python3 /tmp/install-neat-insight.py
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

`neat-insight` uses `mkcert` to create a locally trusted HTTPS certificate at startup. If `mkcert` is missing, startup attempts to install it with a supported package manager: Homebrew on macOS, common Linux package managers, winget/Chocolatey/Scoop on Windows, or `go install` as a fallback.

```bash
source .venv/bin/activate
neat-insight --port 9900
```

Then open:
- `https://${NFS_SERVER_HOST_IP}:9900` when `NFS_SERVER_HOST_IP` is set
- `https://127.0.0.1:9900` otherwise

Notes:
- When `/sdk-cert/neat-sdk.pem` exists, the app validates and uses that SDK-provided certificate before attempting mkcert generation. The private key may be embedded in that PEM or provided as `/sdk-cert/neat-sdk-key.pem`, `/sdk-cert/neat-sdk.key`, or `/sdk-cert/key.pem`.
- The app runs `mkcert -install` and regenerates `cert.pem`/`key.pem` under the neat-insight data directory on startup.
- Certificates include the configured host IP, `127.0.0.1`, and `localhost`.
- If automatic mkcert installation is unavailable, install mkcert manually and restart `neat-insight`.

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
- mkcert, or a supported package manager for automatic runtime installation

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

## Testing metadata

`neat-insight` now ships a metadata test sender for vf metadata ports (`9100-9179`).

Examples:

```bash
neat-insight-metadata-test --count 1 --types object-detection
neat-insight-metadata-test --count 4 --types object-detection,classification,pose-estimation
neat_insight/tools/multisrc-harness.sh start --count 16
```

Notes:
- Default destination is `127.0.0.1`, starting at UDP port `9100`.
- Supported metadata types are `object-detection`, `classification`, `pose-estimation`, and `segmentation`.
- `neat_insight/tools/metadata-test.py` remains as a compatibility wrapper, but the packaged CLI is the preferred entry point.
