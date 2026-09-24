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

## Video Viewer

The Video Viewer displays low-latency WebRTC streams from the video forwarder.

For channel `N`:

```text
video:    UDP 9000 + N
metadata: UDP 9100 + N
```

For example, channel `0` uses video UDP `9000` and metadata UDP `9100`; channel `1` uses video UDP `9001` and metadata UDP `9101`.

If the sender runs on a DevKit or another external machine, use the mapped `videoUDP` and `metadataUDP` host port ranges from `neat --json`. The channel math is the same, but the starting ports may be different.

The viewer can render metadata overlays for common vision outputs, including object detection, classification, pose estimation, segmentation, and tracking. Viewer settings let you tune overlay behavior such as confidence thresholds, ROI display, tracking history, and synchronization buffering. Metadata timestamps use source PTS milliseconds and are omitted when unavailable.

Use the Video Viewer to confirm:

- The application is sending video to the expected channel.
- Metadata is arriving on the matching metadata channel.
- Overlays align with the video frame.
- Browser playback is healthy.

![Insight Video Viewer showing a four-channel WebRTC grid.](images/insight-video-viewer.png)

The Video Viewer can show one or more channels at a time, with pagination and channel selection controls for larger multi-stream tests.

## Peripherals

Peripherals lists the cameras connected to a board and shows the modes each camera reports. Discovery reads device information only: it does not publish a stream, so cameras stay available to your applications, apart from the moment a scan reads a MIPI camera's own modes. The camera export API also works from the cached scan without touching the board.

### Selected board

Insight works with one selected board, shown in the header. Select it to open the board settings, where you can change the board, test the connection, or trust a reflashed board's host key. Peripherals uses this selection. The Stats view still uses its legacy local or `cfg.json` target and does not yet follow it.

The board is chosen in this order:

- **A board you entered**: open the board settings and give its address, SSH port, and user. **Use default** returns to the automatic choice.
- **Insight installed on the board**: Insight inspects the board it runs on.
- **Neat SDK**: the DevKit paired with `sima-cli sdk setup --devkit <ip>`.

Insight connects over SSH with the keys of the account that runs it. It never asks for or stores a password. If authentication fails, the page shows the `ssh-copy-id` command that authorizes a key on the board. After a board is reflashed it presents a new SSH host key; Insight refuses to connect until you compare the fingerprints and select **Trust new key**.

### Cameras and modes

Select **Refresh** to scan the board. Insight finds MIPI cameras through libcamera and the media graph, and USB cameras through V4L2. For each camera it shows the identity, connection, device identifier, availability, and the pixel formats, resolutions, and frame rates the camera reports. Each camera and mode has a support level:

| Level | Meaning |
| --- | --- |
| Verified | The mode has been validated with Core `CameraInput`. |
| Advertised | The camera reports the mode, but it has not been validated with Core. It can still fail when capture starts. |
| Not supported | Core `CameraInput` cannot use it. This includes USB cameras, raw sensor formats, and formats other than NV12. |

To read a MIPI camera's modes, Refresh briefly opens the camera through libcamera without streaming. Cameras that another application is using are skipped and keep the modes from the previous scan. Availability names the process that holds a camera; Insight can see other users' processes only when it runs as root or the board allows passwordless `sudo`, and reports **Unknown** otherwise.

### Camera configuration API

The page lets you inspect formats, resolutions, and frame rates. It does not currently include a copy or download action. API clients can post a selected mode to `/api/peripherals/cameras/export` and receive Python (`pyneat.CameraInputOptions`), C++, and JSON representations. An Apps `config.yaml` `camera:` block is included only when the installed `libcamerasrc` supports the required capture-buffer option. Exports always name the camera explicitly. For USB cameras the API returns a device descriptor, not a `CameraInput` configuration.

Two behaviors measured on a Modalix DevKit shape the export. It allows CPU fallback (`allow_cpu_fallback = True`), because strict zero-copy did not start there. And the camera delivers the frame rate of the sensor mode libcamera picks, not the requested rate: an IMX477 at 1920×1080 delivered about 66 fps when 15 or 30 fps was requested. Drop frames in your application if you need fewer.

## Stats

