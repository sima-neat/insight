---
name: sima-use-neat-insight
description: Use when working with the neat-insight Flask API, frontend, media library, RTSP media-source controls, vf viewer URLs, UDP/RTP ingest statistics, WebRTC egress/browser statistics, metrics endpoints, health checks, or coding-agent API documentation for neat-insight. This skill helps agents inspect service state, upload/delete/inspect media, assign and control media-source streams, debug inbound vf streams and browser delivery, build viewer links, and understand endpoint request/response contracts.
---

# Use Neat Insight

## Overview

Use the neat-insight HTTP API as the control plane for media management, RTSP media-source playback, runtime metrics, environment metadata, and frontend serving. Prefer these APIs over editing persisted state files directly unless the user explicitly asks for low-level debugging.

Default local backend URL is `https://127.0.0.1:9900`. The service uses a local mkcert certificate in normal development, so local API clients may need to trust mkcert or pass an insecure TLS option for diagnostics.

## Operating Rules

- Call `/api/health` first when connecting to a running neat-insight instance.
- Use JSON request bodies for POST endpoints except `/api/upload/media`, which uses multipart form field `file`.
- Treat file paths returned by media APIs as relative paths under the neat-insight media directory. Do not send absolute host paths to media-library APIs.
- Use `/api/mediasrc` to read source state before changing assignments or playback.
- Stop active media sources before destructive media operations when possible. `/api/delete-media` also clears matching assignments for deleted files.
- Do not configure DevKit IP through neat-insight UI or API. Remote devkit configuration is environment-driven.
- Use `/api/viewer-url` for vf viewer links instead of hand-building them when the browser target should match the current backend host.
- Use `/api/ingest/stats` when debugging whether RTP reaches vf before assuming a browser, ICE, or decoder problem.
- Use `/api/egress/stats` when RTP reaches vf but the browser does not decode, render, or keep a stable WebRTC session.
- Use `neat-insight-metadata-test` or `neat_insight/tools/multisrc-harness.sh` when vf metadata/DataChannel behavior needs reproducible synthetic traffic.

## Health And Metrics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Return service identity, status, and UTC timestamp for smoke tests and readiness checks. |
| `GET` | `/api/metrics` | Return a point-in-time system metrics payload with CPU, memory, disk, temperature, MLA, remote, and `pipeline_status` compatibility fields. |
| `GET` | `/api/neat-metrics` | Open a server-sent events stream of JSON metrics events from the local metrics broker. |
| `GET` | `/api/ingest/stats` | Return active vf UDP/RTP ingest streams and compact transport, media, forwarding, and WebRTC stats. |
| `GET` | `/api/egress/stats` | Return active vf WebRTC egress peers with RTCP feedback and browser decode/render stats. |
| `GET` | `/api/logs/<logname>` | Return recent `EV74` or `syslog` lines as `text/plain`; unknown or missing logs return 404. |
| `GET` | `/api/system/tools` | Return booleans for `ffmpeg` and `gst-launch-1.0` availability on `PATH`. |

Example:

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/metrics
curl -k https://127.0.0.1:9900/api/ingest/stats
curl -k https://127.0.0.1:9900/api/egress/stats
curl -k https://127.0.0.1:9900/api/system/tools
```

## Ingest Stats

`/api/ingest/stats` proxies vf's non-decoding ingest stats for both video RTP (UDP `9000-9079`) and metadata JSON (UDP `9100-9179`). Use it to answer whether UDP is reaching vf, whether vf has a WebRTC track attached, whether H264 stream headers/keyframes are present, and whether metadata is flowing to the viewer.

| Query | Behavior |
| --- | --- |
| none | Return active channels only with compact stats. |
| `all=1` | Include inactive channels, useful for checking configured UDP ports. |
| `verbose=1` | Include diagnostics such as NAL type counts, payload type history, estimated sequence gaps, jitter estimate, malformed packet count, and recent errors. |
| `all=1&verbose=1` | Return the full diagnostic view for all vf channels. |

Each channel includes top-level RTP identity fields, an `rtp` object, a `forwarding` object, a `media` object, a `webrtc` object, plus a `metadata` object for the UDP JSON ingest + DataChannel forwarding path. A healthy inbound H264 stream should normally show increasing `rtp.packets_received`, nonzero `rtp.bitrate_bps`, `media.seen_sps`, `media.seen_pps`, and periodic `media.idr_count` growth. Metadata should show increasing `metadata.messages_received`; if `metadata.messages_received` grows but `metadata.messages_forwarded` stays flat, the browser DataChannel is not open (or vf is not currently able to send metadata to the browser).

Examples:

```bash
curl -k https://127.0.0.1:9900/api/ingest/stats
curl -k 'https://127.0.0.1:9900/api/ingest/stats?all=1&verbose=1'
```

## Egress Stats

`/api/egress/stats` proxies vf's WebRTC delivery stats. Use it after `/api/ingest/stats` confirms RTP is arriving, especially when the viewer has bitrate but no visible video.

| Query | Behavior |
| --- | --- |
| none | Return active channels and peers only. |
| `all=1` | Include inactive channels/peers, useful after reconnects or closed browser sessions. |
| `verbose=1` | Include peer diagnostics such as recent RTCP read errors. |
| `all=1&verbose=1` | Return the full egress diagnostic view. |

Each channel includes a `metadata` summary with counts of metadata messages dropped due to having no open DataChannel. Each peer includes connection states, RTCP feedback, the latest browser report when the viewer is connected, and a `metadata` object that reflects vf's server-side metadata DataChannel sends (message/byte counters plus rate estimates and send errors). RTCP feedback can show receiver reports, PLI/FIR keyframe requests, NACKs, REMB bitrate estimates, loss, and jitter. Browser reports come from `RTCPeerConnection.getStats()` plus the video element state, including `frames_decoded`, `frames_dropped`, `frames_per_second`, `ready_state`, `current_time`, and `active`.

Examples:

```bash
curl -k https://127.0.0.1:9900/api/egress/stats
curl -k 'https://127.0.0.1:9900/api/egress/stats?all=1&verbose=1'
```

## Synthetic Metadata Testing

For viewer and vf metadata-path testing, use the bundled metadata sender instead of building ad hoc UDP emitters.

Examples:

```bash
neat-insight-metadata-test --count 1 --types object-detection
neat-insight-metadata-test --count 4 --types object-detection,classification --fps 30
neat_insight/tools/multisrc-harness.sh start --count 16 --meta-types object-detection,segmentation
```

The metadata sender targets UDP `9100+channel` by default and emits JSON compatible with Insight's metadata overlays. It supports `object-detection`, `classification`, `pose-estimation`, and `segmentation`.

## Media Library

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/api/media-files` | None | Recursive folder tree under the media directory; hidden files and macOS archive metadata are omitted. |
| `POST` | `/api/upload/media` | Multipart form field `file` | Streaming `text/plain` progress while saving a file or extracting `zip`, `tar`, `gz`, or `tar.gz` archives. |
| `POST` | `/api/delete-media` | JSON `{"path": "relative/path"}` | `{"message": "Deleted successfully"}`; clears media-source assignments that point at deleted files. |
| `POST` | `/api/media-info` | JSON `{"path": "relative/path"}` | File size plus image dimensions for JPG/PNG or video track metadata from MediaInfo. |
| `GET` | `/media/<path:filename>` | Relative media path | Raw media file content for preview or download. |

