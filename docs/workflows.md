---
title: Common Workflows
description: Use Insight to validate single-stream apps, multi-stream apps, and missing video or metadata.
sidebar_position: 4
---

# Common Workflows

## Validate a single-stream vision app

1. Open Insight.
2. Go to Media Library and upload a short test video.
3. Go to RTSP Source and assign the video to `src1`.
4. Start `src1`.
5. Run your application with `rtsp://127.0.0.1:8554/src1` as input.
6. Open Video Viewer and watch channel `0`.
7. If your app sends metadata, confirm overlays appear on the video.
8. Use the Stats placeholder to see where system load diagnostics will appear in the next release.

## Validate multiple input streams

1. Upload or prepare multiple videos in Media Library.
2. Use RTSP Source `Auto Assign` to map videos to source slots.
3. Use `Bulk Start` to start the number of sources your application expects.
4. Run the application against the corresponding `srcN` RTSP URLs.
5. Open Video Viewer with the expected channel set.
6. Use viewer diagnostics to check for stream bottlenecks. The Stats view is a placeholder in this release and is planned to add runtime bottleneck diagnostics in the next release.

## Debug missing video or overlays

Use this sequence to isolate the issue:

1. Confirm the application is running and targeting the correct Insight host.
2. Confirm the output video port is in `9000-9079`.
3. Confirm the metadata port, if used, is the matching port in `9100-9179`.
4. Open Video Viewer and check the expected channel.
5. Use system information to confirm whether Insight is using default ports or SDK-mapped ports.
6. Use System Information and logs to check device state. Stats is currently a placeholder and is planned to cover device load and runtime health in the next release.

If video is visible but overlays are missing, focus on the metadata path. If overlays are delayed or appear out of sync, tune the viewer metadata delay setting.

## Tips

- Use short media clips when you are building a new app loop. They make RTSP setup and repeated validation faster.
- Keep channel numbering consistent: if video goes to channel `N`, send metadata to the metadata port for the same `N`.
- Use the Workspace view to inspect generated model and profiling artifacts before copying files out of the environment.
- Use the Quick Tour in the top-right corner of the Insight UI when you are introducing a new developer to the tool.
- Use System Information before assuming a port is wrong. In SDK deployments, the browser-facing port may be different from the internal service port.
