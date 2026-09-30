export const AUXILIARY_METADATA_TYPE = "auxiliary-visualization";
export const AUXILIARY_SCHEMA_VERSION = 1;

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 80;

export function createAuxiliaryRendererRegistry() {
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
    has(name) {
      return renderers.has(name);
    },
  };
}

export const auxiliaryRendererRegistry = createAuxiliaryRendererRegistry();

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

export function inspectAuxiliaryMessage(message, registry = auxiliaryRendererRegistry) {
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
    if (!sameRtpTimestamp(inspected.view.rtpTimestamp, rtpTimestamp)) {
      // Auxiliary views are frame-strict. Ordinary overlays retain the queue's
      // arrival fallback, but a separate panel must never describe another frame.
      continue;
    }
    auxiliaryViews.push(inspected.view);
  }

  return { overlays, auxiliaryViews, ignoredAuxiliary };
}
