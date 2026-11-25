---
title: Auxiliary Visualizations
description: What the Viewer draws, and where the metadata types it draws are defined.
sidebar_position: 4
---

# Auxiliary Visualizations

The Viewer draws an app's results over its video only: boxes, classes, tracks, poses and masks,
the metadata types the [contracts](contracts.md#types) define. It has no panel beside the video,
and no 3D view.

A message of another type, `auxiliary-visualization` (the BlazePose 3D panel of earlier Insight
releases) among them, is ignored ([What Insight ignores](contracts.md#what-insight-ignores)). To
show a body pose, send it as `pose-estimation` in video pixels.
