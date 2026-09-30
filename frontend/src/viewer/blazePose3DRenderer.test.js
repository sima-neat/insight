import assert from "node:assert/strict";
import test from "node:test";

import { drawBlazePose3D, projectWorldPoint } from "./blazePose3DRenderer.js";

function recordingContext() {
  const calls = [];
  return {
    calls,
    beginPath() { calls.push(["beginPath"]); },
    moveTo(x, y) { calls.push(["moveTo", x, y]); },
    lineTo(x, y) { calls.push(["lineTo", x, y]); },
    stroke() { calls.push(["stroke"]); },
    arc(x, y, radius) { calls.push(["arc", x, y, radius]); },
    fill() { calls.push(["fill"]); },
    fillText(text) { calls.push(["fillText", text]); },
  };
}

test("the native projection preserves depth as a visible screen displacement", () => {
  const near = projectWorldPoint({ x: 0, y: 0, z: 0 });
  const deep = projectWorldPoint({ x: 0, y: 0, z: 1 });

  assert.ok(near);
  assert.ok(deep);
  assert.notEqual(near.x, deep.x);
  assert.notEqual(near.y, deep.y);
});

test("BlazePose 3D renderer draws connected world keypoints", () => {
  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 240, height: 180 }, {
    poses: [{
      id: "pose_1",
      keypoints: [
        { name: "left_shoulder", x: -0.2, y: -0.4, z: 0.1, confidence: 0.9 },
        { name: "left_elbow", x: -0.4, y: 0, z: 0.2, confidence: 0.8 },
        { name: "left_wrist", x: -0.5, y: 0.4, z: 0.3, confidence: 0.95 },
      ],
    }],
  });

  assert.ok(ctx.calls.some(([name]) => name === "lineTo"));
  assert.equal(ctx.calls.filter(([name]) => name === "arc").length, 3);
});

test("empty or invalid BlazePose payloads render a stable empty state", () => {
  for (const payload of [{}, { poses: [] }, { poses: [{ keypoints: [{ name: "nose", x: "bad" }] }] }]) {
    const ctx = recordingContext();
    assert.doesNotThrow(() => drawBlazePose3D(ctx, { width: 120, height: 90 }, payload));
    assert.ok(ctx.calls.some(([name, text]) => name === "fillText" && /No 3D pose/.test(text)));
  }
});
