import assert from "node:assert/strict";
import test from "node:test";

import { MAX_CHANNELS, PAGE_SIZE_PRESETS, normalizeVisiblePerPage } from "./viewerLayout.js";

test("viewer exposes 48 as the largest simultaneous page size", () => {
  assert.equal(MAX_CHANNELS, 80);
  assert.deepEqual(PAGE_SIZE_PRESETS, [1, 4, 9, 16, 24, 36, 48]);
});

test("persisted page sizes normalize to a supported option", () => {
  assert.equal(normalizeVisiblePerPage("40"), 36);
  assert.equal(normalizeVisiblePerPage("80"), 48);
  assert.equal(normalizeVisiblePerPage("invalid"), 4);
});