Stats reads the board's own telemetry from Sentinel, the `simaai-sentinel` daemon, so you can separate application behavior from device behavior. A dropped frame may come from the stream path, but it may also correlate with board power, on-die temperature, CPU load, or memory pressure.

Stats works on the selected board, chosen in the same **Board** panel the Peripherals page uses.

### Sentinel daemon

The page first reports whether Sentinel is installed and running on that board, and its version. When it is missing, select **Install Sentinel**: Insight runs `sima-cli neat install sentinel` on the board itself, which needs `sima-cli` there and passwordless `sudo`. When either is missing, the page names the command to run in a shell on the board instead. An installed and running daemon is never reinstalled from here, because the installer restarts it and would end a trace in flight.

### Live metrics

While the tab is open and visible, Insight polls Sentinel's latest sample every two seconds and shows each value with the label, unit, group, and thresholds Sentinel defines for it, ranked as normal, warning, or critical. A metric the board cannot measure reads as an em dash, never as zero. Recent samples are drawn as a sparkline beside each value. Use **Pause updates** to stop polling; it also stops on its own when the browser tab is hidden or the view is left.

### Traces and runs

A trace records every sample around a workload. Name it, optionally add a note and tags, and select **Start trace**; **Stop trace** saves it as a run on the board. Sentinel records one trace at a time and refuses a name a saved run already uses. Saved runs are listed with their state, start time, duration, and sample count, and survive a daemon restart. Open a run to see it summarised: every metric it recorded, with the label, unit, group and thresholds that were in force at the time, and the smallest, largest and mean value over that run's samples. A metric that crossed its warning or critical threshold at any point in the run is marked. The run's metadata — its name, note, sample interval, Sentinel version, and the board it ran on — sits below that.

Select two to eight runs and **Compare selected** to put the metrics in rows and the runs in columns. Sentinel measures the comparison against one baseline run, which is marked in the header; every other cell shows that metric's mean over the run with its percentage change against the baseline beside it. A change too small to print shows as “<0.01%” rather than as no change at all.

Where a cell shows “—” in place of a change, Sentinel withheld one, and the table says which of its reasons applies rather than leaving one em dash to stand for all of them. A list under the table counts each reason, and every “—” carries the same sentence for a pointer or a screen reader. The reasons are:

- **Sentinel publishes no change for it.** Run totals — duration, energy and sample count — are reported per run without a percentage.
- **The baseline measured 0, and there is no percentage change from 0.** The baseline did measure the metric; there is simply no percentage from zero. This is common for per-core CPU usage on an idle baseline, and it is where the change is often largest: a core that averaged 0% in the baseline and 5.9% in the other run shows “—” here, so read the two values rather than the change.
- **The baseline run has no value for that metric.** The only case in which the baseline never measured it.
- **This run has no value for that metric.** Where a run was listed but Sentinel summarised nothing for it, the whole column reads this way and is called out above the table.

Run totals are shown in the units the rest of the view uses: a duration Sentinel reports in milliseconds reads in seconds, and energy in joules.

### Values from a board you have left

Reading a board takes an SSH round trip, so an answer can arrive after you have selected another board. Insight keeps those values and labels them with the board they came from, with a way to read them again, rather than showing them as the current board's.

### Insight host

Below the runs, a compact panel reports the machine Insight itself runs on — the SDK container, or the board Insight is installed on — from `/api/metrics`: CPU load, memory, disk, and a temperature where the platform exposes one. It answers a different question from the board telemetry above it, such as whether the container is running out of disk, and it is read every 15 seconds rather than every two. When the legacy `REMOTE_DEVKIT` configuration is set, this panel reports that connection instead, and says so.

### NEAT profiling timeline

Last on the tab, the profiling timeline plots numeric fields from the profiling events Insight streams from a running application. It is independent of Sentinel: it measures the application, not the device.

## System Information

The system information panel summarizes the environment Insight can see. In the Neat Development Environment, it can show SDK and component information, Insight status, update information, and exposed port mappings such as `mainUI` and `videoUI`.

This is the first place to check when a URL does not match the default port. Insight reads the available port map and uses the mapped `videoUI` port when opening the viewer. For command-line workflows, `neat --json` shows the same port-map information.
