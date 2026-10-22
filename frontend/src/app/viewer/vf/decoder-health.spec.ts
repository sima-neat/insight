import { INITIAL_DECODER_HEALTH, updateDecoderHealth } from './decoder-health';

const STALL_MS = 5000;

describe('updateDecoderHealth', () => {
  it('reports a stall while input advances without decoded output', () => {
    let state = updateDecoderHealth(
      INITIAL_DECODER_HEALTH,
      { framesReceived: 10, framesDecoded: 5 },
      0,
      STALL_MS,
    );
    state = updateDecoderHealth(state, { framesReceived: 20, framesDecoded: 5 }, 1000, STALL_MS);
    expect(state.stalled).toBe(false);

    state = updateDecoderHealth(state, { framesReceived: 60, framesDecoded: 5 }, 6000, STALL_MS);
    expect(state.stalled).toBe(true);
  });

  it('clears a pending stall when output is decoded', () => {
    let state = updateDecoderHealth(
      INITIAL_DECODER_HEALTH,
      { framesReceived: 10, framesDecoded: 5 },
      0,
      STALL_MS,
    );
    state = updateDecoderHealth(state, { framesReceived: 20, framesDecoded: 5 }, 1000, STALL_MS);
    state = updateDecoderHealth(state, { framesReceived: 30, framesDecoded: 6 }, 6000, STALL_MS);

    expect(state.decodedAdvanced).toBe(true);
    expect(state.stalledSinceMs).toBeNull();
    expect(state.stalled).toBe(false);
  });

  it('does not trigger recovery on an idle input', () => {
    let state = updateDecoderHealth(
      INITIAL_DECODER_HEALTH,
      { framesReceived: 10, framesDecoded: 5 },
      0,
      STALL_MS,
    );
    state = updateDecoderHealth(state, { framesReceived: 10, framesDecoded: 5 }, 6000, STALL_MS);

    expect(state.stalledSinceMs).toBeNull();
    expect(state.stalled).toBe(false);
  });

  it('does not trigger recovery when the decode counter is missing', () => {
    let state = updateDecoderHealth(INITIAL_DECODER_HEALTH, { framesReceived: 10 }, 0, STALL_MS);
    state = updateDecoderHealth(state, { framesReceived: 20 }, 6000, STALL_MS);

    expect(state.stalledSinceMs).toBeNull();
    expect(state.stalled).toBe(false);
  });
});
