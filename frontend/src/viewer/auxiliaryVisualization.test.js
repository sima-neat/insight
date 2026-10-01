import assert from "node:assert/strict";
import test from "node:test";

import {
  AUXILIARY_METADATA_TYPE,
  auxiliaryRendererRegistry,
  createAuxiliaryViewPreference,
  initialAuxiliarySessionSettings,
  nextAuxiliaryPreview,
  partitionFrameMetadata,
  reconcileAuxiliaryPanelMode,
  restoreAuxiliaryViewPreference,
  retainAuxiliaryViews,
  routeAuxiliarySettingsEvent,
} from "./auxiliaryVisualization.js";
import { createMetadataQueue, enqueueMetadata, takeMetadataForFrame } from "./metadataSync.js";

function registryWith(...names) {
  const renderers = new Map(names.map((name) => [name, { title: name, draw() {} }]));
  return { get: (name) => renderers.get(name) ?? null };
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
  const result = partitionFrameMetadata([{ data: message({ renderer: "plot" }) }], 42, registry);
  const view = result.auxiliaryViews[0];

  assert.equal(view.renderer, "plot");
  assert.equal(view.id, "pose");
  assert.equal(view.frameId, "frame-1");
});

test("generic renderer registration preserves renderer-owned settings integration", () => {
  const viewerSettings = {
    toSession(settings) { return { scale: settings.scale }; },
  };
  auxiliaryRendererRegistry.register(
    "point-cloud-3d-test",
    { title: "Point Cloud", draw() {}, viewerSettings },
  );

  const renderer = auxiliaryRendererRegistry.get("point-cloud-3d-test");
  assert.equal(renderer.viewerSettings, viewerSettings);
  assert.deepEqual(renderer.viewerSettings.toSession({ scale: 2 }), { scale: 2 });
});

test("per-view preferences apply only while their Viewer Configuration baseline is current", () => {
  const configured = { showReferenceCube: true, yaw: 0.25, pitch: 0.5 };
  const preference = createAuxiliaryViewPreference(configured, { yaw: 1.25 });

  assert.deepEqual(
    restoreAuxiliaryViewPreference(configured, preference),
    { showReferenceCube: true, yaw: 1.25, pitch: 0.5 },
  );
  assert.deepEqual(
    restoreAuxiliaryViewPreference({ ...configured, yaw: -0.75 }, preference),
    { showReferenceCube: true, yaw: -0.75, pitch: 0.5 },
  );
  assert.deepEqual(restoreAuxiliaryViewPreference(configured, { yaw: 2 }, false), configured);
});

test("a restored auxiliary view reconciles its panel mode with explicit viewer settings", () => {
  assert.equal(
    reconcileAuxiliaryPanelMode("compact", { enabled: false, panelMode: "expanded" }, true),
    "hidden",
  );
  assert.equal(
    reconcileAuxiliaryPanelMode("hidden", { enabled: true, panelMode: "expanded" }, true),
    "expanded",
  );
  assert.equal(
    reconcileAuxiliaryPanelMode("expanded", { enabled: true, panelMode: "compact" }, false),
    "expanded",
  );
});

test("closing a preview still refreshes after its view stops being selected", () => {
  assert.deepEqual(
    routeAuxiliarySettingsEvent(
      "viewer-settings-changed",
      "blazepose-3d",
      "point-cloud-3d",
      "blazepose-3d",
    ),
    { isPreview: false, cancelsPreview: true, appliesToSelection: true },
  );
});

test("a preview is retained before its renderer becomes selected", () => {
  const routing = routeAuxiliarySettingsEvent(
    "viewer-settings-preview",
    "blazepose-3d",
    "point-cloud-3d",
    null,
  );
  const settings = { yawDegrees: 90 };

  assert.equal(routing.appliesToSelection, false);
  assert.deepEqual(
    nextAuxiliaryPreview(null, routing, "blazepose-3d", settings),
    { renderer: "blazepose-3d", settings },
  );
});

test("a recreated renderer session starts from the active preview", () => {
  const toSession = ({ yawDegrees }) => ({ yaw: yawDegrees * Math.PI / 180 });

  assert.deepEqual(
    initialAuxiliarySessionSettings(
      { yaw: 0 },
      { yawDegrees: 90 },
      toSession,
      true,
    ),
    { yaw: Math.PI / 2 },
  );
});

test("generic transport preserves an arbitrary renderer-owned 3D payload", () => {
  const registry = registryWith("mesh-3d");
  const payload = {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    triangles: [[0, 1, 2]],
    coordinateSystem: { handedness: "right", units: "millimeters" },
  };
  const result = partitionFrameMetadata(
    [{ data: message({ renderer: "mesh-3d", payload }) }],
    42,
    registry,
  );

  assert.equal(result.auxiliaryViews[0].payload, payload);
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

test("timestamped auxiliary data uses the selected frame in the video callback fallback", () => {
  const registry = registryWith("blazepose-3d");
  const queue = createMetadataQueue();
  enqueueMetadata(queue, message(), 10);

  const candidates = takeMetadataForFrame(queue, undefined, 0, 11);
  const result = partitionFrameMetadata(candidates, undefined, registry);

  assert.equal(result.auxiliaryViews[0]?.id, "pose");
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

test("each auxiliary view keeps an independent dropout grace", () => {
  const pose = { id: "pose", renderer: "blazepose-3d" };
  const chart = { id: "chart", renderer: "plot" };
  const first = retainAuxiliaryViews(new Map(), [pose, chart], new Map(), 1000);
  const partial = retainAuxiliaryViews(first.views, [chart], first.lastSeenById, 1160);

  assert.deepEqual([...partial.views.keys()], ["pose", "chart"]);
  const expired = retainAuxiliaryViews(partial.views, [chart], partial.lastSeenById, 1161);
  assert.deepEqual([...expired.views.keys()], ["chart"]);
  assert.equal(expired.lastSeenById.has("pose"), false);
});

test("current-frame auxiliary views replace retained IDs before the panel limit", () => {
  const previous = Array.from({ length: 16 }, (_, id) => ({ id: `previous-${id}` }));
  const incoming = Array.from({ length: 16 }, (_, id) => ({ id: `incoming-${id}` }));
  const first = retainAuxiliaryViews(new Map(), previous, new Map(), 1000);
  const next = retainAuxiliaryViews(first.views, incoming, first.lastSeenById, 1016);

  assert.equal(next.views.size, 16);
  assert.deepEqual([...next.views.keys()], incoming.map(({ id }) => id));
  assert.deepEqual([...next.lastSeenById.keys()], incoming.map(({ id }) => id));
});

test("one frame cannot create an unbounded auxiliary tab set", () => {
  const registry = registryWith("plot");
  const candidates = Array.from({ length: 18 }, (_, id) => ({
    data: message({ id: `view-${id}`, renderer: "plot" }),
  }));
  const result = partitionFrameMetadata(candidates, 42, registry);

  assert.equal(result.auxiliaryViews.length, 16);
  assert.equal(result.ignoredAuxiliary.length, 2);
  assert.match(result.ignoredAuxiliary[0].reason, /exceeds/);
});
