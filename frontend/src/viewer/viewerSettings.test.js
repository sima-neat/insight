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
  assert.equal(settings.version, 5);
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
      yawDegrees: -45,
      pitchDegrees: 20,
      showReferenceBox: true,
      stabilizePose: true,
    },
  );
});

test("BlazePose 3D settings resolve independently for each channel", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      auxiliary: {
        "blazepose-3d": { yawDegrees: -20, pitchDegrees: 10, panelMode: "compact" },
      },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 4,
      auxiliary: {
        "blazepose-3d": { enabled: false, yawDegrees: 75, panelMode: "expanded" },
      },
    }),
  });

  assert.deepEqual(
    { ...api.resolveAuxiliarySettings(1, "blazepose-3d") },
    {
      enabled: true,
      panelMode: "compact",
      yawDegrees: -20,
      pitchDegrees: 10,
      showReferenceBox: true,
      stabilizePose: true,
    },
  );
  assert.deepEqual(
    { ...api.resolveAuxiliarySettings(2, "blazepose-3d") },
    {
      enabled: false,
      panelMode: "expanded",
      yawDegrees: 75,
      pitchDegrees: 10,
      showReferenceBox: true,
      stabilizePose: true,
    },
  );
});

test("BlazePose 3D settings clamp camera angles and reject invalid panel modes", () => {
  const api = loadSettingsApi();
  const settings = api.normalizeSettings({
    version: 4,
    auxiliary: {
      "blazepose-3d": {
        panelMode: "floating",
        yawDegrees: 999,
        pitchDegrees: -999,
      },
    },
  });

  assert.equal(settings.auxiliary["blazepose-3d"].panelMode, "compact");
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

test("a channel can discard its 3D override and inherit global settings", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 5,
      auxiliary: { "blazepose-3d": { showReferenceBox: false, stabilizePose: false } },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 5,
      auxiliary: { "blazepose-3d": { showReferenceBox: true, stabilizePose: true } },
    }),
  });

  assert.equal(api.hasScopeAuxiliarySettings("channel_2", "blazepose-3d"), true);
  api.clearScopeAuxiliarySettings("channel_2", "blazepose-3d");
  assert.equal(api.hasScopeAuxiliarySettings("channel_2", "blazepose-3d"), false);
  assert.equal(api.resolveAuxiliarySettings(2, "blazepose-3d").showReferenceBox, false);
  assert.equal(api.resolveAuxiliarySettings(2, "blazepose-3d").stabilizePose, false);
});
