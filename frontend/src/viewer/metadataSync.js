const METADATA_QUEUE_LIMIT = 300;
const UNTYPED = "";

function metadataTypeOf(data) {
  return typeof data?.type === "string" ? data.type : UNTYPED;
}

function oldestReceivedAt(byType) {
  let oldest = Infinity;
  for (const item of byType.values()) oldest = Math.min(oldest, item.receivedAt);
  return oldest;
}

export function applyVideoSyncBuffer(receiver, targetMs) {
  if (!receiver || !("jitterBufferTarget" in receiver)) {
    return { supported: false, applied: false, targetMs: null };
  }
  try {
    receiver.jitterBufferTarget = targetMs;
    return {
      supported: true,
      applied: true,
      targetMs: Number(receiver.jitterBufferTarget),
    };
  } catch (_err) {
    return { supported: true, applied: false, targetMs: null };
  }
}

export function createMetadataQueue() {
  return {
    timestamped: new Map(),
    arrival: [],
    stats: {
      timestampMatches: 0,
      arrivalFallbacks: 0,
      frameMisses: 0,
      expired: 0,
      evicted: 0,
      untimestampedReceived: 0,
    },
  };
}

export function enqueueMetadata(queue, data, receivedAt) {
  const rtpTimestamp = data?._insight?.rtp_timestamp;
  const item = { receivedAt, data };
  if (Number.isInteger(rtpTimestamp) && rtpTimestamp >= 0) {
    const key = rtpTimestamp >>> 0;
    // A producer may describe one frame with several metadata types, so a frame
    // holds one entry per type. A repeat of the same type replaces it.
    const byType = queue.timestamped.get(key) ?? new Map();
    queue.timestamped.delete(key);
    byType.set(metadataTypeOf(data), item);
    queue.timestamped.set(key, byType);
    while (queue.timestamped.size > METADATA_QUEUE_LIMIT) {
      const oldest = queue.timestamped.keys().next().value;
      queue.stats.evicted += queue.timestamped.get(oldest).size;
      queue.timestamped.delete(oldest);
    }
    return;
  }

  queue.stats.untimestampedReceived += 1;
  queue.arrival.push(item);
  if (queue.arrival.length > METADATA_QUEUE_LIMIT) {
    const evicted = queue.arrival.length - METADATA_QUEUE_LIMIT;
    queue.arrival.splice(0, evicted);
    queue.stats.evicted += evicted;
  }
}

export function takeMetadataForFrame(queue, rtpTimestamp, metadataRetentionMs, now) {
  pruneMetadataQueue(queue, metadataRetentionMs, now);
  const hasFrameTimestamp = Number.isInteger(rtpTimestamp) && rtpTimestamp >= 0;
  if (hasFrameTimestamp) {
    const key = rtpTimestamp >>> 0;
    const byType = queue.timestamped.get(key) ?? null;
    if (byType && byType.size > 0) {
      queue.timestamped.delete(key);
      queue.stats.timestampMatches += 1;
      return [...byType.values()];
    }
  }

  if (!hasFrameTimestamp) {
    const latest = new Map();
    for (const byType of queue.timestamped.values()) {
      for (const [type, item] of byType) {
        const held = latest.get(type);
        if (!held || item.receivedAt >= held.receivedAt) latest.set(type, item);
      }
    }
    for (const item of queue.arrival) {
      const type = metadataTypeOf(item.data);
      const held = latest.get(type);
      if (!held || item.receivedAt >= held.receivedAt) latest.set(type, item);
    }
    queue.timestamped.clear();
    queue.arrival.length = 0;
    if (latest.size > 0) {
      queue.stats.arrivalFallbacks += 1;
      return [...latest.values()];
    }
  }

  if (queue.arrival.length > 0) {
    const latest = new Map();
    for (const item of queue.arrival) latest.set(metadataTypeOf(item.data), item);
    queue.arrival.length = 0;
    queue.stats.arrivalFallbacks += 1;
    return [...latest.values()];
  }
  queue.stats.frameMisses += 1;
  return [];
}

export function metadataQueueSnapshot(queue) {
  return {
    ...queue.stats,
    timestampedPending: queue.timestamped.size,
    arrivalPending: queue.arrival.length,
  };
}

function pruneMetadataQueue(queue, metadataRetentionMs, now) {
  if (metadataRetentionMs <= 0) return;
  for (const [timestamp, item] of queue.timestamped) {
    if (now - oldestReceivedAt(item) <= metadataRetentionMs) break;
    queue.stats.expired += item.size;
    queue.timestamped.delete(timestamp);
  }
  while (queue.arrival.length && now - queue.arrival[0].receivedAt > metadataRetentionMs) {
    queue.arrival.shift();
    queue.stats.expired += 1;
  }
}
