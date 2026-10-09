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

// `failWritesFor` lists storage keys whose writes fail while all others succeed.
function loadSettingsApiWithStorage(stored = {}, { failWrites = false, failWritesFor = [] } = {}) {
  const values = new Map(Object.entries(stored).map(([key, value]) => [key, JSON.stringify(value)]));
  const window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (failWrites || failWritesFor.includes(key)) throw new Error("quota exceeded");
        values.set(key, value);
      },
      removeItem: (key) => {
        if (failWrites || failWritesFor.includes(key)) throw new Error("quota exceeded");
        values.delete(key);
      },
      get length() {
        return values.size;
      },
      key: (i) => Array.from(values.keys())[i] ?? null
    }
  };
  vm.runInNewContext(resolverSource, { window });
  return {
    api: realmSafeApi(window.viewerSettingsApi),
    readStored: (key) => (values.has(key) ? JSON.parse(values.get(key)) : null),
    // The exact string in storage, to check a restore came back byte for byte
    // rather than merely equal after a re-serialize.
    readRaw: (key) => values.get(key) ?? null
  };
}

test("writing one general override leaves the scope's other values inherited", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 500, showRoi: false }, types: {} }
  });

  api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 600);

  assert.deepEqual(readStored("viewerSettings_channel_1").general, { videoSyncBufferMs: 600 });
  const resolved = api.resolveTypeSettings(1, "pose-estimation");
  assert.equal(resolved.general.videoSyncBufferMs, 600);
  assert.equal(resolved.general.showRoi, false);
});

test("writing one general override leaves other scopes untouched", () => {
  const global = { version: 4, general: { videoSyncBufferMs: 500 }, types: {} };
  const { api, readStored } = loadSettingsApiWithStorage({ viewerSettings_global: global });

  api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 600);

  assert.deepEqual(readStored("viewerSettings_global"), global);
  assert.equal(readStored("viewerSettings_channel_2"), null);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").general.videoSyncBufferMs, 500);
});

test("writing one general override keeps the scope's existing overrides", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { metadataRetentionMs: 2500 },
      types: { segmentation: { maskOpacity: 0.7 } }
    }
  });

  api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 600);

  const stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.general, { metadataRetentionMs: 2500, videoSyncBufferMs: 600 });
  assert.equal(stored.types.segmentation.maskOpacity, 0.7);
  assert.equal(stored.version, 4);
});

test("writing one general override clamps the value like the settings dialog", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 9000);

  assert.equal(readStored("viewerSettings_channel_1").general.videoSyncBufferMs, 4000);
});

test("writing one general override reports a storage failure", () => {
  const { api } = loadSettingsApiWithStorage({}, { failWrites: true });

  assert.equal(api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 600), null);
});

test("scope overrides are read without defaults", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  assert.deepEqual(api.readScopeOverrides("channel_1").general, { videoSyncBufferMs: 600 });
  assert.deepEqual(api.readScopeOverrides("channel_2"), { general: {}, types: {} });
});

test("clearing one own general value keeps the others and the types", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 600, metadataRetentionMs: 2500 },
      types: { segmentation: { maskOpacity: 0.7 } }
    }
  });

  api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs");

  const stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.general, { metadataRetentionMs: 2500 });
  assert.equal(stored.types.segmentation.maskOpacity, 0.7);
  assert.equal(api.resolveTypeSettings(1, "pose-estimation").general.videoSyncBufferMs, 350);
});

test("clearing a value the scope does not have succeeds and changes nothing else", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { metadataRetentionMs: 2500 }, types: {} }
  });

  const result = api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs");

  assert.deepEqual(result.general, { metadataRetentionMs: 2500 });
  assert.deepEqual(readStored("viewerSettings_channel_1").general, { metadataRetentionMs: 2500 });
});

test("clearing reports a storage failure as null", () => {
  const { api } = loadSettingsApiWithStorage(
    { viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} } },
    { failWrites: true }
  );

  assert.equal(api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs"), null);
});

test("clearing a general value through clearScopeGeneralOverride removes the entry when nothing is left", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  const result = api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs");

  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.ok(result && typeof result === "object");
});

