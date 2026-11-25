---
title: Common Workflows
description: Use Insight to test an app against files, webcams and cameras, view its output, and find missing video or metadata.
sidebar_position: 4
---

# Common Workflows

The addresses below are for an app in the SDK container. An app on a DevKit reaches Insight in the
SDK at the SDK host's address and on the ports the SDK published ([Ports and
network](ports-network.md#an-app-on-a-devkit)).

## Test an app against a video file

1. In **Media**, **Import…** a short video from your computer or from the **Catalog**.
2. In **Streaming**, select `src1`, pick the video with **Change…**, then **Start**. The slot goes
   **Live**.
3. Run your app against `rtsp://127.0.0.1:8554/src1` (**Copy** in the slot's panel gives the URL),
   sending its video and metadata to channel 1 ([Contracts](contracts.md)).
4. In **Viewer**, watch channel 1. If nothing shows, see [Missing video or
   overlays](#missing-video-or-overlays).

For a multi-stream app, import several videos, then use **Auto assign** and **Start…** in the
Streaming page's ⋯ menu: the app reads `src1` to `srcN` and sends each result to its own channel.

## Use your webcam as a source

A webcam on the computer running your browser can be a source, so you can test against a live
camera without copying anything to the board.

1. Open Insight in a browser that trusts its certificate: browsers allow camera access only on a
   secure page ([The certificate](install-upgrade.md#the-certificate)).
2. In **Streaming**, select a slot and set its **Source** to **Camera**. Select **Enable camera
   access**, allow it, and pick your camera. Choose its **Resolution** (1920x1080 at 30 fps by
   default) to test your app at another size, or at 60 fps.
3. Select **Start**. The browser publishes the camera to Insight, and the slot goes **Live**. Your
   app reads the slot's RTSP URL as it would a file's, as H.264.

The browser tab sends the video: keep it open and in the foreground, since browsers slow down
hidden tabs. Closing or reloading it ends the stream. In the SDK, the browser must also reach the
webcam publishing ports (`webrtcWhip` and `webrtcWhipIce`); when publishing fails, open the
publishing URL the message names once and accept its certificate.

## Pull an IP camera into a slot

1. In **Streaming**, select a slot and set its **Source** to **Stream URL**.
2. Enter the camera's `rtsp://` or `rtsps://` URL and, if it needs them, its username and password,
   then select **Pull**.
3. The slot shows **Connecting…**, then **Live** with the camera's codec, resolution and frame rate.
   **Unreachable** means the camera does not answer (Insight keeps trying); **Auth failed** means it
   rejects the username or password.

Insight forwards the camera's stream unchanged; Neat apps decode H.264, H.265 and MJPEG.
**Stop** ends the pull but keeps the camera on the slot, which reads **Idle** (its side panel says
**Stopped**); **Start** pulls it again. When Insight restarts, the slot keeps its camera but does
not pull until you select **Start**. Insight keeps the camera's URL only when it holds no username, password or query
string; otherwise the slot shows **Needs URL**, and you enter the URL and credentials again.

## Publish into a slot from another program

Any RTSP publisher can use a free slot, for example ffmpeg with a camera on the host:

```bash
ffmpeg -f v4l2 -i /dev/video0 -c:v libx264 -preset veryfast -tune zerolatency -g 30 -pix_fmt yuv420p \
  -f rtsp -rtsp_transport tcp rtsp://<insight-host>:8554/src2
```

The slot turns **External**, and apps read it at the same URL. The first publisher keeps the slot
until it stops; **Take over…** disconnects it. The slot's preview starts at the publisher's next
keyframe, so a keyframe every second (`-g 30` at 30 fps) keeps the wait short.

## Check the Viewer without an app

`neat-insight-metadata-test` sends a channel a test stream: a test pattern with a white square
sweeping across it, and metadata drawn around the square on each frame. It comes with Insight
(in the SDK container, `/opt/neat-insight/venv/bin/neat-insight-metadata-test`), sends to
`127.0.0.1` unless `--host` names another machine, and needs ffmpeg with libx264, which the SDK
container has:

```bash
neat-insight-metadata-test 1                                      # channel 1, object detection
neat-insight-metadata-test 1 --types object-detection,tracking,pose-estimation,segmentation,classification
neat-insight-metadata-test 1 --metadata-delay-ms 500             # metadata half a second late
```

An overlay that drifts off the square means frames and metadata are not matched; with a delay
past the video sync buffer, the tile shows **Metadata late**. It runs until Ctrl-C. Do not run it
on a channel an app feeds: two streams on one port garble each other.

## Missing video or overlays

Check in this order:

1. **The address.** In the SDK container, the app sends to `127.0.0.1`; from a DevKit, to the SDK
   host's address and the ports `neat --json` lists ([Ports and network](ports-network.md)).
2. **The channel.** Video and metadata go to the same channel `N`: video to `9000+N`, metadata to
   `9100+N`, with `N` below the channel count **System information** shows. In the SDK it is 4
   unless the SDK was set up with more.
3. **What arrives.** `curl -k 'https://127.0.0.1:9900/api/ingest/stats?all=1&verbose=1'` lists
   every channel: whether video arrives (`active`), its payload type and codec (`rtp.payload_type`,
   `media.codec`), and the metadata messages received, not valid JSON, and forwarded to a browser
   (`metadata.messages_received`, `invalid_json`, `messages_forwarded`). Packets of a payload type
   Insight does not play count as `diagnostics.unsupported_packets`.
   `diagnostics.incomplete_frames` counts frames withheld because a packet was lost (every codec;
   the whole frames an H.265 channel then holds until its next IRAP are not counted),
   `unusable_frames` the JPEG frames Insight could not rebuild (counted, with the reason in
   `recent_errors`, only while a viewer watches the channel) and `skipped_frames` the frames a
   viewer skipped because its connection was too slow to take them. While the Viewer shows the
   channel, messages received but never forwarded matched no frame.
4. **The browser.** It must reach the WebRTC ports (`webRTC` in the SDK's port map). A browser
   that cannot decode H.265 says so on an H.265 tile. A JPEG tile needs no decoder in the browser:
   the page draws its frames.
5. **Unmatched metadata.** A message's `timestamp` must be its frame's time in whole milliseconds on
   the video's RTP clock, as the [contracts](contracts.md#matching-a-message-to-its-frame) say;
   seconds, nanoseconds or the wall clock match nothing.
6. **Late metadata.** If the tile shows **Metadata late**, the metadata arrives after its frame was
   shown: raise the **Video sync buffer** from the notice, or send the metadata sooner.
7. **Hidden overlays.** In the Viewer's side panel, check that the type's overlay is shown and that
   its confidence threshold or a region of interest does not hide everything.
