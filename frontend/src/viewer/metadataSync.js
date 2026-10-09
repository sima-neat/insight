const METADATA_QUEUE_LIMIT = 300;
const UNTYPED = "";
const LATENESS_WINDOW_MS = 5000;
const LATENESS_WINDOW_MIN_MESSAGES = 10;
// Bounds both memories against a stream that presents or sends far faster than expected.
const LATENESS_MEMORY_LIMIT = 1024;

function metadataTypeOf(data) {
  return typeof data?.type === "string" ? data.type : UNTYPED;
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
    timestampedEntries: 0,
    arrival: [],
    // Presented frames, oldest first: RTP timestamp -> presentation time.
    presented: new Map(),
    lastPresented: null,
    lastPresentedAt: 0,
    // Outcomes of timestamped messages in the recent window, oldest first.
    outcomes: [],
    stats: {
      timestampMatches: 0,
      arrivalFallbacks: 0,
      frameMisses: 0,
      expired: 0,
      evicted: 0,
      untimestampedReceived: 0,
      late: 0,
    },
  };
}

export function enqueueMetadata(queue, data, receivedAt) {
  const rtpTimestamp = data?._insight?.rtp_timestamp;
  const item = { receivedAt, data };
  if (Number.isInteger(rtpTimestamp) && rtpTimestamp >= 0) {
    const key = rtpTimestamp >>> 0;
    if (isLate(queue, key)) {
      // Its frame is gone, so it can never be drawn. Queueing it would only
      // surface later as an eviction, which reads as a capacity problem.
      const presentedAt = queue.presented.get(key);
      queue.stats.late += 1;
      recordOutcome(queue, {
        at: queue.lastPresentedAt,
        late: true,
        latenessMs: presentedAt === undefined ? null : Math.max(0, receivedAt - presentedAt),
      });
      return;
    }
    // A producer may describe one frame with several metadata types, so a frame
    // holds one entry per type. A repeat of the same type replaces it.
    const byType = queue.timestamped.get(key) ?? new Map();
    const type = metadataTypeOf(data);
    if (!byType.has(type)) queue.timestampedEntries += 1;
    queue.timestamped.delete(key);
    byType.delete(type);
    byType.set(type, item);
    queue.timestamped.set(key, byType);
    while (queue.timestampedEntries > METADATA_QUEUE_LIMIT) {
      const oldest = queue.timestamped.keys().next().value;
      const evicted = queue.timestamped.get(oldest).size;
      queue.timestampedEntries -= evicted;
      queue.stats.evicted += evicted;
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
    recordPresentedFrame(queue, key, now);
    const byType = queue.timestamped.get(key) ?? null;
    if (byType && byType.size > 0) {
      queue.timestamped.delete(key);
      queue.timestampedEntries -= byType.size;
      queue.stats.timestampMatches += 1;
      // The late share is a share of messages, so every type of the frame counts.
      for (let matched = 0; matched < byType.size; matched += 1) {
        recordOutcome(queue, { at: now, late: false, latenessMs: null });
      }
      return [...byType.values()];
    }
  }

  if (!hasFrameTimestamp) {
    let latest = null;
    let latestFrame = null;
    // Arrival time selects a frame; only its shared timestamp can group types.
    for (const byType of queue.timestamped.values()) {
      for (const item of byType.values()) {
        if (!latest || item.receivedAt >= latest.receivedAt) {
          latest = item;
          latestFrame = byType;
        }
      }
    }
    for (const item of queue.arrival) {
      if (!latest || item.receivedAt >= latest.receivedAt) {
        latest = item;
        latestFrame = null;
      }
    }
    queue.timestamped.clear();
    queue.timestampedEntries = 0;
    queue.arrival.length = 0;
    if (latest) {
      queue.stats.arrivalFallbacks += 1;
      return latestFrame ? [...latestFrame.values()] : [latest];
    }
  }

  if (queue.arrival.length > 0) {
    const latest = queue.arrival[queue.arrival.length - 1];
    queue.arrival.length = 0;
    queue.stats.arrivalFallbacks += 1;
    return [latest];
  }
  queue.stats.frameMisses += 1;
  return [];
}

export function metadataQueueSnapshot(queue) {
  const lateOutcomes = queue.outcomes.filter((outcome) => outcome.late);
  const lateness = lateOutcomes
    .map((outcome) => outcome.latenessMs)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  return {
    ...queue.stats,
    timestampedPending: queue.timestampedEntries,
    arrivalPending: queue.arrival.length,
    recentLateShare:
      queue.outcomes.length >= LATENESS_WINDOW_MIN_MESSAGES
        ? lateOutcomes.length / queue.outcomes.length
        : null,
    recentLatenessMedianMs: nearestRank(lateness, 0.5),
    recentLatenessP90Ms: nearestRank(lateness, 0.9),
    recentLatenessMaxMs: lateness.length ? lateness[lateness.length - 1] : null,
  };
}

export function resetLatenessWindow(queue) {
  queue.outcomes.length = 0;
}

// The subtraction is reduced to a signed 32-bit value, so it stays correct
// across the RTP timestamp wrap.
function isLate(queue, key) {
  return queue.lastPresented !== null && ((key - queue.lastPresented) | 0) <= 0;
}

// The window is aged here and nowhere else: a hidden tab presents no frames
// while messages keep arriving, and must not dilute or expire the window.
function recordPresentedFrame(queue, key, now) {
  queue.presented.delete(key);
  queue.presented.set(key, now);
  queue.lastPresented = key;
  queue.lastPresentedAt = now;
  for (const [timestamp, presentedAt] of queue.presented) {
    if (now - presentedAt <= LATENESS_WINDOW_MS && queue.presented.size <= LATENESS_MEMORY_LIMIT) break;
    queue.presented.delete(timestamp);
  }
  let expired = 0;
  while (expired < queue.outcomes.length && now - queue.outcomes[expired].at > LATENESS_WINDOW_MS) {
    expired += 1;
  }
  if (expired > 0) queue.outcomes.splice(0, expired);
}

function recordOutcome(queue, outcome) {
  queue.outcomes.push(outcome);
  if (queue.outcomes.length > LATENESS_MEMORY_LIMIT) {
    queue.outcomes.splice(0, queue.outcomes.length - LATENESS_MEMORY_LIMIT);
  }
}

function nearestRank(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function pruneMetadataQueue(queue, metadataRetentionMs, now) {
  if (metadataRetentionMs <= 0) return;
  // Types for one frame arrive at different times, and a frame moves to the
  // end of the map on each arrival, so neither frames nor entries sit in age
  // order. Every entry is checked; a frame goes only once it holds none.
  for (const [timestamp, byType] of queue.timestamped) {
    for (const [type, item] of byType) {
      if (now - item.receivedAt <= metadataRetentionMs) continue;
      byType.delete(type);
      queue.timestampedEntries -= 1;
      queue.stats.expired += 1;
    }
    if (byType.size === 0) queue.timestamped.delete(timestamp);
  }
  while (queue.arrival.length && now - queue.arrival[0].receivedAt > metadataRetentionMs) {
    queue.arrival.shift();
    queue.stats.expired += 1;
  }
}
