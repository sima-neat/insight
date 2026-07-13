const METADATA_QUEUE_LIMIT = 300;
const METADATA_QUEUE_MAX_AGE_MS = 5000;
// Video uses a 90 kHz RTP clock. Never carry a drawable overlay forward more
// than about 133 ms, even when the wall-clock hold has not expired.
export const METADATA_PAST_FRAME_HOLD_TICKS = 12000;

export function signedRtpDelta(currentTimestamp, previousTimestamp) {
  if (!Number.isInteger(currentTimestamp) || !Number.isInteger(previousTimestamp)) return null;
  const delta = ((currentTimestamp >>> 0) - (previousTimestamp >>> 0)) >>> 0;
  return delta >= 0x80000000 ? delta - 0x100000000 : delta;
}

export function canHoldPastFrameMetadata(currentTimestamp, metadataTimestamp) {
  const delta = signedRtpDelta(currentTimestamp, metadataTimestamp);
  return delta !== null && delta > 0 && delta <= METADATA_PAST_FRAME_HOLD_TICKS;
}

export function createMetadataQueue() {
  return { timestamped: new Map(), arrival: [], frameSynchronized: false };
}

export function enqueueMetadata(queue, data, receivedAt) {
  const rtpTimestamp = data?._insight?.rtp_timestamp;
  const item = { receivedAt, data };
  if (Number.isInteger(rtpTimestamp) && rtpTimestamp >= 0) {
    queue.frameSynchronized = true;
    const key = rtpTimestamp >>> 0;
    queue.timestamped.delete(key);
    queue.timestamped.set(key, item);
    while (queue.timestamped.size > METADATA_QUEUE_LIMIT) {
      queue.timestamped.delete(queue.timestamped.keys().next().value);
    }
    return;
  }

  queue.arrival.push(item);
  if (queue.arrival.length > METADATA_QUEUE_LIMIT) {
    queue.arrival.splice(0, queue.arrival.length - METADATA_QUEUE_LIMIT);
  }
}

export function takeMetadataForFrame(queue, rtpTimestamp, metadataDelayMs, now) {
  pruneMetadataQueue(queue, now);
  if (Number.isInteger(rtpTimestamp) && rtpTimestamp >= 0) {
    const key = rtpTimestamp >>> 0;
    const item = queue.timestamped.get(key) ?? null;
    if (item) {
      queue.timestamped.delete(key);
      return item;
    }
  }

  for (let i = queue.arrival.length - 1; i >= 0; i -= 1) {
    const item = queue.arrival[i];
    if (now - item.receivedAt >= metadataDelayMs) {
      queue.arrival.splice(0, i + 1);
      return item;
    }
  }
  return null;
}

function pruneMetadataQueue(queue, now) {
  for (const [timestamp, item] of queue.timestamped) {
    if (now - item.receivedAt <= METADATA_QUEUE_MAX_AGE_MS) break;
    queue.timestamped.delete(timestamp);
  }
  while (queue.arrival.length && now - queue.arrival[0].receivedAt > METADATA_QUEUE_MAX_AGE_MS) {
    queue.arrival.shift();
  }
}
