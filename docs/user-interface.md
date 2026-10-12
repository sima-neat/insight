---
title: User Interface
description: Learn the main Insight views and when to use each one.
sidebar_position: 3
---

# User Interface

Insight is organized around the development tasks you perform while validating a vision application: inspect files, prepare media, start sources, view output, and watch runtime health.

## Workspace

The Workspace view lets you browse the project files visible to Insight. In the Neat Development Environment, this is normally `/workspace`; outside the SDK, Insight falls back to the current working directory.

Use Workspace to:

- Search and browse source files, configuration, model artifacts, and generated outputs.
- Preview text, code, Markdown, images, and selected binary artifacts.
- Inspect MPK package archives without manually extracting them.
- View specialized development artifacts such as MLA stats, MPK manifests, and pipeline sequence files.

Workspace is especially useful when an application produces several build outputs and logs. It gives you a browser-accessible way to inspect those artifacts while staying in the same development session.

![Insight Workspace view showing a pipeline sequence graph and workspace artifacts.](images/insight-workspace-overview.png)

## Media Sources

Media Sources is where you add and manage media files used for application tests. Select **Import Media** to open the import dialog, then choose one of three sources:

- **Local files**: Choose or drag and drop one or more files from your computer. H.264 MP4 uploads are normalized for low-latency playback with B-frames disabled while preserving the source frame rate.
- **Catalog**: Import from SiMa's curated video catalog for repeatable tests with known assets. Browse by asset type or name, search the catalog, filter by resolution, frame rate, and codec, preview a video, then import one variant or select and import several matching assets.
- **YouTube**: Paste a regular YouTube video URL, validate it to display a preview, and choose a start time, clip length, and output profile. Insight supports 1-, 3-, or 5-minute clips at `1080p30`, `720p30`, or `480p30`. The imported clip is converted to WebRTC-friendly H.264 with B-frames disabled. Active live streams are not supported; use a regular video or an archived live stream.

Catalog and YouTube imports require network access. Insight displays progress while it downloads and prepares the media, then saves the result in the local media library.

Supported video formats include common container formats such as `mp4`, `mov`, `avi`, `mkv`, and `webm`. Insight also recognizes MJPEG assets and HEVC/H.265 media for codec-aware streaming. MJPEG and HEVC media are preserved so they can be streamed with their original codec behavior.

After importing media, you can filter the file list, preview a selected file, inspect its basic metadata, or delete files that are no longer needed. Use Media Sources before configuring streaming sources so you know which files are available, which codec Insight detected, and whether they are readable.

The library is shown as folders. Folder rows open the folder and list its subfolders and videos; each folder row shows how many streamable files it holds. Use **Back** to return to the parent folder, **Media Root** to jump to the top of the library, and the breadcrumb to see where you are or jump to any level. The filter searches the current folder and everything beneath it and shows matches with their path relative to the current folder. Files Insight cannot stream are listed greyed with a **Not streamable** tag so you can still preview or delete them; the assign dialog in Streaming Sources hides them. Folder names are ordinary labels you choose, for example `30FPS/` or `120FPS-720p-h264/`; Insight never reads video settings from them. In the Neat SDK the library lives at `/workspace/.insight-media/`, so it survives SDK restarts. Uploads always land at the top of the library.

![Insight Media Sources view showing a selected video preview and media metadata.](images/insight-media-library.png)

Media Sources combines importing, file selection, preview, metadata inspection, and delete actions in one view. Imported catalog assets are stored under `catalog/`, and YouTube clips are stored under `youtube/`, so you can identify how files entered the library.

## Streaming Sources

The Streaming Sources view turns uploaded media files into live source slots. Each source slot can expose an RTSP URL:

```text
rtsp://127.0.0.1:8554/src1
rtsp://127.0.0.1:8554/src2
rtsp://127.0.0.1:8554/src3
```

Those URLs are correct for applications running in the same SDK container as Insight. If the application runs on a DevKit or another external machine, use the SDK host IP address and the mapped `rtsp.tcp` host port from `neat --json`.

Insight selects codec and transport options from the assigned media:

- H.264 media streams over RTSP as H.264.
- HEVC/H.265 media streams over RTSP as H.265.
- MJPEG media can stream over RTSP as MJPEG or over HTTP as multipart MJPEG.

The codec is determined by the selected media and is not manually changed in the UI. MJPEG over RTSP is encoded into RTP-compatible MJPEG, while HTTP MJPEG can preserve MJPEG frames for camera-style HTTP testing.