test("a clear that cannot remove the entry reports a failure", () => {
  const channel1 = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
  const { api, readStored } = loadSettingsApiWithStorage(
    { viewerSettings_channel_1: channel1 },
    { failWritesFor: ["viewerSettings_channel_1"] }
  );

  assert.equal(api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs"), null);
  assert.deepEqual(readStored("viewerSettings_channel_1"), channel1);
});

test("listing finds channels with their own value, sorted by channel number", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_10: { version: 4, general: { videoSyncBufferMs: 900 }, types: {} },
    viewerSettings_channel_2: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    viewerSettings_channel_7: { version: 4, general: { videoSyncBufferMs: 700 }, types: {} },
    viewerSettings_channel_3: { version: 4, general: { metadataRetentionMs: 2500 }, types: {} }
  });

  assert.deepEqual(api.listChannelGeneralOverrides("videoSyncBufferMs"), [
    { channel: 2, value: 500 },
    { channel: 7, value: 700 },
    { channel: 10, value: 900 }
  ]);
});

test("listing ignores the global scope, malformed entries and foreign keys", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    viewerSettings_channel_abc: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    viewerSettings_channel_4: "not json",
    layoutCount: 3
  });

  assert.deepEqual(api.listChannelGeneralOverrides("videoSyncBufferMs"), []);
});

test("listing reports a channel whose own value equals the global value", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} }
  });

  assert.deepEqual(api.listChannelGeneralOverrides("videoSyncBufferMs"), [{ channel: 1, value: 500 }]);
});

test("saving with general keys stores only those keys", () => {
  const { api, readStored } = loadSettingsApiWithStorage();
  const settings = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };

  const stored = api.writeScopeSettings("channel_1", settings, { generalKeys: ["videoSyncBufferMs"] });
  assert.deepEqual(stored.general, { videoSyncBufferMs: 600 });
  assert.deepEqual(readStored("viewerSettings_channel_1").general, { videoSyncBufferMs: 600 });
  assert.deepEqual(stored.types, api.normalizeSettings(settings).types);

  const storedEmpty = api.writeScopeSettings("channel_1", settings, { generalKeys: [] });
  assert.deepEqual(storedEmpty.general, {});
});

test("saving without the option stores every general key as before", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  api.writeScopeSettings("channel_1", { version: 4, general: { videoSyncBufferMs: 600 }, types: {} });

  assert.deepEqual(Object.keys(readStored("viewerSettings_channel_1").general).sort(), [
    "applyRoiFiltering",
    "metadataRetentionMs",
    "showRoi",
    "videoSyncBufferMs"
  ]);
});

test("the followed value is the global scope's own value, else the default", () => {
  const withGlobal = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 1000, metadataRetentionMs: 0 }, types: {} },
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} }
  }).api;
  assert.equal(withGlobal.followedGeneralValue("videoSyncBufferMs"), 1000);
  assert.equal(withGlobal.followedGeneralValue("metadataRetentionMs"), 0);
  assert.equal(withGlobal.followedGeneralValue("showRoi"), true);

  const withoutGlobal = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  }).api;
  assert.equal(withoutGlobal.followedGeneralValue("videoSyncBufferMs"), 350);
});

test("keys to store keep own keys, add changed keys and leave unchanged inherited keys out", () => {
  const { api } = loadSettingsApiWithStorage();
  const loaded = { videoSyncBufferMs: 350, metadataRetentionMs: 0, showRoi: true, applyRoiFiltering: true };

  assert.deepEqual(
    api.generalKeysToStore(["metadataRetentionMs"], loaded, { ...loaded, videoSyncBufferMs: 600, showRoi: false }),
    ["metadataRetentionMs", "videoSyncBufferMs", "showRoi"]
  );
  assert.deepEqual(api.generalKeysToStore([], loaded, { ...loaded }), []);
  assert.deepEqual(
    api.generalKeysToStore(["videoSyncBufferMs"], loaded, { ...loaded, videoSyncBufferMs: 600 }),
    ["videoSyncBufferMs"]
  );
});

test("raising for a channel and then applying globally leaves no entry for the channel", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  api.writeScopeGeneralOverride("channel_1", "videoSyncBufferMs", 600);
  const result = api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 800);

  assert.deepEqual(result, { applied: 800, raised: true });
  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.equal(readStored("viewerSettings_global").general.videoSyncBufferMs, 800);
});

