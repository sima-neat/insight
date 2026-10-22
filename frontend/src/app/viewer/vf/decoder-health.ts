/** The decoder counters of the previous stats sample, and when a stall began. */
export interface DecoderHealth {
  lastFramesReceived: number | null;
  lastFramesDecoded: number | null;
  stalledSinceMs: number | null;
}

export interface DecoderHealthUpdate extends DecoderHealth {
  /** Whether the decoder produced frames since the previous sample. */
  decodedAdvanced: boolean;
  /** Whether frames have arrived without any being decoded for the threshold or longer. */
  stalled: boolean;
}

export const INITIAL_DECODER_HEALTH: DecoderHealth = {
  lastFramesReceived: null,
  lastFramesDecoded: null,
  stalledSinceMs: null,
};

/**
 * Detects a decoder that stopped: frames keep arriving (`framesReceived` advances) while
 * `framesDecoded` does not. An idle input is not a stall, and neither is a browser that reports no
 * decode counter, since nothing can be concluded from it.
 */
export function updateDecoderHealth(
  state: DecoderHealth,
  report: { framesReceived?: number; framesDecoded?: number },
  nowMs: number,
  stallThresholdMs: number,
): DecoderHealthUpdate {
  const { framesReceived, framesDecoded } = report;
  const receivedAdvanced =
    framesReceived !== undefined &&
    state.lastFramesReceived !== null &&
    framesReceived > state.lastFramesReceived;
  const decodedAdvanced =
    framesDecoded !== undefined &&
    state.lastFramesDecoded !== null &&
    framesDecoded > state.lastFramesDecoded;
  const stalledSinceMs =
    decodedAdvanced || !receivedAdvanced || framesDecoded === undefined
      ? null
      : (state.stalledSinceMs ?? nowMs);

  return {
    lastFramesReceived: framesReceived ?? state.lastFramesReceived,
    lastFramesDecoded: framesDecoded ?? state.lastFramesDecoded,
    stalledSinceMs,
    decodedAdvanced,
    stalled: stalledSinceMs !== null && nowMs - stalledSinceMs >= stallThresholdMs,
  };
}
