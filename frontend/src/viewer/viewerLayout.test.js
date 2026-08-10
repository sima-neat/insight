import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CHANNELS,
  PAGE_SIZE_PRESETS,
  gridDimensions,
  normalizeMaxChannels,
  normalizeVisiblePerPage,
  pageSizePresetsForLimit,
  parseChannelIndices,
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

test("configured SDK capacity limits channel selection and page sizes", () => {
  assert.equal(normalizeMaxChannels("4"), 4);
  assert.deepEqual(parseChannelIndices(null, 4), [0, 1, 2, 3]);
  assert.deepEqual(parseChannelIndices("", 4), []);
  assert.deepEqual(parseChannelIndices("3,4,79,bad,0,3", 4), [0, 3]);
  assert.deepEqual(pageSizePresetsForLimit(4), [1, 4]);
  assert.deepEqual(pageSizePresetsForLimit(3), [1, 3]);
  assert.equal(normalizeVisiblePerPage("48", 4), 4);
});

test("missing or invalid capacity preserves the legacy eighty-channel behavior", () => {
  for (const value of [null, "", "bad", "4channels", "0", "81"]) {
    assert.equal(normalizeMaxChannels(value), 80);
  }
  assert.equal(parseChannelIndices(null).length, 80);
});

test("24 visible streams use four rows and six columns", () => {
  assert.deepEqual(gridDimensions(24), { columns: 6, rows: 4 });
});

test("48 visible streams use six rows and eight columns", () => {
  assert.deepEqual(gridDimensions(48), { columns: 8, rows: 6 });
});
