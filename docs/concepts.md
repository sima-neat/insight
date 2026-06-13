---
title: Concepts
description: Understand how Insight fits into the Neat application development workflow.
sidebar_position: 1
---

# Concepts

Insight sits beside your application while you build and test. It does not replace the Neat Library or your application runtime. Instead, it gives you a browser view into the artifacts and signals that are normally scattered across the SDK container, the DevKit, log files, media files, and streaming ports.

```text
Neat Development Environment or DevKit

  Workspace files        Media files           Neat application
       |                    |                         |
       v                    v                         v
  Workspace tab  ->  RTSP Source tab  ->  video UDP 9000-9079
                                      ->  metadata UDP 9100-9179
                                                   |
                                                   v
                                           Video Viewer tab
                                                   |
                                                   v
                                      Stats placeholder and logs
```

The typical loop is:

1. Inspect the workspace and application artifacts.
2. Upload or select media files for testing.
3. Turn media files into RTSP sources such as `rtsp://127.0.0.1:8554/src1`.
4. Run your application against those sources.
5. Watch the application output in the Video Viewer.
6. Use system information and logs to diagnose performance or runtime issues. The Stats view is present as a placeholder in this release and is planned to be completed in the next release.

## What Insight is for

Insight is designed for vision ML application development and validation. It helps you see whether media, runtime output, metadata, and system behavior line up during a test run.

Use Insight to:

- Prepare repeatable video inputs.
- Confirm that application output reaches the expected viewer channel.
- Render metadata overlays for common vision outputs.
- Inspect generated model, package, source, and profiling artifacts.
- Compare application symptoms with device or SDK runtime state. The Stats view is the planned location for this workflow, but it is a placeholder in the current release.

## What Insight is not

Insight is not the primary application runtime and it is not a replacement for the Neat Library APIs. Your application still runs through the normal Neat runtime path. Insight observes, visualizes, and helps configure the supporting test loop.