Select the file field of a source row to open **Source for srcN**. Its **Video file** tab has the same folder browser as Media Sources; pick a video, then **Assign**, or **Clear** to unassign. Its **Camera** tab assigns one of your cameras instead, and its **Stream URL** tab pulls a network stream (see below). You can start and stop individual sources, auto-assign unique files across source slots, bulk start sources, stop all streams, and copy stream URLs for use by applications or test harnesses.

This view is useful when you need repeatable input streams for an object detection, segmentation, tracking, classification, or GenAI vision application.

![Insight Streaming Sources view showing assigned source slots and source preview.](images/insight-rtsp-source.png)

The Streaming Sources view lets you assign media files to source slots, start or stop streams, copy the active stream URL, and preview the selected source before wiring it into an application.

### Use a webcam as a source

A webcam attached to the computer running your browser can be used as a live source, so you can test an application against a real camera without copying a file onto the board first.

1. Select the file field of a source slot and switch the **Source for srcN** dialog to **Camera**.
2. Select **Enable camera access**, there or under **Local cameras** in Media Sources. The browser asks for camera permission; Insight cannot grant it for you. After you allow access, your cameras are listed in the tab.
3. Select a camera and **Assign** it, then select **Start**. The row shows a `[CAM]` badge (video files show `[VID]`), the browser publishes the camera to Insight, and the slot reports `Live`.
4. Use **Copy URL** to get the RTSP URL and point your application at it, exactly as you would for a file source.

The camera list updates as cameras are connected and disconnected. Webcam sources publish video only, as H.264.

The preview beside the source list shows your local camera feed while capture is active. It is not the video the board received, and it does not show the delay that a receiving application sees; if publishing fails, capture stops and the preview clears.

Selecting **Stop**, unplugging the camera, or closing the browser tab ends the stream and returns the slot to `Idle`. **Stop All**, **Reset** and **Auto Assign** also release every webcam, because each of them takes those slots away: Reset and Auto Assign clear the camera selection as well, so pick the camera again afterwards. The browser tab must stay open while the webcam is publishing: it is the component sending video to Insight. For the same reason, a webcam source is never restored as `Live` after Insight restarts — reselect the camera and start it again.

If starting a webcam fails, the message names the cause:

| What you see | What to do |
| --- | --- |
| Camera permission was denied | Allow camera access for the Insight site in your browser settings, then re-enable camera access under Media Sources → Local cameras. |
| That camera is no longer available | The camera was disconnected. Select **Refresh cameras** and reselect it. |
| The camera could not be started | Another application is using the camera. Close it and retry. |
| Could not reach the webcam publish endpoint | The browser could not reach the publish listener. Trust the `webrtcWhip` endpoint's certificate (open its URL once to accept it) and confirm the port is reachable (see [Ports and Network Behavior](ports-network.md)). |
| Webcam publish was rejected | Insight could not accept the stream. Confirm the `webrtcWhip` port is reachable (see [Ports and Network Behavior](ports-network.md)) and that your browser trusts the Insight certificate. |

Browsers only allow camera access on pages they consider secure. If **Enable camera access** does nothing, open Insight over HTTPS and trust its certificate first; see [Install and Upgrade](install-upgrade.md).

### External streams

Any RTSP, WebRTC (WHIP) or SRT tool can publish directly to a source slot, for example ffmpeg capturing a camera on the host:

```bash
ffmpeg -f v4l2 -i /dev/video0 -c:v libx264 -preset veryfast -tune zerolatency -g 30 -pix_fmt yuv420p \
  -f rtsp -rtsp_transport tcp rtsp://<insight-host>:8554/src2
```

The SDK container maps the RTSP port (8554) and the WHIP port (`webrtcWhip`, 8889); SRT publishers must run inside the container or on a DevKit-native install.

Insight shows such a slot as **External** within about two seconds: the row is read-only, the chip lists protocol, publisher address and, once probed, resolution and frame rate. The codec cell turns amber with a warning when the stream uses a codec Neat pipelines cannot decode (anything other than H.264, H.265 or MJPEG). Copy URL stays available; applications keep reading `rtsp://…/srcN` as usual, regardless of the publish protocol.

Whoever publishes first holds the slot. Starting a file on an External slot, or publishing to a slot Insight is already streaming, is rejected instead of silently replacing the running stream. **Take over** — the square stop glyph in the External row — disconnects the external publisher (and its readers) after a confirmation; the slot returns to Idle with its previous file assignment. A publisher that reconnects automatically may re-take an idle slot, so stop the external tool first when you want to reuse the slot for a file.

