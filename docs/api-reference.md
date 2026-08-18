---
title: REST API Reference
description: Automate Neat Insight with its OpenAPI document, Swagger UI, and HTTP endpoints.
sidebar_position: 6
---

# REST API Reference

Insight exposes its browser control plane as an HTTP API. You can use it to automate health checks, media imports, streaming-source setup, viewer discovery, workspace inspection, and runtime diagnostics.

The running service publishes two API documentation endpoints:

- `GET /api/docs` opens the interactive Swagger UI.
- `GET /api/openapi.json` returns the OpenAPI 3.1 document for client generation and other tooling.

For a default local installation, open:

```text
https://127.0.0.1:9900/api/docs
```

Insight normally uses a locally generated development certificate. Command-line clients may need to trust that certificate or use `-k` for local diagnostics:

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/openapi.json -o neat-insight-openapi.json
```

## Common automation flow

Upload a file, assign it to a source slot, and start playback:

```bash
curl -k -F "file=@person_clip.mp4" \
  https://<INSIGHT_HOST>:9900/api/upload/media

curl -k -H "Content-Type: application/json" \
  -d '{"index":1,"file":"person_clip.mp4"}' \
  https://<INSIGHT_HOST>:9900/api/mediasrc/assign

curl -k -H "Content-Type: application/json" \
  -d '{"index":1}' \
  https://<INSIGHT_HOST>:9900/api/mediasrc/start
```

Read `/api/mediasrc` before changing assignments or playback state. Stop active sources before deleting their media when possible.

## Response and streaming conventions

- Most endpoints return JSON. Errors generally use `{"error": "message"}` with an HTTP error status.
- Uploads and imports return `text/plain` streaming progress rather than a single JSON object.
- `/api/neat-metrics` is a server-sent event stream.
- MJPEG preview and source endpoints return multipart image streams.
- Media and workspace raw-file endpoints return the requested binary content.

The Swagger UI uses the same host as Insight, so its **Try it out** requests target the current installation. Operations such as delete, reset, start, and stop change service state immediately.

## API groups

The OpenAPI document groups operations by purpose:

- **Service and system** — health, environment, build details, metrics, logs, and optional tools.
- **Diagnostics** — RTP ingest, WebRTC egress, and server-sent metrics.
- **Media library and imports** — catalog, YouTube, upload, delete, inspect, preview, and download.
- **Media sources** — assignment and RTSP/HTTP playback control.
- **Viewer** — browser-reachable viewer URL and configured channel capacity.
- **Workspace** — browse, search, inspect, and preview workspace files and MPK archive members.
- **DevKit shell** — discover and start the hosted shell bridge when configured.

The raw OpenAPI file is also maintained in the Insight repository at `neat_insight/openapi.json`. Tests compare its operations with Flask's registered `/api` routes so new endpoints cannot be added silently without updating the reference.
