import assert from "node:assert/strict";
import test from "node:test";

import {
  AUXILIARY_METADATA_TYPE,
  createAuxiliaryRendererRegistry,
  inspectAuxiliaryMessage,
  partitionFrameMetadata,
  shouldAnimateAuxiliaryView,
  shouldHoldLastAuxiliaryFrame,
} from "./auxiliaryVisualization.js";
import { createMetadataQueue, enqueueMetadata, takeMetadataForFrame } from "./metadataSync.js";

function registryWith(...names) {
  const registry = createAuxiliaryRendererRegistry();
  for (const name of names) registry.register(name, { title: name, draw() {} });
  return registry;
}

function message({ id = "pose", renderer = "blazepose-3d", rtp = 42, payload = { poses: [] } } = {}) {
  return {
    type: AUXILIARY_METADATA_TYPE,
    timestamp: 1000,
    frame_id: "frame-1",
    data: { schema_version: 1, id, renderer, title: "3D Pose", payload },
    _insight: { rtp_timestamp: rtp },
  };
}

test("renderer selection uses the registered renderer named by the generic payload", () => {
  const registry = registryWith("blazepose-3d", "plot");
  const result = inspectAuxiliaryMessage(message({ renderer: "plot" }), registry);

  assert.equal(result.reason, null);
  assert.equal(result.view.renderer, "plot");
  assert.equal(result.view.id, "pose");
  assert.equal(result.view.frameId, "frame-1");
});

test("generic renderer registration preserves renderer-owned settings integration", () => {
  const registry = createAuxiliaryRendererRegistry();
  const viewerSettings = {
    toSession(settings) { return { scale: settings.scale }; },
    toViewer(settings) { return { scale: settings.scale }; },
  };
  registry.register("point-cloud-3d", { title: "Point Cloud", draw() {}, viewerSettings });

  assert.equal(registry.get("point-cloud-3d").viewerSettings, viewerSettings);
  assert.deepEqual(registry.get("point-cloud-3d").viewerSettings.toSession({ scale: 2 }), { scale: 2 });
});

test("generic transport preserves an arbitrary renderer-owned 3D payload", () => {
  const registry = registryWith("mesh-3d");
  const payload = {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    triangles: [[0, 1, 2]],
    coordinateSystem: { handedness: "right", units: "millimeters" },
  };
  const result = inspectAuxiliaryMessage(message({ renderer: "mesh-3d", payload }), registry);

  assert.equal(result.reason, null);
  assert.equal(result.view.payload, payload);
});

test("unknown and malformed auxiliary payloads are rejected without becoming overlays", () => {
  const registry = registryWith("blazepose-3d");
  const unknown = message({ renderer: "not-installed" });
  const malformed = { ...message(), data: { schema_version: 9 } };
  const result = partitionFrameMetadata(
    [{ data: unknown }, { data: malformed }],
    42,
    registry,
  );

  assert.deepEqual(result.overlays, []);
  assert.deepEqual(result.auxiliaryViews, []);
  assert.equal(result.ignoredAuxiliary.length, 2);
  assert.match(result.ignoredAuxiliary[0].reason, /unknown renderer/);
  assert.match(result.ignoredAuxiliary[1].reason, /schema_version/);
});

test("auxiliary data requires the exact decoded RTP frame while normal overlays remain available", () => {
  const registry = registryWith("blazepose-3d");
  const poseOverlay = { type: "pose-estimation", data: { poses: [] } };
  const candidates = [{ data: poseOverlay }, { data: message({ rtp: 41 }) }];

  const result = partitionFrameMetadata(candidates, 42, registry);

  assert.deepEqual(result.overlays.map((item) => item.data), [poseOverlay]);
  assert.deepEqual(result.auxiliaryViews, []);
});

test("untimestamped auxiliary data cannot use the ordinary arrival fallback", () => {
  const registry = registryWith("blazepose-3d");
  const queue = createMetadataQueue();
  const untimestamped = message();
  delete untimestamped._insight;
  enqueueMetadata(queue, untimestamped, 10);

  const candidates = takeMetadataForFrame(queue, 42, 0, 11);
  const result = partitionFrameMetadata(candidates, 42, registry);

  assert.deepEqual(result.auxiliaryViews, []);
  assert.deepEqual(result.overlays, []);
});