The Source Preview panel can show an External slot live at the source's own frame rate; the preview is **off by default** (remembered per browser) and decodes nothing while off. After selecting another external slot, a "Connecting" indicator is shown until the first frame of the new stream arrives. That wait is mostly the time until the publisher's next keyframe, so give streams you intend to preview a keyframe interval of about a second (`-g 30` at 30 fps in the example above; encoder defaults are often several seconds). Inside the SDK container, publishers and readers outside the container appear with the Docker bridge address rather than their real IP.

Auto Assign, Bulk Start, Stop All and Reset never touch an External stream; the result message lists which slots were skipped. Reset still clears the stored assignment of every slot, External ones included.

![Insight Streaming Sources view with two External slots, one of them flagged for an unsupported codec.](images/insight-external-source.png)

External slots show the publisher, its address and the probed stream format; the codec cell turns amber when Neat pipelines cannot decode the stream.

### Pulled streams

A stream that already exists on the network, typically an IP camera, can be pulled into a slot. Click the file button of an Idle slot, switch the dialog to **Stream URL**, enter the camera's `rtsp://` or `rtsps://` URL and, if the camera needs them, its username and password, then press **Pull**. Insight configures mediamtx to pull the stream and forward it unchanged to `rtsp://…:8554/srcN`; nothing is decoded or re-encoded, and applications read the slot like any other.

The row shows **Pulled** in teal once frames arrive, with the source host, resolution and frame rate in the chip and the codec in the codec cell. Before that it shows **Connecting…**. If the camera cannot be reached the row turns amber, **Unreachable**, with the reason; mediamtx keeps retrying and the row returns to Pulled by itself when the camera is back. If the camera rejects the username or password when you press **Pull**, the dialog shows the message and the slot is unchanged. The row shows **Auth failed** in red only if the camera starts rejecting the credentials later, for example after it was unreachable at first, and stays there: press **Stop** and pull again with the right credentials. A password is only ever kept in memory; Insight never writes it to disk, shows it again, or logs it, and a pulled slot is not restored after Insight restarts.

**Stop** on the row releases the pull and the slot returns to Idle with its previous file assignment. Assigning a file, starting, or taking over a pulled slot is rejected. Auto Assign, Bulk Start, Stop All and Reset skip pulled slots like External ones and list them in the result message.

The Source Preview panel works for pulled slots exactly like for External ones (preview off by default). An `rtsps://` camera with a self-signed certificate is reported as unreachable with a certificate message in this release.

### Frame rate

The Source Preview panel shows an FPS control under the file name of the selected source, and the row notes the chosen rate next to the file once it is set. When you assign a video, the control shows the frame rate detected in the file. Use the `−` and `+` buttons to change it in steps of 5, or type a whole number between 1 and 240.

When the value differs from the file's native frame rate, starting the source first creates a *rendition*: a copy of the video re-encoded at the requested constant frame rate with the same encoding rules as the Insight media catalog (H.264 baseline or H.265 main, `yuv420p`, no B-frames, one reference frame, a closed one-second GOP). The row shows **Encoding** with a progress bar in the preview panel, then goes **Live** streaming the rendition. Renditions are stored under `.renditions/` in the media directory and recorded in `renditions.json`, so the next start — including after restarting Insight — reuses them instead of encoding again. Replacing a source file with different content invalidates its old renditions. Deleting a source file removes its renditions. Byte-identical files (for example a copy under another name) share one rendition, which stays until the last of them is deleted or replaced. If encoding fails, the source file is untouched and no partial rendition is kept.

Insight encodes one rendition at a time. While another rendition is being encoded, the preview panel shows **Waiting for another rendition to finish encoding…** and the encode starts as soon as the other one is done. Before encoding, Insight checks the free space in the media directory: it needs the rendition's expected size plus 1 GB to spare, and otherwise the start fails with a message saying how much space is needed. Clear renditions or free up space, then start the source again.

MJPEG sources cannot change frame rate; the control is disabled for them.

**Clear renditions** in the Streaming Sources toolbar deletes every cached rendition (except ones a playing source is using); they are re-created on the next start.

## Video Viewer

The Video Viewer displays low-latency WebRTC streams from the video forwarder.

For channel `N`:

```text
video:    UDP 9000 + N
metadata: UDP 9100 + N
```

