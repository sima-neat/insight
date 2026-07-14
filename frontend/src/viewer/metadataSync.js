const METADATA_QUEUE_LIMIT = 300;

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
    queue.timestamped.delete(key);
    queue.timestamped.set(key, item);
    while (queue.timestamped.size > METADATA_QUEUE_LIMIT) {
      queue.timestamped.delete(queue.timestamped.keys().next().value);
      queue.stats.evicted += 1;
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
    const item = queue.timestamped.get(key) ?? null;
    if (item) {
      queue.timestamped.delete(key);
      queue.stats.timestampMatches += 1;
      return item;
    }
  }

  if (!hasFrameTimestamp) {
    let item = queue.arrival.at(-1) ?? null;
    for (const timestamped of queue.timestamped.values()) {
      if (!item || timestamped.receivedAt >= item.receivedAt) item = timestamped;
    }
    queue.timestamped.clear();
    queue.arrival.length = 0;
    if (item) {
      queue.stats.arrivalFallbacks += 1;
      return item;
    }
  }

  if (queue.arrival.length > 0) {
    const item = queue.arrival[queue.arrival.length - 1];
    queue.arrival.length = 0;
    queue.stats.arrivalFallbacks += 1;
    return item;
  }
  queue.stats.frameMisses += 1;
  return null;
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
    if (now - item.receivedAt <= metadataRetentionMs) break;
    queue.timestamped.delete(timestamp);
    queue.stats.expired += 1;
  }
  while (queue.arrival.length && now - queue.arrival[0].receivedAt > metadataRetentionMs) {
    queue.arrival.shift();
    queue.stats.expired += 1;
  }
}
