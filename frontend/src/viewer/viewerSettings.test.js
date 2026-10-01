import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const resolverSource = readFileSync(
  new URL("../../../webrtc/static/js/viewer-settings-resolver.js", import.meta.url),
  "utf8",
);

function loadSettingsApi(stored = {}) {
  const values = new Map(Object.entries(stored));
  const window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
  vm.runInNewContext(resolverSource, { window });
  return window.viewerSettingsApi;
}

test("viewer synchronization settings default to a 300 ms video buffer and unlimited retention", () => {
  const api = loadSettingsApi();

  assert.deepEqual(
    { ...api.defaults.general },
    {
      videoSyncBufferMs: 300,
      metadataRetentionMs: 0,
      showRoi: true,
      applyRoiFiltering: true,
    },
  );
});

test("viewer synchronization settings preserve configured values", () => {
  const api = loadSettingsApi();

  const settings = api.normalizeSettings({
    version: 4,
    general: { videoSyncBufferMs: 700, metadataRetentionMs: 2500 },
  });

  assert.equal(settings.general.videoSyncBufferMs, 700);
  assert.equal(settings.general.metadataRetentionMs, 2500);
});

test("the previous 350 ms default migrates to the measured 300 ms floor", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 8,
      general: { videoSyncBufferMs: 350 },
    }),
  });

  assert.equal(api.resolveTypeSettings(0).general.videoSyncBufferMs, 300);
  assert.equal(api.readScopeSettings("global").general.videoSyncBufferMs, 300);
});

test("auxiliary mutations migrate legacy settings without creating channel overrides", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 9,
      general: { metadataRetentionMs: 2500 },
      types: { "pose-estimation": { visible: false } },
    }),
    viewerSettings_channel_0: JSON.stringify({
      version: 3,
      general: { videoSyncBufferMs: 350 },
      auxiliary: { "blazepose-3d": { panelMode: "expanded" } },
    }),
    viewerSettings_channel_1: JSON.stringify({
      version: 3,
      general: { videoSyncBufferMs: 350 },
      auxiliary: { "blazepose-3d": { panelMode: "expanded" } },
    }),
  });

  api.writeScopeAuxiliarySettings("channel_0", "blazepose-3d", { panelMode: "collapsed" });
  api.clearScopeAuxiliarySettings("channel_1", "blazepose-3d");

  for (const channelIndex of [0, 1]) {
    const resolved = api.resolveTypeSettings(channelIndex, "pose-estimation");
    assert.equal(resolved.general.videoSyncBufferMs, 300);
    assert.equal(resolved.general.metadataRetentionMs, 2500);
    assert.equal(resolved.type.visible, false);
  }
  assert.equal(api.resolveAuxiliarySettings(0, "blazepose-3d").panelMode, "collapsed");
  assert.equal(api.hasScopeAuxiliarySettings("channel_1", "blazepose-3d"), false);
});

test("version two settings migrate without retaining overlay delay", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 2,
      general: { metadataDelay: 900, showRoi: false },
      types: { "object-detection": { confidenceThreshold: 0.5 } },
    }),
  });

  const settings = api.readScopeSettings("global");
  assert.equal(settings.version, 9);
  assert.equal(settings.general.videoSyncBufferMs, 300);
  assert.equal(settings.general.metadataRetentionMs, 0);
  assert.equal(settings.general.showRoi, false);
  assert.equal(settings.types["object-detection"].confidenceThreshold, 0.5);
  assert.equal("metadataDelay" in settings.general, false);
});

test("BlazePose 3D settings normalize values and discard obsolete controls", () => {
  const api = loadSettingsApi();
  const settings = api.normalizeSettings({
    version: 6,
    auxiliary: {
      "blazepose-3d": {
        panelMode: "floating",
        backgroundTransparency: 3,
        autoRotate: true,
        rotationSpeed: 80,
        paused: true,
        stabilizePose: true,
        yawDegrees: 999,
        pitchDegrees: -999,
      },
    },
    types: {
      "pose-estimation": {
        poseStrokeColor: "#123456",
        poseFillColor: "#654321",
        poseFont: "12px sans-serif",
      },
    },
  });
  const pose3D = settings.auxiliary["blazepose-3d"];

  assert.deepEqual({ ...api.defaults.auxiliary["blazepose-3d"] }, {
    enabled: true,
    panelMode: "compact",
    backgroundTransparency: 0,
    yawDegrees: -45,
    pitchDegrees: 20,
    showReferenceBox: true,
  });
  assert.deepEqual(
    {
      panelMode: pose3D.panelMode,
      backgroundTransparency: pose3D.backgroundTransparency,
      yawDegrees: pose3D.yawDegrees,
      pitchDegrees: pose3D.pitchDegrees,
    },
    { panelMode: "compact", backgroundTransparency: 1, yawDegrees: 180, pitchDegrees: -60 },
  );
  for (const key of ["autoRotate", "rotationSpeed", "paused", "stabilizePose"]) {
    assert.equal(key in pose3D, false);
  }
  assert.deepEqual(
    {
      poseStrokeColor: settings.types["pose-estimation"].poseStrokeColor,
      poseFillColor: settings.types["pose-estimation"].poseFillColor,
      poseFont: settings.types["pose-estimation"].poseFont,
    },
    { poseStrokeColor: "#123456", poseFillColor: "#654321", poseFont: "12px sans-serif" },
  );
});

