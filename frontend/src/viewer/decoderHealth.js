// Chrome installs a null decoder when it cannot create a real one for the
// negotiated codec, and reports it as "NullVideoDecoder (fallback from: ...)".
// Every frame is then discarded, so the condition never clears and a reconnect
// only renegotiates into the same state.
function decoderUnavailable(report) {
  return typeof report.decoderImplementation === "string" &&
    /^null/i.test(report.decoderImplementation.trim());
}

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
    unsupported: decoderUnavailable(report),
    stalled:
      !decoderUnavailable(report) &&
      stalledSinceMs != null &&
      nowMs - stalledSinceMs >= stallThresholdMs,
  };
}