For example, channel `0` uses video UDP `9000` and metadata UDP `9100`; channel `1` uses video UDP `9001` and metadata UDP `9101`.

If the sender runs on a DevKit or another external machine, use the mapped `videoUDP` and `metadataUDP` host port ranges from `neat --json`. The channel math is the same, but the starting ports may be different.

The viewer can render metadata overlays for common vision outputs, including object detection, classification, pose estimation, segmentation, and tracking. Each metadata type has a **Show Overlay** switch, so its output can be hidden without changing confidence thresholds or styles. Pose Estimation also lets you show or hide joint markers and opt into landmark names; names are hidden by default to keep a full-body pose readable. The viewer can also show frame-correlated data in a separate per-channel auxiliary panel; the built-in BlazePose 3D view is the first renderer. Multiple auxiliary views appear as tabs, and the panel can be collapsed, expanded, or hidden. See [Auxiliary Visualizations](auxiliary-visualizations.md) for the protocol. Viewer settings let you tune overlay behavior such as confidence thresholds, ROI display, tracking history, and synchronization buffering. Metadata timestamps use source PTS milliseconds and are omitted when unavailable.

### Global and channel settings

Viewer settings exist in two scopes. The settings button of the viewer page opens the global settings. The button at the right end of a tile's status bar opens the settings of that channel; the dialog's title names the channel.

A channel follows the global settings. To give a channel its own value, open its settings, switch on **Own value** next to the setting, set the value and select **Save**. A value that a channel sets itself takes precedence over the global value. Switching **Own value** off again makes the channel follow the global value. Class colors work per entry: the channel's dialog shows the global entries as **from global**, and **Override** copies one into an entry of the channel.

The global dialog lists, under each setting, the channels that set their own value. **Use global value** removes a channel's own value at once, without **Save**. **Reset all channels to the global settings…** removes the own values of every channel; regions of interest are kept.

Settings are stored in the browser. They are not shared between browsers or machines.

### Metadata colors

Overlays pick colors from one shared palette of 40 colors so that different identities stay apart on a crowded frame. The first 20 colors are the most distinct; the other 20 are only used when more than 20 identities need a color at once: classes across all channels, or tracks or poses on one channel. Each metadata type defines what identity means:

| Metadata type | Colored by | Parts that share the color |
|---|---|---|
| `object-detection` | class `label` | box, label, confidence |
| `segmentation` | class `label` | mask, outline, box, label |
| `classification` | class `label` | each label line |
| `tracking` | track `id` | box, label, history trail |
| `pose-estimation` | pose `id` | keypoints, skeleton, keypoint names, box, label |

A color is allocated the first time an identity appears. Class labels share one allocation across all channels, so `bicycle` has the same color on every tile and `person` looks the same in detection, segmentation and classification. Overrides are per metadata type: an object-detection entry for `person` does not recolor `person` in segmentation or classification. Tracks and poses are allocated per channel, because an `id` is only unique within one stream; their colors start over when the channel reconnects. An identity keeps its color while it is on screen on any channel. Once it has been gone for more than 5 seconds, its color can be handed to a new identity. When more identities are on screen than the palette holds, new identities share the color of the one drawn longest ago rather than taking a color from anything visible.

Tracks and poses without an `id` draw in one neutral color. Senders that want per-person or per-track colors must include `id`.

Object detection and segmentation settings hold optional per-class overrides. An entry for a label fixes that class's color and line style. An entry labelled `default` fixes the color of every class without its own entry. Without any entries, all classes are colored automatically.

### Late metadata

An overlay is drawn only if its metadata has reached the browser by the time the video frame is shown. The viewer holds video back by the video sync buffer (300 ms by default) to give metadata that time. An application that sends metadata later than the buffer allows loses its overlays, even though video and message rate look healthy.

When at least half of the recent messages arrive after their frame, the tile shows a **Metadata late** chip in its status bar. Select it to see:

| Value | Meaning |
|---|---|
| Arrives after its frame | How long after the frame was shown its metadata arrived, as measured by this browser. |
| Video sync buffer | The buffer in effect for this channel. |
| Late messages | Share of recent messages that arrived too late to be drawn. |

The panel offers two ways to raise the buffer to a value that covers the measured lateness:

| Button | Effect |
|---|---|
| **Raise for this channel to N ms** | Sets the video sync buffer of this channel only. Other channels keep their setting. |
| **Raise globally to N ms** | Sets the global video sync buffer. It applies to every channel that has no value of its own. If this channel had its own value, that value is removed. |
| **Use global value (V ms)** | Shown instead of **Raise globally to N ms** when the global video sync buffer already covers the measured lateness. Removes this channel's own value; the global value is not changed. |

