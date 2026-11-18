# neat-insight (insight-next prototype)

> **Prototype.** `insight-next` is a copy of [`sima-neat/insight`](https://github.com/sima-neat/insight)
> used to rebuild the Insight frontend in Angular on a new UI kit. It started from upstream commit `829ec7c`
> with fresh history (see [`UPSTREAM.md`](UPSTREAM.md)), and the React frontend and the org-level release
> workflows were removed. On this branch the backend is being rewritten from scratch as one Go server
> (`server/`), which runs the old Python backend behind it until it has replaced it; what apps rely
> on is in [`docs/contracts.md`](docs/contracts.md).
> The rest of this README describes upstream Insight, and `docs/` still describes the upstream UI until the
> Angular frontend reaches parity.

**Documentation:** [English](docs/index.md) | [한국어](docs/i18n/ko/index.md) | [日本語](docs/i18n/ja/index.md) | [繁體中文](docs/i18n/zh-Hant/index.md) | [Українська](docs/i18n/uk/index.md)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

`neat-insight` is a web app for inspecting NEAT apps and helping to setup test for vision ML apps.

It provides:
- Multi-channel WebRTC video viewer with MetadataReceiver support
- Frame-correlated auxiliary visualization panels, including BlazePose 3D
- Codec-aware media source control with RTSP and HTTP MJPEG streaming
- System and application metrics dashboard

User documentation for the software docs site is maintained in
[`docs/index.md`](docs/index.md).

## Install

> **For this prototype:** both options below install upstream Insight, not `insight-next`. To run the
> prototype, build it from source (see [Build from source](#build-from-source) and
> [Work on the frontend](#work-on-the-frontend)); its frontend uses the
> [`neat-ui`](https://github.com/justin-guth-sima/neat-ui) kit, vendored as a release tarball in
> `frontend/vendor/`.

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
2. Open Streaming to assign/start/stop input sources. To publish a webcam attached to your browser's computer as a live source, enable a camera under Media Sources → Local cameras and select it in a source slot.
3. Open Stats to inspect live and recorded Sentinel telemetry from the selected board.

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

Frame-correlated data that should not cover the video can use an auxiliary
visualization panel. See [`docs/auxiliary-visualizations.md`](docs/auxiliary-visualizations.md)
for the generic contract and built-in BlazePose 3D renderer. Viewer Configuration
controls the panel per channel, and the 3D skeleton stays frame-aligned with the
2D pose overlay.

## Build from source

Use this when you need to modify functionality.

Prerequisites:
- Python 3.10+
- Node.js 24 and npm for the frontend (`.node-version`)
- Go, the version `server/go.mod` names, for the server
- A C compiler for each Linux target: `gcc` for the host, plus
  `gcc-aarch64-linux-gnu` or `gcc-x86-64-linux-gnu` to cross-build the other
  Linux wheel. Linux wheels bundle a small `LD_PRELOAD` shim
  (`tools/ffmpeg_nodelay.c`) that keeps the RTSP publishers' TCP sockets
  free of Nagle delay; `NEAT_INSIGHT_FFMPEG_PRELOAD` overrides its path at
  runtime.
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
- `--target-platform <host|all|linux-aarch64|linux-amd64|macos-arm64>` (no Windows: the server
  needs Unix process groups)
- `--skip-frontend`
- `--skip-shim` (Linux wheels then run ffmpeg with Nagle enabled)

### Work on the frontend

The frontend is an Angular app in `frontend/` built on the vendored `@sima/neat-ui` kit (see
[`AGENTS.md`](AGENTS.md)). It needs Node.js 24; `fnm use` picks it up from `.node-version`. Run these
in `frontend/`:

```bash
npm ci                        # install, once and after dependency changes
npm start                     # dev server on http://localhost:4200
npm test -- --watch=false     # unit tests
npm run lint                  # ESLint and Stylelint
npm run build                 # production build into frontend/dist
npm run e2e                   # end-to-end tests
```

The dev server serves the app alone, without the backend; the e2e tests mock what they need. To
see the build the way users do, build the server with the frontend in it (`./build.sh`, or
`scripts/build-server.sh linux amd64 neat_insight/bin/neat-insight` after `npm run build`) and
start `neat-insight` from a source-tree install. The server serves the app and falls back to
`index.html` for client-side routes such as `/viewer`.

### Work on the server

The server is a Go module in `server/` (see [`AGENTS.md`](AGENTS.md)). Run these in `server/`:

```bash
go test -race ./...           # tests
go vet ./...                  # static checks
go generate ./...             # after a change to api/openapi.yaml, the API's source
```

`npm run e2e` starts the dev server itself. The first run needs Chromium with its system libraries:
`npx playwright install --with-deps chromium`. To test a build that is already running, for example
one deployed into the SDK container, point the tests at it. They then record no screenshots, videos
or traces, and delete the test output directory (including Playwright's failure context, which holds
a snapshot of the page) when the run ends. A failed assertion still prints its message and call log
in the terminal.

```bash
INSIGHT_BASE_URL=https://127.0.0.1:9900 npm run e2e
```

The Viewer's playback tests run only against a deployed build, and need the test feed below running
on channel 0. One of them stops the feed and starts it again, detached; afterwards
`scripts/test-feed.sh stop 0` stops it.

### Run the prototype in the Neat SDK container

The SDK container (`sima-cli sdk setup`) runs the stock Insight as the `insight-admin` service on
port 9900. `scripts/deploy-sdk-dev.sh` replaces it with this checkout, for testing in the browser,
and puts the stock service back when you are done. The container sees `~/workspace` on the host as
`/workspace`; the script keeps a dev copy at `~/workspace/.insight-dev` with its own virtualenv and
never touches `/opt/neat-insight` in the container.

Once, to create the dev copy (`build.sh` needs Go and produces the server and viewer binaries under
`neat_insight/bin/`):

```bash
C=$(docker ps --format '{{.Names}}' | grep -m1 sima-neat-sdk)
./build.sh
rsync -a --exclude .git --exclude node_modules ./ ~/workspace/.insight-dev/
docker exec "$C" bash -c 'cd /workspace/.insight-dev && python3 -m venv .venv && .venv/bin/pip install -e .'
```

Then, after every change (Node.js 24 for the frontend build and Go for the server, both on the host
because the container has neither):

```bash
scripts/deploy-sdk-dev.sh                 # build the frontend, sync, restart on https://localhost:9900
scripts/deploy-sdk-dev.sh --no-frontend   # backend or docs only
scripts/deploy-sdk-dev.sh --restore       # stop the dev build, start the stock service again
```

The script picks the first running `sima-neat-sdk*` container (`INSIGHT_SDK_CONTAINER=<name>` picks
another), writes the deployed commit to `~/workspace/.insight-dev/DEPLOYED_COMMIT` and logs to
`~/workspace/.insight-dev/dev-insight.log`. A deploy restarts mediamtx, so external publishers (a
webcam, a test stream) have to be started again; hard-reload the browser tab afterwards.

### Test feed for the Viewer

`scripts/test-feed.sh` feeds one Viewer channel in the Neat SDK container with a test stream. Video
goes to UDP `9000+N`: an H.264 test pattern at 640×480 and 15 fps, with a white square sweeping
across it. Metadata goes to UDP `9100+N`: for every frame, an object-detection box around the
square. Each message carries its frame's RTP time as its `timestamp`, so Insight matches it to that frame
(`scripts/test_feed_metadata.py` explains how), and a box that drifts off its square shows a sync
problem.

Run it from the checkout on the laptop. It finds the container the way the dev deploy does
(`INSIGHT_SDK_CONTAINER=<name>` picks another) and needs only ffmpeg and Python there, which the SDK
image has.

```bash
scripts/test-feed.sh 0                          # channel 0, until Ctrl-C
scripts/test-feed.sh 0 --metadata-delay-ms 500  # metadata 500 ms behind its frames, like a slow model
scripts/test-feed.sh stop 0                     # from another terminal; `stop` alone stops every feed
```

Keep it off channels a real pipeline feeds: two streams on one port garble each other.

## Testing metadata

`neat-insight` ships a metadata test sender for the channels' metadata ports (`9100+N`).

Examples:

```bash
neat-insight-metadata-test --count 1 --types object-detection
neat-insight-metadata-test --count 4 --types object-detection,classification,pose-estimation,segmentation,tracking
neat_insight/tools/multisrc-harness.sh start --count 16
```

Notes:
- Default destination is `127.0.0.1`, starting at UDP port `9100`.
- Supported metadata types are `object-detection`, `classification`, `pose-estimation`, `segmentation`, and `tracking`.
- Overlay colors follow the identity rules in [docs/user-interface.md](docs/user-interface.md#metadata-colors): class for detection, segmentation and classification, `id` for tracking and pose estimation.
- `neat_insight/tools/metadata-test.py` remains as a compatibility wrapper, but the packaged CLI is the preferred entry point.
