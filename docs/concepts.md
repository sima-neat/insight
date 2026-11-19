---
title: Concepts
description: Understand how Insight fits into the Neat application development workflow.
sidebar_position: 1
---

# Concepts

Insight sits beside your app while you build and test it. It does not run your app or replace your
editor and terminal: it gives your app video to read, and shows you what your app sends back.

- **Source** (`src1` to `src48`): a video stream Insight serves over RTSP for your app to read. It
  plays a file from the media library in a loop, your browser's webcam, or an IP camera Insight
  pulls; another program may also publish into a free source. You set sources up on the
  **Streaming** page.
- **Media library**: the video files sources play. You import them on the **Media** page from your
  computer or from SiMa's catalog of test videos. In the SDK the library is
  `/workspace/.insight-media`, so it survives a restart of the container.
- **Channel** (`0` and up): one tile of the **Viewer**. Your app shows up on channel `N` by sending
  its video to one UDP port and its metadata (the AI results as JSON) to another; Insight matches
  each message to its video frame and draws it there. Source and channel numbers are independent.
- **Board**: the one board Insight inspects on the **Peripherals** and **Stats** pages, reached
  over SSH: the board Insight runs on, the DevKit paired with the SDK, or one you enter.
- **Sentinel** (`simaai-sentinel`): SiMa's service on the board that reports its cameras,
  microphones and telemetry. Peripherals and Stats read from it; Insight installs nothing on the
  board.

The [contracts](contracts.md) give the exact rules for sources and channels, and
[Ports and network](ports-network.md) gives the ports.
