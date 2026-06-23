---
title: Common Workflows
description: Use Insight to validate single-stream apps, multi-stream apps, and missing video or metadata.
sidebar_position: 4
---

# Common Workflows

## Import standard test videos

Use the standard video sets when you need repeatable media for examples, smoke tests, or multi-stream validation:

```text
https://artifacts.sima-neat.com/assets/videos/720p16/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/720p16/video16.mp4

https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4
...
https://artifacts.sima-neat.com/assets/videos/480p30/video16.mp4
```

For manual use, download the files you need and upload them from Media Sources.

For API-driven setup, check whether Insight already has media files:

```bash
curl -k https://127.0.0.1:9900/api/media-files
```

If the media library is empty, download and upload a standard video:

```bash
tmpdir="$(mktemp -d)"
curl -fL "https://artifacts.sima-neat.com/assets/videos/480p30/video01.mp4" \
  -o "${tmpdir}/video01.mp4"
curl -k -F "file=@${tmpdir}/video01.mp4" \
  https://127.0.0.1:9900/api/upload/media
```

Repeat this for additional files, or upload an archive when you want to seed a larger media set.

## Validate a single-stream vision app

1. Open Insight.
2. Go to Media Sources and upload a short test video.
3. Go to Streaming Sources and assign the video to `src1`.
4. Start `src1`.
5. Run your application with the correct RTSP URL:
   - Inside the SDK container: `rtsp://127.0.0.1:8554/src1`
   - On a DevKit or external machine: `rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1`
6. Open Video Viewer and watch channel `0`.
7. If your app sends metadata, confirm overlays appear on the video.
8. Use the Stats placeholder to see where system load diagnostics will appear in the next release.

## Validate multiple input streams

1. Upload or prepare multiple videos in Media Sources.
2. Use Streaming Sources `Auto Assign` to map videos to source slots.
3. Use `Bulk Start` to start the number of sources your application expects.
4. Run the application against the corresponding `srcN` stream URLs.
5. Open Video Viewer with the expected channel set.
6. Use viewer diagnostics to check for stream bottlenecks. The Stats view is a placeholder in this release and is planned to add runtime bottleneck diagnostics in the next release.

When the application runs outside the SDK container, resolve the RTSP, video UDP, and metadata UDP host ports from `neat --json` before launching the test.

## Configure application endpoints from the SDK port map

Use this workflow when the application runs on a DevKit and Insight runs inside the SDK:

1. In the SDK, check that Insight is running:

   ```bash
   insight-admin status
   ```

2. Get the SDK port map:

   ```bash
   neat --json
   ```

3. Find the SDK host IP from `insight.webUiUrl`, or use the host IP printed by the SDK setup flow.
4. Find `rtsp.tcp.hostPortStart`, `videoUDP.hostPortStart`, and `metadataUDP.hostPortStart` in `exposedPorts`.
5. Configure application input streams with:

   ```text
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src1
   rtsp://<sdk-host-ip>:<rtsp.tcp hostPortStart>/src2
   ```

6. Configure application output ports by channel:

   ```text
   video channel N:    <sdk-host-ip>:<videoUDP hostPortStart + N>
   metadata channel N: <sdk-host-ip>:<metadataUDP hostPortStart + N>
   ```

7. Start the application and open Video Viewer.
8. Use `/api/ingest/stats` if the viewer does not show video. It reports whether RTP and metadata are reaching Insight before you debug browser or WebRTC behavior.

## Debug missing video or overlays

Use this sequence to isolate the issue:

1. Confirm the application is running and targeting the correct Insight host.
2. Confirm whether the application is running inside the SDK container or on an external machine.
3. If it is external, confirm it uses the mapped `videoUDP` and `metadataUDP` host ports from `neat --json`.
4. If it is inside the SDK container, confirm the output video port is in `9000-9079`.
5. Confirm the metadata port, if used, is the matching channel in the metadata UDP range.
6. Open Video Viewer and check the expected channel.
7. Use system information to confirm whether Insight is using default ports or SDK-mapped ports.
8. Use System Information and logs to check device state. Stats is currently a placeholder and is planned to cover device load and runtime health in the next release.

If video is visible but overlays are missing, focus on the metadata path. If overlays are delayed or appear out of sync, tune the viewer metadata delay setting.

## Tips

- Use short media clips when you are building a new app loop. They make source setup and repeated validation faster.
- Use HTTP MJPEG sources when you need to simulate a camera that exposes multipart MJPEG over HTTP.
- Keep channel numbering consistent: if video goes to channel `N`, send metadata to the metadata port for the same `N`.
- Use the Workspace view to inspect generated model and profiling artifacts before copying files out of the environment.
- Use the Quick Tour in the top-right corner of the Insight UI when you are introducing a new developer to the tool.
- Use System Information before assuming a port is wrong. In SDK deployments, the browser-facing port may be different from the internal service port.
