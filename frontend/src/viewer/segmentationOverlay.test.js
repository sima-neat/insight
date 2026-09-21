import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const drawingSource = readFileSync(
  new URL("../../../webrtc/static/drawing.js", import.meta.url),
  "utf8",
);

// A 2D context that records the calls the segmentation renderer makes. Every
// property the renderer assigns has to be writable, and every method it calls
// has to exist, or the draw aborts before reaching the box.
function recordingContext(calls) {
  return {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    font: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    setLineDash() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    save() {},
    restore() {},
    fill() {},
    stroke() {
      calls.push("stroke");
    },
    strokeRect(...args) {
      calls.push(["strokeRect", ...args]);
    },
    fillRect() {},
    fillText(text, x, y) {
      calls.push(["fillText", text, x, y]);
    },
    drawImage() {
      calls.push("drawImage");
    },
    putImageData() {},
  };
}

function loadSegmentationRenderer() {
  const window = {};
  const maskContext = recordingContext([]);
  const maskCanvas = {
    width: 0,
    height: 0,
    getContext: () => maskContext,
  };
  maskContext.canvas = maskCanvas;

  const sandbox = {
    window,
    document: { createElement: () => maskCanvas },
    // loadRoiPolygons reads this; returning null gives it an empty ROI list.
    localStorage: { getItem: () => null },
    ImageData: class {
      constructor(data, width, height) {
        Object.assign(this, { data, width, height });
      }
    },
    console,
  };
  vm.runInNewContext(drawingSource, sandbox);
  return window.drawStrategies.segmentation;
}

// The renderer is driven entirely through drawContext.settings, so no viewer
// settings module is needed. ROI drawing is off to keep the call log to the
// segment itself.
const SETTINGS = {
  general: { showRoi: false, applyRoiFiltering: false },
  type: { confidenceThreshold: 0, maskOpacity: 0.4, objects: [] },
};

// Container and video share both size and aspect, so the scale is 1:1 with no
// letterbox offset and recorded coordinates are the bounding box verbatim.
const VIDEO = { videoWidth: 100, videoHeight: 100 };
const CANVAS = { width: 100, height: 100, clientWidth: 100, clientHeight: 100 };

function draw(segments) {
  const calls = [];
  const render = loadSegmentationRenderer();
  render(recordingContext(calls), CANVAS, { segments }, VIDEO, 0, {
    settings: SETTINGS,
  });
  return calls;
}

function strokeRects(calls) {
  return calls.filter(call => Array.isArray(call) && call[0] === "strokeRect");
}

test("a polygon mask is drawn without a second, upright box around it", () => {
  // A rotated polygon without an explicit bbox exercises bbox derivation.
  const calls = draw([
    {
      id: 1,
      label: "ship",
      confidence: 0.9,
      mask_format: "polygon",
      mask: [[10, 50], [50, 10], [90, 50], [50, 90]],
    },
  ]);

  assert.ok(calls.includes("stroke"), "the polygon outline itself is still stroked");
  assert.deepEqual(strokeRects(calls), [], "no axis-aligned box is stroked for a polygon");
});

test("a polygon mask still gets its label, placed from the derived bbox", () => {
  const calls = draw([
    {
      id: 1,
      label: "ship",
      confidence: 0.87,
      mask_format: "polygon",
      mask: [[10, 50], [50, 10], [90, 50], [50, 90]],
    },
  ]);

  assert.deepEqual(
    calls.filter(call => Array.isArray(call) && call[0] === "fillText"),
    [["fillText", "ship (87%)", 12, 4]],
  );
});

test("an RLE mask keeps its box, which is the rectangle the mask is painted into", () => {
  const calls = draw([
    {
      id: 2,
      label: "ship",
      confidence: 0.9,
      mask_format: "rle",
      bbox: [10, 20, 30, 40],
      mask: { size: [4, 3], counts: [0, 6, 6] },
    },
  ]);

  assert.ok(calls.includes("drawImage"), "the mask is blitted into the bbox");
  assert.deepEqual(
    strokeRects(calls),
    [["strokeRect", 10, 20, 30, 40]],
    "the RLE box is unchanged by the polygon fix",
  );
});