The video of every affected channel is delayed by the additional time. The viewer never changes the buffer by itself, and the panel never lowers the global buffer. After a change, the viewer waits a few seconds before it judges lateness again, because the browser moves to a larger buffer gradually.

The chip disappears once fewer than a tenth of the messages are late. If the buffer needed would exceed the maximum of 4000 ms, the panel offers no button: the application has to send its metadata sooner. If the lateness could not be measured, because the metadata does not belong to the frames that were shown, the panel says so and offers no button either.

Applications that forward the encoded input stream unchanged and send metadata only after decode and inference are the typical case, because their video does not wait for inference.

Use the Video Viewer to confirm:

- The application is sending video to the expected channel.
- Metadata is arriving on the matching metadata channel.
- Overlays align with the video frame.
- Auxiliary views clear and update with the corresponding video frame.
- Browser playback is healthy.

![Insight Video Viewer showing a four-channel WebRTC grid.](images/insight-video-viewer.png)

The Video Viewer can show one or more channels at a time, with pagination and channel selection controls for larger multi-stream tests.

## Peripherals

Peripherals lists the cameras and microphones connected to a board and shows what each one reports. SiMa Sentinel on the board discovers them; Insight reads Sentinel's catalog. Discovery reads device information only: it never opens or streams a device, so devices stay available to your applications. Only a camera preview or a microphone test opens a device, and only while it runs.

### Selected board

Insight works with one selected board, shown in the header. Select it to open the board settings, where you can change the board, test the connection, or trust a reflashed board's host key. Peripherals uses this selection. The Stats view still uses its legacy local or `cfg.json` target and does not yet follow it.

The board is chosen in this order:

- **A board you entered**: open the board settings and give its address, SSH port, and user. **Use default** returns to the automatic choice.
- **Insight installed on the board**: Insight inspects the board it runs on.
- **Neat SDK**: the DevKit paired with `sima-cli sdk setup --devkit <ip>`.

Insight connects over SSH with the keys of the account that runs it. It never asks for or stores a password. If authentication fails, the page shows the `ssh-copy-id` command that authorizes a key on the board. After a board is reflashed it presents a new SSH host key; Insight refuses to connect until you compare the fingerprints and select **Trust new key**.

### Cameras and modes

Select **Refresh** to scan the board: Insight asks SiMa Sentinel to rescan and waits for the result. Sentinel finds MIPI cameras through the media graph and the ISP, and USB cameras through V4L2. If Sentinel is not installed, not running, or too old to report peripherals, the page says so; install or update it with `sima-cli neat install sentinel`. For each camera the page shows the identity, connection, device identifier, and the pixel formats and resolutions the camera reports. No camera's resolutions show a frame rate: a MIPI camera's rate depends on the sensor mode it is running in, so it is not known before the camera runs, and the page treats every camera the same way. Insight does not set frame rates. Each mode is in one of three states, and the pixel format and resolution menus group their entries under them:

| State | Meaning |
| --- | --- |
| Available | The board's camera overlays support the camera's sensor, the ISP outputs the mode's size, and its pixel format is NV12. |
| Unverified | On a board whose ISP takes the sensor's sizes at run time (Platform 3.0), an NV12 size of a supported sensor that SiMa Sentinel cannot confirm libcamera streams exactly, because libcamera may crop it from a larger mode. It can be selected and previewed to check; it is never preselected. |
| Unsupported | Any of those fails. A USB camera is always Unsupported, because it has no camera overlay on the board, and the page shows no reason for it. For a MIPI camera the reason says which: the sensor is not in the board's camera overlays; the ISP cannot output the size; the format is not NV12; or, on a board whose ISP takes the sensor's sizes at run time (Platform 3.0), the size is wider than libcamera streams (4032 pixels on the IMX477). A Sentinel too old to report the board's camera overlays leaves every mode Unsupported until you update it. |

SiMa Sentinel decides each mode's state and gives its reason; Insight shows that answer. With a Sentinel too old to decide, Insight applies the same rule to Sentinel's catalog. The overlay check matches the sensor Sentinel links to the camera in the board's device tree against the sensors the overlays installed under `/boot` support. The NV12 condition is a fixed fact about Neat's `CameraInput`, which outputs NV12; Insight does not query Neat on the board. Every detected camera shows a **Connected** pill and its state: **Available** when any of its modes is, otherwise **Unverified** when any of its modes is, otherwise **Unsupported**; an Unverified or Unsupported camera's panel says why. Insight does not say whether another program is using a camera.

