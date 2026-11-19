---
title: Insight
description: Use Neat Insight to serve test video streams to your Neat app and to view the video and AI results your app sends back.
sidebar_position: 0
---

# Insight

Neat Insight is a browser tool for developing Neat vision apps. It serves video streams your app
reads, and shows the video your app sends back with its AI results (boxes, classes, poses, masks,
tracks) drawn over it. It also lists a board's cameras and microphones and shows the board's
telemetry.

```text
media file, webcam or IP camera ──▶ Insight source srcN ──RTSP──▶ your app
your app ──video and metadata over UDP──▶ Insight ──WebRTC──▶ the Viewer in your browser
```

Insight comes with the Neat SDK, where it starts with the container, and can also be installed on
a DevKit ([Install and upgrade](install-upgrade.md)).

## Quick start

1. Open `https://localhost:9900`, or `https://<host-ip>:9900` from another machine. If the SDK
   published Insight on another port, `neat --json` gives its address as `insight.webUiUrl`.
2. In **Media**, select **Import…** and import a video from the **Catalog** tab.
3. In **Streaming**, select slot `src1`, choose the video with **Change…**, then select **Start**.
   An app in the SDK container reads it at `rtsp://127.0.0.1:8554/src1`.
4. Run your app with Insight as the destination of its video and metadata on channel 1, as the
   [contracts](contracts.md) say.
5. Open **Viewer** to watch channel 1 with its overlays.

## Documentation

- [Concepts](concepts.md): sources, channels, the board, and how they fit together.
- [Install and upgrade](install-upgrade.md): Insight in the SDK and on a DevKit.
- [User interface](user-interface.md): each page of Insight.
- [Common workflows](workflows.md): the tasks you do with Insight, and what to check when video or
  overlays are missing.
- [Ports and network](ports-network.md): the ports Insight uses and how the SDK remaps them.
- [Contracts](contracts.md): what an app does to read Insight's sources and show up in its Viewer.
- [REST API](api-reference.md): automating Insight.
