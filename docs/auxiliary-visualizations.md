---
title: Auxiliary Visualizations
description: Send frame-correlated data to a viewer-side visualization panel.
sidebar_position: 4
---

# Auxiliary Visualizations

The Video Viewer can render data that does not belong on top of the video in a
separate panel. Each channel owns its panel. The first built-in renderer displays
BlazePose world landmarks as a projected 3D skeleton inside an optional reference
cube.

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

## BlazePose camera controls

Open a tile's menu and select **3D Pose** in Viewer Configuration to control
that channel independently. The panel can be shown or hidden, rendered compact,
collapsed, or expanded, and given an initial camera yaw and pitch. The reference
cube can also be hidden when only the skeleton is wanted. Global Viewer
Configuration establishes defaults, while settings opened from a tile apply to
that channel. The tile's collapse, expand, and hide buttons update the same
channel setting.

The BlazePose view orbits around the world-landmark skeleton by default so depth
and limb placement are visible from more than one angle. The controls below the
canvas can:

- show or hide the labeled reference cube;
- enable or disable automatic orbit;
- change the orbit speed;
- pause or resume the current orbit; and
- reset the camera to its default angle.

Drag directly on the canvas to inspect the pose manually. Dragging pauses the
orbit at the selected angle; select **Resume** to continue. The cube and camera
settings stay synchronized with Viewer Configuration for that channel. Orbit
speed and pause state remain browser-local and are stored separately for every
channel and auxiliary view ID, so adjusting one stream does not change another
stream.

Animation runs only while the selected view has frame-correlated data and its
panel is visible. It stops when data is missing, the panel is collapsed or
hidden, another tab is selected, or the viewer is closed.

## Multiple views and overlays

Send one metadata message per view and use a distinct `data.id`. Several views
for the same timestamp appear as tabs in one panel. A frame can also carry
ordinary overlay messages such as `pose-estimation`; overlays continue to draw
on the video while auxiliary data renders separately. All messages for the frame
must use the same source PTS timestamp and channel.

The selected tab is stored per channel in the browser. Missing, late, expired,
malformed, and unknown-renderer messages never reuse data from a previous frame.

## Adding a renderer

Viewer renderers are explicitly registered in
`frontend/src/viewer/auxiliaryVisualization.js`; metadata cannot load code or
select arbitrary modules. A renderer supplies a stable name, a default title,
and a `draw(context, viewport, payload, frame)` function. Keep payload validation
inside the renderer and treat malformed input as an empty view.

Interactive renderers may also provide `createSession()`. The returned session
can expose declarative controls through `getControls()` and `applyControl()`,
pointer handlers, and `isAnimating()`. The generic panel owns animation-frame
scheduling and browser persistence, calls the session `draw()` method, and calls
`destroy()` when the view is hidden, collapsed, replaced, switched away from,
reset, or unmounted. A renderer must not start its own animation loop.

Run the reusable viewer checks after changing the protocol or a renderer:

```bash
cd frontend
npm ci
npm run test:auxiliary
npm run test:viewer
npm run build:viewer
```
