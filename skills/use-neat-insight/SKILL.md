---
name: sima-use-neat-insight
description: Use when working with the neat-insight Flask API, frontend, media sources, streaming source controls, vf viewer URLs, UDP/RTP ingest statistics, WebRTC egress/browser statistics, metrics endpoints, health checks, or coding-agent API documentation for neat-insight. This skill helps agents inspect service state, upload/delete/inspect media, assign and control media-source streams, debug inbound vf streams and browser delivery, build viewer links, and understand endpoint request/response contracts.
---

# Use Neat Insight

## Overview

Use the neat-insight HTTP API as the control plane for media management, streaming source playback, runtime metrics, environment metadata, and frontend serving. Prefer these APIs over editing persisted state files directly unless the user explicitly asks for low-level debugging.

Default local backend URL is `https://127.0.0.1:9900`. The service uses a local mkcert certificate in normal development, so local API clients may need to trust mkcert or pass an insecure TLS option for diagnostics.

User-facing documentation lives at `https://developer.sima.ai/software/tools/insight/`. Read that documentation when the user asks for conceptual guidance, SDK usage, UI workflows, or installation instructions rather than endpoint-level API details.

Insight is bundled with the Neat Development Environment and can also be installed on a Modalix DevKit with `sima-cli neat install insight@<ref>`. In the SDK, Insight provides RTSP media-source control and WebRTC video rendering from inside the SDK container while exposing host ports that external devices, including a DevKit, can connect to.

## SDK Status And Port Mapping

When running inside the Neat Development Environment, check service state before debugging media paths:

```bash
insight-admin status
neat --json
```

`insight-admin status` checks the supervised Insight service. `neat --json` reports the SDK-visible Insight state and `exposedPorts` map. The port map is the source of truth for clients outside the SDK container.

Default container ports are:

| Name | Default host/container port | Purpose |
| --- | --- | --- |
| `mainUI` | TCP `9900` | Main Insight UI and API. |
| `videoUI` | TCP `8081` | WebRTC Video Viewer UI. |
| `rtsp.tcp` | TCP `8554` | RTSP media-source server. |
| `videoUDP` | UDP `9000-9079` | Video RTP ingest for viewer channels `0-79`. |
| `metadataUDP` | UDP `9100-9179` | Metadata JSON ingest for viewer channels `0-79`. |
| `webRTC` | UDP `40000-40199` by default | WebRTC media transport range. |
| `webSSH` | TCP `8022` | Browser shell to a paired DevKit when available. |

If default host ports are already in use, `sima-cli` can allocate non-default host ports. Do not assume `9900`, `8081`, `8554`, `9000`, or `9100` are the browser/device-facing ports. Parse `neat --json` and use `exposedPorts[*].hostPortStart` and `hostPortEnd`.

Example `neat --json` shape:

```json
{
  "exposedPorts": [
    {"hostPortEnd": null, "hostPortStart": 9900, "name": "mainUI", "protocol": "tcp"},
    {"hostPortEnd": 9179, "hostPortStart": 9100, "name": "metadataUDP", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8554, "name": "rtsp.tcp", "protocol": "tcp"},
    {"hostPortEnd": 9079, "hostPortStart": 9000, "name": "videoUDP", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8081, "name": "videoUI", "protocol": "tcp"},
    {"hostPortEnd": 40199, "hostPortStart": 40000, "name": "webRTC", "protocol": "udp"},
    {"hostPortEnd": null, "hostPortStart": 8022, "name": "webSSH", "protocol": "tcp"}
  ],
  "insight": {
    "serviceState": "Running",
    "venv": "/opt/neat-insight/venv",
    "webUiUrl": "https://10.0.0.210:9900"
  }
}
```

Endpoint selection rules:

- Browser or external device opening Insight UI: use `insight.webUiUrl` or `mainUI`.
- Browser opening Video Viewer: prefer `/api/viewer-url`, because it uses the mapped `videoUI` port.
- Application inside the SDK container consuming RTSP sources: use `rtsp://127.0.0.1:8554/srcN`.
- Application on a DevKit or another external machine consuming RTSP sources from SDK Insight: use `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/srcN`.
- Application inside the SDK container sending video or metadata to the viewer: use UDP `9000 + channel` and `9100 + channel`.
- Application on a DevKit or another external machine sending video or metadata to SDK Insight: use `<sdk-host-ip>:<videoUDP hostPortStart + channel>` and `<sdk-host-ip>:<metadataUDP hostPortStart + channel>`.

