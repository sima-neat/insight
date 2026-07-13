import assert from "node:assert/strict";
import test from "node:test";

import {
  canHoldPastFrameMetadata,
  createMetadataQueue,
  enqueueMetadata,
  signedRtpDelta,
  takeMetadataForFrame,
} from "./metadataSync.js";

test("bounded hold accepts recent past metadata and rejects future or old metadata", () => {
  assert.equal(canHoldPastFrameMetadata(109000, 100000), true);
  assert.equal(canHoldPastFrameMetadata(112000, 100000), true);
  assert.equal(canHoldPastFrameMetadata(112001, 100000), false);
  assert.equal(canHoldPastFrameMetadata(100000, 109000), false);
  assert.equal(canHoldPastFrameMetadata(100000, 100000), false);
});

test("RTP delta and bounded hold handle timestamp wraparound", () => {
  assert.equal(signedRtpDelta(1000, 0xfffff000), 5096);
  assert.equal(canHoldPastFrameMetadata(1000, 0xfffff000), true);
  assert.equal(signedRtpDelta(0xfffff000, 1000), -5096);
  assert.equal(canHoldPastFrameMetadata(0xfffff000, 1000), false);
});

test("timestamped metadata is selected only for its decoded RTP frame", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.equal(queue.frameSynchronized, true);
  assert.equal(takeMetadataForFrame(queue, 4321, 0, 20), null);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20)?.data, message);
  assert.equal(takeMetadataForFrame(queue, 1234, 0, 20), null);
});

test("metadata without a source timestamp falls back to arrival delay", () => {
  const queue = createMetadataQueue();
  const message = { type: "classification", data: { top_classes: [] } };

  enqueueMetadata(queue, message, 10);

  assert.equal(queue.frameSynchronized, false);
  assert.equal(takeMetadataForFrame(queue, 1234, 20, 29), null);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 20, 30)?.data, message);
});

test("timestamped metadata queue evicts its oldest entry at capacity", () => {
  const queue = createMetadataQueue();

  for (let timestamp = 0; timestamp <= 300; timestamp += 1) {
    enqueueMetadata(queue, { _insight: { rtp_timestamp: timestamp } }, timestamp);
  }

  assert.equal(takeMetadataForFrame(queue, 0, 0, 300), null);
  assert.equal(takeMetadataForFrame(queue, 1, 0, 300)?.data._insight.rtp_timestamp, 1);
});

test("expired timestamped metadata cannot render", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 5011), null);
});

test("duplicate RTP timestamp keeps the newest metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1234 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 30)?.data.value, "new");
});
