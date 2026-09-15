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

  assert.deepEqual(takeMetadataForFrame(queue, 4321, 0, 20), []);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20)[0]?.data, message);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20), []);
});

test("metadata without a source timestamp falls back to the next video frame", () => {
  const queue = createMetadataQueue();
  const message = { type: "classification", data: { top_classes: [] } };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 1234, 20, 0)[0]?.data, message);
});

test("timestamped metadata falls back when the decoded frame has no RTP timestamp", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 20)[0]?.data, message);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
});

test("missing frame identity selects the newest arrival across metadata queues", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "timestamped", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "untimestamped" }, 20);

  assert.equal(takeMetadataForFrame(queue, undefined, 0, 30)[0]?.data.value, "untimestamped");
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

  assert.deepEqual(takeMetadataForFrame(queue, 0, 0, 300), []);
  assert.equal(takeMetadataForFrame(queue, 1, 0, 300)[0]?.data._insight.rtp_timestamp, 1);
});

test("configured retention expires unmatched timestamped metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 1234, 5000, 5011), []);
});

test("zero retention keeps metadata until match or capacity eviction", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 500_000)[0]?.data._insight.rtp_timestamp, 1234);
});

test("duplicate RTP timestamp keeps the newest metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1234 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 30)[0]?.data.value, "new");
});

test("replacing a timestamp keeps retention ordered by newest arrival", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { value: "expired", _insight: { rtp_timestamp: 2 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1 } }, 20);

  assert.deepEqual(takeMetadataForFrame(queue, 2, 15, 30), []);
  assert.equal(takeMetadataForFrame(queue, 1, 15, 30)[0]?.data.value, "new");
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

test("one frame keeps metadata of every type, not just the last to arrive", () => {
  const queue = createMetadataQueue();
  const pose = {
    type: "pose-estimation",
    data: { poses: [] },
    _insight: { rtp_timestamp: 4242 },
  };
  const tracking = {
    type: "tracking",
    data: { tracks: [] },
    _insight: { rtp_timestamp: 4242 },
  };

  enqueueMetadata(queue, pose, 10);
  enqueueMetadata(queue, tracking, 11);

  const items = takeMetadataForFrame(queue, 4242, 0, 12);
  assert.deepEqual(
    items.map((item) => item.data.type).sort(),
    ["pose-estimation", "tracking"],
  );
});

test("metadata types for one frame expire independently", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 7 } }, 0);
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 7 } }, 40);

  // Retention 50 at t=60: pose (age 60) is gone, tracking (age 20) is not.
  const items = takeMetadataForFrame(queue, 7, 50, 60);
  assert.deepEqual(items.map((item) => item.data.type), ["tracking"]);
  assert.equal(metadataQueueSnapshot(queue).expired, 1);
});

test("a stale type does not hide behind a fresher frame", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 2 } }, 10);
  // Frame 1 moves behind frame 2 on this arrival, so its stale pose sits
  // after a frame whose entries are all fresh.
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 1 } }, 40);

  const items = takeMetadataForFrame(queue, 1, 50, 55);
  assert.deepEqual(items.map((item) => item.data.type), ["tracking"]);
  assert.equal(metadataQueueSnapshot(queue).expired, 1);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
});
