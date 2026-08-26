import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const drawingSource = readFileSync(
  new URL("../../../webrtc/static/drawing.js", import.meta.url),
  "utf8",
);

function loadDecoder() {
  const window = {};
  vm.runInNewContext(drawingSource, { window });
  return window.decodeRleMaskAlpha;
}

function loadSegmentColorResolver() {
  const window = {};
  vm.runInNewContext(drawingSource, { window });
  return window.colorForSegmentClass;
}

// Alpha channel of the decoded RGBA buffer, as a row-major grid of 0/1.
function decodeToGrid(counts, maskWidth, maskHeight) {
  const pixels = new Uint8ClampedArray(maskWidth * maskHeight * 4);
  loadDecoder()(pixels, counts, maskWidth, maskHeight);

  const rows = [];
  for (let y = 0; y < maskHeight; y += 1) {
    const row = [];
    for (let x = 0; x < maskWidth; x += 1) {
      row.push(pixels[(y * maskWidth + x) * 4 + 3] === 255 ? 1 : 0);
    }
    rows.push(row);
  }
  return rows;
}

test("RLE runs are decoded column-major with a leading background run", () => {
  // size [4, 3] counts [0, 6, 6]: six foreground pixels fill column 0 and the top of column 1.
  assert.deepEqual(decodeToGrid([0, 6, 6], 3, 4), [
    [1, 1, 0],
    [1, 1, 0],
    [1, 0, 0],
    [1, 0, 0],
  ]);
});

test("RLE decoding of a non-square mask is not transposed", () => {
  // A row-major decode would light the top row instead of the first column.
  assert.deepEqual(decodeToGrid([0, 4], 3, 4), [
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
    [1, 0, 0],
  ]);

  // Seven runs of three over a 7x3 mask: every second column is foreground.
  assert.deepEqual(decodeToGrid([3, 3, 3, 3, 3, 3, 3], 7, 3), [
    [0, 1, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 1, 0],
    [0, 1, 0, 1, 0, 1, 0],
  ]);
});

test("RLE run lengths past the mask total stop the decode", () => {
  const started = process.hrtime.bigint();
  const grid = decodeToGrid([0, 1e9], 3, 4);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.deepEqual(grid, [
    [1, 1, 1],
    [1, 1, 1],
    [1, 1, 1],
    [1, 1, 1],
  ]);
  assert.ok(elapsedMs < 1000, `decode of a 1e9 run took ${elapsedMs.toFixed(1)} ms`);
});

test("RLE counts that encode no foreground leave the buffer untouched", () => {
  const blank = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  assert.deepEqual(decodeToGrid([], 3, 4), blank);
  assert.deepEqual(decodeToGrid([12], 3, 4), blank);
});

test("segmentation classes keep distinct stable colors", () => {
  const colorForClass = loadSegmentColorResolver();
  const person = colorForClass("person");
  const car = colorForClass("car");
  const bottle = colorForClass("bottle");

  assert.equal(colorForClass("person"), person);
  assert.equal(new Set([person, car, bottle]).size, 3);
});