test("applying globally raises the global value and removes the channel's own value", () => {
  for (const stored of [
    { viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} } },
    {}
  ]) {
    const { api, readStored } = loadSettingsApiWithStorage({
      ...stored,
      viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} }
    });

    const result = api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600);

    assert.deepEqual(result, { applied: 600, raised: true });
    assert.equal(readStored("viewerSettings_global").general.videoSyncBufferMs, 600);
    // Nothing was left of the channel's own values, so its entry is gone rather
    // than an empty stub.
    assert.equal(readStored("viewerSettings_channel_1"), null);
    assert.equal(api.resolveTypeSettings(1, "pose-estimation").general.videoSyncBufferMs, 600);
  }
});

test("applying globally never lowers the global value", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 1000 }, types: {} },
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} }
  });

  const result = api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600);

  assert.deepEqual(result, { applied: 1000, raised: false });
  assert.equal(readStored("viewerSettings_global").general.videoSyncBufferMs, 1000);
  // Nothing was left of the channel's own values, so its entry is gone rather
  // than an empty stub.
  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.equal(api.resolveTypeSettings(1, "pose-estimation").general.videoSyncBufferMs, 1000);
});

test("applying globally with a global value equal to the target does not write the global scope", () => {
  const global = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
  // 600.4 and "600" normalize to 600, so they count as equal too.
  for (const value of [600, 600.4, "600"]) {
    const { api, readStored } = loadSettingsApiWithStorage(
      {
        viewerSettings_global: global,
        viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} }
      },
      { failWritesFor: ["viewerSettings_global"] }
    );

    const result = api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", value);

    assert.deepEqual(result, { applied: 600, raised: false });
    assert.deepEqual(readStored("viewerSettings_global"), global);
    // Nothing was left of the channel's own values, so its entry is gone rather
    // than an empty stub.
    assert.equal(readStored("viewerSettings_channel_1"), null);
  }
});

test("applying globally keeps the channel's other own values and types", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 350, metadataRetentionMs: 2500, showRoi: false },
      types: { segmentation: { maskOpacity: 0.7 } }
    }
  });

  api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600);

  const stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.general, { metadataRetentionMs: 2500, showRoi: false });
  assert.equal(stored.types.segmentation.maskOpacity, 0.7);
});

test("applying globally does not touch other channels' own values", () => {
  const channel2 = { version: 4, general: { videoSyncBufferMs: 450 }, types: {} };
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} },
    viewerSettings_channel_2: channel2
  });

  api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600);

  assert.deepEqual(readStored("viewerSettings_channel_2"), channel2);
  assert.equal(api.resolveTypeSettings(2, "pose-estimation").general.videoSyncBufferMs, 450);
});

test("applying globally reports a storage failure as null and leaves the global value as it was", () => {
  const global = { version: 4, general: { videoSyncBufferMs: 350, showRoi: false }, types: {} };
  const channel1 = { version: 4, general: { videoSyncBufferMs: 350 }, types: {} };
  const { api, readStored } = loadSettingsApiWithStorage(
    { viewerSettings_global: global, viewerSettings_channel_1: channel1 },
    { failWritesFor: ["viewerSettings_channel_1"] }
  );

  assert.equal(api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600), null);
  assert.deepEqual(readStored("viewerSettings_global"), global);
  assert.deepEqual(readStored("viewerSettings_channel_1"), channel1);
});

test("a failed global apply removes a global entry that did not exist before", () => {
  const { api, readStored } = loadSettingsApiWithStorage(
    { viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 350 }, types: {} } },
    { failWritesFor: ["viewerSettings_channel_1"] }
  );

  assert.equal(api.applyGlobalGeneral("channel_1", "videoSyncBufferMs", 600), null);
  assert.equal(readStored("viewerSettings_global"), null);
});

test("clearing a value the scope does not have writes nothing", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  const result = api.clearScopeGeneralOverride("channel_1", "videoSyncBufferMs");

  assert.equal(readStored("viewerSettings_channel_1"), null);
  // Still an object, so callers see success.
  assert.deepEqual(result.general, {});
  assert.deepEqual(result.types, {});
});

// Maps a scalar id to the value resolveTypeSettings reports for it, following the
// id's own path (general.<key>, types.<type>.<key> or types.tracking.history.<key>).
function resolvedValueForId(api, channel, id) {
  const parts = id.split(".");
  if (parts[0] === "general") {
    return api.resolveTypeSettings(channel, "object-detection").general[parts[1]];
  }
  const resolvedType = api.resolveTypeSettings(channel, parts[1]).type;
  return parts.length === 3 ? resolvedType[parts[2]] : resolvedType.history[parts[3]];
}

