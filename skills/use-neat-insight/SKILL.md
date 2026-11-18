---
name: sima-use-neat-insight
description: Use when working with the neat-insight API, frontend, media sources, streaming source controls, viewer URLs, the Viewer's channels (an app's RTP video on UDP 9000+N and JSON metadata on 9100+N, matched and sent to browsers over WebRTC), metrics endpoints, health checks, or coding-agent API documentation for neat-insight. This skill helps agents inspect service state, upload/delete/inspect media, assign and control media-source streams, debug why an app's video or boxes do not show, build viewer links, and understand endpoint request/response contracts.
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
| `videoUI` | TCP `8081` | Not served any more: the Viewer is `/viewer` on `mainUI`. `neat --json` may still list the port. |
| `rtsp.tcp` | TCP `8554` | RTSP media-source server. |
| `videoUDP` | UDP `9000-9079` | Video RTP ingest for viewer channels `0-79`. |
| `metadataUDP` | UDP `9100-9179` | Metadata JSON ingest for viewer channels `0-79`. |
| `webRTC` | UDP `40000-40199` by default | WebRTC media transport range. |
| `webSSH` | TCP `8022` | Browser shell to a paired DevKit when available. |

If default host ports are already in use, `sima-cli` can allocate non-default host ports. Do not assume `9900`, `8554`, `9000`, or `9100` are the browser/device-facing ports. Parse `neat --json` and use `exposedPorts[*].hostPortStart` and `hostPortEnd`.

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
- Browser opening the Video Viewer: prefer `/api/viewer-url`, because it returns the `/viewer` page on the origin the browser reached Insight on (or the configured public origin).
- Application inside the SDK container consuming RTSP sources: use `rtsp://127.0.0.1:8554/srcN`.
- Application on a DevKit or another external machine consuming RTSP sources from SDK Insight: use `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/srcN`.
- Application inside the SDK container sending video or metadata to the viewer: use UDP `9000 + channel` and `9100 + channel`.
- Application on a DevKit or another external machine sending video or metadata to SDK Insight: use `<sdk-host-ip>:<videoUDP hostPortStart + channel>` and `<sdk-host-ip>:<metadataUDP hostPortStart + channel>`.

Keep video and metadata channel numbers aligned. For channel `N`, video goes to the `videoUDP` start port plus `N`, and metadata goes to the `metadataUDP` start port plus `N`.

## Operating Rules

