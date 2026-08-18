# neat-insight

[![Vulcan CI](https://github.com/sima-neat/insight/actions/workflows/vulcan-ci.yml/badge.svg)](https://github.com/sima-neat/insight/actions/workflows/vulcan-ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

`neat-insight` is a web app for inspecting NEAT apps and helping to setup test for vision ML apps.

It provides:
- Multi-channel WebRTC video viewer with MetadataReceiver support
- Codec-aware media source control with RTSP and HTTP MJPEG streaming
- System and application metrics dashboard

User documentation for the software docs site is maintained in
[`docs/index.md`](docs/index.md).

## Install

### Option 1: Install from PyPI (official release)

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install neat-insight
```

### Option 2: Install from Neat artifacts

```bash
sima-cli neat install insight@main
```

This installs the platform-compatible `neat-insight` wheel into an isolated virtual environment.

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
2. Open Streaming to assign/start/stop input sources.
3. Open Stats to see the planned location for system load and runtime metrics. This view is a placeholder in the current release and is expected to be completed in the next release.

## Viewer settings

Open the global viewer menu or a channel tile menu to configure overlays. Global
settings apply to all channels; channel settings override the global values for
that channel.

Available metadata settings:
- Object Detection: confidence threshold and per-label box style.
- Segmentation: confidence threshold, mask opacity, and per-label mask color and outline style.
- Tracking: confidence threshold, track history visibility, trail length, and how
  long lost-track trails remain visible.
- Other metadata types are rendered with defaults until type-specific settings
  are added.

ROI settings are split into filtering and display:
- Apply ROI Filtering controls whether ROI polygons filter box-like metadata.
- Show ROI Overlay controls only whether ROI polygons are drawn over the video.

General settings include Overlay Delay, which delays metadata selection so boxes
and tracks can be aligned with the displayed WebRTC frame.

## Build from source

Use this when you need to modify functionality.

Prerequisites:
- Python 3.10+
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
- Supported metadata types are `object-detection`, `classification`, `pose-estimation`, `segmentation`, and `tracking`.
- `neat_insight/tools/metadata-test.py` remains as a compatibility wrapper, but the packaged CLI is the preferred entry point.
