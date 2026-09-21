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
  for (let i = 0; i < size; i += 1) {
    allocator.colorFor(0, "track", `t${i}`, 100 + i);
  }
  // Refresh t0 so t1 becomes the oldest.
  allocator.colorFor(0, "track", "t0", 500);
  const evictedColor = allocator.colorFor(0, "track", "t1", 200);
  const newcomer = allocator.colorFor(0, "track", "new", 600);
  assert.equal(newcomer, evictedColor, "newcomer takes the slot of the oldest identity");
  assert.equal(allocator.colorFor(0, "track", "t0", 601), PALETTE[0], "refreshed identity keeps its color");
  assert.equal(allocator.size(0, "track"), size);
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
  assert.equal(resolveColor({ ...base, identity: undefined }), NEUTRAL_COLOR);
  assert.equal(resolveColor({ ...base, identity: "" }), NEUTRAL_COLOR);
  assert.equal(resolveColor({ ...base, identity: "cat" }), PALETTE[0]);
  assert.equal(resolveColor({ ...base, identity: "cat", overrides: { person: "#123456" } }), PALETTE[0]);
  assert.equal(allocator.size(0, "class"), 1, "overridden identities do not consume palette slots");
});
