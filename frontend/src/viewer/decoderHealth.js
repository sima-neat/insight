export function updateDecoderHealth(state, report, nowMs, stallThresholdMs) {
  const receivedAdvanced =
    typeof report.framesReceived === "number" &&
    state.lastFramesReceived != null &&
    report.framesReceived > state.lastFramesReceived;
  const decodedAdvanced =
    typeof report.framesDecoded === "number" &&
    state.lastFramesDecoded != null &&
    report.framesDecoded > state.lastFramesDecoded;
  const stalledSinceMs =
    decodedAdvanced || !receivedAdvanced || typeof report.framesDecoded !== "number"
      ? null
      : (state.stalledSinceMs ?? nowMs);

  return {
    lastFramesReceived: report.framesReceived ?? state.lastFramesReceived,
    lastFramesDecoded: report.framesDecoded ?? state.lastFramesDecoded,
    stalledSinceMs,
    decodedAdvanced,
    stalled: stalledSinceMs != null && nowMs - stalledSinceMs >= stallThresholdMs,
  };
}
