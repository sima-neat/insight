---
title: Ports and Network Behavior
description: Understand Insight port usage, channel mapping, and SDK port remapping.
sidebar_position: 5
---

# Ports and Network Behavior

Insight uses several ports during normal operation.

| Purpose | Default port or range | Protocol |
| --- | --- | --- |
| Main Insight web UI | `9900` | HTTPS |
| Video Viewer web UI | `8081` | HTTPS |
| RTSP media sources | `8554` | RTSP over TCP |
| Video ingest channels | `9000-9079` | UDP |
| Metadata ingest channels | `9100-9179` | UDP |
| Web SSH to paired DevKit | environment configured | HTTPS |

## Channel mapping

The Video Viewer uses paired video and metadata ports. For channel `N`:

```text
video:    UDP 9000 + N
metadata: UDP 9100 + N
```

For example:

| Viewer channel | Video port | Metadata port |
| --- | --- | --- |
| `0` | `9000` | `9100` |
| `1` | `9001` | `9101` |
| `2` | `9002` | `9102` |

Keep the channel number consistent between video and metadata. If your application sends video to channel `3`, send corresponding metadata to the metadata port for channel `3`.

## SDK port mapping

In the Neat Development Environment, ports may be remapped by the SDK container. Insight reads the SDK port-map configuration when available so UI links point to the browser-reachable host port.

This matters most for the Video Viewer. The internal default viewer port is `8081`, but the browser-facing port can be different when the SDK maps `videoUI` to another host port.

Use System Information in the Insight UI to check the actual exposed ports before assuming a URL is wrong.

## Related tools

- **Neat Development Environment** provides the containerized build and run environment where Insight is bundled.
- **Neat Library** provides the application APIs used to build and run vision workloads.
- **sima-cli** installs and upgrades Insight packages and other Neat artifacts.
- **Model Compiler and LLiMa** produce model artifacts that you can inspect through Workspace and validate through applications running beside Insight.
