export const AUXILIARY_METADATA_TYPE = "auxiliary-visualization";
const AUXILIARY_SCHEMA_VERSION = 1;
const AUXILIARY_DROPOUT_GRACE_MS = 160;
const MAX_AUXILIARY_VIEWS_PER_PANEL = 16;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 80;
const VIEW_PREFERENCE_VERSION = 1;

function createAuxiliaryRendererRegistry() {
  const renderers = new Map();
  return {
    register(name, renderer) {
      if (typeof name !== "string" || !name.trim()) {
        throw new TypeError("auxiliary renderer name must be a non-empty string");
      }
      if (!renderer || typeof renderer.draw !== "function") {
        throw new TypeError(`auxiliary renderer ${name} must provide draw()`);
      }
      if (renderers.has(name)) {
        throw new Error(`auxiliary renderer ${name} is already registered`);
      }
      renderers.set(name, Object.freeze({ ...renderer }));
    },
    get(name) {
      return renderers.get(name) ?? null;
    },
  };
}

export const auxiliaryRendererRegistry = createAuxiliaryRendererRegistry();

function mergeAuxiliarySessionSettings(configured, stored) {
  return {
    ...(configured && typeof configured === "object" ? configured : {}),
    ...(stored && typeof stored === "object" ? stored : {}),
  };
}

function comparableSettings(value) {
  if (Array.isArray(value)) return value.map(comparableSettings);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, comparableSettings(value[key])]),
  );
}

function settingsMatch(left, right) {
  return JSON.stringify(comparableSettings(left)) === JSON.stringify(comparableSettings(right));
}

export function createAuxiliaryViewPreference(configured, settings) {
  return {
    preference_version: VIEW_PREFERENCE_VERSION,
    baseline: configured && typeof configured === "object" ? configured : {},
    settings: settings && typeof settings === "object" ? settings : {},
  };
}

export function restoreAuxiliaryViewPreference(configured, stored, acceptLegacy = true) {
  const baseline = configured && typeof configured === "object" ? configured : {};
  if (stored?.preference_version === VIEW_PREFERENCE_VERSION) {
    return settingsMatch(baseline, stored.baseline)
      ? mergeAuxiliarySessionSettings(baseline, stored.settings)
      : baseline;
  }
  return acceptLegacy ? mergeAuxiliarySessionSettings(baseline, stored) : baseline;
}

export function reconcileAuxiliaryPanelMode(currentMode, settings, hasExplicitSettings) {
  if (!hasExplicitSettings) return currentMode;
  if (settings?.enabled === false) return "hidden";
  return ["compact", "collapsed", "expanded"].includes(settings?.panelMode)
    ? settings.panelMode
    : "compact";
}

// Keep only previously correlated data across a brief video/metadata delivery gap.
function shouldHoldLastAuxiliaryFrame(
  hasCurrentViews,
  lastViewAtMs,
  nowMs,
  graceMs = AUXILIARY_DROPOUT_GRACE_MS,
) {
  return hasCurrentViews
    && Number.isFinite(lastViewAtMs)
    && Number.isFinite(nowMs)
    && nowMs >= lastViewAtMs
    && nowMs - lastViewAtMs <= graceMs;
}

export function retainAuxiliaryViews(currentViews, incomingViews, lastSeenById, nowMs) {
  const nextViews = new Map();
  const nextLastSeen = new Map();
  const incomingById = new Map();
  for (const view of incomingViews) {
    if (incomingById.has(view.id)) {
      incomingById.set(view.id, view);
    } else if (incomingById.size < MAX_AUXILIARY_VIEWS_PER_PANEL) {
      incomingById.set(view.id, view);
    }
  }
  const retainedCapacity = MAX_AUXILIARY_VIEWS_PER_PANEL - incomingById.size;
  let retainedCount = 0;

  for (const [id, view] of currentViews) {
    if (incomingById.has(id)) {
      nextViews.set(id, incomingById.get(id));
      nextLastSeen.set(id, nowMs);
      incomingById.delete(id);
    } else if (
      retainedCount < retainedCapacity
      && shouldHoldLastAuxiliaryFrame(true, lastSeenById.get(id), nowMs)
    ) {
      nextViews.set(id, view);
      nextLastSeen.set(id, lastSeenById.get(id));
      retainedCount += 1;
    }
  }
  for (const [id, view] of incomingById) {
    nextViews.set(id, view);
    nextLastSeen.set(id, nowMs);
  }
  return { views: nextViews, lastSeenById: nextLastSeen };
}

