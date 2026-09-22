---
title: Auxiliary Visualizations
description: Send frame-correlated data to a viewer-side visualization panel.
sidebar_position: 4
---

# Auxiliary Visualizations

The Video Viewer can render data that does not belong on top of the video in a
separate panel. Each channel owns its panel. The first built-in renderer displays
BlazePose world landmarks as a projected 3D skeleton.

Send auxiliary data through the same metadata UDP port as overlays: channel `N`
uses `metadataUDP + N` (UDP `9100 + N` with the default mapping). Set the
top-level `timestamp` to the source video PTS in integer milliseconds. Auxiliary
data is frame-strict: the panel updates only when Insight correlates the message
to the exact decoded RTP frame, and it clears for a frame with no matching data.
`frame_id` is retained for diagnostics but is not used for correlation.

## Message contract

The outer message uses the normal Insight metadata envelope:

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
      "poses": [
        {
          "id": "pose_1",
          "keypoints": [
            {"name": "nose", "x": 0.01, "y": -0.42, "z": -0.08, "confidence": 0.98}
          ]
        }
      ]
    }
  }
}
```

Fields under `data` have these meanings:

| Field | Requirement |
| --- | --- |
| `schema_version` | Integer `1`. Unknown versions are ignored. |
| `id` | Stable non-empty identifier for this view. A later message with the same ID replaces that view for the frame. |
| `renderer` | Name of a renderer compiled into Insight. Unknown names are ignored safely. |
| `title` | Optional panel label. |
| `payload` | Renderer-specific JSON object. |

The `blazepose-3d` payload accepts `poses[]`; every pose contains an ID and named
`keypoints[]` with finite `x`, `y`, and `z` world coordinates. `confidence` is
optional and points below `0.3` are omitted. Multiple poses receive distinct
colors.

## Multiple views and overlays

Send one metadata message per view and use a distinct `data.id`. Several views
for the same timestamp appear as tabs in one panel. A frame can also carry
ordinary overlay messages such as `pose-estimation`; overlays continue to draw
on the video while auxiliary data renders separately. All messages for the frame
must use the same source PTS timestamp and channel.

The panel can be collapsed, expanded over its tile, or hidden. Its mode and
selected tab are stored per channel in the browser. Missing, late, expired,
malformed, and unknown-renderer messages never reuse data from a previous frame.

## Adding a renderer

Viewer renderers are explicitly registered in
`frontend/src/viewer/auxiliaryVisualization.js`; metadata cannot load code or
select arbitrary modules. A renderer supplies a stable name, a default title,
and a `draw(context, viewport, payload, frame)` function. Keep payload validation
inside the renderer and treat malformed input as an empty view.

Run the reusable viewer checks after changing the protocol or a renderer:

```bash
cd frontend
npm ci
npm run test:auxiliary
npm run test:viewer
npm run build:viewer
```

