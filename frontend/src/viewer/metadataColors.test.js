import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const colorsSource = readFileSync(
  new URL("../../../webrtc/static/js/metadata-colors.js", import.meta.url),
  "utf8",
);

function loadColors() {
  const window = {};
  vm.runInNewContext(colorsSource, { window });
  return window.metadataColors;
}

test("palette has 20 distinct hex colors and a neutral color", () => {
  const { PALETTE, NEUTRAL_COLOR } = loadColors();
  assert.equal(PALETTE.length, 20);
  assert.equal(new Set(PALETTE).size, 20);
  PALETTE.forEach((color) => assert.match(color, /^#[0-9a-f]{6}$/));
  assert.equal(NEUTRAL_COLOR, "#f8fafc");
  assert.equal(PALETTE.includes(NEUTRAL_COLOR), false);
});

test("allocator keeps the same color for the same identity and differs across identities", () => {
  const { createColorAllocator } = loadColors();
  const allocator = createColorAllocator();
  const first = allocator.colorFor(0, "track", "7", 1);
  const second = allocator.colorFor(0, "track", "8", 2);
  assert.notEqual(first, second);
  assert.equal(allocator.colorFor(0, "track", "7", 3), first);
  assert.equal(allocator.colorFor(0, "track", 7, 4), first, "numeric and string ids are the same identity");
});

test("allocator maps are separate per channel and per namespace", () => {
  const { createColorAllocator, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  assert.equal(allocator.colorFor(0, "track", "1", 1), PALETTE[0]);
  assert.equal(allocator.colorFor(1, "track", "x", 1), PALETTE[0]);
  assert.equal(allocator.colorFor(0, "pose", "y", 1), PALETTE[0]);
  assert.equal(allocator.colorFor(0, "class", "person", 1), PALETTE[0]);
  assert.equal(allocator.colorFor(0, "class", "car", 1), PALETTE[1]);
});

test("allocator evicts the least recently seen identity when the palette is exhausted", () => {
  const { createColorAllocator, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  const size = PALETTE.length;
  const colors = [];
  for (let i = 0; i < size; i += 1) {
    colors.push(allocator.colorFor(0, "track", `t${i}`, 100 + i));
  }
  // Refresh t0 so t1 becomes the oldest.
  allocator.colorFor(0, "track", "t0", 500);
  const newcomer = allocator.colorFor(0, "track", "new", 600);
  assert.equal(newcomer, colors[1], "newcomer takes the slot of the oldest identity, t1");
  assert.equal(allocator.colorFor(0, "track", "t0", 601), colors[0], "refreshed identity keeps its color");
  assert.equal(allocator.colorFor(0, "track", "t1", 602), colors[2], "evicted t1 returns as a newcomer and takes the next oldest slot, t2's");
  assert.equal(allocator.size(0, "track"), size);
});

test("allocator lastSeen updates are independent per channel and namespace", () => {
  const { createColorAllocator, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  allocator.colorFor(1, "class", "far-future", 1_000_000);
  const size = PALETTE.length;
  for (let i = 0; i < size; i += 1) allocator.colorFor(0, "track", `t${i}`, 100 + i);
  const refreshed = allocator.colorFor(0, "track", "t0", 300);
  allocator.colorFor(0, "track", "new", 301);
  assert.equal(allocator.colorFor(0, "track", "t0", 302), refreshed, "t0 survived because its refresh was recorded despite a larger now on another channel");
});

test("allocator breaks eviction ties by insertion order", () => {
  const { createColorAllocator, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  const size = PALETTE.length;
  const colors = [];
  for (let i = 0; i < size + 5; i += 1) {
    colors.push(allocator.colorFor(0, "track", `t${i}`, 42));
  }
  // The last `size` identities must be pairwise distinct.
  assert.equal(new Set(colors.slice(5)).size, size);
  // t0..t4 were evicted; t5 keeps PALETTE[5].
  assert.equal(allocator.colorFor(0, "track", "t5", 43), PALETTE[5]);
});

test("allocator clear drops all state", () => {
  const { createColorAllocator, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  allocator.colorFor(0, "track", "a", 1);
  allocator.colorFor(0, "track", "b", 2);
  allocator.clear();
  assert.equal(allocator.size(0, "track"), 0);
  assert.equal(allocator.colorFor(0, "track", "b", 3), PALETTE[0]);
});

test("resolveColor prefers overrides, then neutral for missing identity, then the allocator", () => {
  const { createColorAllocator, resolveColor, NEUTRAL_COLOR, PALETTE } = loadColors();
  const allocator = createColorAllocator();
  const base = { allocator, channelIndex: 0, namespace: "class", now: 1 };
  assert.equal(resolveColor({ ...base, identity: "person", overrides: { person: "#123456" } }), "#123456");
  assert.equal(resolveColor({ ...base, identity: "dog", overrides: { default: "#abcdef" } }), "#abcdef");
  assert.equal(resolveColor({ ...base, identity: null, overrides: {} }), NEUTRAL_COLOR);
  assert.equal(resolveColor({ ...base, identity: null, overrides: { default: "#abcdef" } }), "#abcdef");
  assert.equal(resolveColor({ ...base, identity: undefined }), NEUTRAL_COLOR);
  assert.equal(resolveColor({ ...base, identity: "" }), NEUTRAL_COLOR);
  assert.equal(resolveColor({ ...base, identity: "cat" }), PALETTE[0]);
  assert.equal(resolveColor({ ...base, identity: "cat", overrides: { person: "#123456" } }), PALETTE[0]);
  assert.equal(allocator.size(0, "class"), 1, "overridden identities do not consume palette slots");
});

const drawingSource = readFileSync(
  new URL("../../../webrtc/static/drawing.js", import.meta.url),
  "utf8",
);

// Runs the color module and the renderers in one context, the way viewer.html loads them.
// `settingsByType` is what window.resolveTypeSettings returns per metadata type.
function loadViewer(settingsByType = {}) {
  const window = {
    resolveTypeSettings: (_index, metadataType) => ({
      metadataType,
      general: { videoSyncBufferMs: 350, metadataRetentionMs: 0, showRoi: false, applyRoiFiltering: false },
      type: settingsByType[metadataType] || {},
    }),
  };
  const context = { window, console, performance: { now: () => 0 } };
  vm.runInNewContext(colorsSource, context);
  vm.runInNewContext(drawingSource, context);
  return window;
}

// Records the stroke and fill colors in force for every drawing call.
function createRecordingContext() {
  const calls = [];
  const ctx = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    font: "",
    globalAlpha: 1,
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    save() {},
    restore() {},
    measureText: (text) => ({ width: text.length * 7 }),
  };
  ["strokeRect", "fillRect", "fillText", "stroke", "fill", "arc"].forEach((op) => {
    ctx[op] = (...args) => calls.push({ op, args, strokeStyle: ctx.strokeStyle, fillStyle: ctx.fillStyle });
  });
  return { ctx, calls };
}

const VIDEO = { videoWidth: 1280, videoHeight: 720 };
const CANVAS = { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 };

function draw(window, type, data, options = {}) {
  const { ctx, calls } = createRecordingContext();
  const drawContext = { now: options.now ?? 0, ...options.drawContext };
  window.drawStrategies[type](ctx, CANVAS, data, VIDEO, options.channel ?? 0, drawContext);
  return calls;
}

function textCalls(calls) {
  return calls.filter((call) => call.op === "fillText");
}

function colorOfText(calls, needle) {
  const call = textCalls(calls).find((entry) => String(entry.args[0]).includes(needle));
  assert.ok(call, `expected a label containing "${needle}"`);
  return call.fillStyle;
}

function detection(label, x = 0) {
  return { id: `${label}-${x}`, label, confidence: 0.9, bbox: [x, 10, 50, 50] };
}

test("object detection colors each class distinctly and stably across frames", () => {
  const window = loadViewer();
  const objects = [detection("car", 0), detection("person", 100), detection("bicycle", 200), detection("dog", 300)];
  const frame1 = draw(window, "object-detection", { objects });
  const frame2 = draw(window, "object-detection", { objects: [...objects].reverse() }, { now: 16 });
  const colors1 = ["car", "person", "bicycle", "dog"].map((label) => colorOfText(frame1, label));
  const colors2 = ["car", "person", "bicycle", "dog"].map((label) => colorOfText(frame2, label));
  assert.equal(new Set(colors1).size, 4);
  assert.deepEqual(colors2, colors1);
  colors1.forEach((color) => assert.ok(window.metadataColors.PALETTE.includes(color)));
  assert.equal(colors1.includes("#00ff00"), false);
  assert.equal(colors1.includes("lime"), false);
});

test("object detection draws the box and label of one object in the same color", () => {
  const window = loadViewer();
  const calls = draw(window, "object-detection", { objects: [detection("car"), detection("person", 100)] });
  const boxes = calls.filter((call) => call.op === "strokeRect");
  const labels = textCalls(calls);
  assert.equal(boxes.length, 2);
  assert.equal(labels.length, 2);
  assert.equal(boxes[0].strokeStyle, labels[0].fillStyle);
  assert.equal(boxes[1].strokeStyle, labels[1].fillStyle);
  assert.notEqual(boxes[0].strokeStyle, boxes[1].strokeStyle);
});

test("object detection honors per-label and default overrides", () => {
  const window = loadViewer({
    "object-detection": {
      confidenceThreshold: 0,
      objects: [
        { label: "person", color: "#123456", style: "dashed", width: 3 },
        { label: "default", color: "#abcdef", style: "solid", width: 1 },
      ],
    },
  });
  const calls = draw(window, "object-detection", { objects: [detection("person"), detection("car", 100)] });
  assert.equal(colorOfText(calls, "person"), "#123456");
  assert.equal(colorOfText(calls, "car"), "#abcdef");
});

test("a class keeps one color across detection, segmentation and classification on a channel", () => {
  const window = loadViewer();
  const detectionCalls = draw(window, "object-detection", { objects: [detection("person"), detection("car", 100)] });
  const segmentationCalls = draw(window, "segmentation", {
    segments: [
      { id: "s1", label: "car", confidence: 0.9, mask_format: "polygon", mask: [[0, 0], [40, 0], [20, 40]] },
      { id: "s2", label: "truck", confidence: 0.9, mask_format: "polygon", mask: [[100, 0], [140, 0], [120, 40]] },
    ],
  });
  const classificationCalls = draw(window, "classification", {
    top_classes: [
      { label: "truck", confidence: 0.8 },
      { label: "person", confidence: 0.1 },
      { label: "boat", confidence: 0.05 },
    ],
  });
  assert.equal(colorOfText(segmentationCalls, "car"), colorOfText(detectionCalls, "car"));
  assert.equal(colorOfText(classificationCalls, "person"), colorOfText(detectionCalls, "person"));
  assert.equal(colorOfText(classificationCalls, "truck"), colorOfText(segmentationCalls, "truck"));
  const classificationColors = ["truck", "person", "boat"].map((label) => colorOfText(classificationCalls, label));
  assert.equal(new Set(classificationColors).size, 3);
});

test("segmentation uses one color for a segment's fill, outline, box and label", () => {
  const window = loadViewer();
  const calls = draw(window, "segmentation", {
    segments: [
      { id: "s1", label: "car", confidence: 0.9, mask_format: "polygon", mask: [[0, 0], [40, 0], [20, 40]] },
      { id: "s2", label: "person", confidence: 0.9, mask_format: "polygon", mask: [[100, 0], [140, 0], [120, 40]] },
    ],
  });
  const perSegment = [];
  let current = null;
  calls.forEach((call) => {
    if (call.op === "fill") {
      current = { fill: call.fillStyle };
      perSegment.push(current);
    } else if (call.op === "stroke" && current) {
      current.outline = call.strokeStyle;
    } else if (call.op === "strokeRect" && current) {
      current.box = call.strokeStyle;
    } else if (call.op === "fillText" && current) {
      current.label = call.fillStyle;
    }
  });
  assert.equal(perSegment.length, 2);
  perSegment.forEach((segment) => {
    assert.equal(segment.outline, segment.fill);
    assert.equal(segment.box, segment.fill);
    assert.equal(segment.label, segment.fill);
  });
  assert.notEqual(perSegment[0].fill, perSegment[1].fill);
});

test("renderers use the allocator from the draw context when given", () => {
  const window = loadViewer();
  const allocator = window.metadataColors.createColorAllocator();
  draw(window, "object-detection", { objects: [detection("car")] }, { drawContext: { colorAllocator: allocator } });
  assert.equal(allocator.size(0, "class"), 1);
});

test("palette reuse keeps the identities on screen distinct", () => {
  const window = loadViewer();
  const size = window.metadataColors.PALETTE.length;
  const objects = [];
  for (let i = 0; i < size + 5; i += 1) objects.push(detection(`class${i}`, i * 10));
  draw(window, "object-detection", { objects });
  const lastFrame = draw(window, "object-detection", { objects: objects.slice(5) }, { now: 16 });
  // "class1 (" avoids matching "class10".
  const colors = objects.slice(5).map((obj) => colorOfText(lastFrame, `${obj.label} (`));
  assert.equal(new Set(colors).size, size);
  assert.equal(new Set(colors).size, new Set(window.metadataColors.PALETTE).size);
});

function track(id, label = "person", x = 0) {
  return { id, label, confidence: 0.9, bbox: [x, 10, 80, 130] };
}

test("tracking colors by track id, stable across frames, with trails matching boxes", () => {
  const window = loadViewer();
  const trackHistory = new Map();
  const tracks = [track("1", "person", 0), track("2", "person", 200), track("3", "forklift", 400)];
  let firstColors = null;
  let last = null;
  for (let frame = 0; frame < 5; frame += 1) {
    const moved = tracks.map((entry) => ({ ...entry, bbox: [entry.bbox[0] + frame * 5, 10, 80, 130] }));
    last = draw(window, "tracking", { tracks: moved }, { now: frame * 33, drawContext: { trackHistory } });
    const colors = ["#1", "#2", "#3"].map((needle) => colorOfText(last, needle));
    assert.equal(new Set(colors).size, 3);
    if (firstColors === null) firstColors = colors;
    else assert.deepEqual(colors, firstColors);
  }
  const trails = last.filter((call) => call.op === "stroke");
  assert.equal(trails.length, 3, "one trail per track once history exists");
  const boxes = last.filter((call) => call.op === "strokeRect");
  assert.deepEqual(
    trails.map((call) => call.strokeStyle).sort(),
    boxes.map((call) => call.strokeStyle).sort(),
  );
});

test("tracking keeps colors stable across frames", () => {
  const window = loadViewer();
  const trackHistory = new Map();
  const first = draw(window, "tracking", { tracks: [track("1"), track("2", "person", 200)] }, { drawContext: { trackHistory } });
  const second = draw(window, "tracking", { tracks: [track("2", "person", 210), track("1", "person", 10)] }, { now: 33, drawContext: { trackHistory } });
  assert.equal(colorOfText(second, "#1"), colorOfText(first, "#1"));
  assert.equal(colorOfText(second, "#2"), colorOfText(first, "#2"));
  assert.notEqual(colorOfText(first, "#1"), colorOfText(first, "#2"));
});

test("a track without an id draws in the neutral color", () => {
  const window = loadViewer();
  const calls = draw(window, "tracking", { tracks: [{ label: "person", confidence: 0.9, bbox: [0, 10, 80, 130] }] }, { drawContext: { trackHistory: new Map() } });
  assert.equal(colorOfText(calls, "person"), window.metadataColors.NEUTRAL_COLOR);
});

function pose(id, originX, originY) {
  const points = {
    nose: [0, 0], left_eye: [-5, -5], right_eye: [5, -5],
    left_shoulder: [-20, 30], right_shoulder: [20, 30],
    left_hip: [-15, 90], right_hip: [15, 90],
  };
  return {
    id,
    label: "person",
    keypoints: Object.entries(points).map(([name, [dx, dy]]) => ({ name, x: originX + dx, y: originY + dy, confidence: 0.95 })),
  };
}

// Splits the recorded calls into one group per pose, using the label as the group end.
function poseGroups(calls) {
  const groups = [];
  let current = { colors: new Set(), ops: new Set() };
  calls.forEach((call) => {
    if (call.op === "fillRect") return; // label background
    current.ops.add(call.op);
    current.colors.add(call.op === "stroke" || call.op === "strokeRect" ? call.strokeStyle : call.fillStyle);
    if (call.op === "fillText" && String(call.args[0]).startsWith("person")) {
      groups.push(current);
      current = { colors: new Set(), ops: new Set() };
    }
  });
  return groups;
}

test("pose estimation colors each person distinctly and draws every part in that color", () => {
  const window = loadViewer();
  const poses = [pose("pose_1", 200, 150), pose("pose_2", 600, 150), pose("pose_3", 1000, 150)];
  const calls = draw(window, "pose-estimation", { poses });
  const groups = poseGroups(calls);
  assert.equal(groups.length, 3);
  groups.forEach((group) => {
    assert.equal(group.colors.size, 1, "skeleton, keypoints, names, box and label share one color");
    ["stroke", "arc", "fill", "strokeRect", "fillText"].forEach((op) => assert.ok(group.ops.has(op), `missing ${op}`));
  });
  const colors = groups.map((group) => [...group.colors][0]);
  assert.equal(new Set(colors).size, 3);
  assert.equal(colorOfText(calls, "person #pose_2"), colors[1]);
});

test("pose estimation keeps a person's color across frames", () => {
  const window = loadViewer();
  const first = draw(window, "pose-estimation", { poses: [pose("a", 200, 150), pose("b", 600, 150)] });
  const second = draw(window, "pose-estimation", { poses: [pose("b", 610, 150), pose("a", 210, 150)] }, { now: 33 });
  assert.equal(colorOfText(second, "#a"), colorOfText(first, "#a"));
  assert.equal(colorOfText(second, "#b"), colorOfText(first, "#b"));
});

test("a pose without an id draws in the neutral color with a plain label", () => {
  const window = loadViewer();
  const anonymous = pose(undefined, 200, 150);
  delete anonymous.id;
  const calls = draw(window, "pose-estimation", { poses: [anonymous] });
  const label = textCalls(calls).find((call) => String(call.args[0]).startsWith("person"));
  assert.equal(label.args[0], "person");
  assert.equal(label.fillStyle, window.metadataColors.NEUTRAL_COLOR);
});

test("pose bounding box covers the confident keypoints with padding", () => {
  const window = loadViewer();
  const calls = draw(window, "pose-estimation", { poses: [pose("p", 200, 150)] });
  const box = calls.find((call) => call.op === "strokeRect");
  assert.ok(box);
  const [x, y, w, h] = box.args;
  assert.equal(x, 200 - 20 - 8);
  assert.equal(y, 150 - 5 - 8);
  assert.equal(w, 40 + 16);
  assert.equal(h, 95 + 16);
});
