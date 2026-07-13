import assert from "node:assert/strict";
import test from "node:test";

import { createMetadataQueue, enqueueMetadata, takeMetadataForFrame } from "./metadataSync.js";

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

test("metadata without a source timestamp falls back to arrival delay", () => {
  const queue = createMetadataQueue();
  const message = { type: "classification", data: { top_classes: [] } };

  enqueueMetadata(queue, message, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 20, 29), null);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 20, 30)?.data, message);
});