test("one frame can carry several independently selected auxiliary views", () => {
  const registry = registryWith("blazepose-3d", "plot");
  const queue = createMetadataQueue();
  enqueueMetadata(queue, message({ id: "pose", renderer: "blazepose-3d" }), 10);
  enqueueMetadata(queue, message({ id: "latency", renderer: "plot" }), 11);

  const candidates = takeMetadataForFrame(queue, 42, 0, 12);
  const result = partitionFrameMetadata(candidates, 42, registry);

  assert.deepEqual(result.auxiliaryViews.map((view) => view.id), ["pose", "latency"]);
});

test("a repeated auxiliary id replaces only that view on the frame", () => {
  const registry = registryWith("blazepose-3d", "plot");
  const queue = createMetadataQueue();
  enqueueMetadata(queue, message({ id: "pose", payload: { version: 1 } }), 10);
  enqueueMetadata(queue, message({ id: "latency", renderer: "plot" }), 11);
  enqueueMetadata(queue, message({ id: "pose", payload: { version: 2 } }), 12);

  const result = partitionFrameMetadata(takeMetadataForFrame(queue, 42, 0, 13), 42, registry);

  assert.deepEqual(result.auxiliaryViews.map((view) => view.id), ["latency", "pose"]);
  assert.equal(result.auxiliaryViews[1].payload.version, 2);
});

test("missing, late, and expired auxiliary data produce no frame view", () => {
  const registry = registryWith("blazepose-3d");
  const queue = createMetadataQueue();

  assert.deepEqual(partitionFrameMetadata(takeMetadataForFrame(queue, 42, 0, 1), 42, registry).auxiliaryViews, []);
  enqueueMetadata(queue, message(), 10);
  assert.deepEqual(partitionFrameMetadata(takeMetadataForFrame(queue, 43, 0, 11), 43, registry).auxiliaryViews, []);
  assert.deepEqual(partitionFrameMetadata(takeMetadataForFrame(queue, 42, 5, 20), 42, registry).auxiliaryViews, []);
});

test("channel-local queues cannot display another channel's auxiliary payload", () => {
  const registry = registryWith("blazepose-3d");
  const channelZero = createMetadataQueue();
  const channelOne = createMetadataQueue();
  enqueueMetadata(channelZero, message({ payload: { channel: 0 } }), 10);
  enqueueMetadata(channelOne, message({ payload: { channel: 1 } }), 10);

  const zero = partitionFrameMetadata(takeMetadataForFrame(channelZero, 42, 0, 11), 42, registry);
  const one = partitionFrameMetadata(takeMetadataForFrame(channelOne, 42, 0, 11), 42, registry);

  assert.equal(zero.auxiliaryViews[0].payload.channel, 0);
  assert.equal(one.auxiliaryViews[0].payload.channel, 1);
  assert.equal(takeMetadataForFrame(channelZero, 42, 0, 12).length, 0);
});

test("auxiliary animation runs only for a visible payload that requests it", () => {
  const animating = { isAnimating: () => true };
  const still = { isAnimating: () => false };

  assert.equal(shouldAnimateAuxiliaryView("compact", true, animating), true);
  assert.equal(shouldAnimateAuxiliaryView("expanded", true, animating), true);
  assert.equal(shouldAnimateAuxiliaryView("collapsed", true, animating), false);
  assert.equal(shouldAnimateAuxiliaryView("hidden", true, animating), false);
  assert.equal(shouldAnimateAuxiliaryView("compact", false, animating), false);
  assert.equal(shouldAnimateAuxiliaryView("compact", true, still), false);
  assert.equal(shouldAnimateAuxiliaryView("compact", true, null), false);
});

test("a correlated auxiliary view is held only through a brief delivery gap", () => {
  assert.equal(shouldHoldLastAuxiliaryFrame(true, 1000, 1160), true);
  assert.equal(shouldHoldLastAuxiliaryFrame(true, 1000, 1161), false);
  assert.equal(shouldHoldLastAuxiliaryFrame(false, 1000, 1050), false);
  assert.equal(shouldHoldLastAuxiliaryFrame(true, Number.NEGATIVE_INFINITY, 1050), false);
  assert.equal(shouldHoldLastAuxiliaryFrame(true, 1100, 1050), false);
});
