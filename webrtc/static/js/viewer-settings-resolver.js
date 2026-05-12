(() => {
  const SETTINGS_VERSION = 2;
  const DEFAULT_OBJECTS = [{ label: "default", color: "#00ff00", style: "solid", width: 1 }];
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
      showTrackHistory: true
    },
    "pose-estimation": {},
    segmentation: {},
    classification: {}
  };
  const GENERAL_DEFAULTS = {
    metadataDelay: 0,
    showRoi: true
  };

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

  function normalizeObjects(objects, fallback = DEFAULT_OBJECTS) {
    if (!Array.isArray(objects)) return clone(fallback);
    const normalized = objects.map(normalizeObjectEntry).filter(Boolean);
    return normalized.length ? normalized : clone(fallback);
  }

  function mergeObjectStyles(...objectLists) {
    const byLabel = new Map();
    objectLists.flat().forEach((entry) => {
      const normalized = normalizeObjectEntry(entry);
      if (normalized) byLabel.set(normalized.label, normalized);
    });
    if (!byLabel.has("default")) {
      byLabel.set("default", clone(DEFAULT_OBJECTS[0]));
    }
    return Array.from(byLabel.values());
  }

  function normalizeGeneral(rawGeneral = {}, fillDefaults = true) {
    const general = fillDefaults ? clone(GENERAL_DEFAULTS) : {};
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "metadataDelay")) {
      general.metadataDelay = Math.max(0, parseNumber(rawGeneral.metadataDelay, GENERAL_DEFAULTS.metadataDelay));
    }
    if (Object.prototype.hasOwnProperty.call(rawGeneral, "showRoi")) {
      general.showRoi = rawGeneral.showRoi !== false;
    }
    return general;
  }

  function normalizeTypeSettings(metadataType, rawType = {}, fillDefaults = true) {
    const type = fillDefaults ? clone(TYPE_DEFAULTS[metadataType] || {}) : {};
    if (metadataType === "object-detection") {
      if (Object.prototype.hasOwnProperty.call(rawType, "confidenceThreshold")) {
        type.confidenceThreshold = Math.max(0, Math.min(1, parseNumber(rawType.confidenceThreshold, 0)));
      }
      if (Object.prototype.hasOwnProperty.call(rawType, "objects")) {
        type.objects = normalizeObjects(rawType.objects);
      }
    } else if (metadataType === "tracking") {
      if (Object.prototype.hasOwnProperty.call(rawType, "showTrackHistory")) {
        type.showTrackHistory = rawType.showTrackHistory !== false;
      }
    } else if (rawType && typeof rawType === "object") {
      Object.assign(type, rawType);
    }
    return type;
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

    if (rawSettings.version === SETTINGS_VERSION) {
      settings.general = normalizeGeneral(rawSettings.general);
      METADATA_TYPES.forEach((type) => {
        settings.types[type.value] = normalizeTypeSettings(type.value, rawSettings.types?.[type.value]);
      });
      return settings;
    }

    settings.general = normalizeGeneral({
      metadataDelay: rawSettings.metadataDelay,
      showRoi: rawSettings.showRoi
    });
    settings.types["object-detection"] = normalizeTypeSettings("object-detection", {
      confidenceThreshold: rawSettings.confidenceThreshold,
      objects: rawSettings.objects
    });
    settings.types.tracking = normalizeTypeSettings("tracking", {
      showTrackHistory: rawSettings.showTrackHistory
    });
    ["classification", "pose-estimation", "segmentation"].forEach((metadataType) => {
      settings.types[metadataType] = normalizeTypeSettings(metadataType, rawSettings);
    });
    return settings;
  }

  function settingsOverrides(rawSettings) {
    const overrides = { general: {}, types: {} };
    if (!rawSettings || typeof rawSettings !== "object") return overrides;

    if (rawSettings.version === SETTINGS_VERSION) {
      overrides.general = normalizeGeneral(rawSettings.general, false);
      METADATA_TYPES.forEach((type) => {
        const rawType = rawSettings.types?.[type.value];
        if (rawType && typeof rawType === "object") {
          overrides.types[type.value] = normalizeTypeSettings(type.value, rawType, false);
        }
      });
      return overrides;
    }

    const legacyGeneral = {};
    if (Object.prototype.hasOwnProperty.call(rawSettings, "metadataDelay")) {
      legacyGeneral.metadataDelay = rawSettings.metadataDelay;
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "showRoi")) {
      legacyGeneral.showRoi = rawSettings.showRoi;
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
      false
    );

    const legacyTracking = {};
    if (Object.prototype.hasOwnProperty.call(rawSettings, "showTrackHistory")) {
      legacyTracking.showTrackHistory = rawSettings.showTrackHistory;
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
    if (type === "object-detection") {
      typeSettings = {
        confidenceThreshold:
          channelType.confidenceThreshold ?? globalType.confidenceThreshold ?? TYPE_DEFAULTS[type].confidenceThreshold,
        objects: mergeObjectStyles(TYPE_DEFAULTS[type].objects, globalType.objects || [], channelType.objects || [])
      };
    } else if (type === "tracking") {
      typeSettings = {
        showTrackHistory:
          channelType.showTrackHistory ?? globalType.showTrackHistory ?? TYPE_DEFAULTS[type].showTrackHistory
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

  function writeScopeSettings(scope, settings) {
    const normalized = normalizeSettings(settings);
    window.localStorage.setItem(`viewerSettings_${scope}`, JSON.stringify(normalized));
    return normalized;
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
    normalizeSettings,
    resolveTypeSettings
  };
  window.resolveTypeSettings = resolveTypeSettings;
})();
