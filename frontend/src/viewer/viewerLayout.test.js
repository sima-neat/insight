import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHANNELS,
  PAGE_SIZE_PRESETS,
  gridDimensions,
  normalizeVisiblePerPage,
} from "./viewerLayout.js";

test("viewer exposes 48 as the largest simultaneous page size", () => {
  assert.equal(MAX_CHANNELS, 80);
  assert.deepEqual(PAGE_SIZE_PRESETS, [1, 4, 9, 16, 24, 36, 48]);
});

test("persisted page sizes normalize to a supported option", () => {
  assert.equal(normalizeVisiblePerPage("40"), 36);
  assert.equal(normalizeVisiblePerPage("80"), 48);
  assert.equal(normalizeVisiblePerPage("invalid"), 4);
});

test("24 visible streams use four columns and six rows", () => {
  assert.deepEqual(gridDimensions(24), { columns: 4, rows: 6 });
});

test("48 visible streams use six columns and eight rows", () => {
  assert.deepEqual(gridDimensions(48), { columns: 6, rows: 8 });
});