Examples:

```bash
curl -k https://127.0.0.1:9900/api/media-files
curl -k -F "file=@sample.mp4" https://127.0.0.1:9900/api/upload/media
curl -k -H "Content-Type: application/json" \
  -d '{"path":"sample.mp4"}' \
  https://127.0.0.1:9900/api/media-info
```

## Media Sources

Media sources are indexed RTSP source slots. Each source object includes an `index`, an assigned relative `file`, and a playback `state`.

| Method | Path | Request | Behavior |
| --- | --- | --- | --- |
| `GET` | `/api/mediasrc/videos` | None | Return sorted relative video paths accepted by the media-source streamer. |
| `GET` | `/api/mediasrc` | None | Return persisted source assignments and playback states. |
| `POST` | `/api/mediasrc/assign` | JSON `{"index": 0, "file": "video.mp4"}` | Assign or clear one source; if it was playing, restart with the new file. |
| `POST` | `/api/mediasrc/auto-assign-all` | None | Stop active sources, assign unique available videos to source slots in index order, and persist stopped assignments. |
| `POST` | `/api/mediasrc/start` | JSON `{"index": 0}` | Start one assigned source and mark it `playing`. |
| `POST` | `/api/mediasrc/start-bulk` | JSON `{"count": 4}` | Start the first `count` assigned sources in index order and report `started`, `already_running`, and `errors`. |
| `POST` | `/api/mediasrc/stop` | JSON `{"index": 0}` | Stop one source and persist `stopped`. |
| `POST` | `/api/mediasrc/stop-all` | None | Stop every source and return how many were previously playing. |
| `POST` | `/api/mediasrc/reset` | None | Stop all sources and rewrite default empty assignments. |

Common workflow:

```bash
curl -k https://127.0.0.1:9900/api/mediasrc/videos
curl -k -H "Content-Type: application/json" \
  -d '{"index":0,"file":"sample.mp4"}' \
  https://127.0.0.1:9900/api/mediasrc/assign
curl -k -H "Content-Type: application/json" \
  -d '{"index":0}' \
  https://127.0.0.1:9900/api/mediasrc/start
curl -k https://127.0.0.1:9900/api/mediasrc
```

## Environment And Viewer

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/envinfo` | Return `is_sima_board` and `is_remote_devkit_configured` frontend flags. |
| `GET` | `/api/buildinfo` | Return parsed local/remote SiMa build metadata, or host platform details when no devkit is configured. |
| `GET` | `/api/server-ip` | Return `CONTAINER_HOST_IP` when set, otherwise infer a browser-reachable local IP or fall back to `127.0.0.1`. |
| `GET` | `/api/viewer-url?mode=light&src=0,1` | Return the HTTPS vf viewer URL on port `8081` for the request host. |
| `GET` | `/` | Serve built frontend `index.html`, or 503 when the frontend is not built. |
| `GET` | `/<path:path>` | Serve built frontend assets or fall back to `index.html` for SPA routing. |

Use `/api/server-ip` and `/api/viewer-url` when debugging container, bridge networking, or browser viewer access. The viewer URL uses the backend request host and port `8081`.

## Error Handling

Most JSON API errors return `{"error": "message"}` with an HTTP error status. Common statuses are:

- `400` for missing or invalid request fields.
- `403` for unsafe media paths.
- `404` for missing logs, media files, or media-source indexes.
- `500` for local processing or stream startup failures.
- `502` for unreachable or unreadable remote devkit build information.

When automating, check HTTP status before trusting the payload, and preserve error strings in user-facing diagnostics.