test("the scalar settings list has the eleven ids of the spec, each with its tab and metadata type", () => {
  const { api } = loadSettingsApiWithStorage();

  assert.deepEqual(api.scalarSettings(), [
    { id: "general.videoSyncBufferMs", tab: "General", metadataType: null },
    { id: "general.metadataRetentionMs", tab: "General", metadataType: null },
    { id: "general.showRoi", tab: "ROI", metadataType: null },
    { id: "general.applyRoiFiltering", tab: "ROI", metadataType: null },
    { id: "types.object-detection.confidenceThreshold", tab: "Metadata", metadataType: "object-detection" },
    { id: "types.segmentation.confidenceThreshold", tab: "Metadata", metadataType: "segmentation" },
    { id: "types.segmentation.maskOpacity", tab: "Metadata", metadataType: "segmentation" },
    { id: "types.tracking.confidenceThreshold", tab: "Metadata", metadataType: "tracking" },
    { id: "types.tracking.history.enabled", tab: "Metadata", metadataType: "tracking" },
    { id: "types.tracking.history.trailLength", tab: "Metadata", metadataType: "tracking" },
    { id: "types.tracking.history.lostTrackTtlMs", tab: "Metadata", metadataType: "tracking" }
  ]);
});

test("the followed value is the global scope's own value, else the default, for general, type and nested ids", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: {
      version: 4,
      general: { videoSyncBufferMs: 900 },
      types: { tracking: { history: { trailLength: 40 } } }
    }
  });

  assert.equal(api.followedValue("general.videoSyncBufferMs"), 900);
  assert.equal(api.followedValue("general.metadataRetentionMs"), 0);
  assert.equal(api.followedValue("types.tracking.confidenceThreshold"), 0);
  assert.equal(api.followedValue("types.tracking.history.trailLength"), 40);
  assert.equal(api.followedValue("types.tracking.history.lostTrackTtlMs"), 2000);
  assert.equal(api.followedValue("no.such.id"), null);
});

test("own values are read by id, nested ones included, empty for an empty scope", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 600 },
      types: { tracking: { history: { trailLength: 25 } } }
    }
  });

  assert.deepEqual(api.readScopeOwnValues("channel_1"), {
    "general.videoSyncBufferMs": 600,
    "types.tracking.history.trailLength": 25
  });
  assert.deepEqual(api.readScopeOwnValues("channel_2"), {});
});

test("own values of a scope stored by the old dialog are all reported", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 700, metadataRetentionMs: 3000, showRoi: false, applyRoiFiltering: false },
      types: {
        "object-detection": { confidenceThreshold: 0.4 },
        segmentation: { confidenceThreshold: 0.5, maskOpacity: 0.6 },
        tracking: { confidenceThreshold: 0.3, history: { enabled: false, trailLength: 30, lostTrackTtlMs: 6000 } }
      }
    }
  });

  assert.deepEqual(api.readScopeOwnValues("channel_1"), {
    "general.videoSyncBufferMs": 700,
    "general.metadataRetentionMs": 3000,
    "general.showRoi": false,
    "general.applyRoiFiltering": false,
    "types.object-detection.confidenceThreshold": 0.4,
    "types.segmentation.confidenceThreshold": 0.5,
    "types.segmentation.maskOpacity": 0.6,
    "types.tracking.confidenceThreshold": 0.3,
    "types.tracking.history.enabled": false,
    "types.tracking.history.trailLength": 30,
    "types.tracking.history.lostTrackTtlMs": 6000
  });
});

test("own values of a legacy tracking scope with flat keys are reported under the history ids", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: {},
      types: { tracking: { showTrackHistory: false, trailLength: 20, lostTrackTtlMs: 5000 } }
    }
  });

  assert.deepEqual(api.readScopeOwnValues("channel_1"), {
    "types.tracking.history.enabled": false,
    "types.tracking.history.trailLength": 20,
    "types.tracking.history.lostTrackTtlMs": 5000
  });
});

