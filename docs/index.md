---
title: Insight
description: Use Neat Insight to inspect workspaces, prepare media streams, view runtime video, and debug Neat application behavior.
sidebar_position: 0
---

# Insight

Insight is the browser-based inspection and test console for Neat vision application development. It brings the pieces of a vision runtime loop into one place: the project workspace, test media, RTSP source setup, live WebRTC video, metadata overlays, and the planned home for system/runtime statistics.

Use Insight when you want to answer practical development questions quickly:

- What files, models, packages, and profiling artifacts are in my workspace?
- Which test videos are available, and which RTSP sources are playing?
- Is my application producing video on the expected channel?
- Is metadata arriving in sync with the video frame?
- Is the problem in the application, the stream path, or the device runtime?

Insight is bundled with the Neat Development Environment and is also available as a Neat artifact package that you can install or upgrade with `sima-cli neat install`. In the SDK, Insight is automatically configured with host port mappings so a browser, a DevKit, or another machine on the network can connect to its UI, RTSP sources, and video-rendering ports.

## Documentation

- [Concepts](concepts.md) explains how Insight fits into the Neat development workflow.
- [Install and Upgrade](install-upgrade.md) covers bundled SDK usage, DevKit installation, and upgrade commands.
- [User Interface](user-interface.md) describes the Workspace, Media Library, RTSP Source, Video Viewer, Stats, and System Information views.
- [Common Workflows](workflows.md) walks through single-stream, multi-stream, and debugging flows.
- [Ports and Network Behavior](ports-network.md) lists the ports Insight uses and how SDK port mapping affects links.

## Quick start

In the Neat Development Environment, first check that Insight is running:

```bash
insight-admin status
```

Then open Insight from a browser:

```text
https://localhost:9900
```

If you are browsing from another machine on the same network, use the SDK host IP address:

```text
https://<host-ip>:9900
```

If the default ports were not available when the SDK was created, the browser-facing ports may be different. Run this command inside the SDK to see the actual port map:

```bash
neat --json
```

Look at `insight.webUiUrl` for the main UI and `exposedPorts` for RTSP, video UDP, metadata UDP, WebRTC, and the Video Viewer UI.

The basic development loop is:

1. Open Insight.
2. Upload or select media in Media Library.
3. Start one or more RTSP sources.
4. Run your Neat application.
5. Watch the output and metadata overlays in Video Viewer.
6. Use the SDK port map when configuring applications running on a DevKit or another external machine.
7. Use Workspace to inspect artifacts, and use the Stats placeholder to understand where system/runtime diagnostics will land in the next release.

If you do not already have media files, start with the standard test videos listed in [Common Workflows](workflows.md#import-standard-test-videos).
