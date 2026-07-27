import assert from "node:assert/strict";
import test from "node:test";

import { updateDecoderHealth } from "./decoderHealth.js";

const STALL_MS = 5000;

function initialState() {
  return {
    lastFramesReceived: null,
    lastFramesDecoded: null,
    stalledSinceMs: null,
  };
}

test("reports a stall while input advances without decoded output", () => {
  let state = updateDecoderHealth(
    initialState(),
    { framesReceived: 10, framesDecoded: 5 },
    0,
    STALL_MS,
  );
  state = updateDecoderHealth(state, { framesReceived: 20, framesDecoded: 5 }, 1000, STALL_MS);
  assert.equal(state.stalled, false);

  state = updateDecoderHealth(state, { framesReceived: 60, framesDecoded: 5 }, 6000, STALL_MS);
  assert.equal(state.stalled, true);
});

test("decoded output clears a pending stall", () => {
  let state = updateDecoderHealth(
    initialState(),
    { framesReceived: 10, framesDecoded: 5 },
    0,
    STALL_MS,
  );
  state = updateDecoderHealth(state, { framesReceived: 20, framesDecoded: 5 }, 1000, STALL_MS);
  state = updateDecoderHealth(state, { framesReceived: 30, framesDecoded: 6 }, 6000, STALL_MS);

  assert.equal(state.decodedAdvanced, true);
  assert.equal(state.stalledSinceMs, null);
  assert.equal(state.stalled, false);
});

test("an idle input does not trigger decoder recovery", () => {
  let state = updateDecoderHealth(
    initialState(),
    { framesReceived: 10, framesDecoded: 5 },
    0,
    STALL_MS,
  );
  state = updateDecoderHealth(state, { framesReceived: 10, framesDecoded: 5 }, 6000, STALL_MS);

  assert.equal(state.stalledSinceMs, null);
  assert.equal(state.stalled, false);
});

test("missing decode counters do not trigger recovery", () => {
  let state = updateDecoderHealth(initialState(), { framesReceived: 10 }, 0, STALL_MS);
  state = updateDecoderHealth(state, { framesReceived: 20 }, 6000, STALL_MS);

  assert.equal(state.stalledSinceMs, null);
  assert.equal(state.stalled, false);
});

test("a null decoder is reported as unsupported rather than stalled", () => {
  const nullDecoder = "NullVideoDecoder (fallback from: ExternalDecoder (VideoToolboxVideoDecoder))";
  let state = updateDecoderHealth(
    initialState(),
    { framesReceived: 10, framesDecoded: 5, decoderImplementation: nullDecoder },
    0,
    STALL_MS,
  );
  state = updateDecoderHealth(
    state,
    { framesReceived: 60, framesDecoded: 5, decoderImplementation: nullDecoder },
    6000,
    STALL_MS,
  );

  assert.equal(state.unsupported, true);
  assert.equal(state.stalled, false, "reconnecting cannot recover an absent decoder");
});

test("a real decoder that stops producing is still a recoverable stall", () => {
  const real = "ExternalDecoder (VideoToolboxVideoDecoder)";
  let state = updateDecoderHealth(
    initialState(),
    { framesReceived: 10, framesDecoded: 5, decoderImplementation: real },
    0,
    STALL_MS,
  );
  state = updateDecoderHealth(
    state,
    { framesReceived: 20, framesDecoded: 5, decoderImplementation: real },
    1000,
    STALL_MS,
  );
  state = updateDecoderHealth(
    state,
    { framesReceived: 60, framesDecoded: 5, decoderImplementation: real },
    6000,
    STALL_MS,
  );

  assert.equal(state.unsupported, false);
  assert.equal(state.stalled, true);
});