test("writing own settings stores exactly what is given", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  const stored = api.writeScopeOwnSettings(
    "channel_1",
    { "general.videoSyncBufferMs": 600, "types.tracking.confidenceThreshold": 0.5, "no.such.id": 1 },
    { "object-detection": [{ label: "car", color: "#ff0000", style: "dashed", width: 3 }] }
  );

  assert.deepEqual(readStored("viewerSettings_channel_1"), stored);
  assert.deepEqual(stored.general, { videoSyncBufferMs: 600 });
  assert.deepEqual(stored.types, {
    tracking: { confidenceThreshold: 0.5 },
    "object-detection": { objects: [{ label: "car", color: "#ff0000", style: "dashed", width: 3 }] }
  });
  assert.deepEqual(api.readScopeOwnValues("channel_1"), {
    "general.videoSyncBufferMs": 600,
    "types.tracking.confidenceThreshold": 0.5
  });
});

test("writing own settings replaces what the scope had before", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 600, showRoi: false },
      types: {
        segmentation: {
          maskOpacity: 0.7,
          objects: [{ label: "old", color: "#123456", style: "solid", width: 1 }]
        }
      }
    }
  });

  api.writeScopeOwnSettings("channel_1", { "general.metadataRetentionMs": 1000 }, {});

  const stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.general, { metadataRetentionMs: 1000 });
  assert.deepEqual(stored.types, {});
});

test("writing with nothing to store removes the scope's entry", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  const result = api.writeScopeOwnSettings("channel_1", {}, {});

  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.deepEqual(result, { version: 4, general: {}, types: {} });
});

test("written values are normalized like the dialog's controls", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  api.writeScopeOwnSettings("channel_1", {
    "general.videoSyncBufferMs": 9000,
    "types.tracking.confidenceThreshold": 1.7,
    "types.tracking.history.trailLength": 500
  });

  const stored = readStored("viewerSettings_channel_1");
  assert.equal(stored.general.videoSyncBufferMs, 4000);
  assert.equal(stored.types.tracking.confidenceThreshold, 1);
  assert.equal(stored.types.tracking.history.trailLength, 120);
});

test("a switched-on value equal to the followed value is still an own value", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} }
  });

  api.writeScopeOwnSettings("channel_1", { "general.videoSyncBufferMs": 500 });

  assert.deepEqual(api.readScopeOwnValues("channel_1"), { "general.videoSyncBufferMs": 500 });
  assert.deepEqual(api.listChannelOverrides("general.videoSyncBufferMs"), [{ channel: 1, value: 500 }]);
});

test("resolving a channel agrees with its own values and the followed values for all eleven ids", () => {
  const { api } = loadSettingsApiWithStorage();

  api.writeScopeOwnSettings("global", {
    "general.videoSyncBufferMs": 900,
    "general.showRoi": false,
    "types.object-detection.confidenceThreshold": 0.6,
    "types.tracking.history.trailLength": 50
  });
  api.writeScopeOwnSettings("channel_1", {
    "general.metadataRetentionMs": 5000,
    "general.applyRoiFiltering": false,
    "types.segmentation.confidenceThreshold": 0.3,
    "types.segmentation.maskOpacity": 0.9,
    "types.tracking.confidenceThreshold": 0.2,
    "types.tracking.history.enabled": false,
    "types.tracking.history.lostTrackTtlMs": 4000
  });

  const own = api.readScopeOwnValues("channel_1");
  api.scalarSettings().forEach(({ id }) => {
    const expected = Object.prototype.hasOwnProperty.call(own, id) ? own[id] : api.followedValue(id);
    assert.equal(resolvedValueForId(api, 1, id), expected);
  });
});

test("clearing one own value keeps the others and the class colour entries", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 600, metadataRetentionMs: 2500 },
      types: {
        tracking: { history: { enabled: false, trailLength: 20, lostTrackTtlMs: 5000 } },
        segmentation: { objects: [{ label: "car", color: "#ff0000", style: "solid", width: 1 }] }
      }
    }
  });

  api.clearScopeOwnValue("channel_1", "general.videoSyncBufferMs");
  let stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.general, { metadataRetentionMs: 2500 });
  assert.deepEqual(stored.types.segmentation.objects, [
    { label: "car", color: "#ff0000", style: "solid", width: 1 }
  ]);

  // Clearing a nested id leaves its siblings under the same parent untouched.
  api.clearScopeOwnValue("channel_1", "types.tracking.history.enabled");
  stored = readStored("viewerSettings_channel_1");
  assert.deepEqual(stored.types.tracking.history, { trailLength: 20, lostTrackTtlMs: 5000 });
});

