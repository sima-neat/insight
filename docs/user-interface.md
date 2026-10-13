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

You can assign media to a source, start and stop individual sources, auto-assign unique files across source slots, bulk start sources, stop all streams, and copy stream URLs for use by applications or test harnesses.

This view is useful when you need repeatable input streams for an object detection, segmentation, tracking, classification, or GenAI vision application.

![Insight Streaming Sources view showing assigned source slots and source preview.](images/insight-rtsp-source.png)

The Streaming Sources view lets you assign media files to source slots, start or stop streams, copy the active stream URL, and preview the selected source before wiring it into an application.

### Use a webcam as a source

A webcam attached to the computer running your browser can be used as a live source, so you can test an application against a real camera without copying a file onto the board first.

1. Go to Media Sources and, under **Local cameras**, select **Enable camera access**. The browser asks for camera permission; Insight cannot grant it for you.
2. After you allow access, your cameras appear in each source dropdown under a **Cameras** group, above your video files:

   ```text
   Not assigned
   Cameras
     Integrated Camera
     USB Camera
   Video files
     catalog/parking_garage_cars/parking_garage_cars_1080p.mp4
   ```

3. Select a camera for a source slot, then select **Start**. The row shows a `[CAM]` badge (video files show `[VID]`), the browser publishes the camera to Insight, and the slot reports `Live`.
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

Select **Refresh** to scan the board: Insight asks SiMa Sentinel to rescan and waits for the result. Sentinel finds MIPI cameras through the media graph and the ISP, and USB cameras through V4L2. If Sentinel is not installed, not running, or too old to report peripherals, the page says so; install or update it with `sima-cli neat install sentinel`. For each camera the page shows the identity, connection, device identifier, and the pixel formats and resolutions the camera reports. No camera's resolutions show a frame rate: a MIPI camera's rate depends on the sensor mode it is running in, so it is not known before the camera runs, and the page treats every camera the same way. Insight does not set frame rates. Each mode is in one of two states, and the pixel format and resolution menus group their entries under them:

| State | Meaning |
| --- | --- |
| Available | The board's camera overlays support the camera's sensor, the ISP outputs the mode's size, and its pixel format is NV12. |
| Unsupported | Any of those fails. A USB camera is always Unsupported, because it has no camera overlay on the board, and the page shows no reason for it. For a MIPI camera the reason says which: the sensor is not in the board's camera overlays; the ISP cannot output the size; the format is not NV12; or, on a board whose ISP takes the sensor's sizes at run time (Platform 3.0), the size is wider than libcamera streams (4032 pixels on the IMX477). A Sentinel too old to report the board's camera overlays leaves every mode Unsupported until you update it. |

SiMa Sentinel decides each mode's state and gives its reason; Insight shows that answer. With a Sentinel too old to decide, Insight applies the same rule to Sentinel's catalog. The overlay check matches the sensor Sentinel links to the camera in the board's device tree against the sensors the overlays installed under `/boot` support. The NV12 condition is a fixed fact about Neat's `CameraInput`, which outputs NV12; Insight does not query Neat on the board. Every detected camera shows a **Connected** pill and its state: **Available** when any of its modes is, otherwise **Unsupported**, and the camera's panel says why. Insight does not say whether another program is using a camera.

### Preview a camera

Select **Start preview** to see what a camera sees. Insight runs a GStreamer pipeline on the board over its existing connection: it captures the selected mode (`libcamerasrc` for a MIPI camera, `v4l2src` for a USB camera), scales it to at most 640 pixels wide at up to 15 fps, and sends JPEG frames back, which the page shows as they arrive. Nothing else on the board is needed beyond GStreamer itself; if `gst-launch-1.0` is missing, the preview names the packages to install (`gstreamer1.0-tools`, `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, and `gstreamer1.0-libcamera` for MIPI cameras).

A preview holds the camera, so your application cannot open it until you stop the preview. Insight will not start one on a camera another process is already using, and it never stops that process for you. Capture stops when you select **Stop**, leave the page, refresh the scan, or change the selected board. A closed browser stops it too. If Insight stops or restarts, the board pipeline exits at its next frame, once its output connection has closed; after a silent network loss it can hold the camera until the board's SSH connection times out. To clear a preview that still holds the camera, select **Stop** while the page still shows it, wait for that timeout, or end the `gst-launch-1.0` process on the board.

A MIPI camera previews its Available modes. On a board whose ISP takes the sensor's sizes at run time (Platform 3.0), a size the sensor lists may still not be one libcamera outputs; the preview then names the size libcamera streams at so you can pick it. A USB camera previews any mode it lists in MJPG or a raw format such as YUYV, even though its modes are Unsupported for Neat's `CameraInput`; Insight opens it by its stable `/dev/v4l/by-id` path when the board has one.

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
