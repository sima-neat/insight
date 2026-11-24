---
title: Ports and Network Behavior
description: The ports Insight uses, how the SDK remaps them, and how an app or browser outside the SDK reaches Insight.
sidebar_position: 5
---

# Ports and Network Behavior

The ports below are the ones inside the SDK container, or on a DevKit Insight is installed on. The
SDK publishes them on its host, under the names in the first column, on other ports when these are
taken.

| Port-map name | Port | Protocol | Use |
| --- | --- | --- | --- |
| `mainUI` | 9900 | HTTPS (TCP) | The web UI, the Viewer, the API, and HTTP MJPEG sources. |
| `rtsp.tcp` | 8554 | RTSP (TCP) | The sources `src1` to `src48`, which apps read and other programs may publish into. |
| none | 8000, 8001 | RTP and RTCP (UDP) | The same over RTSP with UDP transport. |
| none | 8890 | SRT (UDP) | The sources again, over SRT: MediaMTX's SRT listener, on by default. |
| `videoUDP` | 9000 + N | UDP | Channel `N`'s video (RTP). |
| `metadataUDP` | 9100 + N | UDP | Channel `N`'s metadata (JSON). |
| `webRTC` | a range, 40000–40200 outside the SDK | UDP | The Viewer's video, from Insight to the browser. |
| `webrtcWhip` | 8889 | HTTPS (TCP) | A browser publishing its webcam as a source. |
| `webrtcWhipIce` | 8189 | UDP | That webcam's video. |

Channels run from 0 to one below the channel count: 80 on a DevKit, in the SDK the number it
publishes (`insightVideoChannels`, 4 by default). The ports without a port-map name are
MediaMTX's too, open as its others are. Insight also runs MediaMTX's control API on
`127.0.0.1:9901`, reachable from the same machine only.

Insight is a developer tool for a trusted network: its sources, channels and API take no
credentials ([what that means](#on-a-shared-network)).

## On a shared network

Insight protects a page you open from other websites, and nothing more. Anyone who can reach its
ports can use it:

- **No sign-in.** The web UI and the API answer anyone who reaches `mainUI`.
- **MediaMTX takes any publisher and any reader.** Anyone who reaches `rtsp.tcp`, SRT's 8890 or
  `webrtcWhip` can watch every source and publish into any that has no publisher; its WebRTC
  endpoint answers pages of any origin (`webrtcAllowOrigin: '*'`).
- **The channels take any sender.** Whatever arrives on a channel's UDP ports is shown in the
  Viewer.
- **Pages of other sites may frame Insight**: it sends no `X-Frame-Options` or
  `frame-ancestors`.

What it does refuse: a request that changes something (any method but `GET`, `HEAD` and
`OPTIONS`) sent by a page of another origin, answered 403 `cross_origin`. So another website you
visit cannot start, stop, delete or upload anything through your browser. GETs are not checked:
such a page cannot read Insight's answers (the browser keeps them from it), but it can make
requests that do something, such as loading Insight's MJPEG streams and previews
(`/stream/http/srcN.mjpg`, `/api/slots/{n}/preview.mjpg`, `/api/media/preview.mjpg`), each of
which runs an FFmpeg process while it is watched, up to Insight's limit of relayed streams.
Requests that send no origin (curl, scripts) pass.

To use Insight beyond a network you trust, do not publish its ports. Reach it through an SSH
tunnel or a VPN instead, or put `mainUI` behind a reverse proxy that signs users in, and close the
other ports (RTSP, SRT, WHIP, the UDP ranges) to everyone who should not publish or watch.

## The SDK's port map

`neat --json` in the SDK lists the published ports in `exposedPorts`, and Insight's address as
`insight.webUiUrl`:

```json
{"name": "rtsp.tcp", "hostPortStart": 18554, "protocol": "tcp"}
{"name": "videoUDP", "hostPortStart": 19000, "hostPortEnd": 19003, "protocol": "udp"}
{"name": "metadataUDP", "hostPortStart": 19100, "hostPortEnd": 19103, "protocol": "udp"}
```

`hostPortStart` is the port to use from outside the container, the start of the range for a range.
**System information** in Insight shows the same ports.

## An app on a DevKit

An app in the SDK container uses the ports in the table at `127.0.0.1`. An app on a DevKit that
works with Insight in the SDK uses the SDK host's address and the published ports. With the map
above:

```text
source src1:        rtsp://<sdk-host-ip>:18554/src1
channel 0 video:    <sdk-host-ip>:19000      channel 0 metadata: <sdk-host-ip>:19100
channel 3 video:    <sdk-host-ip>:19003      channel 3 metadata: <sdk-host-ip>:19103
```

The [contracts](contracts.md#port-remapping-in-the-sdk-container) say which options of Neat's
senders take these ports.

## A browser on another machine

The browser needs `mainUI`, and the `webRTC` range for the Viewer's video; to publish a webcam,
`webrtcWhip` and `webrtcWhipIce` as well. When a firewall or a NAT lies between the browser and
Insight, these UDP ports must be open to it.

## Hosted environments

Where Insight runs behind a proxy or a NAT, the hosting setup writes optional files into
`/home/docker/.insight-config/`, each holding one line, read when Insight starts
(`insight-admin restart` after a change):

| File | Purpose |
| --- | --- |
| `browser-ice-address` | The IPv4 address browsers reach Insight's WebRTC ports at, for the Viewer and webcam publishing. Without it, Insight offers `CONTAINER_HOST_IP` when that is set. A value that is not such an address stops Insight from starting. |
| `launch-url` | The URL browsers open Insight at. The links Insight makes (the Viewer, webcam publishing, HTTP MJPEG) use its origin. A value Insight cannot use is logged and ignored. |
| `url-routing` | `proxy` (the default) to make links through the launch URL, `direct` to make them on Insight's own ports. |

**System information** shows the browser address and public origin Insight applied.
