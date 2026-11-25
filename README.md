# Neat Insight

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Documentation:** [English](docs/index.md) | [한국어](docs/i18n/ko/index.md) | [日本語](docs/i18n/ja/index.md) | [繁體中文](docs/i18n/zh-Hant/index.md) | [Українська](docs/i18n/uk/index.md)

Neat Insight is SiMa.ai's browser tool for developing Neat vision apps: it publishes video streams
for your app to read, and views the video your app sends back with its AI detections drawn over
it.

- **Media** and **Streaming**: play video files, your browser's webcam or an IP camera as RTSP
  sources `src1` to `src48`.
- **Viewer**: a grid of channels, each showing an app's video with its object detection,
  classification, tracking, pose and segmentation results.
- **Peripherals** and **Stats**: a board's cameras and microphones, and its telemetry from SiMa
  Sentinel, live and as recorded runs.

## Install

Insight comes with the Neat SDK, which starts it with the container. To install it on a DevKit:

```bash
sima-cli neat install insight
source ~/.simaai/neat-insight/venv/bin/activate
neat-insight
```

On a DevKit, Insight makes its HTTPS certificate with [mkcert](https://github.com/FiloSottile/mkcert),
which must be installed there (Insight stops an mkcert that has not finished in 5 minutes and says
so). [Install and upgrade](docs/install-upgrade.md) has the details and how to upgrade.

## Open it

Open `https://<host>:9900` in a browser, where `<host>` is the machine Insight runs on
(`localhost` in the SDK). In the SDK, `neat --json` names the address if the SDK published Insight
on another port. [The user interface](docs/user-interface.md) describes each page.

## Make your app show up in Insight

An app reads a source at `rtsp://<host>:8554/srcN` and shows up on Viewer channel `N` by sending
its video (RTP) to UDP `9000+N` and its results (JSON) to UDP `9100+N`. The
[contracts](docs/contracts.md) give the exact rules, with a minimal pyneat app; Neat's
`VideoSender` and `MetadataSender` follow them.

`neat-insight-metadata-test <channel>`, which comes with Insight, sends a channel a test pattern
with metadata matched to its frames, to check the Viewer without an app
([Common workflows](docs/workflows.md#check-the-viewer-without-an-app)).

## Documentation

- [Overview and quick start](docs/index.md)
- [Common workflows](docs/workflows.md), including what to check when video or overlays are missing
- [Ports and network](docs/ports-network.md)
- [REST API](docs/api-reference.md): the server serves its OpenAPI document at `/api/openapi.yaml`

## Contributing

Insight is a Go server (`server/`) with an Angular web UI (`frontend/`), packaged as a Python wheel.
[AGENTS.md](AGENTS.md) explains how the repository is put together, how to build, test and try a
change in the SDK container, and the rules that changes follow.
