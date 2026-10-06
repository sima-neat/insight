---
title: Auxiliary Visualizations
description: Send frame-correlated data to a viewer-side visualization panel.
sidebar_position: 4
---

# Auxiliary Visualizations

The Video Viewer can show frame-correlated data beside the video instead of as
an overlay. Each channel has an independent panel, and multiple views appear as
tabs. Insight routes an opaque JSON payload to a registered renderer; the first
built-in renderer displays BlazePose world landmarks as a 3D skeleton.

Send auxiliary data to the channel's metadata UDP port (`metadataUDP + N`). Set
`timestamp` to the source video PTS in integer milliseconds. The viewer accepts
auxiliary data only for the exact decoded RTP frame and keeps the last matched
view for at most 160 milliseconds during a brief delivery gap.

## Message contract

```json
{
  "type": "auxiliary-visualization",
  "timestamp": 1234,
  "frame_id": "42",
  "data": {
    "schema_version": 1,
    "id": "world-pose",
    "renderer": "blazepose-3d",
    "title": "3D Pose",
    "payload": {
      "poses": [{
        "id": "pose_1",
        "keypoints": [
          {"name": "nose", "x": 0.01, "y": -0.42, "z": -0.08, "confidence": 0.98}
        ]
      }]
    }
  }
}
```

| Field | Requirement |
| --- | --- |
| `schema_version` | Integer `1`; unknown versions are ignored. |
| `id` | Stable, non-empty view identifier. |
| `renderer` | Registered viewer renderer; unknown names are ignored. |
| `title` | Optional panel label. |
| `payload` | Renderer-specific JSON object. |

The envelope is not pose-specific. A point cloud, mesh, chart, or another 3D
view can register a renderer and define its own payload without changing the
transport or panel.

## BlazePose 3D

The `blazepose-3d` payload accepts `poses[]`, each containing named
`keypoints[]` with finite `x`, `y`, and `z` world coordinates. Confidence is
optional; lower-confidence joints fade instead of disappearing. The skeleton
uses distinct colors for the head, torso, subject-left, and subject-right body
regions. Multiple poses also receive distinct outline colors.

Open **3D Pose** in Viewer Configuration to set visibility, panel size,
transparency, camera yaw and pitch, and reference-cube visibility globally or
per channel. Panel controls can toggle the cube or reset the camera; dragging
the canvas selects a fixed view angle. The renderer draws each correlated frame
directly and does not smooth or animate it independently from the 2D overlay.

The default camera uses a stable metric frame. Producers can override it with
`payload.view.center.{x,y,z}` and `payload.view.half_extent`.

## Multiple views and renderers

Send one message per view with a distinct `data.id`; up to 16 views for one
timestamp appear as tabs. Ordinary overlay messages can use the same frame and
continue to render on the video. Keep the channel and source PTS identical for
all data belonging to that frame.

Renderers are registered in
`frontend/src/viewer/auxiliaryVisualization.js`. A renderer provides a name,
title, and `draw(context, viewport, payload, frame)` function. Interactive
renderers can also provide a session with controls and pointer handlers. The
panel owns redraw scheduling, settings, and cleanup.

Run the viewer checks after changing the protocol or a renderer:

```bash
cd frontend
npm ci
npm run test:viewer
npm run build:viewer
```
