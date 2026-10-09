(() => {
  const SETTINGS_VERSION = 4;
  const SUPPORTED_VERSIONS = [2, 3, 4];
  // Unlisted classes are colored automatically (see metadata-colors.js), so the
  // defaults hold no entries. A user-added `default` entry overrides all unlisted classes.
  const DEFAULT_OBJECTS = [];
  const LEGACY_DEFAULT_COLOR = "#00ff00";
  const METADATA_TYPES = [
    { value: "object-detection", label: "Object Detection" },
    { value: "tracking", label: "Tracking" },
    { value: "pose-estimation", label: "Pose Estimation" },
    { value: "segmentation", label: "Segmentation" },
    { value: "classification", label: "Classification" }
  ];
  const TYPE_DEFAULTS = {
    "object-detection": {
      confidenceThreshold: 0,
      objects: DEFAULT_OBJECTS
    },
    tracking: {
      confidenceThreshold: 0,
      history: {
        enabled: true,
        trailLength: 10,
        lostTrackTtlMs: 2000
      }
    },
    "pose-estimation": {},
    segmentation: {
      confidenceThreshold: 0,
      maskOpacity: 0.4,
      objects: DEFAULT_OBJECTS
    },
    classification: {}
  };
  const GENERAL_DEFAULTS = {
    videoSyncBufferMs: 350,
    metadataRetentionMs: 0,
    showRoi: true,
    applyRoiFiltering: true
  };

  // The one table that drives every own-value function: an id is the setting's
  // path in the stored scope, split for the generic path helpers below.
  const SCALAR_SETTINGS = [
    { id: "general.videoSyncBufferMs", tab: "General", metadataType: null, path: ["general", "videoSyncBufferMs"] },
    { id: "general.metadataRetentionMs", tab: "General", metadataType: null, path: ["general", "metadataRetentionMs"] },
    { id: "general.showRoi", tab: "ROI", metadataType: null, path: ["general", "showRoi"] },
    { id: "general.applyRoiFiltering", tab: "ROI", metadataType: null, path: ["general", "applyRoiFiltering"] },
    {
      id: "types.object-detection.confidenceThreshold",
      tab: "Metadata",
      metadataType: "object-detection",
      path: ["types", "object-detection", "confidenceThreshold"]
    },
    {
      id: "types.segmentation.confidenceThreshold",
      tab: "Metadata",
      metadataType: "segmentation",
      path: ["types", "segmentation", "confidenceThreshold"]
    },
    {
      id: "types.segmentation.maskOpacity",
      tab: "Metadata",
      metadataType: "segmentation",
      path: ["types", "segmentation", "maskOpacity"]
    },
    {
      id: "types.tracking.confidenceThreshold",
      tab: "Metadata",
      metadataType: "tracking",
      path: ["types", "tracking", "confidenceThreshold"]
    },
    {
      id: "types.tracking.history.enabled",
      tab: "Metadata",
      metadataType: "tracking",
      path: ["types", "tracking", "history", "enabled"]
    },
    {
      id: "types.tracking.history.trailLength",
      tab: "Metadata",
      metadataType: "tracking",
      path: ["types", "tracking", "history", "trailLength"]
    },
    {
      id: "types.tracking.history.lostTrackTtlMs",
      tab: "Metadata",
      metadataType: "tracking",
      path: ["types", "tracking", "history", "lostTrackTtlMs"]
    }
  ];

  // What a scalar setting is worth with nothing stored anywhere: the same shape
  // ({ general, types }) as the overrides a scope reads, so the generic path
  // helpers work on either one.
  const DEFAULTS_ROOT = { general: GENERAL_DEFAULTS, types: TYPE_DEFAULTS };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function metadataTypeOrDefault(metadataType) {
    return METADATA_TYPES.some((type) => type.value === metadataType) ? metadataType : "object-detection";
  }

  function parseNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clampNumber(value, min, max, fallback) {
    return Math.max(min, Math.min(max, parseNumber(value, fallback)));
  }

  function normalizeObjectEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) return null;
    return {
      label,
      color: typeof entry.color === "string" ? entry.color : "#00ff00",
      style: ["solid", "dashed", "dotted"].includes(entry.style) ? entry.style : "solid",
      width: [1, 3].includes(Number(entry.width)) ? Number(entry.width) : 1
    };
  }

  // Before version 4 every list carried an injected `default` entry in the stock
  // green. Dropping it lets the automatic colors take over; a recolored default is
  // a deliberate user override and stays.
  function dropStockDefault(entries) {
    return entries.filter(
      (entry) => !(entry.label === "default" && entry.color.toLowerCase() === LEGACY_DEFAULT_COLOR)
    );
  }

  function normalizeObjects(objects, { legacy = false } = {}) {
    if (!Array.isArray(objects)) return [];
    const normalized = objects.map(normalizeObjectEntry).filter(Boolean);
    return legacy ? dropStockDefault(normalized) : normalized;
  }

  function mergeObjectStyles(...objectLists) {
    const byLabel = new Map();
    objectLists.flat().forEach((entry) => {
      const normalized = normalizeObjectEntry(entry);
      if (normalized) byLabel.set(normalized.label, normalized);
    });
    return Array.from(byLabel.values());
  }

  function normalizeGeneral(rawGeneral = {}, fillDefaults = true) {
    const general = fillDefaults ? clone(GENERAL_DEFAULTS) : {};
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "videoSyncBufferMs")) {
      general.videoSyncBufferMs = Math.round(
        clampNumber(rawGeneral.videoSyncBufferMs, 0, 4000, GENERAL_DEFAULTS.videoSyncBufferMs)
      );
    }
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "metadataRetentionMs")) {
      general.metadataRetentionMs = Math.round(
        clampNumber(rawGeneral.metadataRetentionMs, 0, 30000, GENERAL_DEFAULTS.metadataRetentionMs)
      );
    }
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "showRoi")) {
      general.showRoi = rawGeneral.showRoi !== false;
    }
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "applyRoiFiltering")) {
      general.applyRoiFiltering = rawGeneral.applyRoiFiltering !== false;
    }
    return general;
  }

  function normalizeTrackingHistory(rawHistory = {}, fillDefaults = true) {
    const defaults = TYPE_DEFAULTS.tracking.history;
    const history = fillDefaults ? clone(defaults) : {};
    if (!rawHistory || typeof rawHistory !== "object") return history;

    if (Object.prototype.hasOwnProperty.call(rawHistory, "enabled")) {
      history.enabled = rawHistory.enabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(rawHistory, "trailLength")) {
      history.trailLength = Math.round(clampNumber(rawHistory.trailLength, 1, 120, defaults.trailLength));
    }
    if (Object.prototype.hasOwnProperty.call(rawHistory, "lostTrackTtlMs")) {
      history.lostTrackTtlMs = Math.round(clampNumber(rawHistory.lostTrackTtlMs, 0, 30000, defaults.lostTrackTtlMs));
    }
    return history;
  }

  function normalizeTypeSettings(metadataType, rawType = {}, fillDefaults = true, { legacy = false } = {}) {
    const type = fillDefaults ? clone(TYPE_DEFAULTS[metadataType] || {}) : {};
    if (metadataType === "object-detection" || metadataType === "segmentation") {
      if (Object.prototype.hasOwnProperty.call(rawType, "confidenceThreshold")) {
        type.confidenceThreshold = clampNumber(rawType.confidenceThreshold, 0, 1, 0);
      }
      if (Object.prototype.hasOwnProperty.call(rawType, "objects")) {
        type.objects = normalizeObjects(rawType.objects, { legacy });
      }
      if (metadataType === "segmentation" && Object.prototype.hasOwnProperty.call(rawType, "maskOpacity")) {
        type.maskOpacity = clampNumber(rawType.maskOpacity, 0, 1, TYPE_DEFAULTS.segmentation.maskOpacity);
      }
    } else if (metadataType === "tracking") {
      if (Object.prototype.hasOwnProperty.call(rawType, "confidenceThreshold")) {
        type.confidenceThreshold = clampNumber(rawType.confidenceThreshold, 0, 1, 0);
      }
      const history = normalizeTrackingHistory(rawType.history, fillDefaults);
      if (Object.prototype.hasOwnProperty.call(rawType, "showTrackHistory")) {
        history.enabled = rawType.showTrackHistory !== false;
      }
      if (Object.prototype.hasOwnProperty.call(rawType, "trailLength")) {
        history.trailLength = Math.round(clampNumber(rawType.trailLength, 1, 120, TYPE_DEFAULTS.tracking.history.trailLength));
      }
      if (Object.prototype.hasOwnProperty.call(rawType, "lostTrackTtlMs")) {
        history.lostTrackTtlMs = Math.round(clampNumber(rawType.lostTrackTtlMs, 0, 30000, TYPE_DEFAULTS.tracking.history.lostTrackTtlMs));
      }
      if (fillDefaults || Object.keys(history).length > 0) {
        type.history = history;
      }
    } else if (rawType && typeof rawType === "object") {
      Object.assign(type, rawType);
    }
    return type;
  }

  function findScalarSetting(id) {
    return SCALAR_SETTINGS.find((setting) => setting.id === id) || null;
  }

  // Reads a scalar setting's value out of a { general, types } shaped object
  // (overrides or DEFAULTS_ROOT) by its id's path; undefined when absent.
  function scalarValueAt(root, path) {
    let node = root;
    for (const key of path) {
      if (node == null || typeof node !== "object") return undefined;
      node = node[key];
    }
    return node;
  }

  // Writes a scalar setting's value into a { general, types } shaped object,
  // creating the intermediate objects (e.g. types.tracking.history) as needed.
  function setScalarValueAt(root, path, value) {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      if (!node[key] || typeof node[key] !== "object") node[key] = {};
      node = node[key];
    }
    node[path[path.length - 1]] = value;
  }

  // The inverse of setScalarValueAt: removes one leaf, leaving its siblings (and
  // any other setting under a different path) untouched.
  function deleteScalarValueAt(root, path) {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      node = node && node[path[i]];
      if (node == null || typeof node !== "object") return;
    }
    if (node && typeof node === "object") delete node[path[path.length - 1]];
  }

  // Normalizes one raw value the way the dialog's own control would, reusing the
  // file's existing normalizers so clamping and rounding match exactly. The
  // setting's path shape says which normalizer applies: general.<key>,
  // types.<type>.<key>, or the nested types.tracking.history.<key>.
  function normalizeScalarValue(setting, rawValue) {
    const path = setting.path;
    if (path[0] === "general") {
      return normalizeGeneral({ [path[1]]: rawValue }, false)[path[1]];
    }
    const metadataType = path[1];
    if (path.length === 3) {
      return normalizeTypeSettings(metadataType, { [path[2]]: rawValue }, false)[path[2]];
    }
    const key = path[3];
    return normalizeTypeSettings(metadataType, { history: { [key]: rawValue } }, false).history[key];
  }

  function readRawSettings(scope) {
    try {
      const raw = window.localStorage.getItem(`viewerSettings_${scope}`);
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  function normalizeSettings(rawSettings) {
    const settings = {
      version: SETTINGS_VERSION,
      general: clone(GENERAL_DEFAULTS),
      types: {}
    };
    METADATA_TYPES.forEach((type) => {
      settings.types[type.value] = clone(TYPE_DEFAULTS[type.value] || {});
    });

    if (!rawSettings || typeof rawSettings !== "object") return settings;

    if (SUPPORTED_VERSIONS.includes(rawSettings.version)) {
      const legacy = rawSettings.version < SETTINGS_VERSION;
      settings.general = normalizeGeneral(rawSettings.general);
      METADATA_TYPES.forEach((type) => {
        settings.types[type.value] = normalizeTypeSettings(type.value, rawSettings.types?.[type.value], true, { legacy });
      });
      return settings;
    }

    settings.general = normalizeGeneral({
      showRoi: rawSettings.showRoi,
      applyRoiFiltering: rawSettings.applyRoiFiltering
    });
    settings.types["object-detection"] = normalizeTypeSettings("object-detection", {
      confidenceThreshold: rawSettings.confidenceThreshold,
      objects: rawSettings.objects
    }, true, { legacy: true });
    settings.types.tracking = normalizeTypeSettings("tracking", {
      confidenceThreshold: rawSettings.trackingConfidenceThreshold,
      showTrackHistory: rawSettings.showTrackHistory,
      trailLength: rawSettings.trailLength,
      lostTrackTtlMs: rawSettings.lostTrackTtlMs
    });
    ["classification", "pose-estimation"].forEach((metadataType) => {
      settings.types[metadataType] = normalizeTypeSettings(metadataType, rawSettings);
    });
    return settings;
  }

  function settingsOverrides(rawSettings) {
    const overrides = { general: {}, types: {} };
    if (!rawSettings || typeof rawSettings !== "object") return overrides;

    if (SUPPORTED_VERSIONS.includes(rawSettings.version)) {
      const legacy = rawSettings.version < SETTINGS_VERSION;
      overrides.general = normalizeGeneral(rawSettings.general, false);
      METADATA_TYPES.forEach((type) => {
        const rawType = rawSettings.types?.[type.value];
        if (rawType && typeof rawType === "object") {
          overrides.types[type.value] = normalizeTypeSettings(type.value, rawType, false, { legacy });
        }
      });
      return overrides;
    }

    const legacyGeneral = {};
    if (Object.prototype.hasOwnProperty.call(rawSettings, "showRoi")) {
      legacyGeneral.showRoi = rawSettings.showRoi;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "applyRoiFiltering")) {
      legacyGeneral.applyRoiFiltering = rawSettings.applyRoiFiltering;
    }
    overrides.general = normalizeGeneral(legacyGeneral, false);

    const legacyObjectDetection = {};
    if (Object.prototype.hasOwnProperty.call(rawSettings, "confidenceThreshold")) {
      legacyObjectDetection.confidenceThreshold = rawSettings.confidenceThreshold;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "objects")) {
      legacyObjectDetection.objects = rawSettings.objects;
    }
    overrides.types["object-detection"] = normalizeTypeSettings(
      "object-detection",
      legacyObjectDetection,
      false,
      { legacy: true }
    );

    const legacyTracking = {};
    if (Object.prototype.hasOwnProperty.call(rawSettings, "trackingConfidenceThreshold")) {
      legacyTracking.confidenceThreshold = rawSettings.trackingConfidenceThreshold;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "showTrackHistory")) {
      legacyTracking.showTrackHistory = rawSettings.showTrackHistory;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "trailLength")) {
      legacyTracking.trailLength = rawSettings.trailLength;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "lostTrackTtlMs")) {
      legacyTracking.lostTrackTtlMs = rawSettings.lostTrackTtlMs;
    }
    overrides.types.tracking = normalizeTypeSettings("tracking", legacyTracking, false);
    return overrides;
  }

  function resolveTypeSettings(channelIndex, metadataType) {
    const type = metadataTypeOrDefault(metadataType);
    const globalOverrides = settingsOverrides(readRawSettings("global"));
    const channelOverrides = settingsOverrides(readRawSettings(`channel_${channelIndex}`));
    const globalType = globalOverrides.types[type] || {};
    const channelType = channelOverrides.types[type] || {};

    const general = {
      ...GENERAL_DEFAULTS,
      ...globalOverrides.general,
      ...channelOverrides.general
    };

    let typeSettings;
    if (type === "object-detection" || type === "segmentation") {
      typeSettings = {
        confidenceThreshold:
          channelType.confidenceThreshold ?? globalType.confidenceThreshold ?? TYPE_DEFAULTS[type].confidenceThreshold,
        objects: mergeObjectStyles(TYPE_DEFAULTS[type].objects, globalType.objects || [], channelType.objects || [])
      };
      if (type === "segmentation") {
        typeSettings.maskOpacity =
          channelType.maskOpacity ?? globalType.maskOpacity ?? TYPE_DEFAULTS[type].maskOpacity;
      }
    } else if (type === "tracking") {
      const defaultHistory = TYPE_DEFAULTS[type].history;
      const globalHistory = globalType.history || {};
      const channelHistory = channelType.history || {};
      typeSettings = {
        confidenceThreshold:
          channelType.confidenceThreshold ?? globalType.confidenceThreshold ?? TYPE_DEFAULTS[type].confidenceThreshold,
        history: {
          enabled: channelHistory.enabled ?? globalHistory.enabled ?? defaultHistory.enabled,
          trailLength: channelHistory.trailLength ?? globalHistory.trailLength ?? defaultHistory.trailLength,
          lostTrackTtlMs: channelHistory.lostTrackTtlMs ?? globalHistory.lostTrackTtlMs ?? defaultHistory.lostTrackTtlMs
        }
      };
    } else {
      typeSettings = {
        ...(TYPE_DEFAULTS[type] || {}),
        ...globalType,
        ...channelType
      };
    }

    return {
      metadataType: type,
      general,
      type: typeSettings
    };
  }

  function readScopeSettings(scope) {
    return normalizeSettings(readRawSettings(scope));
  }

  function writeScopeSettings(scope, settings, options = {}) {
    const normalized = normalizeSettings(settings);
    if (!options.generalKeys) {
      window.localStorage.setItem(`viewerSettings_${scope}`, JSON.stringify(normalized));
      return normalized;
    }
    // A settings dialog only owns some of the general keys (see spec addendum B); the
    // rest keeps following the global scope and the defaults, so only the listed keys
    // are carried over from the freshly normalized values.
    const general = {};
    options.generalKeys.forEach((key) => {
      general[key] = normalized.general[key];
    });
    const stored = {
      version: SETTINGS_VERSION,
      general,
      types: normalized.types
    };
    window.localStorage.setItem(`viewerSettings_${scope}`, JSON.stringify(stored));
    return stored;
  }

  // Shared by every function that stores a scope's own values in the
  // { version, general, types } shape, so a storage failure is handled once.
  function storeScopeOverrides(scope, general, types) {
    const stored = {
      version: SETTINGS_VERSION,
      general,
      types
    };
    try {
      window.localStorage.setItem(`viewerSettings_${scope}`, JSON.stringify(stored));
    } catch (_err) {
      return null;
    }
    return stored;
  }

  // writeScopeSettings stores every default, which turns a whole scope into
  // overrides. This stores only what the scope already overrode plus one key, so
  // the rest keeps following the global scope and the defaults.
  function writeScopeGeneralOverride(scope, key, value) {
    const overrides = settingsOverrides(readRawSettings(scope));
    const general = { ...overrides.general, ...normalizeGeneral({ [key]: value }, false) };
    return storeScopeOverrides(scope, general, overrides.types);
  }

  // The scope's own values, with no defaults filled in: what the tile button and
  // the dialogs need to show what a channel or the global scope actually set.
  function readScopeOverrides(scope) {
    return settingsOverrides(readRawSettings(scope));
  }

  // The inverse of writeScopeGeneralOverride: drops one key so the scope goes back
  // to following the global scope (or the default) for it, keeping everything else.
  // A scope without its own value for `key` is left unwritten, so clearing never
  // creates an empty scope entry; the unchanged overrides still signal success.
  // When the key was the scope's last own value, the scope's storage entry is
  // removed instead of storing an empty one.
  function clearScopeGeneralOverride(scope, key) {
    const overrides = settingsOverrides(readRawSettings(scope));
    if (!Object.prototype.hasOwnProperty.call(overrides.general, key)) return overrides;
    const general = { ...overrides.general };
    delete general[key];
    return storeOrRemoveScopeOverrides(scope, general, overrides.types);
  }

  // What a channel gets for a general key when it has no value of its own: the
  // global scope's own value, otherwise the default. An unknown key yields null.
  function followedGeneralValue(key) {
    const globalOwn = readScopeOverrides("global").general;
    if (Object.prototype.hasOwnProperty.call(globalOwn, key)) return globalOwn[key];
    return Object.prototype.hasOwnProperty.call(GENERAL_DEFAULTS, key) ? GENERAL_DEFAULTS[key] : null;
  }

  // A channel dialog's save stores a general key as the channel's own if the channel
  // had its own value at load, or if the control now holds something else than the
  // dialog loaded into it. Values compare strictly (numbers for spinners, booleans
  // for toggles). Each key appears once, in order of first appearance.
  function generalKeysToStore(ownKeys, loadedValues, currentValues) {
    const keys = [];
    const add = (key) => {
      if (!keys.includes(key)) keys.push(key);
    };
    Array.from(ownKeys || []).forEach(add);
    const loaded = loadedValues || {};
    Object.keys(currentValues || {}).forEach((key) => {
      if (currentValues[key] !== loaded[key]) add(key);
    });
    return keys;
  }

  // The panel's global action: the channel gives up its own value and follows the
  // global one, which is raised to `value` if it is below it, never lowered. Either
  // everything is stored or the global scope is put back as it was (null result).
  function applyGlobalGeneral(channelScope, key, value) {
    const normalized = normalizeGeneral({ [key]: value }, false)[key];
    if (normalized === undefined) return null;
    const globalStorageKey = "viewerSettings_global";
    let previousGlobal;
    try {
      previousGlobal = window.localStorage.getItem(globalStorageKey);
    } catch (_err) {
      return null;
    }
    const followed = followedGeneralValue(key);
    const raise = followed < normalized;
    if (raise && !writeScopeGeneralOverride("global", key, normalized)) return null;
    if (!clearScopeGeneralOverride(channelScope, key)) {
      if (raise) {
        try {
          if (previousGlobal == null) {
            window.localStorage.removeItem(globalStorageKey);
          } else {
            window.localStorage.setItem(globalStorageKey, previousGlobal);
          }
        } catch (_err) {
          // Nothing more can be done; the caller still learns that the action failed.
        }
      }
      return null;
    }
    return { applied: raise ? normalized : followed, raised: raise };
  }

  // Every channel scope in storage that has its own value for `key`, for the global
  // dialog's "Channel N uses its own value" lines. Storage access itself can throw
  // (e.g. a disabled localStorage), so the whole scan is guarded.
  function listChannelGeneralOverrides(key) {
    const found = [];
    try {
      const total = window.localStorage.length;
      for (let i = 0; i < total; i++) {
        const storageKey = window.localStorage.key(i);
        const match = typeof storageKey === "string" && storageKey.match(/^viewerSettings_channel_(\d+)$/);
        if (!match) continue;
        const channel = Number(match[1]);
        const overrides = readScopeOverrides(`channel_${channel}`);
        if (Object.prototype.hasOwnProperty.call(overrides.general, key)) {
          found.push({ channel, value: overrides.general[key] });
        }
      }
    } catch (_err) {
      return [];
    }
    return found.sort((a, b) => a.channel - b.channel);
  }

  // The eleven scalar settings the dialog's switches cover, for building their
  // controls without a second, hand-kept list.
  function scalarSettings() {
    return SCALAR_SETTINGS.map(({ id, tab, metadataType }) => ({ id, tab, metadataType }));
  }

  // What a channel gets for a scalar setting when it has no value of its own: the
  // global scope's own value, otherwise the default. An unknown id yields null.
  function followedValue(id) {
    const setting = findScalarSetting(id);
    if (!setting) return null;
    const globalOwn = scalarValueAt(readScopeOverrides("global"), setting.path);
    if (globalOwn !== undefined) return globalOwn;
    const fallback = scalarValueAt(DEFAULTS_ROOT, setting.path);
    return fallback !== undefined ? fallback : null;
  }

  // The scope's own scalar values, nested ones included, keyed by id. Presence,
  // not equality with the followed value, is what makes a value "own" (see
  // applyGlobalGeneral's channel scopes, which can equal the global one).
  function readScopeOwnValues(scope) {
    const overrides = readScopeOverrides(scope);
    const values = {};
    SCALAR_SETTINGS.forEach((setting) => {
      const value = scalarValueAt(overrides, setting.path);
      if (value !== undefined) values[setting.id] = value;
    });
    return values;
  }

  // What it takes for a scope's own values to be worth keeping stored: at least
  // one scalar value (what readScopeOwnValues reports) or at least one class
  // colour entry in any metadata type. An empty object, a `history: {}` or an
  // `objects: []` left behind by clearing the last value hold nothing, so a scope
  // reduced to those is removed rather than stored, defined once here for every
  // caller (clearScopeGeneralOverride, clearScopeOwnValue, countChannelScopes).
  function overridesHoldSomething(overrides) {
    const hasScalarValue = SCALAR_SETTINGS.some(
      (setting) => scalarValueAt(overrides, setting.path) !== undefined
    );
    if (hasScalarValue) return true;
    return Object.values(overrides.types || {}).some(
      (type) => Array.isArray(type?.objects) && type.objects.length > 0
    );
  }

  // Stores the overrides if they still hold something, otherwise removes the
  // scope's storage entry so an empty scope is never left behind. Either way
  // returns an object (the overrides as they are after the change) on success,
  // or null when storage failed, matching storeScopeOverrides' contract.
  function storeOrRemoveScopeOverrides(scope, general, types) {
    if (overridesHoldSomething({ general, types })) {
      return storeScopeOverrides(scope, general, types);
    }
    try {
      window.localStorage.removeItem(`viewerSettings_${scope}`);
    } catch (_err) {
      return null;
    }
    return { general: {}, types: {} };
  }

  // Every channel scope in storage that has its own value for `id`, generalizing
  // listChannelGeneralOverrides to any scalar id, nested ones included.
  function listChannelOverrides(id) {
    const setting = findScalarSetting(id);
    if (!setting) return [];
    const found = [];
    try {
      const total = window.localStorage.length;
      for (let i = 0; i < total; i++) {
        const storageKey = window.localStorage.key(i);
        const match = typeof storageKey === "string" && storageKey.match(/^viewerSettings_channel_(\d+)$/);
        if (!match) continue;
        const channel = Number(match[1]);
        const value = scalarValueAt(readScopeOverrides(`channel_${channel}`), setting.path);
        if (value !== undefined) found.push({ channel, value });
      }
    } catch (_err) {
      return [];
    }
    return found.sort((a, b) => a.channel - b.channel);
  }

  // The global scope's own class colour entries for a metadata type, for the
  // channel dialog's inherited, greyed-out list.
  function inheritedObjects(metadataType) {
    const type = metadataTypeOrDefault(metadataType);
    const globalType = readScopeOverrides("global").types[type];
    return globalType && Array.isArray(globalType.objects) ? globalType.objects : [];
  }

  // Stores exactly the given scalar values and class colour entries as the
  // scope's own, replacing whatever it had before. What is not given is not
  // stored; a scope left with nothing at all is removed instead of holding an
  // empty stub.
  function writeScopeOwnSettings(scope, ownValues, ownObjects) {
    const general = {};
    const types = {};
    Object.entries(ownValues || {}).forEach(([id, value]) => {
      const setting = findScalarSetting(id);
      if (!setting) return;
      const normalized = normalizeScalarValue(setting, value);
      setScalarValueAt(setting.path[0] === "general" ? general : types, setting.path.slice(1), normalized);
    });
    Object.entries(ownObjects || {}).forEach(([metadataType, entries]) => {
      if (!METADATA_TYPES.some((type) => type.value === metadataType)) return;
      const normalized = normalizeObjects(entries);
      if (normalized.length === 0) return;
      if (!types[metadataType]) types[metadataType] = {};
      types[metadataType].objects = normalized;
    });

    if (Object.keys(general).length === 0 && Object.keys(types).length === 0) {
      try {
        window.localStorage.removeItem(`viewerSettings_${scope}`);
      } catch (_err) {
        return null;
      }
      return { version: SETTINGS_VERSION, general: {}, types: {} };
    }
    return storeScopeOverrides(scope, general, types);
  }

  // The inverse of one writeScopeOwnSettings value: drops one id so the scope
  // goes back to following the global scope (or the default) for it, keeping its
  // other own values and class colour entries. A scope without an own value for
  // `id`, or an unknown id, is left unwritten; the unchanged overrides still
  // signal success, as clearScopeGeneralOverride's do. When the id was the
  // scope's last own value, the scope's storage entry is removed instead of
  // storing an empty one.
  function clearScopeOwnValue(scope, id) {
    const setting = findScalarSetting(id);
    const overrides = readScopeOverrides(scope);
    if (!setting) return overrides;
    if (scalarValueAt(overrides, setting.path) === undefined) return overrides;
    deleteScalarValueAt(overrides, setting.path);
    return storeOrRemoveScopeOverrides(scope, overrides.general, overrides.types);
  }

  // The number of stored channel scopes that hold something of their own, for
  // the global dialog's reset link (which the dialog hides when this is zero).
  // A channel scope left holding nothing (see overridesHoldSomething), e.g. one
  // stored by an earlier build of this branch, does not count.
  function countChannelScopes() {
    try {
      let count = 0;
      const total = window.localStorage.length;
      for (let i = 0; i < total; i++) {
        const key = window.localStorage.key(i);
        const match = typeof key === "string" && key.match(/^viewerSettings_channel_(\d+)$/);
        if (!match) continue;
        if (overridesHoldSomething(readScopeOverrides(`channel_${match[1]}`))) count++;
      }
      return count;
    } catch (_err) {
      return 0;
    }
  }

  // The reset action: removes every channel's own values, leaving the global
  // scope and the drawn regions (viewerROI_*) alone. This is destructive and
  // user-triggered on purpose, so it is all-or-nothing, the way applyGlobalGeneral
  // already is for the global scope: the raw string of every entry is read before
  // any is removed (so nothing has changed yet if that fails), and a removal that
  // throws partway through is rolled back by restoring every entry already
  // removed, byte for byte.
  function clearAllChannelScopes() {
    let entries;
    try {
      entries = new Map();
      const total = window.localStorage.length;
      for (let i = 0; i < total; i++) {
        const key = window.localStorage.key(i);
        if (typeof key === "string" && /^viewerSettings_channel_\d+$/.test(key)) {
          entries.set(key, window.localStorage.getItem(key));
        }
      }
    } catch (_err) {
      return null;
    }
    const removedKeys = [];
    try {
      entries.forEach((_raw, key) => {
        window.localStorage.removeItem(key);
        removedKeys.push(key);
      });
    } catch (_err) {
      removedKeys.forEach((key) => {
        try {
          window.localStorage.setItem(key, entries.get(key));
        } catch (_restoreErr) {
          // Nothing more can be done; the caller still learns that the action failed.
        }
      });
      return null;
    }
    return entries.size;
  }

  window.viewerSettingsApi = {
    version: SETTINGS_VERSION,
    metadataTypes: METADATA_TYPES,
    defaults: {
      general: GENERAL_DEFAULTS,
      types: TYPE_DEFAULTS
    },
    readScopeSettings,
    writeScopeSettings,
    writeScopeGeneralOverride,
    readScopeOverrides,
    clearScopeGeneralOverride,
    listChannelGeneralOverrides,
    followedGeneralValue,
    generalKeysToStore,
    applyGlobalGeneral,
    scalarSettings,
    followedValue,
    readScopeOwnValues,
    listChannelOverrides,
    inheritedObjects,
    writeScopeOwnSettings,
    clearScopeOwnValue,
    countChannelScopes,
    clearAllChannelScopes,
    normalizeSettings,
    resolveTypeSettings
  };
  window.resolveTypeSettings = resolveTypeSettings;
})();