test("viewer settings resolve and clear independent channel overrides", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 9,
      types: {
        "object-detection": { visible: false, confidenceThreshold: 0.8 },
        "pose-estimation": { showKeypoints: false, showKeypointLabels: true },
      },
      auxiliary: {
        "blazepose-3d": {
          yawDegrees: -20,
          backgroundTransparency: 0.35,
          showReferenceBox: false,
        },
      },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 9,
      types: {
        "object-detection": { visible: true },
        "pose-estimation": { showKeypoints: true, showKeypointLabels: false },
      },
      auxiliary: {
        "blazepose-3d": {
          enabled: false,
          yawDegrees: 75,
          panelMode: "expanded",
          backgroundTransparency: 0.8,
        },
      },
    }),
  });

  assert.equal(api.resolveAuxiliarySettings(1, "blazepose-3d").backgroundTransparency, 0.35);
  assert.equal(api.resolveAuxiliarySettings(2, "blazepose-3d").backgroundTransparency, 0.8);
  assert.equal(api.resolveTypeSettings(1, "object-detection").type.visible, false);
  assert.equal(api.resolveTypeSettings(2, "object-detection").type.visible, true);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").type.showKeypoints, true);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").type.showKeypointLabels, false);
  api.writeScopeAuxiliarySettings("channel_3", "blazepose-3d", {
    enabled: true,
    panelMode: "expanded",
  });
  assert.equal(api.resolveTypeSettings(3, "object-detection").type.confidenceThreshold, 0.8);
  assert.equal(api.resolveAuxiliarySettings(3, "blazepose-3d").panelMode, "expanded");
  const updatedGlobal = api.readScopeSettings("global");
  updatedGlobal.auxiliary["blazepose-3d"].backgroundTransparency = 0.6;
  api.writeScopeSettings("global", updatedGlobal);
  assert.equal(api.resolveAuxiliarySettings(3, "blazepose-3d").backgroundTransparency, 0.6);
  assert.equal(api.resolveAuxiliarySettings(3, "blazepose-3d").panelMode, "expanded");
  assert.equal(api.defaults.types["pose-estimation"].showKeypointLabels, false);
  assert.equal(api.hasScopeAuxiliarySettings("channel_2", "blazepose-3d"), true);
  api.clearScopeAuxiliarySettings("channel_2", "blazepose-3d");
  assert.equal(api.hasScopeAuxiliarySettings("channel_2", "blazepose-3d"), false);
  assert.equal(api.resolveAuxiliarySettings(2, "blazepose-3d").showReferenceBox, false);
});

test("a global save can clear all channel settings overrides", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 8,
      types: { "pose-estimation": { visible: false } },
      auxiliary: { "blazepose-3d": { enabled: false, backgroundTransparency: 0.8 } },
    }),
    viewerSettings_channel_0: JSON.stringify({
      version: 8,
      types: { "pose-estimation": { visible: true } },
      auxiliary: { "blazepose-3d": { enabled: true, backgroundTransparency: 0.25 } },
    }),
    viewerSettings_channel_3: JSON.stringify({ version: 8, general: { videoSyncBufferMs: 900 } }),
  });

  assert.equal(api.resolveTypeSettings(0, "pose-estimation").type.visible, true);
  assert.equal(api.resolveAuxiliarySettings(0, "blazepose-3d").enabled, true);
  assert.equal(api.clearAllChannelSettings(), 2);
  assert.equal(api.resolveTypeSettings(0, "pose-estimation").type.visible, false);
  assert.equal(api.resolveAuxiliarySettings(0, "blazepose-3d").enabled, false);
  assert.equal(api.resolveAuxiliarySettings(0, "blazepose-3d").backgroundTransparency, 0.8);
  assert.equal(api.clearAllChannelSettings(), 0);
  assert.equal(api.hasScopeAuxiliarySettings("channel_0", "blazepose-3d"), false);
});
