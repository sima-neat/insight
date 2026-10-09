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
  return realmSafeApi(window.viewerSettingsApi);
}

// The resolver script runs in a separate vm context, so every object or array it
// returns belongs to that context's realm. node:assert/strict compares prototypes
// by reference, so a vm-realm value never structurally equals a same-shaped
// literal built in this file. Round-trip values through JSON so assertions
// compare plain objects native to this realm.
function realmSafeApi(api) {
  const safe = {};
  for (const [key, value] of Object.entries(api)) {
    safe[key] =
      typeof value === "function"
        ? (...args) => JSON.parse(JSON.stringify(value(...args)))
        : JSON.parse(JSON.stringify(value));
  }
  return safe;
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
    version: 3,
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
  assert.equal(settings.version, 4);
  assert.equal(settings.general.videoSyncBufferMs, 350);
  assert.equal(settings.general.metadataRetentionMs, 0);
  assert.equal(settings.general.showRoi, false);
  assert.equal(settings.types["object-detection"].confidenceThreshold, 0.5);
  assert.equal("metadataDelay" in settings.general, false);
});

test("settings version is 4 and object lists default to empty", () => {
  const api = loadSettingsApi();
  assert.equal(api.version, 4);
  assert.deepEqual(api.defaults.types["object-detection"].objects, []);
  assert.deepEqual(api.defaults.types.segmentation.objects, []);
});

test("resolved object styles contain only user entries, no injected default", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      types: { "object-detection": { objects: [{ label: "person", color: "#112233" }] } },
    }),
  });
  const resolved = api.resolveTypeSettings(0, "object-detection");
  assert.deepEqual(resolved.type.objects, [{ label: "person", color: "#112233", style: "solid", width: 1 }]);
  assert.deepEqual(api.resolveTypeSettings(0, "segmentation").type.objects, []);
});

test("migrating from version 3 drops a stock green default entry", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 3,
      types: {
        "object-detection": {
          objects: [
            { label: "default", color: "#00ff00", style: "solid", width: 1 },
            { label: "car", color: "#ff0000", style: "dashed", width: 3 },
          ],
        },
        segmentation: {
          objects: [{ label: "default", color: "#00ff00", style: "solid", width: 1 }],
        },
      },
    }),
  });
  const settings = api.readScopeSettings("global");
  assert.equal(settings.version, 4);
  assert.deepEqual(settings.types["object-detection"].objects, [
    { label: "car", color: "#ff0000", style: "dashed", width: 3 },
  ]);
  assert.deepEqual(settings.types.segmentation.objects, []);
  assert.deepEqual(api.resolveTypeSettings(0, "segmentation").type.objects, []);
});

test("migrating from version 3 keeps a recolored default entry as an override", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 3,
      types: {
        "object-detection": {
          objects: [{ label: "default", color: "#ff00ff", style: "solid", width: 1 }],
        },
      },
    }),
  });
  const resolved = api.resolveTypeSettings(0, "object-detection");
  assert.deepEqual(resolved.type.objects, [{ label: "default", color: "#ff00ff", style: "solid", width: 1 }]);
});

test("version 4 settings keep an explicit stock green default entry", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      types: {
        "object-detection": {
          objects: [{ label: "default", color: "#00ff00", style: "solid", width: 1 }],
        },
      },
    }),
  });
  const resolved = api.resolveTypeSettings(0, "object-detection");
  assert.equal(resolved.type.objects.length, 1);
  assert.equal(resolved.type.objects[0].color, "#00ff00");
});

test("channel object entries override global entries by label", () => {
  const api = loadSettingsApi({
    viewerSettings_global: JSON.stringify({
      version: 4,
      types: { "object-detection": { objects: [{ label: "person", color: "#111111" }, { label: "car", color: "#222222" }] } },
    }),
    viewerSettings_channel_2: JSON.stringify({
      version: 4,
      types: { "object-detection": { objects: [{ label: "person", color: "#333333" }] } },
    }),
  });
  const resolved = api.resolveTypeSettings(2, "object-detection");
  const byLabel = Object.fromEntries(resolved.type.objects.map((entry) => [entry.label, entry.color]));
  assert.deepEqual(byLabel, { person: "#333333", car: "#222222" });
});