test("clearing a value the scope does not have writes nothing, own or unknown", () => {
  const { api, readStored } = loadSettingsApiWithStorage();

  const result = api.clearScopeOwnValue("channel_1", "types.tracking.history.trailLength");
  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.deepEqual(result, { general: {}, types: {} });

  // An unknown id is ignored the same way: nothing to remove, nothing written.
  const unknownResult = api.clearScopeOwnValue("channel_1", "no.such.id");
  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.deepEqual(unknownResult, { general: {}, types: {} });
});

test("clearing a channel's last own value removes its entry", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  const result = api.clearScopeOwnValue("channel_1", "general.videoSyncBufferMs");

  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.ok(result && typeof result === "object");
});

test("clearing a channel's last nested own value removes its entry", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: {},
      types: { tracking: { history: { trailLength: 30 } } }
    }
  });

  const result = api.clearScopeOwnValue("channel_1", "types.tracking.history.trailLength");

  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.ok(result && typeof result === "object");
});

test("clearing a value keeps the entry while class colour entries remain", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: {
      version: 4,
      general: { videoSyncBufferMs: 600 },
      types: {
        "object-detection": { objects: [{ label: "car", color: "#ff0000", style: "solid", width: 1 }] }
      }
    }
  });

  api.clearScopeOwnValue("channel_1", "general.videoSyncBufferMs");

  const stored = readStored("viewerSettings_channel_1");
  assert.notEqual(stored, null);
  assert.deepEqual(stored.types["object-detection"].objects, [
    { label: "car", color: "#ff0000", style: "solid", width: 1 }
  ]);
});

test("listing channel overrides works for a nested id, sorted by channel, ignoring the global scope and malformed entries", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: { version: 4, general: {}, types: { tracking: { history: { trailLength: 99 } } } },
    viewerSettings_channel_10: { version: 4, general: {}, types: { tracking: { history: { trailLength: 90 } } } },
    viewerSettings_channel_2: { version: 4, general: {}, types: { tracking: { history: { trailLength: 20 } } } },
    viewerSettings_channel_4: "not json",
    layoutCount: 3
  });

  assert.deepEqual(api.listChannelOverrides("types.tracking.history.trailLength"), [
    { channel: 2, value: 20 },
    { channel: 10, value: 90 }
  ]);
});

test("inherited objects are the global scope's own entries for the type", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_global: {
      version: 4,
      general: {},
      types: { "object-detection": { objects: [{ label: "car", color: "#ff0000", style: "solid", width: 1 }] } }
    }
  });

  assert.deepEqual(api.inheritedObjects("object-detection"), [
    { label: "car", color: "#ff0000", style: "solid", width: 1 }
  ]);
  assert.deepEqual(api.inheritedObjects("segmentation"), []);
});

test("counting and clearing channel scopes leaves regions, the global scope and foreign keys alone", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} },
    viewerSettings_channel_2: { version: 4, general: { videoSyncBufferMs: 700 }, types: {} },
    viewerSettings_channel_3: { version: 4, general: { videoSyncBufferMs: 800 }, types: {} },
    viewerSettings_global: { version: 4, general: { videoSyncBufferMs: 500 }, types: {} },
    // Regions are stored as viewerROI_<index> (see webrtc/static/js/roi.js), not
    // viewerROI_channel_<N>.
    viewerROI_1: { regions: [] },
    viewerROI_0: { regions: [] },
    foreignKey: 42
  });

  assert.equal(api.countChannelScopes(), 3);

  const removed = api.clearAllChannelScopes();

  assert.equal(removed, 3);
  assert.equal(api.countChannelScopes(), 0);
  assert.notEqual(readStored("viewerSettings_global"), null);
  assert.notEqual(readStored("viewerROI_1"), null);
  assert.notEqual(readStored("viewerROI_0"), null);
  assert.notEqual(readStored("foreignKey"), null);
});

test("empty channel entries are not counted", () => {
  const { api } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: {}, types: {} },
    viewerSettings_channel_2: {
      version: 4,
      general: {},
      types: { tracking: { history: {} }, segmentation: { objects: [] }, classification: {} }
    },
    viewerSettings_channel_3: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  assert.equal(api.countChannelScopes(), 1);
});

test("a reset still removes empty channel entries", () => {
  const { api, readStored } = loadSettingsApiWithStorage({
    viewerSettings_channel_1: { version: 4, general: {}, types: {} },
    viewerSettings_channel_2: {
      version: 4,
      general: {},
      types: { tracking: { history: {} }, segmentation: { objects: [] }, classification: {} }
    },
    viewerSettings_channel_3: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} }
  });

  const removed = api.clearAllChannelScopes();

  assert.equal(removed, 3);
  assert.equal(readStored("viewerSettings_channel_1"), null);
  assert.equal(readStored("viewerSettings_channel_2"), null);
  assert.equal(readStored("viewerSettings_channel_3"), null);
});

