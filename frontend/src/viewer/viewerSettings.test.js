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

test("viewer synchronization settings default to a 350 ms video buffer and unlimited retention", () => {
  const api = loadSettingsApi();

  assert.deepEqual(
    { ...api.defaults.general },
    {
      videoSyncBufferMs: 350,
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

test("version two settings migrate without retaining overlay delay", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 2,
      general: { metadataDelay: 900, showRoi: false },
      types: { "object-detection": { confidenceThreshold: 0.5 } },
    }),
  });

  const settings = api.readScopeSettings("global");
  assert.equal(settings.version, 8);
  assert.equal(settings.general.videoSyncBufferMs, 350);
  assert.equal(settings.general.metadataRetentionMs, 0);
  assert.equal(settings.general.showRoi, false);
  assert.equal(settings.types["object-detection"].confidenceThreshold, 0.5);
  assert.equal("metadataDelay" in settings.general, false);
});

test("BlazePose 3D settings have visible reference-box defaults", () => {
  const api = loadSettingsApi();

  assert.deepEqual(
    { ...api.defaults.auxiliary["blazepose-3d"] },
    {
      enabled: true,
      panelMode: "compact",
      backgroundTransparency: 0,
      yawDegrees: -45,
      pitchDegrees: 20,
      showReferenceBox: true,
    },
  );
});

test("legacy animation and stabilization settings are discarded", () => {
  const api = loadSettingsApi();
  const settings = api.normalizeSettings({
    version: 6,
    auxiliary: {
      "blazepose-3d": {
        autoRotate: true,
        rotationSpeed: 80,
        paused: true,
        stabilizePose: true,
        yawDegrees: 35,
      },
    },
  });
  const pose3D = settings.auxiliary["blazepose-3d"];

  assert.equal(settings.version, 8);
  assert.equal(pose3D.yawDegrees, 35);
  assert.equal("autoRotate" in pose3D, false);
  assert.equal("rotationSpeed" in pose3D, false);
  assert.equal("paused" in pose3D, false);
  assert.equal("stabilizePose" in pose3D, false);
});

test("BlazePose 3D settings resolve independently for each channel", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      auxiliary: {
        "blazepose-3d": {
          yawDegrees: -20,
          pitchDegrees: 10,
          panelMode: "compact",
          backgroundTransparency: 0.35,
        },
      },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 4,
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

  assert.deepEqual(
    { ...api.resolveAuxiliarySettings(1, "blazepose-3d") },
    {
      enabled: true,
      panelMode: "compact",
      backgroundTransparency: 0.35,
      yawDegrees: -20,
      pitchDegrees: 10,
      showReferenceBox: true,
    },
  );
  assert.deepEqual(
    { ...api.resolveAuxiliarySettings(2, "blazepose-3d") },
    {
      enabled: false,
      panelMode: "expanded",
      backgroundTransparency: 0.8,
      yawDegrees: 75,
      pitchDegrees: 10,
      showReferenceBox: true,
    },
  );
});

test("BlazePose 3D settings clamp transparency and camera angles and reject invalid panel modes", () => {
  const api = loadSettingsApi();
  const settings = api.normalizeSettings({
    version: 4,
    auxiliary: {
      "blazepose-3d": {
        panelMode: "floating",
        backgroundTransparency: 3,
        yawDegrees: 999,
        pitchDegrees: -999,
      },
    },
  });

  assert.equal(settings.auxiliary["blazepose-3d"].panelMode, "compact");
  assert.equal(settings.auxiliary["blazepose-3d"].backgroundTransparency, 1);
  assert.equal(settings.auxiliary["blazepose-3d"].yawDegrees, 180);
  assert.equal(settings.auxiliary["blazepose-3d"].pitchDegrees, -60);
});

test("panel shortcuts do not create unrelated channel overrides", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      types: { "object-detection": { confidenceThreshold: 0.8 } },
    }),
  });

  api.writeScopeAuxiliarySettings("channel_3", "blazepose-3d", {
    enabled: true,
    panelMode: "expanded",
  });

  assert.equal(api.resolveTypeSettings(3, "object-detection").type.confidenceThreshold, 0.8);
  assert.equal(api.resolveAuxiliarySettings(3, "blazepose-3d").panelMode, "expanded");
});

test("metadata overlay visibility resolves globally and per channel", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 5,
      types: { "object-detection": { visible: false } },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 5,
      types: { "object-detection": { visible: true } },
    }),
  });

  assert.equal(api.resolveTypeSettings(1, "object-detection").type.visible, false);
  assert.equal(api.resolveTypeSettings(2, "object-detection").type.visible, true);
});

test("pose overlay defaults stay readable and resolve per channel", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 6,
      types: { "pose-estimation": { showKeypoints: false, showKeypointLabels: true } },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 6,
      types: { "pose-estimation": { showKeypoints: true, showKeypointLabels: false } },
    }),
  });

  assert.equal(api.defaults.types["pose-estimation"].showKeypointLabels, false);
  assert.equal(api.resolveTypeSettings(1, "pose-estimation").type.showKeypoints, false);
  assert.equal(api.resolveTypeSettings(1, "pose-estimation").type.showKeypointLabels, true);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").type.showKeypoints, true);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").type.showKeypointLabels, false);
});

test("a channel can discard its 3D override and inherit global settings", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 5,
      auxiliary: { "blazepose-3d": { showReferenceBox: false } },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 5,
      auxiliary: { "blazepose-3d": { showReferenceBox: true } },
    }),
  });

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