Keep video and metadata channel numbers aligned. For channel `N`, video goes to the `videoUDP` start port plus `N`, and metadata goes to the `metadataUDP` start port plus `N`.

## Operating Rules

- Call `/api/health` first when connecting to a running neat-insight instance.
- Use JSON request bodies for POST endpoints except `/api/upload/media`, which uses multipart form field `file`.
- Treat file paths returned by media APIs as relative paths under the neat-insight media directory. Do not send absolute host paths to media-source APIs.
- Use `/api/mediasrc` to read source state before changing assignments or playback.
- Stop active media sources before destructive media operations when possible. `/api/delete-media` also clears matching assignments for deleted files.
- Do not configure DevKit IP through neat-insight UI or API. Remote devkit configuration is environment-driven.
- Use `/api/viewer-url` for vf viewer links instead of hand-building them when the browser target should match the current backend host.
- Use `/api/ingest/stats` when debugging whether RTP reaches vf before assuming a browser, ICE, or decoder problem.
- Use `/api/egress/stats` when RTP reaches vf but the browser does not decode, render, or keep a stable WebRTC session.
- Use `neat-insight-metadata-test` or `neat_insight/tools/multisrc-harness.sh` when vf metadata/DataChannel behavior needs reproducible synthetic traffic.
- Use the SDK port map before instructing DevKit-side apps or external tools to connect to Insight. Default ports only apply when the SDK was able to publish the defaults.
- For RTSP media-source URLs copied from the UI, adjust the host and port when the consumer is outside the SDK container.
- Test overlay rendering on `videoUI`, not `mainUI`. Only the vf viewer loads `/static/drawing.js`; the console's Video Viewer bundles no overlay renderer and draws only what a browser cached from an older install.
- Hard-reload the viewer after installing a new Insight before trusting a rendering result. A browser can serve a stale `drawing.js` for days.
- Read `messages_forwarded` as DataChannel delivery, not correlation success. Zero forwarded with peers attached cannot distinguish no viewer from no match; use the correlation counters below.
- Reproduce overlay loss against a wall-clock-paced source before blaming Insight. Metadata pairs with video within one millisecond, so a pipeline that stamps its two branches from different clocks drifts out of tolerance permanently. Model latency does not move source PTS; a known cause is an internal graph boundary replacing source PTS with appsrc running time (sima-neat/core#654).
- Keep changes here proportionate and comment only invariants. Pull requests have been rejected for size and comment density with correct behaviour; value justifications belong in the pull request body.

## Health And Metrics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Return service identity, status, and UTC timestamp for smoke tests and readiness checks. |
| `GET` | `/api/metrics` | Return a point-in-time system metrics payload with CPU, memory, disk, temperature, MLA, remote, and `pipeline_status` compatibility fields. |
| `GET` | `/api/neat-metrics` | Open a server-sent events stream of JSON metrics events from the local metrics broker. |
| `GET` | `/api/ingest/stats` | Return active vf UDP/RTP ingest streams and compact transport, media, forwarding, and WebRTC stats. |
| `GET` | `/api/egress/stats` | Return active vf WebRTC egress peers with RTCP feedback and browser decode/render stats. |
| `GET` | `/api/logs/<logname>` | Return recent `EV74` or `syslog` lines as `text/plain`; unknown or missing logs return 404. |
| `GET` | `/api/system/tools` | Return booleans for `ffmpeg`, `ffprobe`, and `gst-launch-1.0` availability on `PATH`. |

Example:

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/metrics
curl -k https://127.0.0.1:9900/api/ingest/stats
curl -k https://127.0.0.1:9900/api/egress/stats
curl -k https://127.0.0.1:9900/api/system/tools
```

## Ingest Stats

`/api/ingest/stats` proxies vf's non-decoding ingest stats for both video RTP (UDP `9000-9079`) and metadata JSON (UDP `9100-9179`). Use it to answer whether UDP is reaching vf, whether vf has a WebRTC track attached, whether H.264 or H.265 parameter sets and keyframes are present, and whether metadata is flowing to the viewer.

| Query | Behavior |
| --- | --- |
| none | Return active channels only with compact stats. |
| `all=1` | Include inactive channels, useful for checking configured UDP ports. |
| `verbose=1` | Include diagnostics such as NAL type counts, payload type history, estimated sequence gaps, jitter estimate, malformed packet count, and recent errors. |
| `all=1&verbose=1` | Return the full diagnostic view for all vf channels. |

Each channel includes top-level RTP identity fields, an `rtp` object, a `forwarding` object, a `media` object, a `webrtc` object, plus a `metadata` object for the UDP JSON ingest + DataChannel forwarding path. A healthy inbound H.264 stream should normally show increasing `rtp.packets_received`, nonzero `rtp.bitrate_bps`, `media.seen_sps`, `media.seen_pps`, and periodic `media.idr_count` growth. A healthy H.265 stream should also show `media.seen_vps` and periodic `media.keyframe_count` growth. Metadata should show increasing `metadata.messages_received`. If it grows while `metadata.messages_forwarded` stays flat, inspect the correlation outcomes below before moving to the DataChannel.

Examples:

```bash
curl -k https://127.0.0.1:9900/api/ingest/stats
curl -k 'https://127.0.0.1:9900/api/ingest/stats?all=1&verbose=1'
```

### Metadata Correlation

Overlays are drawn only when a metadata message is matched to the video frame it
describes. Insight matches `metadata.timestamp * 90` against the incoming video
RTP timestamp within ±90 units — one millisecond. Use these fields inside each
channel's `metadata` object to attribute an overlay failure without a packet
capture.

| Field | Meaning |
| --- | --- |
| `matched_video_first` | Metadata matched a frame that was already retained. |
| `matched_metadata_first` | Metadata waited, and a later frame released it. |
| `pending_video` | Frame timestamp mappings retained now for lookup; matches do not remove them. |
| `pending_metadata` | Messages waiting now for their frame. |
| `expired_video` | Frame mappings retired after retention, whether or not they matched metadata. |
| `expired_metadata` | Messages that aged past retention without matching. |
| `evicted_video` | Frame mappings retired inside retention, by capacity or a source restart, whether or not they matched metadata. |
| `evicted_metadata` | Messages dropped inside retention, by capacity or a source restart. |
| `messages_forwarded` | Delivered to a browser DataChannel. Not a correlation result. |
| `dropped_no_data_channel` | Reached forwarding, but no browser peer accepted it. |
| `frame_id` | Latest producer frame identifier. Diagnostics only; nothing correlates on it. |

Every timestamped message leaves through exactly one of matched, expired, or
evicted, or is still counted in `pending_metadata`. The video fields describe
the lifetime of reusable timestamp mappings, not match or loss outcomes.

Read them in this order:

- `rtp.packets_received` flat: video is not reaching Insight, so correlation
  cannot happen.
- `rtp.packets_received` climbing while `forwarding.packets_forwarded` stays
  flat: frames are not entering correlation. Check
  `forwarding.webrtc_track_attached`, `forwarding.packets_dropped_no_track`, and
  `forwarding.write_errors` first.
- `messages_received` climbing while every correlation outcome stays flat: the
  messages have no usable `timestamp` and bypass correlation. Check
  `invalid_json` and the producer schema.
- `matched_*` both zero while `pending_metadata`, `expired_metadata`, or
  `evicted_metadata` climbs, with `forwarding.packets_forwarded` also climbing:
  timestamps are not matching. Compare the metadata timestamp against the video
  RTP timestamp.
- `matched_*` climbing, then stopping while `forwarding.packets_forwarded` keeps
  climbing: progressive drift. Overlays that "worked and then stopped" are this.
- `evicted_metadata` climbing: unmatched metadata reached the capacity bound or
  was cleared by a source restart.
- `pending_metadata` high with matches still occurring: ordinary arrival skew.
- `matched_*` climbing but `messages_forwarded` flat: correlation works. Inspect
  the DataChannel, the viewer, and the browser cache instead.

Two properties to respect when reading:

- Only `pending_video` and `pending_metadata` are instantaneous depths;
  everything else is cumulative. Sample twice over a known interval and compare
  the deltas, or a long-running channel looks broken from its history alone.
- Retention only binds while arrivals fit in the correlator's capacity. At the
  ~100 messages per second measured on a DevKit, capacity holds ~2.5 s, so a
  sustained metadata mismatch can report `evicted_metadata` before
  `expired_metadata`. Both mean timestamped metadata failed to match.

## Egress Stats

`/api/egress/stats` proxies vf's WebRTC delivery stats. Use it after `/api/ingest/stats` confirms RTP is arriving, especially when the viewer has bitrate but no visible video.

| Query | Behavior |
| --- | --- |
| none | Return active channels and peers only. |
| `all=1` | Include inactive channels/peers, useful after reconnects or closed browser sessions. |
| `verbose=1` | Include peer diagnostics such as recent RTCP read errors. |
| `all=1&verbose=1` | Return the full egress diagnostic view. |

`all=1` returns closed and failed peers alongside live ones, so a channel can list far more peers than it has viewers. `peer_count` counts only active peers while the `peers` array holds every returned record, and any total computed across that array includes dead sessions. Filter on each peer's `active` field before aggregating, or omit `all=1` when you want the live view.

A peer is `active` when its connection is up. That is not a statement about how current its numbers are: a viewer whose tab is backgrounded stops reporting while staying connected, so its `browser` block can be minutes old and still appear under an active peer. Compare the peer's `last_browser_report_at` against the response's top-level `time` — both are server timestamps — before trusting `frames_decoded` or `frames_per_second`.

Each channel includes a `metadata` summary with counts of metadata messages dropped due to having no open DataChannel. Each peer includes connection states, RTCP feedback, the latest browser report when the viewer is connected, and a `metadata` object that reflects vf's server-side metadata DataChannel sends (message/byte counters plus rate estimates and send errors). RTCP feedback can show receiver reports, PLI/FIR keyframe requests, NACKs, REMB bitrate estimates, loss, and jitter. Browser reports come from `RTCPeerConnection.getStats()` plus the video element state, including `frames_decoded`, `frames_dropped`, `frames_per_second`, `ready_state`, `current_time`, and `active`.

Browser reports also include `inbound_rtp.average_jitter_buffer_delay_ms`, `inbound_rtp.decoder_implementation`, `inbound_rtp.power_efficient_decoder`, and a `synchronization` object with the configured video buffer and metadata retention, jitter-buffer support, timestamp matches, arrival fallbacks, misses, expiry, eviction, and pending queue counts.

Examples:

```bash
curl -k https://127.0.0.1:9900/api/egress/stats
curl -k 'https://127.0.0.1:9900/api/egress/stats?all=1&verbose=1'
```

## Localizing A Video Problem

"The video is stalled" can fail at any hop between the application and the
browser's decoder. Walk these in order and stop at the first one that fails;
each step names the field that decides it. Take two samples a few seconds apart
and compare deltas, because every counter here is cumulative.

| Step | Question | Field | Failing means |
| --- | --- | --- | --- |
| 1 | Is RTP reaching vf? | `rtp.packets_received` rising, channel `active` | Nothing arrived. Check app receiver host/port against `neat --json`, not vf. |
| 2 | Is vf forwarding it? | `forwarding.packets_forwarded` rising with `rtp.packets_received` | vf is dropping. Check `diagnostics.estimated_sequence_gaps` and `diagnostics.malformed_packets`. |
| 3 | Is a viewer attached? | `forwarding.webrtc_track_attached` | No browser is bound to the channel. `forwarding.packets_dropped_no_track` counts what was discarded meanwhile. |
| 4 | Is the browser receiving? | peer `browser.inbound_rtp.packets_received` rising | Transport problem between vf and the browser. Check the peer's ICE and connection states. |
| 5 | Is the browser decoding? | `browser.inbound_rtp.frames_decoded` rising | Frames arrive but do not decode. Continue to step 6. |
| 6 | Which decoder did it get? | `browser.inbound_rtp.decoder_implementation` | A name starting with `Null` means the browser has no decoder for the negotiated codec. Reconnecting cannot fix it. |

Step 5 is where codec problems surface. If `frames_received` rises while
`frames_decoded` stays flat and `frames_dropped` rises to match, the stream
reached the browser intact and the decoder rejected it — vf and the application
are both healthy and the fault is browser-side.

Two field notes that matter when reading this:

- `media.idr_count` stays `0` for H.265. Use `media.keyframe_count` for H.265
  random-access points; `idr_count` applies to H.264 only.
- `forwarding.webrtc_track_attached` means a viewer is bound to the channel,
  not that a track object exists. With no viewer open it is `false` and
  `packets_dropped_no_track` climbs, which is expected rather than a fault.

When `/offer` fails, the HTTP response carries a stable short message; the
underlying cause is written to the vf service log with its channel index. Read
the log rather than inferring from the response text, which is identical across
several different causes.

## Synthetic Metadata Testing

For viewer and vf metadata-path testing, use the bundled metadata sender instead of building ad hoc UDP emitters.

Examples:

```bash
neat-insight-metadata-test --count 1 --types object-detection
neat-insight-metadata-test --count 4 --types object-detection,classification --fps 30
neat_insight/tools/multisrc-harness.sh start --count 16 --meta-types object-detection,segmentation
```

The metadata sender targets UDP `9100+channel` by default and emits JSON compatible with Insight's metadata overlays. It supports `object-detection`, `classification`, `pose-estimation`, and `segmentation`.

## Segmentation Metadata

`type: "segmentation"` carries `data.segments[]`, one entry per instance with `label`, `confidence`, `bbox` in frame pixels, `mask_format`, and `mask`.

The two mask formats use different coordinate frames:

| `mask_format` | `mask` | Coordinate frame |
| --- | --- | --- |
| `polygon` | `[[x, y], ...]`, at least three points | Frame-absolute. `bbox` optional, derived from the extent when absent. |
| `rle` | `{"size": [h, w], "counts": [...]}` | Bbox-local: `size` covers the `bbox` rectangle, not the image. `bbox` required. |

RLE runs are column-major, the first run is background, and `counts` is a JSON array of integers — not the compressed byte string `pycocotools.mask.encode()` returns. Send the mask at mask-head resolution; the viewer stretches it onto `bbox` with interpolation.

Dropped segments warn once per channel and id in the browser console. Check there first when segments do not render.

## Media Sources

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/api/media-files` | None | Recursive folder tree under the media directory; hidden files and macOS archive metadata are omitted. |
| `POST` | `/api/upload/media` | Multipart form field `file` | Streaming `text/plain` progress while saving a file or extracting `zip`, `tar`, `gz`, or `tar.gz` archives. |
| `POST` | `/api/delete-media` | JSON `{"path": "relative/path"}` | `{"message": "Deleted successfully"}`; clears media-source assignments that point at deleted files. |
| `POST` | `/api/media-info` | JSON `{"path": "relative/path"}` | File size plus image dimensions for JPG/PNG or video track metadata from ffprobe, including detected codec when available. |
| `GET` | `/api/media-preview/mjpeg?path=<path>` | Query string | Multipart MJPEG preview for MJPEG media files that browsers cannot preview directly. |
| `GET` | `/media/<path:filename>` | Relative media path | Raw media file content for preview or download. |

Examples:

```bash
curl -k https://127.0.0.1:9900/api/media-files
curl -k -F "file=@sample.mp4" https://127.0.0.1:9900/api/upload/media
curl -k -H "Content-Type: application/json" \
  -d '{"path":"sample.mp4"}' \
  https://127.0.0.1:9900/api/media-info
```

## Standard Test Videos

SiMa provides curated test videos that are useful for repeatable Insight and Neat application validation:

```text
https://artifacts.sima-neat.com/assets/videos/720p16/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/720p16/video16.mp4

https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/480p30/video16.mp4
```

When the user asks to prepare Insight media and `/api/media-files` returns no usable video files, download one or more standard videos to a temporary location and import them through the media upload API. Do not assume a host filesystem path is visible to Insight; use `/api/upload/media`.

Example:

```bash
tmpdir="$(mktemp -d)"
curl -fL "https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4" \
  -o "${tmpdir}/video01.mp4"
curl -k -F "file=@${tmpdir}/video01.mp4" \
  https://127.0.0.1:9900/api/upload/media
curl -k https://127.0.0.1:9900/api/media-files
```

For multi-stream testing, import multiple files, then use `/api/mediasrc/auto-assign-all` and `/api/mediasrc/start-bulk`.

## Media Sources

Media sources are indexed source slots. Each source object includes an `index`, an assigned relative `file`, playback `state`, selected `transport`, detected `codec`, `allowed_transports`, and generated stream `urls`.

Codec and transport are derived from the assigned media:

- H.264 media uses RTSP/H.264.
- HEVC/H.265 media uses RTSP/H.265.
- MJPEG media can use RTSP/MJPEG or HTTP multipart MJPEG.

| Method | Path | Request | Behavior |
| --- | --- | --- | --- |
| `GET` | `/api/mediasrc/videos` | None | Return sorted relative media paths accepted by the media-source streamer. |
| `GET` | `/api/mediasrc` | None | Return persisted source assignments, playback states, transport/codec data, allowed transports, and generated stream URLs. |
| `POST` | `/api/mediasrc/assign` | JSON `{"index": 1, "file": "video.mp4", "transport": "rtsp"}` | Assign or clear one source; if it was playing, restart with the new file. Transport is honored only when compatible with the detected codec. |
| `POST` | `/api/mediasrc/auto-assign-all` | None | Stop active sources, assign unique available videos to source slots in index order, and persist stopped assignments. |
| `POST` | `/api/mediasrc/start` | JSON `{"index": 1}` | Start one assigned source and mark it `playing`. |
| `POST` | `/api/mediasrc/start-bulk` | JSON `{"count": 4}` | Start the first `count` assigned sources in index order and report `started`, `already_running`, and `errors`. |
| `POST` | `/api/mediasrc/stop` | JSON `{"index": 1}` | Stop one source and persist `stopped`. |
| `POST` | `/api/mediasrc/stop-all` | None | Stop every source and return how many were previously playing. |
| `POST` | `/api/mediasrc/reset` | None | Stop all sources and rewrite default empty assignments. |
| `GET` | `/stream/http/src<int:index>.mjpg` | None | Active HTTP multipart MJPEG stream for an HTTP/MJPEG source. |
| `GET` | `/stream/http/src<int:index>.jpg` | None | One JPEG snapshot from an active HTTP/MJPEG source. |

Common workflow:

```bash
curl -k https://127.0.0.1:9900/api/mediasrc/videos
curl -k -H "Content-Type: application/json" \
  -d '{"index":1,"file":"sample.mp4"}' \
  https://127.0.0.1:9900/api/mediasrc/assign
curl -k -H "Content-Type: application/json" \
  -d '{"index":1}' \
  https://127.0.0.1:9900/api/mediasrc/start
curl -k https://127.0.0.1:9900/api/mediasrc
```

If the consumer runs outside the SDK container, build RTSP URLs from the SDK port map rather than using the container-local default. For source `src1`, use:

```text
rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1
```

Use `/api/mediasrc` to confirm source assignment and playback state after starting streams.

## Environment And Viewer

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/envinfo` | Return `is_sima_board` and `is_remote_devkit_configured` frontend flags. |
| `GET` | `/api/buildinfo` | Return parsed local/remote SiMa build metadata, or host platform details when no devkit is configured. |
| `GET` | `/api/server-ip` | Return `CONTAINER_HOST_IP` when set, otherwise infer a browser-reachable local IP or fall back to `127.0.0.1`. |
| `GET` | `/api/viewer-url?mode=light&src=0,1` | Return the HTTPS vf viewer URL using the mapped `videoUI` port when the SDK port map is available. |
| `POST` | `/offer?channel=<N>` | Negotiate a vf viewer connection; returns 503 until supported RTP identifies the channel codec, or 415 when the browser cannot decode it. |
| `GET` | `/` | Serve built frontend `index.html`, or 503 when the frontend is not built. |
| `GET` | `/<path:path>` | Serve built frontend assets or fall back to `index.html` for SPA routing. |

Use `/api/server-ip` and `/api/viewer-url` when debugging container, bridge networking, or browser viewer access. The viewer URL uses the backend request host and the mapped `videoUI` port when available, falling back to `8081`.

## Error Handling

Most JSON API errors return `{"error": "message"}` with an HTTP error status. Common statuses are:

- `400` for missing or invalid request fields.
- `403` for unsafe media paths.
- `404` for missing logs, media files, or media-source indexes.
- `500` for local processing or stream startup failures.
- `502` for unreachable or unreadable remote devkit build information.
- `415` from vf `/offer` when the browser's offer does not advertise the channel's codec, meaning it has no decoder for that stream. This is permanent for that browser; viewers must not retry it.
- `503` from vf `/offer` until RTP payload type 96 (H.264) or 98 (H.265) identifies the channel codec; viewers should retry this response.

When automating, check HTTP status before trusting the payload, and preserve error strings in user-facing diagnostics.
