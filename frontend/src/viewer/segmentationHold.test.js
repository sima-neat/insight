import assert from "node:assert/strict";
import test from "node:test";

import {
  SEGMENTATION_CONFIDENCE_ALPHA,
  SEGMENTATION_HOLD_FRAMES,
  SEGMENTATION_TRACK_MISS_FRAMES,
  createSegmentationHoldState,
  segmentationHoldSnapshot,
  selectOverlayMetadata,
} from "./segmentationHold.js";

const segmentation = (count = 1, confidence = 0.8, bbox = [0, 0, 100, 100]) => ({
  data: {
    type: "segmentation",
    data: {
      segments: Array.from({ length: count }, (_value, index) => ({
        id: `seg_${index + 1}`,
        label: "person",
        confidence,
        bbox,
      })),
    },
  },
});
const detection = {
  data: { type: "object-detection", data: { objects: [{}] } },
};
const drawable = (candidate) => {
  if (candidate.data.type === "segmentation") return candidate.data.data.segments.length > 0;
  return candidate.data.data.objects.length > 0;
};

test("holds the latest drawable segmentation for exactly five missing frames", () => {
  const state = createSegmentationHoldState();
  const latest = segmentation();

  const stabilized = selectOverlayMetadata(latest, state, drawable);
  assert.equal(stabilized.data.data.segments.length, 1);
  for (let frame = 0; frame < SEGMENTATION_HOLD_FRAMES; frame += 1) {
    assert.equal(selectOverlayMetadata(null, state, drawable), stabilized);
  }
  assert.equal(selectOverlayMetadata(null, state, drawable), null);

  assert.deepEqual(segmentationHoldSnapshot(state), {
    maxFrames: 5,
    remainingFrames: 0,
    heldFrameDraws: 5,
    expirations: 1,
    smoothedConfidenceUpdates: 0,
    heldTrackDraws: 0,
  });
});

test("fresh segmentation refreshes the five-frame grace window", () => {
  const state = createSegmentationHoldState();
  const first = segmentation();
  const second = segmentation(2);

  selectOverlayMetadata(first, state, drawable);
  selectOverlayMetadata(null, state, drawable);
  assert.equal(selectOverlayMetadata(second, state, drawable).data.data.segments.length, 2);
  assert.equal(state.remainingFrames, SEGMENTATION_HOLD_FRAMES);
});

test("holds an individually missing segment for two inference frames", () => {
  const state = createSegmentationHoldState();

  selectOverlayMetadata(segmentation(), state, drawable);
  for (let frame = 0; frame < SEGMENTATION_TRACK_MISS_FRAMES; frame += 1) {
    const held = selectOverlayMetadata(segmentation(0), state, drawable);
    assert.equal(held.data.data.segments.length, 1);
  }
  assert.equal(selectOverlayMetadata(segmentation(0), state, drawable), null);
});

test("smooths confidence only across matching class and bbox tracks", () => {
  const state = createSegmentationHoldState();

  selectOverlayMetadata(segmentation(1, 0.96), state, drawable);
  const matched = selectOverlayMetadata(segmentation(1, 0.56), state, drawable);
  assert.equal(
    matched.data.data.segments[0].confidence,
    SEGMENTATION_CONFIDENCE_ALPHA * 0.56 + (1 - SEGMENTATION_CONFIDENCE_ALPHA) * 0.96,
  );

  const newLocation = selectOverlayMetadata(
    segmentation(1, 0.56, [500, 500, 100, 100]),
    state,
    drawable,
  );
  assert.equal(newLocation.data.data.segments[0].confidence, 0.56);
});

test("never holds non-segmentation overlays", () => {
  const state = createSegmentationHoldState();

  assert.equal(selectOverlayMetadata(detection, state, drawable), detection);
  assert.equal(selectOverlayMetadata(null, state, drawable), null);
  assert.equal(state.heldFrameDraws, 0);
});