test("storage failures make writeScopeOwnSettings, clearScopeOwnValue and clearAllChannelScopes return null", () => {
  const failingWrite = loadSettingsApiWithStorage({}, { failWrites: true });
  assert.equal(
    failingWrite.api.writeScopeOwnSettings("channel_1", { "general.videoSyncBufferMs": 600 }),
    null
  );

  const failingRemoveWhenEmpty = loadSettingsApiWithStorage(
    { viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} } },
    { failWrites: true }
  );
  assert.equal(failingRemoveWhenEmpty.api.writeScopeOwnSettings("channel_1", {}, {}), null);

  const failingClear = loadSettingsApiWithStorage(
    { viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} } },
    { failWrites: true }
  );
  assert.equal(failingClear.api.clearScopeOwnValue("channel_1", "general.videoSyncBufferMs"), null);

  const failingRemoveAll = loadSettingsApiWithStorage(
    {
      viewerSettings_channel_1: { version: 4, general: { videoSyncBufferMs: 600 }, types: {} },
      viewerSettings_channel_2: { version: 4, general: { videoSyncBufferMs: 700 }, types: {} }
    },
    { failWritesFor: ["viewerSettings_channel_1"] }
  );
  assert.equal(failingRemoveAll.api.clearAllChannelScopes(), null);
});

test("a reset that fails halfway puts back what it had removed", () => {
  const channel1 = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
  const channel2 = { version: 4, general: { videoSyncBufferMs: 700 }, types: {} };
  const channel3 = { version: 4, general: { videoSyncBufferMs: 800 }, types: {} };
  const { api, readStored, readRaw } = loadSettingsApiWithStorage(
    {
      viewerSettings_channel_1: channel1,
      viewerSettings_channel_2: channel2,
      viewerSettings_channel_3: channel3
    },
    { failWritesFor: ["viewerSettings_channel_2"] }
  );
  const rawBefore = {
    1: readRaw("viewerSettings_channel_1"),
    2: readRaw("viewerSettings_channel_2"),
    3: readRaw("viewerSettings_channel_3")
  };

  assert.equal(api.clearAllChannelScopes(), null);

  assert.deepEqual(readStored("viewerSettings_channel_1"), channel1);
  assert.deepEqual(readStored("viewerSettings_channel_2"), channel2);
  assert.deepEqual(readStored("viewerSettings_channel_3"), channel3);
  assert.equal(readRaw("viewerSettings_channel_1"), rawBefore[1]);
  assert.equal(readRaw("viewerSettings_channel_2"), rawBefore[2]);
  assert.equal(readRaw("viewerSettings_channel_3"), rawBefore[3]);
});

test("a reset that fails on the last entry puts back all earlier ones", () => {
  const channel1 = { version: 4, general: { videoSyncBufferMs: 600 }, types: {} };
  const channel2 = { version: 4, general: { videoSyncBufferMs: 700 }, types: {} };
  const channel3 = { version: 4, general: { videoSyncBufferMs: 800 }, types: {} };
  const { api, readStored, readRaw } = loadSettingsApiWithStorage(
    {
      viewerSettings_channel_1: channel1,
      viewerSettings_channel_2: channel2,
      viewerSettings_channel_3: channel3
    },
    { failWritesFor: ["viewerSettings_channel_3"] }
  );
  const rawBefore = {
    1: readRaw("viewerSettings_channel_1"),
    2: readRaw("viewerSettings_channel_2"),
    3: readRaw("viewerSettings_channel_3")
  };

  assert.equal(api.clearAllChannelScopes(), null);

  assert.deepEqual(readStored("viewerSettings_channel_1"), channel1);
  assert.deepEqual(readStored("viewerSettings_channel_2"), channel2);
  assert.deepEqual(readStored("viewerSettings_channel_3"), channel3);
  assert.equal(readRaw("viewerSettings_channel_1"), rawBefore[1]);
  assert.equal(readRaw("viewerSettings_channel_2"), rawBefore[2]);
  assert.equal(readRaw("viewerSettings_channel_3"), rawBefore[3]);
});
