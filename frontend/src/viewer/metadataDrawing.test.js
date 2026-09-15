import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { drawMetadata } from "./metadataDrawing.js";

const drawingSource = readFileSync(
  new URL("../../../webrtc/static/drawing.js", import.meta.url),
  "utf8",
);

function loadStrategies(t) {
  const previousWindow = globalThis.window;
  const window = {};
  vm.runInNewContext(drawingSource, { window });
  globalThis.window = window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return window.drawStrategies;
}

function recordingContext() {
  const stack = [];
  return {
    lineDash: [],
    globalAlpha: 1,
    strokes: [],
    save() { stack.push({ lineDash: [...this.lineDash], globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stack.pop()); },
    setLineDash(value) { this.lineDash = [...value]; },
    strokeRect() { this.strokes.push([...this.lineDash]); },
    stroke() { this.strokes.push([...this.lineDash]); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    fillText() {},
  };
}

test("detection styles do not leak into pose skeletons or the next frame", (t) => {
  loadStrategies(t);
  const canvas = { clientWidth: 640, clientHeight: 480 };
  const video = { videoWidth: 640, videoHeight: 480 };
  const detection = {
    type: "object-detection",
    data: { objects: [{ label: "person", confidence: 1, bbox: [10, 20, 30, 40] }] },
  };
  const pose = {
    type: "pose-estimation",
    data: { poses: [{ keypoints: [
      { name: "nose", x: 20, y: 20, confidence: 1 },
      { name: "left_eye", x: 30, y: 30, confidence: 1 },
    ] }] },
  };

  for (const [style, dash] of [["dashed", [6, 4]], ["dotted", [2, 2]]]) {
    const ctx = recordingContext();
    const settings = { general: { showRoi: false }, type: { objects: [{ label: "default", style }] } };
    drawMetadata(ctx, canvas, detection, video, 0, { settings });
    drawMetadata(ctx, canvas, pose, video, 0, { settings });
    drawMetadata(ctx, canvas, pose, video, 0, { settings });

    assert.deepEqual(ctx.strokes, [dash, [], []]);
    assert.deepEqual(ctx.lineDash, []);
  }
});

test("drawing restores canvas state even when a strategy throws", (t) => {
  const strategies = loadStrategies(t);
  const ctx = recordingContext();
  strategies.failing = (context) => {
    context.setLineDash([6, 4]);
    context.globalAlpha = 0.4;
    throw new Error("drawing failed");
  };

  assert.throws(() => drawMetadata(ctx, {}, { type: "failing" }, {}, 0, {}), /drawing failed/);
  assert.deepEqual(ctx.lineDash, []);
  assert.equal(ctx.globalAlpha, 1);
});

test("unknown metadata cannot invoke inherited properties as drawing strategies", (t) => {
  const strategies = loadStrategies(t);
  Object.setPrototypeOf(strategies, { inherited: () => assert.fail("inherited strategy invoked") });
  strategies.disabled = false;
  for (const type of ["unknown", "__proto__", "constructor", "inherited", "disabled", null, { toString: null }]) {
    assert.doesNotThrow(() => drawMetadata(recordingContext(), {}, { type }, {}, 0, {}));
  }
});