- Call `/api/health` first when connecting to a running neat-insight instance.
- Use JSON request bodies for POST endpoints except `/api/upload/media`, which uses multipart form field `file` and an optional `on_conflict` (`ask`, `keep_both`, `replace`); a name that is already taken answers 409 unless `on_conflict` is set.
- Treat file paths returned by media APIs as relative paths under the neat-insight media directory. Do not send absolute host paths to media-source APIs.
- Use `/api/mediasrc` to read source state before changing assignments or playback.
- Stop active media sources before destructive media operations when possible. `/api/delete-media` also clears matching assignments and cached FPS renditions for deleted files, including files inside a deleted directory.
- Peripherals never captures video: SiMa Sentinel on the board discovers the cameras and microphones (`/run/simaai-sentinel/api.sock`, `GET /v1/peripherals`), and Insight only reads its catalog; only an explicit camera preview captures video and only an explicit microphone test records audio. When Sentinel is missing or fails, surface its error (`peripheral_*` codes, install or update with `sima-cli neat install sentinel`); never add an Insight-side hardware scan as a fallback.
- Preview is the only Peripherals operation that touches the sensor, and only while it runs: over the board connection Insight runs `gst-launch-1.0` (`libcamerasrc` for MIPI, `v4l2src` on the `/dev/v4l/by-id` path for USB) that writes multipart JPEG (at most 640 px wide, up to 15 fps) to stdout, and relays it at the session's `stream_url` as `multipart/x-mixed-replace`. It uses no Viewer channel, UDP port, or PyNeat. Discovery never captures. A failed start carries the pipeline's stderr in `detail`. The session's `camera_fps` is the rate the camera runs at: a USB mode's own rate; for MIPI, Sentinel's `max_fps` from one Sentinel rescan after the first frame (no Insight scan is recorded and the preview keeps running), `null` until then or when Sentinel cannot report it.
- Board-facing features (Peripherals) use one selected board from `/api/board`: a saved manual target, else the board Insight runs on, else the SDK-paired DevKit (`DEVKIT_SYNC_DEVKIT_IP`, `_USER`, `_PORT`). Select a board with `POST /api/board/select` only when the user names one; never send passwords, because authentication uses the SSH keys of the account running Insight. For an SSH selection, the DevKit shell targets that board; an on-board selection falls back to the SDK-paired DevKit. Browser launch is enabled only for an SDK-paired target using the default `sima` account; System Info's host readings (`/api/metrics`) still read the legacy REMOTE_DEVKIT target.
- Use `/api/viewer-url` for viewer links instead of hand-building them when the browser target should match the current backend host.
- Use `/api/channels` first when an app's video or boxes do not show: it says per channel what arrives, what Insight matched, and how many browsers watch, before you suspect the browser, ICE, or the decoder. See [Localizing A Video Or Overlay Problem](#localizing-a-video-or-overlay-problem).
- Insight gets no reports from browsers. What happens after Insight sends a picture (decoding, late metadata, drawing) shows only in the browser: the tile's status bar, the console with `debug=1` in the Viewer URL, and `chrome://webrtc-internals`.
- Use `neat-insight-metadata-test` or `neat_insight/tools/multisrc-harness.sh` when the metadata path needs reproducible synthetic traffic (see [Synthetic Metadata Testing](#synthetic-metadata-testing) for what it does not test).
- Overlay colors are assigned per identity from one palette: class label for detection, segmentation and classification, `id` for tracking and pose. See `docs/user-interface.md#metadata-colors` before judging colors in a screenshot.
- Use the SDK port map before instructing DevKit-side apps or external tools to connect to Insight. Default ports only apply when the SDK was able to publish the defaults.
- For RTSP media-source URLs copied from the UI, adjust the host and port when the consumer is outside the SDK container.
- Test overlay rendering on the Viewer page, `/viewer` on `mainUI` (`/api/viewer-url` builds the link). Nothing is served on `videoUI` (8081) any more.
- Hard-reload the Viewer after installing a new Insight before trusting a rendering result, so the browser does not run a cached older frontend.
- Global Viewer Configuration saves are authoritative: they clear stored channel settings so the change takes effect everywhere. Settings opened from a tile create a later channel override; **Use Global Settings** discards it. Metadata types also have a **Show Overlay** switch; use it instead of treating style rows as visibility controls.
- **Panel Transparency** in the 3D Pose tab adds transparency to auxiliary-panel surfaces without fading the visualization or controls. A global save applies the value to every channel.
- Open the Viewer on a channel before reading its counters. While no browser watches, metadata counts as `no_viewer` and is never matched, and `video.frames_per_second` stays `0`.
- Reproduce overlay loss against a wall-clock-paced source before blaming Insight. Metadata pairs with video within one millisecond (`docs/contracts.md`), so a pipeline that stamps its two branches from different clocks drifts out of tolerance permanently. Model latency does not move source PTS; a known cause is an internal graph boundary replacing source PTS with appsrc running time (sima-neat/core#654).
- Keep changes here proportionate and comment only invariants. Pull requests have been rejected for size and comment density with correct behaviour; value justifications belong in the pull request body.
- A source with `state: "external"` is held by a publisher Insight did not start. Do not call start/assign/stop on it (409); call `/api/mediasrc/takeover` only when the user explicitly wants that stream disconnected. Bulk endpoints leave the external stream alone and report such slots in `skipped_external`; `reset` still clears the stored assignment of every slot.
- A source with `state: "pulled"` is a network stream Insight pulls into the slot (session-only). Do not call start/assign/prepare/takeover on it (409); call stop only when the user wants the pull released. Stop All and Reset stop pulls too and report them in `stopped_pulled`; Auto Assign and Bulk Start skip such slots and report them in `skipped_pulled`. Never echo the URL a user gave for a pull with its credentials; the API never returns them.

## Health And Metrics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Return service identity, status, UTC timestamp, and the startup-scoped browser ICE address/public origin applied by Insight. |
| `GET` | `/api/metrics` | Return a point-in-time system metrics payload with CPU, memory, disk, temperature, MLA, remote, and `pipeline_status` compatibility fields. `cpu_load` is total CPU use (also for the remote DevKit); locally it is measured since the previous read, without blocking. |
| `GET` | `/api/neat-metrics` | Open a server-sent events stream of JSON metrics events from the local metrics broker. |
| `GET` | `/api/channels` | Return every Viewer channel with its video, metadata, viewers, and recent errors (see [Channels](#channels)). |
| `GET` | `/api/ingest/stats` | Return the same counters in the older, frozen shape that the SDK's tests read. |
| `GET` | `/api/logs/<logname>` | Return recent `EV74` or `syslog` lines as `text/plain`; unknown or missing logs return 404. |
| `GET` | `/api/system/tools` | Return booleans for `ffmpeg`, `ffprobe`, and `gst-launch-1.0` availability on `PATH`. |

Example:

```bash
curl -k https://127.0.0.1:9900/api/health
curl -k https://127.0.0.1:9900/api/metrics
curl -k https://127.0.0.1:9900/api/channels
curl -k https://127.0.0.1:9900/api/system/tools
```

## Channels

Insight's Go server (`server/`) serves the Viewer's path itself. For channel `N` it receives RTP on UDP `9000 + N` and metadata JSON on UDP `9100 + N`, matches each metadata message to the frame its `timestamp` names, and sends both to the browsers watching `N` over WebRTC. The rules an app follows (payload types, keyframes, the message envelope, the five metadata types, the timestamp rule) are in `docs/contracts.md`. Read it there rather than guessing a format.

Insight serves channels `0` to `count - 1`: 80 on a DevKit, and in the SDK the number of channels the container publishes (4 by default). An app that sends to a higher channel gets no tile. `/api/channels` returns `count`, and `/api/viewer-url` returns it as `max_video_channels`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/channels` | Every channel with its video, metadata, viewers, and recent errors. It is read from memory, so poll it freely. |
| `POST` | `/api/channels/{N}/offer` | The Viewer's WebRTC offer in, Insight's answer out: JSON `{"type", "sdp"}`, at most 64 KiB, sent as `application/json`. Its error codes are under [Error Handling](#error-handling). |
| `GET` | `/api/ingest/stats` | Frozen: the older shape of the same counters, kept for the SDK's tests ([below](#ingest-stats-frozen)). |

Per channel, `/api/channels` reports:

| Field | Meaning |
| --- | --- |
| `video.active` | Video arrived in the last 3 s. |
| `video.sender` | The address the last video packet came from. |
| `video.codec` | `H264` (payload type 96) or `H265` (98). Absent before any video, and for a payload type Insight does not play. |
| `video.payload_type`, `video.unsupported_packets` | The last payload type seen, and the packets of a type Insight does not play. RTP/JPEG (26) is planned; today such packets count here and the tile waits. |
| `video.packets`, `video.bits_per_second` | Packets received, and the bitrate over the last second. |
| `video.frames_per_second` | Whole pictures sent on to browsers. `0` while nobody watches. |
| `video.keyframes` | Keyframes seen: IDRs for H.264, IRAPs for H.265. |
| `metadata.received`, `metadata.messages_per_second` | Messages received, whole or joined from chunks. |
| `metadata.matched` | Messages matched to the frame their `timestamp` names and sent to be drawn on it. |
| `metadata.unmatched` | Timed messages that found no frame within 5 s (a timestamp in another unit or clock, or video that stopped), or that were pushed out by newer ones or by a sender restart. |
| `metadata.invalid` | Datagrams that were not a JSON object. |
| `metadata.no_viewer` | Messages that arrived while no browser watched. They are not matched and not counted as unmatched. |
| `viewers` | Browsers connected to the channel's video, including connections still being set up. |
| `errors` | The latest problems, oldest first, each starting with its time: malformed RTP, failures to start or send video, failures to send metadata. |

Counters are cumulative since Insight started. Rates cover the last second and drop to `0` once a side has been quiet for 3 s. Sample twice a few seconds apart and compare, or a long-running channel looks broken from its history alone.

```bash
curl -k https://127.0.0.1:9900/api/channels
curl -k https://127.0.0.1:9900/api/channels | jq '.channels[1]'
```

### Ingest Stats (frozen)

`/api/ingest/stats` keeps vf's field names because the SDK's network and smoke tests read them. New diagnostics read `/api/channels`. It is smaller than vf's was: per channel `udp_port`, `active`, `first_packet_at`, `last_packet_at`, `remote_addr`, an `rtp` object (`ssrc`, `payload_type`, `packets_received`, `bytes_received`, `bitrate_bps`, `packet_rate_pps`), a `media` object (`codec`, which is `unknown` before video, `seen_sps`, and `idr_count`, which counts keyframes of both codecs), a `metadata` object (`messages_received`, `messages_forwarded`, `invalid_json`, rates and times), and `webrtc.peer_count`. There are no forwarding, correlation, or WebRTC peer details, and no `seen_pps`, `seen_vps`, or `keyframe_count`.

| Query | Behavior |
| --- | --- |
| none | Only channels receiving video now. A channel with metadata but no video is left out. |
| `all=1` | Every channel. |
| `verbose=1` | Adds `diagnostics`: `malformed_packets`, `unsupported_packets`, and `recent_errors`. |

## Localizing A Video Or Overlay Problem

"My app's video or boxes don't show" can fail at any hop between the app and the browser. Open the Viewer on the channel first, since several counters move only while a browser watches. Then walk these steps against the channel in `/api/channels` and stop at the first one that fails.

| Step | Question | Field | Failing means |
| --- | --- | --- | --- |
| 1 | Does video reach Insight? | `video.packets` rising, `video.active` | Nothing arrived. Check the app's host and port against `neat --json` (`videoUDP` `hostPortStart + N`) and that `N` is below `count`. |
| 2 | Can Insight play it? | `video.codec` set | `unsupported_packets` is rising: the app sends a payload type other than 96 or 98. `video.payload_type` names it; 26 is RTP/JPEG, which is not played yet. |
| 3 | Are there keyframes? | `video.keyframes` growing | A viewer starts at the next keyframe, and Insight cannot ask the app for one. Send a keyframe at least every second, with the parameter sets in band. |
| 4 | Is a browser connected? | `viewers` at least 1 | The offer failed. Read its error code in the browser's network panel or the console with `debug=1` ([Error Handling](#error-handling)). |
| 5 | Is Insight sending pictures? | `video.frames_per_second` above 0 | A viewer is listed but gets no pictures: the WebRTC connection is not up (the browser cannot reach the `webRTC` UDP range, or `network.browser_ice_address` in `/api/health` is wrong), or no keyframe has come yet. |
| 6 | Does the browser decode? | In the browser | Insight's side works. An H.265 tile in a browser without H.265 shows "Codec not supported by this browser"; otherwise look at `chrome://webrtc-internals` and the console with `debug=1`. |
| 7 | Does metadata reach Insight? | `metadata.received` rising | Check the `metadataUDP` port for the same `N` as the video. `metadata.invalid` rising means the datagrams are not JSON objects. |
| 8 | Does metadata match frames? | `metadata.matched` rising | Read the cases below. |

Reading the metadata counters while a browser watches:

- `no_viewer` rising: no browser had the channel open when the messages arrived, so matching was not attempted.
- `unmatched` rising: the `timestamp` names no frame. It must be whole milliseconds on the video's RTP clock (`T = R // 90`, see "Matching a message to its frame" in `docs/contracts.md`), or the video stopped.
- `received` rising while `matched`, `unmatched`, `no_viewer`, and `invalid` stay flat: the messages carry no usable `timestamp` (absent, negative, fractional, or a string). The Viewer draws them on whatever frame shows when they arrive, so boxes lag or jitter.
- `matched` rising, then stopping while the video goes on: progressive drift. Overlays that "worked and then stopped" are this.
- `matched` rising but no overlay: Insight's side works. Check in the browser: the tile's **Metadata late** chip (raise the video sync buffer, `docs/user-interface.md#late-metadata`), the type's **Show Overlay** switch, the confidence threshold, a region of interest, a console warning for an unknown `type`, and coordinates that are not pixels of the video as sent. Frame-accurate drawing needs a Chromium-based browser.

## Synthetic Metadata Testing

For viewer and metadata-path testing, use the bundled metadata sender instead of building ad hoc UDP emitters.

Examples:

```bash
neat-insight-metadata-test --count 1 --types object-detection
neat-insight-metadata-test --count 4 --types object-detection,classification --fps 30
neat_insight/tools/multisrc-harness.sh start --count 16 --meta-types object-detection,segmentation
```

The metadata sender targets UDP `9100+channel` by default and emits JSON compatible with Insight's metadata overlays. It supports `object-detection`, `classification`, `pose-estimation`, `segmentation`, and `tracking`, and sends several identities per type so color assignment can be checked. It stamps `timestamp` with wall-clock seconds (`time.time()`), which matches no frame: Insight treats its messages as untimed and the Viewer draws them on arrival. It tests drawing and colors, not matching.

## Metadata Format

The message envelope, the five types (`object-detection`, `classification`, `tracking`, `pose-estimation`, `segmentation`), their fields and coordinates are in `docs/contracts.md#metadata`, with a JSON Schema per type in `docs/schemas/metadata/`. Validate a message against them before debugging the Viewer. Send one message per type per frame, each with the frame's `timestamp`.

- An RLE segmentation mask covers its `bbox`, not the frame, runs column-major starting with background, and `counts` is a JSON array of integers, not the compressed string `pycocotools.mask.encode()` returns. Only `show_rectangle: true` outlines a segment's `bbox`.
- `auxiliary-visualization` is not a type of the contract; the Viewer ignores it like any unknown type.
- Dropped segments and unknown types warn once per channel in the browser console. Check there first when an overlay does not render.

## Media Sources

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| `GET` | `/api/media-files` | None | Recursive folder tree under the media directory; hidden files and macOS archive metadata are omitted. File nodes carry `streamable` (accepted by the media-source streamer), folder nodes carry `streamable_count`; the UI hides files with `streamable: false`. |
| `POST` | `/api/upload/media` | Multipart form field `file`, optional `on_conflict` (`ask` default, `keep_both`, `replace`) | Streaming `text/plain` progress while saving a file or extracting `zip`, `tar`, `gz`, or `tar.gz` archives (into a folder named after the archive). A taken name (for an archive, its folder) answers 409 `{error, conflict: {existing, suggested}}` and saves nothing unless `on_conflict` is `keep_both` (saves as `name_2`) or `replace` (restarts file slots that were streaming the replaced file). The stream is HTTP 200 even on failure: look for `Failed to extract archive:` or `Failed to save upload:` and a missing `Upload complete.`; a `Could not restart srcN: …` line is only a warning. |
| `POST` | `/api/delete-media` | JSON `{"path": "relative/path"}` | `{"message": "Deleted successfully"}`; clears media-source assignments and cached FPS renditions for deleted files (directories included). |
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

Media sources are indexed source slots. Each source object includes an `index`, an assigned relative `file`, playback `state` (`playing`, `stopped`, `external` or `pulled`), selected `transport`, detected `codec`, `allowed_transports`, and generated stream `urls`. Each source also carries `readers` (current mediamtx readers) and, while external, an `external` object with protocol, address, since, codec_supported, width, height, fps and bitrate_bps; while pulled, a `pull` object with status (`connecting`, `live`, `unreachable`, `auth_failed`), scheme, host, path, error, since, codec_supported, width, height, fps and bitrate_bps.

Codec and transport are derived from the assigned media:

- H.264 media uses RTSP/H.264.
- HEVC/H.265 media uses RTSP/H.265.
- MJPEG media can use RTSP/MJPEG or HTTP multipart MJPEG.

| Method | Path | Request | Behavior |
| --- | --- | --- | --- |
| `GET` | `/api/mediasrc/videos` | None | Return sorted relative media paths accepted by the media-source streamer. |
| `GET` | `/api/mediasrc` | None | Return persisted source assignments, playback states, transport/codec data, allowed transports, and generated stream URLs. `native_fps` is null until the assigned file has been probed; the listing never waits for a probe but starts one in the background, so a later call shows it. |
| `POST` | `/api/mediasrc/assign` | JSON `{"index": 1, "file": "video.mp4", "transport": "rtsp", "fps": 15}` | Assign or clear one source; if it was playing, restart with the new file. Transport is honored only when compatible with the detected codec. `fps` (any whole number from 1, or null for the source rate; a rate no codec level covers for the file's resolution fails at start or prepare) selects the output frame rate; changing `file` without `fps` resets it. Returns 409 for an external slot. |
| `POST` | `/api/mediasrc/auto-assign-all` | None | Stop active sources, assign unique available videos to source slots in index order, and persist stopped assignments. Slots whose file changes lose their `fps` override. |
| `POST` | `/api/mediasrc/start` | JSON `{"index": 1}` | Start one assigned source and mark it `playing`. Returns 409 for an external slot, or if the slot was stopped, reassigned, reset or unassigned while its FPS rendition was being prepared (start it again). |
| `POST` | `/api/mediasrc/prepare` | JSON `{"index": 1}` | Create or reuse the FPS rendition `start` will stream when the slot's `fps` differs from the media's native rate; streams `text/plain` progress ending in `Rendition ready:`, `Reusing rendition:`, `Source frame rate matches`, or `Error:`. Renditions encode one at a time; a waiting prepare repeats `Waiting for another rendition to finish encoding…`. An encode needs the rendition's expected size plus 1 GB free, otherwise it ends in `Error:`. `start` does the same silently when `prepare` is skipped. |
| `GET` | `/api/mediasrc/renditions` | None | Return `{"count": int, "bytes": int}` for all currently stored FPS renditions. |
| `POST` | `/api/mediasrc/renditions/clear` | None | Delete every cached FPS rendition except one a playing source is currently streaming; returns `{"removed": int, "freed_bytes": int, "kept": [rel paths]}`. |
| `POST` | `/api/mediasrc/start-bulk` | JSON `{"count": 4}` | Start the first `count` assigned sources in index order and report `started`, `already_running`, and `errors`. |
| `POST` | `/api/mediasrc/stop` | JSON `{"index": 1}` | Stop one source and persist `stopped`. Returns 409 for an external slot that carries no Insight stream. On a pulled slot it stops the pull: 502 when MediaMTX could not confirm it (the slot stays pulled; retry), 409 while the pull is still being set up (retry in a moment). |
| `POST` | `/api/mediasrc/stop-all` | None | Stop every source and return how many were previously playing. |
| `POST` | `/api/mediasrc/takeover` | JSON `{"index": 2}` | Disconnect the external publisher holding a slot (409 when the slot is not external, 502 when the mediamtx API is unreachable). |
| `POST` | `/api/mediasrc/pull` | JSON `{"index": 3, "url": "rtsp://192.168.1.10:554/stream1", "username": "admin", "password": "…"}` | Pull an existing RTSP/RTSPS stream into the slot (mediamtx forwards it unchanged). 400 with `reason: "auth_failed"` when the camera rejects the credentials, 409 when the slot is streaming, external or pulled, 502 when mediamtx refuses or cannot be reached while configuring the slot. `stop` releases it. |
| `POST` | `/api/mediasrc/reset` | None | Stop all sources and rewrite default empty assignments, including for an externally held slot; the external stream keeps running and its slot is listed in `skipped_external`. |
| `GET` | `/stream/http/src<int:index>.mjpg` | None | Active HTTP multipart MJPEG stream for an HTTP/MJPEG source. |
| `GET` | `/stream/http/src<int:index>.jpg` | None | One JPEG snapshot from an active HTTP/MJPEG source. |
| `GET` | `/stream/preview/src<int:index>.mjpg` | None | Multipart MJPEG preview of any live slot at the source frame rate. Max 4 concurrent (429). |

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

```bash
curl -k -H "Content-Type: application/json" \
  -d '{"index":3,"url":"rtsp://192.168.1.10:554/stream1","username":"admin","password":"secret"}' \
  https://127.0.0.1:9900/api/mediasrc/pull
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
| `GET` | `/api/viewer-url?mode=light&src=0,1` | Return `url`, a link to Insight's `/viewer` page with `src` (the channels asked for, all by default; numbers out of range are dropped), `max_channels`, and `mode` only when it is `light` or `dark`; plus `max_video_channels` (the channel count), `channel_limit_source` (`devkit`, `sdk-port-map`, `legacy-default`), and `sdk_channel_limited`. Frozen. |
| `POST` | `/api/channels/{N}/offer` | The Viewer's WebRTC offer for channel `N` (see [Channels](#channels)). |
| `GET` | `/` | Serve built frontend `index.html`, or 503 when the frontend is not built. |
| `GET` | `/<path:path>` | Serve built frontend assets or fall back to `index.html` for SPA routing. |

Use `/api/server-ip` and `/api/viewer-url` when debugging container, bridge networking, or browser viewer access. The viewer URL is on the same origin as the request (scheme, host and port as the browser reached Insight), or on the launch-URL public origin when one is configured. Nothing is served on the `videoUI` port any more.

Hosted environments can opt into a separate browser-facing network configuration by writing `/home/docker/.insight-config/browser-ice-address` and/or `/home/docker/.insight-config/launch-url` before restarting Insight. The ICE file supplies one IPv4 address to both the Viewer's channels and MediaMTX; the launch URL supplies the trusted origin for viewer, WHIP, and HTTP MJPEG links. Missing files retain the existing `CONTAINER_HOST_IP` and request-host/port-map behavior. A present invalid browser ICE address prevents readiness. An invalid launch URL logs a warning and preserves the request-host/port-map fallback.

## GenAI Studio

Insight relays calls to the GenAI Studio backend on a board (started there with `run.sh`, HTTPS port `5000`). The board's self-signed certificate is accepted by Insight, so clients only call Insight.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/genai/settings` | Return the board address in use (`url`) and the configured and default addresses. |
| `POST` | `/api/genai/settings` | Set or clear `url` (`https://host[:port]`); an empty string clears it. |
| `GET`, `POST` | `/api/genai/<path>` | Forward a Studio API call (`health`, `voices`, `v1/…`, `audio/…`, `models/…`, `benchmark/…`, `tts/…`, `piperplus/…`, `supertonic/…`, `voices/…`, `rag/…`, `board-camera/…`) and stream the answer back unchanged, including binary answers such as a `board-camera/snapshot` JPEG; `shutdown` and other paths return 404. |

The default address is `https://127.0.0.1:5000` on a board, otherwise `https://<DEVKIT_SYNC_DEVKIT_IP>:5000`. Relay errors carry a `reason`: `bad-request` (400), `not-relayed` (404), `unreachable` (502), `not-configured` or `invalid-address` (503), and `cfg-unreadable` or `cfg-unwritable` (500).

```bash
curl -k https://127.0.0.1:9900/api/genai/health
curl -k -N https://127.0.0.1:9900/api/genai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<loaded-model>","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
curl -k https://127.0.0.1:9900/api/genai/board-camera/devices
curl -k -o frame.jpg 'https://127.0.0.1:9900/api/genai/board-camera/snapshot?device=/dev/video16'
```

## Board And Peripherals

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/board` | Selected board target, its `source` (`manual`, `on-board`, `sdk-env`), defaults, `generation`, and last status. Never connects. |
| `POST` | `/api/board/select` | JSON `{"host", "port", "user"}` saves a manual target; `{"reset": true}` restores the default. |
| `POST` | `/api/board/test` | Connect and read the board's host name, machine, and build version. |
| `POST` | `/api/board/trust-host-key` | JSON `{"fingerprint"}`; trust the key a reflashed board presented (`presented_fingerprint` from `host_key_changed`). |
| `GET` | `/api/peripherals` | Last camera and microphone scan for the selected board, or an empty snapshot with `scanned_at: null`. |
| `POST` | `/api/peripherals/refresh` | Ask SiMa Sentinel to rescan MIPI and USB cameras and ALSA microphones, use the catalog of the scan Sentinel runs for that refresh, and mark each camera mode Available or Unsupported. |
| `GET` | `/api/peripherals/preview` | The running preview session, or `null`. |
| `POST` | `/api/peripherals/cameras/preview` | JSON `{"id"}` plus an optional `{"format", "width", "height", "fps"}` (MIPI: an Available mode; USB: any listed MJPG or raw mode); start the board pipeline, wait up to 10 s (two frame periods for a mode slower than 0.2 fps, at most 60 s) for its first frame, and return the session with its `stream_url`. Refuses a busy camera (`409 camera_in_use`, also when libcamera or v4l2src reports it busy) and never stops the process holding it; `502 tool_missing` when the board has no `gst-launch-1.0` or lacks a GStreamer element the pipeline needs (named in `tool`); `502 command_failed` with the pipeline's stderr in `detail`. |
| `GET` | `/api/peripherals/cameras/preview/<session_id>/stream` | The JPEG frames as `multipart/x-mixed-replace; boundary=frame`, one viewer per session (`409 preview_active` for a second). The preview stops when this response ends, when nobody opens it within 15 s of the start, or after 10 s (two frame periods for a mode slower than 0.2 fps, at most 60 s) without a frame. |
| `POST` | `/api/peripherals/cameras/preview/<session_id>/stop` | Close the stream and kill the pipeline by PID on the board, releasing the camera; returns `{"session": null}` for a session that already ended. |
| `POST` | `/api/peripherals/microphones/test` | JSON `{"id"}` (optional `"seconds"`, 1-30); re-read Sentinel's catalog, then record from that microphone on the board until stopped (at most 30 s, 48 kHz, 2 channels); 202 with the test. One test at a time. |
| `GET` | `/api/peripherals/microphones/test` | The selected board's latest test: live `level_dbfs` and `elapsed_ms` while recording, then `level` and `audio_url`, or `error`; `null` before any test or once a scan lists another device under that id. Never connects. |
| `POST` | `/api/peripherals/microphones/test/stop` | End the test named by `{"token": ...}` (from the start) now; another token stops nothing. The result arrives through `GET`. |
| `GET` | `/api/peripherals/microphones/test/<token>.wav` | The finished recording of the selected board as WAV; 404 once a newer test replaced it, another board was selected, or a scan lists another device under that id. |

Board errors carry `code` and `hint`. `auth_failed` includes the `ssh-copy-id` command to authorize the service account's key; `host_key_changed` (409) includes both fingerprints. Camera discovery never captures frames, changes sensor controls, or publishes streams. Each mode's `support.tier` and `reason` are SiMa Sentinel's own verdict (its per-mode `available` and `reason`, sentinel#43). On Platform 3.0 the modes are the sensor's sizes (`sensor_mode`), and Insight also marks IMX477 sizes wider than 4032 `unsupported`, because libcamera streams them at 4032 wide. With a Sentinel that gives no verdict, Insight applies the same rule: a mode is `available` when Sentinel's `board` block lists the camera's sensor (its `configured_cameras` entry for the camera id) among the sensors the board's camera overlays support, the mode is an ISP output size (`isp_output`), and its format is NV12; otherwise it is `unsupported` with a `reason`. NV12 is a fixed fact about Neat's `CameraInput`, not queried from the board. USB cameras are always `unsupported`, and without Sentinel's `board` block every mode is. A camera or format is `available` when any of its modes is; `exportable` and `default_selection` follow the Available modes. Sentinel failures return `peripheral_missing`, `peripheral_refused`, `peripheral_denied` or `peripheral_unavailable` (503; also Sentinel's 429 when 8 refreshes already wait, with a retry hint), `peripheral_version` or `peripheral_response` (502), and `timeout` (504) when Sentinel's refresh scan does not finish within 10 s or the board does not answer. A request answered after the selected board changed returns 409 `stale_snapshot`; refresh first.

Besides a camera preview, a microphone test is the only Peripherals action that opens a device. It records only from the `plughw:` selector Sentinel's current catalog names for that id, never from a card number, and returns 409 `stale_snapshot` when that microphone's capture target or identity in Sentinel's catalog changed since the scan (a change elsewhere in the catalog, such as a previewing camera's rate, does not count), 409 `microphone_in_use` when a live check at test start finds the capture PCM open (naming the process where visible; Sentinel's own availability does not decide), and 409 `test_running` while another test records. Treat these, a missing `arecord` (`tool_missing`), and a silent result as visible outcomes; never stop another process or switch to a different device.

## Board Telemetry (Sentinel)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sentinel` | Whether SiMa Sentinel runs on the selected board: its daemon state, health and `generation`. A missing or failing daemon is a state in the answer, not an error status. |
| `POST` | `/api/sentinel/install?generation=` | Install or update Sentinel on the selected board; `generation` (from the last read) refuses the install with `409 stale_snapshot` if another board was selected since. |
| `GET` | `/api/sentinel/metrics` | The board's metrics with labels, units, thresholds and status, plus recent samples as aligned per-metric series when `history=<n>` (at most 240) is set. |

To poll the history, call `/api/sentinel/metrics?history=240` once, then send the newest `history.timestamps` entry you hold as `after` and `history.epoch` as `epoch`, and append the samples that come back.
A `history.full: true` answer (a first read, a restart, a gap in polling, a reseed, or an `after` the board no longer holds) replaces everything you hold, and its `epoch` is the one to send from then on.

## Error Handling

Most JSON API errors return `{"error": "message"}` with an HTTP error status. Routes the Go server serves (`/api/channels` and its offer among them) answer `{"error": {"code", "message", "hint"}}` instead, `hint` only when there is one; branch on `code`. Common statuses are:

- `400` for missing or invalid request fields.
- `403` for unsafe media paths.
- `404` for missing logs, media files, or media-source indexes.
- `500` for local processing or stream startup failures.
- `502` for unreachable or unreadable remote devkit build information, or an unreachable GenAI Studio board.
- GenAI Studio relay errors carry a `reason`: `400 bad-request` for an invalid board address, `404 not-relayed`, `502 unreachable`, `503 not-configured` or `invalid-address`, and `500 cfg-unreadable` or `cfg-unwritable` when Insight's `cfg.json` cannot be read (nothing is changed or relayed) or saved.
- `POST /api/channels/{N}/offer` codes. A 5xx is worth retrying, a 4xx is final:
  - `503 no_video`: no video of a codec Insight plays has reached the channel yet (payload type 96 or 98). Retry.
  - `503 codec_changed`: the channel's codec changed while the offer was answered. Retry.
  - `500 negotiation_failed`: Insight could not set up the connection, or did not answer within 10 s. The cause is in Insight's server log, with the channel.
  - `415 codec_unsupported`: the browser's offer does not list the channel's codec, so it has no decoder for it. Final for that browser.
  - `415 json_only`: the offer was not sent as `Content-Type: application/json`.
  - `413 offer_too_large`: the offer is larger than 64 KiB.
  - `400 invalid_offer`: the body is no JSON session description or no valid SDP offer. `400 no_such_channel`: `N` is not below the channel count (`400 invalid_request` when it is no integer).
- `502` from `/api/mediasrc/pull` when mediamtx refuses or cannot be reached while configuring the slot.

When automating, check HTTP status before trusting the payload, and preserve error strings in user-facing diagnostics.
