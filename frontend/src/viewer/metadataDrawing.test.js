import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { drawMetadata } from "./metadataDrawing.js";

const drawingSource = readFileSync(
  new URL("../../../webrtc/static/drawing.js", import.meta.url),
  "utf8",
);

function loadStrategies(t, polygons = []) {
  const previousWindow = globalThis.window;
  const window = {};
  vm.runInNewContext(drawingSource, {
    window, performance, console,
    localStorage: { getItem: () => JSON.stringify(polygons) },
  });
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
    fills: [],
    boxes: [],
    texts: [],
    save() { stack.push({ lineDash: [...this.lineDash], globalAlpha: this.globalAlpha }); },
    restore() { Object.assign(this, stack.pop()); },
    setLineDash(value) { this.lineDash = [...value]; },
    strokeRect(...box) { this.strokes.push([...this.lineDash]); this.boxes.push(box); },
    stroke() { this.strokes.push([...this.lineDash]); },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() { this.fills.push(this.fillStyle); },
    fillRect() {},
    measureText(text) { return { width: text.length * 7 }; },
    fillText(text) { this.texts.push(text); },
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

  const warn = t.mock.method(console, "warn", () => {});
  for (let i = 0; i < 3; i += 1) {
    assert.doesNotThrow(() => drawMetadata(ctx, {}, { type: "failing" }, {}, 0, {}));
  }
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(ctx.lineDash, []);
  assert.equal(ctx.globalAlpha, 1);
});

test("pose landmark names are opt-in while joint markers remain configurable", (t) => {
  loadStrategies(t);
  const canvas = { clientWidth: 640, clientHeight: 480 };
  const video = { videoWidth: 640, videoHeight: 480 };
  const pose = {
    type: "pose-estimation",
    data: { poses: [{ keypoints: [{ name: "nose", x: 20, y: 20, confidence: 1 }] }] },
  };

  const clean = recordingContext();
  drawMetadata(clean, canvas, pose, video, 0, {
    settings: { general: {}, type: { showKeypoints: true, showKeypointLabels: false } },
  });
  assert.equal(clean.fills.length, 1);
  assert.deepEqual(clean.texts, []);

  const labeled = recordingContext();
  drawMetadata(labeled, canvas, pose, video, 0, {
    settings: { general: {}, type: { showKeypoints: false, showKeypointLabels: true } },
  });
  assert.equal(labeled.fills.length, 0);
  assert.deepEqual(labeled.texts, ["nose"]);
});

test("a malformed pose does not stop tracking or later frames", (t) => {
  loadStrategies(t);
  t.mock.method(console, "warn", () => {});
  const canvas = { clientWidth: 640, clientHeight: 480 };
  const video = { videoWidth: 640, videoHeight: 480 };
  const ctx = recordingContext();
  const malformed = { type: "pose-estimation", data: { poses: [{ keypoints: {} }] } };
  const tracking = { type: "tracking", data: { tracks: [{ id: 1, bbox: [10, 20, 30, 40] }] } };
  const settings = { general: { showRoi: false }, type: {} };

  for (let frame = 0; frame < 2; frame += 1) {
    for (const message of [malformed, tracking]) {
      assert.doesNotThrow(() => drawMetadata(ctx, canvas, message, video, 1, { settings }));
    }
  }
  assert.equal(ctx.boxes.length, 2);
});

test("shared ROI is drawn once in any metadata order and filtering still applies", (t) => {
  loadStrategies(t, [{ type: "inclusion", points: [
    { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 },
  ] }]);
  const canvas = { clientWidth: 640, clientHeight: 480 };
  const video = { videoWidth: 640, videoHeight: 480 };
  const boxes = [[10, 20, 30, 40], [500, 300, 30, 40]];
  const messages = [
    { type: "object-detection", data: { objects: boxes.map(bbox => ({ bbox, label: "person", confidence: 1 })) } },
    { type: "segmentation", data: { segments: boxes.map(bbox => ({ bbox, mask_format: "polygon", mask: [[10, 20], [40, 20], [10, 60]] })) } },
    { type: "tracking", data: { tracks: boxes.map((bbox, id) => ({ bbox, id })) } },
  ];
  const settings = { general: { showRoi: true }, type: {} };
  const ctx = recordingContext();
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const frameState = {};
    const before = ctx.fills.filter(color => color === "rgba(0,255,0,0.1)").length;
    const boxesBefore = ctx.boxes.length;
    for (const index of order) {
      drawMetadata(ctx, canvas, messages[index], video, 0, { settings, frameState });
    }
    assert.equal(ctx.fills.filter(color => color === "rgba(0,255,0,0.1)").length - before, 1);
    assert.equal(ctx.boxes.length - boxesBefore, 3);
  }
});

test("pose-first and hidden-ROI metadata do not suppress a later visible ROI", (t) => {
  loadStrategies(t, [{ type: "inclusion", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }]);
  const ctx = recordingContext();
  const canvas = { clientWidth: 640, clientHeight: 480 };
  const video = { videoWidth: 640, videoHeight: 480 };
  const frameState = {};
  drawMetadata(ctx, canvas, { type: "pose-estimation", data: { poses: [] } }, video, 0,
    { settings: { general: { showRoi: true }, type: {} }, frameState });
  for (const showRoi of [false, true, true]) {
    drawMetadata(ctx, canvas, { type: "object-detection", data: { objects: [] } }, video, 0,
      { settings: { general: { showRoi }, type: {} }, frameState });
  }
  assert.equal(ctx.fills.length, 1);
});

test("unknown metadata cannot invoke inherited properties as drawing strategies", (t) => {
  const strategies = loadStrategies(t);
  Object.setPrototypeOf(strategies, { inherited: () => assert.fail("inherited strategy invoked") });
  strategies.disabled = false;
  for (const type of ["unknown", "__proto__", "constructor", "inherited", "disabled", null, { toString: null }]) {
    assert.doesNotThrow(() => drawMetadata(recordingContext(), {}, { type }, {}, 0, {}));
  }
});