function boundedString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

export function auxiliaryMessageQueueKey(message) {
  if (message?.type !== AUXILIARY_METADATA_TYPE) return null;
  const id = boundedString(message?.data?.id, MAX_ID_LENGTH);
  return id ? `${AUXILIARY_METADATA_TYPE}\u0000${id}` : AUXILIARY_METADATA_TYPE;
}

function inspectAuxiliaryMessage(message, registry = auxiliaryRendererRegistry) {
  if (message?.type !== AUXILIARY_METADATA_TYPE) {
    return { view: null, reason: "not-auxiliary" };
  }
  const data = message?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { view: null, reason: "data must be an object" };
  }
  if (data.schema_version !== AUXILIARY_SCHEMA_VERSION) {
    return { view: null, reason: `unsupported schema_version ${String(data.schema_version)}` };
  }
  const id = boundedString(data.id, MAX_ID_LENGTH);
  if (!id) return { view: null, reason: "id must be a non-empty string" };
  const rendererName = boundedString(data.renderer, MAX_ID_LENGTH);
  if (!rendererName) return { view: null, reason: "renderer must be a non-empty string" };
  const renderer = registry.get(rendererName);
  if (!renderer) return { view: null, reason: `unknown renderer ${rendererName}` };
  if (!data.payload || typeof data.payload !== "object" || Array.isArray(data.payload)) {
    return { view: null, reason: "payload must be an object" };
  }

  const requestedTitle = boundedString(data.title, MAX_TITLE_LENGTH);
  return {
    view: {
      id,
      renderer: rendererName,
      title: requestedTitle ?? renderer.title ?? rendererName,
      payload: data.payload,
      frameId: message.frame_id,
      rtpTimestamp: message?._insight?.rtp_timestamp,
    },
    reason: null,
  };
}

function sameRtpTimestamp(left, right) {
  return Number.isInteger(left) && Number.isInteger(right) && (left >>> 0) === (right >>> 0);
}

export function partitionFrameMetadata(candidates, rtpTimestamp, registry = auxiliaryRendererRegistry) {
  const overlays = [];
  const auxiliaryViews = [];
  const ignoredAuxiliary = [];
  const correlatedRtpTimestamp = Number.isInteger(rtpTimestamp)
    ? rtpTimestamp
    : candidates.find(({ data }) => Number.isInteger(data?._insight?.rtp_timestamp))
      ?.data?._insight?.rtp_timestamp;

  for (const candidate of candidates) {
    const message = candidate?.data;
    if (message?.type !== AUXILIARY_METADATA_TYPE) {
      overlays.push(candidate);
      continue;
    }

    const inspected = inspectAuxiliaryMessage(message, registry);
    if (!inspected.view) {
      ignoredAuxiliary.push({ message, reason: inspected.reason });
      continue;
    }
    if (!sameRtpTimestamp(inspected.view.rtpTimestamp, correlatedRtpTimestamp)) {
      continue;
    }
    if (auxiliaryViews.length >= MAX_AUXILIARY_VIEWS_PER_PANEL) {
      ignoredAuxiliary.push({
        message,
        reason: `frame exceeds ${MAX_AUXILIARY_VIEWS_PER_PANEL} auxiliary views`,
      });
      continue;
    }
    auxiliaryViews.push(inspected.view);
  }

  return { overlays, auxiliaryViews, ignoredAuxiliary };
}