### Preview a camera

Select **Start preview** to see what a camera sees. Insight runs a GStreamer pipeline on the board over its existing connection: it captures the selected mode (`libcamerasrc` for a MIPI camera, `v4l2src` for a USB camera), scales it to at most 640 pixels wide at up to 15 fps, and sends JPEG frames back, which the page shows as they arrive. Nothing else on the board is needed beyond GStreamer itself; if `gst-launch-1.0` is missing, the preview names the packages to install (`gstreamer1.0-tools`, `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, and `gstreamer1.0-libcamera` for MIPI cameras).

A preview holds the camera, so your application cannot open it until you stop the preview. Insight will not start one on a camera another process is already using, and it never stops that process for you. Capture stops when you select **Stop**, leave the page, refresh the scan, or change the selected board. A closed browser stops it too. If Insight stops or restarts, the board pipeline exits at its next frame, once its output connection has closed; after a silent network loss it can hold the camera until the board's SSH connection times out. To clear a preview that still holds the camera, select **Stop** while the page still shows it, wait for that timeout, or end the `gst-launch-1.0` process on the board.

A MIPI camera previews its Available and Unverified modes. On a board whose ISP takes the sensor's sizes at run time (Platform 3.0), a size the sensor lists may still not be one libcamera outputs; the preview then names the size libcamera streams at so you can pick it. A USB camera previews any mode it lists in MJPG or a raw format such as YUYV, even though its modes are Unsupported for Neat's `CameraInput`; Insight opens it by its stable `/dev/v4l/by-id` path when the board has one.

While a preview runs, the mode beside it shows the camera's frame rate, which can be faster than the preview's 15 fps. The preview asks the camera for the selected mode's rate. For a USB camera the rate shown is that mode's rate. For a MIPI camera it is the most the sensor delivers in this mode, shown as "up to", which Insight asks SiMa Sentinel for once the first frame arrives, so it appears a few seconds after the picture; if Sentinel cannot report it, no rate is shown.

### Camera setup

A Sentinel that reads the board's device tree also reports how the board is set up for cameras. After a Refresh, the board settings show the board **Model** and a **Camera setup** line naming the overlays the board loads that configure a camera sensor. With an older Sentinel, these details do not appear.

### Microphones

Refresh also lists every ALSA capture device SiMa Sentinel reports, USB or on-board. For each microphone Insight shows its name, the ALSA device name to open it with (for example `hw:CARD=Nano,DEV=0`), and, for USB audio devices, the sample formats, channel counts, bit depths, and sample rates it captures. On-board sound cards do not report these, and the page says so.

Discovery never opens a sound device: Sentinel reads `/proc/asound` and sysfs. A USB microphone keeps the same identity when it is unplugged and plugged back into the same port, even when its card number changes; in another port it is a different microphone.

To hear a microphone, select **Test microphone** and speak; the level meter shows what the microphone hears. Select **Stop recording** when you are done (a test stops by itself after 30 seconds), and Insight plays the recording back in the page. **Stop playing** ends the playback. If the recording stays below about -60 dBFS, the page says nothing was picked up; check the microphone's mute button and gain. Only the test opens the device, and only while it records. Before recording, Insight re-reads Sentinel's catalog and records only from the device Sentinel names; if the board's devices changed since the last scan, the page asks you to refresh first. If another application has the microphone open, the test is refused and that application is left alone. Insight does not configure audio input: Core has no audio input.

## Stats

The Stats view is a placeholder in the current release. It marks the planned location for system load and runtime metrics while an application is running, including CPU, memory, disk, temperature when available, MLA memory, and profiling timeline data streamed through Insight.

This feature is intended to be completed in the next release. Once complete, use Stats when you need to separate application behavior from system behavior. For example, a dropped frame problem may come from the application stream path, but it may also correlate with CPU load, memory pressure, or device runtime state.

## System Information

The system information panel summarizes the environment Insight can see. In the Neat Development Environment, it can show SDK and component information, Insight status, update information, and exposed port mappings such as `mainUI` and `videoUI`.

This is the first place to check when a URL does not match the default port. Insight reads the available port map and uses the mapped `videoUI` port when opening the viewer. For command-line workflows, `neat --json` shows the same port-map information.
