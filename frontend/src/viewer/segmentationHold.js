// Five 30 fps display frames bridge short bounded inference/transport gaps
// without adding video buffering or glass-to-glass latency.
export const SEGMENTATION_HOLD_FRAMES = 5;
export const SEGMENTATION_TRACK_MISS_FRAMES = 2;
export const SEGMENTATION_CONFIDENCE_ALPHA = 0.25;
const SEGMENTATION_MATCH_IOU = 0.25;

export function createSegmentationHoldState() {
  return {
    lastDrawable: null,
    remainingFrames: 0,
    heldFrameDraws: 0,
    expirations: 0,
    tracks: [],
    smoothedConfidenceUpdates: 0,
    heldTrackDraws: 0,
  };
}

export function selectOverlayMetadata(candidate, state, isDrawable) {
  if (candidate) {
    if (candidate.data?.type === "segmentation") {
      const stabilized = stabilizeSegmentation(candidate, state);
      const drawable = isDrawable(stabilized);
      if (drawable) {
        state.lastDrawable = stabilized;
        state.remainingFrames = SEGMENTATION_HOLD_FRAMES;
      } else {
        clearHeldSegmentation(state);
      }
      return drawable ? stabilized : null;
    } else {
      clearHeldSegmentation(state);
    }
    const drawable = isDrawable(candidate);
    return drawable ? candidate : null;
  }

  if (state.lastDrawable && state.remainingFrames > 0) {
    state.remainingFrames -= 1;
    state.heldFrameDraws += 1;
    return state.lastDrawable;
  }

  if (state.lastDrawable) {
    state.expirations += 1;
    clearHeldSegmentation(state);
  }
  return null;
}

export function segmentationHoldSnapshot(state) {
  return {
    maxFrames: SEGMENTATION_HOLD_FRAMES,
    remainingFrames: state.remainingFrames,
    heldFrameDraws: state.heldFrameDraws,
    expirations: state.expirations,
    smoothedConfidenceUpdates: state.smoothedConfidenceUpdates,
    heldTrackDraws: state.heldTrackDraws,
  };
}

function clearHeldSegmentation(state) {
  state.lastDrawable = null;
  state.remainingFrames = 0;
  state.tracks = [];
}

function stabilizeSegmentation(candidate, state) {
  const segments = Array.isArray(candidate.data?.data?.segments)
    ? candidate.data.data.segments
    : [];
  const unmatchedPrevious = new Set(state.tracks.map((_track, index) => index));
  const nextTracks = [];
  const stabilized = [];

  for (const segment of segments) {
    const matchIndex = bestTrackMatch(segment, state.tracks, unmatchedPrevious);
    let nextSegment = segment;
    if (matchIndex >= 0) {
      const previous = state.tracks[matchIndex];
      unmatchedPrevious.delete(matchIndex);
      const currentConfidence = numericConfidence(segment.confidence);
      const previousConfidence = numericConfidence(previous.segment.confidence);
      if (currentConfidence !== null && previousConfidence !== null) {
        nextSegment = {
          ...segment,
          confidence:
            SEGMENTATION_CONFIDENCE_ALPHA * currentConfidence +
            (1 - SEGMENTATION_CONFIDENCE_ALPHA) * previousConfidence,
        };
        state.smoothedConfidenceUpdates += 1;
      }
    }
    stabilized.push(nextSegment);
    nextTracks.push({ segment: nextSegment, missedFrames: 0 });
  }

  for (const index of unmatchedPrevious) {
    const previous = state.tracks[index];
    const missedFrames = previous.missedFrames + 1;
    if (missedFrames > SEGMENTATION_TRACK_MISS_FRAMES) continue;
    stabilized.push(previous.segment);
    nextTracks.push({ segment: previous.segment, missedFrames });
    state.heldTrackDraws += 1;
  }

  state.tracks = nextTracks;
  return {
    ...candidate,
    data: {
      ...candidate.data,
      data: {
        ...candidate.data?.data,
        segments: stabilized,
      },
    },
  };
}

function bestTrackMatch(segment, tracks, available) {
  let bestIndex = -1;
  let bestIou = SEGMENTATION_MATCH_IOU;
  for (const index of available) {
    const previous = tracks[index].segment;
    if (previous.label !== segment.label) continue;
    const overlap = bboxIou(previous.bbox, segment.bbox);
    if (overlap < bestIou) continue;
    bestIou = overlap;
    bestIndex = index;
  }
  return bestIndex;
}

function bboxIou(left, right) {
  if (!validBbox(left) || !validBbox(right)) return 0;
  const intersectionWidth = Math.max(
    0,
    Math.min(left[0] + left[2], right[0] + right[2]) - Math.max(left[0], right[0]),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left[1] + left[3], right[1] + right[3]) - Math.max(left[1], right[1]),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union = left[2] * left[3] + right[2] * right[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

function validBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length >= 4 &&
    bbox.every(Number.isFinite) &&
    bbox[2] > 0 &&
    bbox[3] > 0
  );
}

function numericConfidence(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
