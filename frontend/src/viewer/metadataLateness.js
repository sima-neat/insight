const LATE_SHARE_ON = 0.5;
const LATE_SHARE_OFF = 0.1;
const BUFFER_MARGIN_MS = 50;
const BUFFER_STEP_MS = 50;
// Matches the upper bound of the video sync buffer setting.
const BUFFER_MAX_MS = 4000;
const SETTLE_MS_PER_RAISED_MS = 10;
const SETTLE_BASE_MS = 1000;

// Two thresholds, so a share hovering around one value does not make the chip blink.
export function nextWarningActive(active, recentLateShare) {
  if (recentLateShare == null) return active;
  if (recentLateShare >= LATE_SHARE_ON) return true;
  if (recentLateShare < LATE_SHARE_OFF) return false;
  return active;
}

export function suggestedBufferMs(currentBufferMs, p90LatenessMs) {
  if (!Number.isFinite(currentBufferMs) || !Number.isFinite(p90LatenessMs)) return null;
  const needed = currentBufferMs + p90LatenessMs + BUFFER_MARGIN_MS;
  const suggested = Math.ceil(needed / BUFFER_STEP_MS) * BUFFER_STEP_MS;
  return suggested > BUFFER_MAX_MS ? null : suggested;
}

// A browser moves to a raised jitter buffer target gradually, roughly 100 ms per
// second of video. What is measured until it has arrived describes the old buffer.
export function bufferSettleMs(previousBufferMs, nextBufferMs) {
  const raisedBy = Math.max(0, nextBufferMs - previousBufferMs);
  if (!Number.isFinite(raisedBy)) return SETTLE_BASE_MS;
  return raisedBy * SETTLE_MS_PER_RAISED_MS + SETTLE_BASE_MS;
}

// The panel's second button: raise the value the channels follow, or, when that
// already covers the suggestion, only let this channel follow it. The global value
// is never lowered. Without a known followed value the button offers the raise.
function globalActionFor(suggested, followedBufferMs) {
  if (suggested === null) return null;
  if (Number.isFinite(followedBufferMs) && followedBufferMs >= suggested) {
    return { kind: "follow", valueMs: followedBufferMs };
  }
  return { kind: "raise", valueMs: suggested };
}

export function lateNoticeDetails(snapshot, currentBufferMs, bufferSupported, followedBufferMs) {
  const suggested = bufferSupported
    ? suggestedBufferMs(currentBufferMs, snapshot.recentLatenessP90Ms)
    : null;
  let blockedBy = null;
  if (!bufferSupported) blockedBy = "unsupported";
  else if (suggested === null) blockedBy = "maximum";
  return {
    latenessMs:
      snapshot.recentLatenessMedianMs == null ? null : Math.round(snapshot.recentLatenessMedianMs),
    latePercent: snapshot.recentLateShare == null ? null : Math.round(snapshot.recentLateShare * 100),
    bufferMs: currentBufferMs,
    suggestedBufferMs: suggested,
    blockedBy,
    globalAction: globalActionFor(suggested, followedBufferMs),
  };
}
