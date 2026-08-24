import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVideoSyncBuffer,
  createMetadataQueue,
  enqueueMetadata,
  metadataQueueSnapshot,
  takeMetadataForFrame,
} from "./metadataSync.js";

test("video synchronization configures the browser receiver jitter target", () => {
  const receiver = { jitterBufferTarget: 0 };

  assert.deepEqual(applyVideoSyncBuffer(receiver, 350), {
    supported: true,
    applied: true,
    targetMs: 350,
  });
  assert.equal(receiver.jitterBufferTarget, 350);
});

test("video synchronization reports unsupported browser receivers", () => {
  assert.deepEqual(applyVideoSyncBuffer({}, 350), {
    supported: false,
    applied: false,
    targetMs: null,
  });
});

test("timestamped metadata is selected only for its decoded RTP frame", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.equal(takeMetadataForFrame(queue, 4321, 0, 20), null);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20)?.data, message);
  assert.equal(takeMetadataForFrame(queue, 1234, 0, 20), null);
});

test("realtime fallback takes the newest timestamp that the video has passed", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1000 } }, 10);
  enqueueMetadata(queue, { value: "latest-past", _insight: { rtp_timestamp: 1100 } }, 20);
  enqueueMetadata(queue, { value: "future", _insight: { rtp_timestamp: 1300 } }, 30);

  assert.equal(takeMetadataForFrame(queue, 1200, 0, 40, true)?.data.value, "latest-past");
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
  assert.equal(takeMetadataForFrame(queue, 1300, 0, 50, true)?.data.value, "future");
});

test("realtime timestamp fallback handles RTP wraparound", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "before-wrap", _insight: { rtp_timestamp: 0xfffffff0 } }, 10);
  enqueueMetadata(queue, { value: "future", _insight: { rtp_timestamp: 0x00000100 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 0x00000020, 0, 30, true)?.data.value, "before-wrap");
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
});

test("metadata without a source timestamp falls back to the next video frame", () => {
  const queue = createMetadataQueue();
  const message = { type: "classification", data: { top_classes: [] } };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 1234, 20, 0)?.data, message);
});

test("timestamped metadata falls back when the decoded frame has no RTP timestamp", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 20)?.data, message);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
});

test("missing frame identity selects the newest arrival across metadata queues", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "timestamped", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "untimestamped" }, 20);

  assert.equal(takeMetadataForFrame(queue, undefined, 0, 30)?.data.value, "untimestamped");
  assert.deepEqual(metadataQueueSnapshot(queue), {
    timestampMatches: 0,
    arrivalFallbacks: 1,
    frameMisses: 0,
    expired: 0,
    evicted: 0,
    untimestampedReceived: 1,
    timestampedPending: 0,
    arrivalPending: 0,
  });
});

test("timestamped metadata queue evicts its oldest entry at capacity", () => {
  const queue = createMetadataQueue();

  for (let timestamp = 0; timestamp <= 300; timestamp += 1) {
    enqueueMetadata(queue, { _insight: { rtp_timestamp: timestamp } }, timestamp);
  }

  assert.equal(takeMetadataForFrame(queue, 0, 0, 300), null);
  assert.equal(takeMetadataForFrame(queue, 1, 0, 300)?.data._insight.rtp_timestamp, 1);
});

test("configured retention expires unmatched timestamped metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 5000, 5011), null);
});

test("zero retention keeps metadata until match or capacity eviction", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 500_000)?.data._insight.rtp_timestamp, 1234);
});

test("duplicate RTP timestamp keeps the newest metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1234 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 30)?.data.value, "new");
});

test("replacing a timestamp keeps retention ordered by newest arrival", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { value: "expired", _insight: { rtp_timestamp: 2 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 2, 15, 30), null);
  assert.equal(takeMetadataForFrame(queue, 1, 15, 30)?.data.value, "new");
});

test("metadata queue reports exact timestamp matches", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  takeMetadataForFrame(queue, 1234, 0, 20);

  assert.equal(metadataQueueSnapshot(queue).timestampMatches, 1);
});

test("metadata queue reports fallback, misses, expiry, and capacity eviction", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "classification" }, 0);
  takeMetadataForFrame(queue, 1, 0, 1);
  takeMetadataForFrame(queue, 2, 0, 2);
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 3 } }, 0);
  takeMetadataForFrame(queue, 4, 1, 2);
  for (let timestamp = 10; timestamp <= 310; timestamp += 1) {
    enqueueMetadata(queue, { _insight: { rtp_timestamp: timestamp } }, timestamp);
  }

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.arrivalFallbacks, 1);
  assert.equal(snapshot.frameMisses, 2);
  assert.equal(snapshot.expired, 1);
  assert.equal(snapshot.evicted, 1);
  assert.equal(snapshot.untimestampedReceived, 1);
  assert.equal(snapshot.timestampedPending, 300);
});
