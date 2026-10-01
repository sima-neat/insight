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
    drawImage(_source, ...args) {
      calls.push(["drawImage", ...args]);
    },
    putImageData() {},
  };
}

function loadSegmentationRenderer(roiPolygons = []) {
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
    localStorage: { getItem: () => JSON.stringify(roiPolygons) },
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

function draw(segments, { settings = SETTINGS, roiPolygons = [] } = {}) {
  const calls = [];
  const render = loadSegmentationRenderer(roiPolygons);
  render(recordingContext(calls), CANVAS, { segments }, VIDEO, 0, {
    settings,
  });
  return calls;
}

function strokeRects(calls) {
  return calls.filter(call => Array.isArray(call) && call[0] === "strokeRect");
}

test("a polygon hides its rectangle by default but keeps its outline and bbox label", () => {
  const calls = draw([
    {
      id: 1,
      label: "ship",
      confidence: 0.87,
      mask_format: "polygon",
      mask: [[10, 50], [50, 10], [90, 50], [50, 90]],
    },
  ]);

  assert.ok(calls.includes("stroke"), "the polygon outline itself is still stroked");
  assert.deepEqual(strokeRects(calls), []);
  assert.deepEqual(
    calls.filter(call => Array.isArray(call) && call[0] === "fillText"),
    [["fillText", "ship (87%)", 12, 4]],
  );
});

test("an RLE mask hides its rectangle by default but still uses its bbox", () => {
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

  assert.deepEqual(strokeRects(calls), []);
  assert.deepEqual(
    calls.filter(call => Array.isArray(call) && call[0] === "drawImage"),
    [["drawImage", 10, 20, 30, 40]],
  );
  assert.deepEqual(
    calls.filter(call => Array.isArray(call) && call[0] === "fillText"),
    [["fillText", "ship (90%)", 12, 14]],
  );
});

test("boolean show_rectangle opts polygons and RLE masks into a bbox outline", () => {
  const calls = draw([
    {
      label: "polygon",
      mask_format: "polygon",
      show_rectangle: true,
      mask: [[10, 50], [50, 10], [90, 50], [50, 90]],
    },
    {
      label: "mask",
      mask_format: "rle",
      show_rectangle: true,
      bbox: [10, 20, 30, 40],
      mask: { size: [4, 3], counts: [0, 6, 6] },
    },
  ]);

  assert.deepEqual(strokeRects(calls), [
    ["strokeRect", 10, 10, 80, 80],
    ["strokeRect", 10, 20, 30, 40],
  ]);
});

test("only boolean true enables the rectangle", () => {
  for (const show_rectangle of [undefined, false, "true", 1]) {
    const calls = draw([{
      label: "region",
      mask_format: "polygon",
      show_rectangle,
      mask: [[10, 50], [50, 10], [90, 50], [50, 90]],
    }]);
    assert.deepEqual(strokeRects(calls), []);
  }
});

test("a hidden rectangle still uses its derived bbox for ROI filtering", () => {
  const settings = {
    ...SETTINGS,
    general: { ...SETTINGS.general, applyRoiFiltering: true },
  };
  const roiPolygons = [{
    type: "inclusion",
    points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0.5 }],
  }];
  const calls = draw([
    {
      label: "inside",
      mask_format: "polygon",
      mask: [[10, 10], [30, 10], [30, 30], [10, 30]],
    },
    {
      label: "outside",
      mask_format: "polygon",
      mask: [[70, 70], [90, 70], [90, 90], [70, 90]],
    },
  ], { settings, roiPolygons });

  assert.deepEqual(strokeRects(calls), []);
  assert.deepEqual(
    calls.filter(call => Array.isArray(call) && call[0] === "fillText"),
    [["fillText", "inside (100%)", 12, 4]],
  );
});
