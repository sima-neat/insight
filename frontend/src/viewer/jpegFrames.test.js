import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptJpegChunk,
  createJpegAssembler,
  parseJpegChunk,
  selectFrameToPresent,
} from "./jpegFrames.js";

function chunk(ts, index, count, bytes) {
  const buffer = new ArrayBuffer(8 + bytes.length);
  const view = new DataView(buffer);
  view.setUint32(0, ts);
  view.setUint16(4, index);
  view.setUint16(6, count);
  new Uint8Array(buffer, 8).set(bytes);
  return buffer;
}

test("parseJpegChunk reads the big-endian header vf writes", () => {
  const parsed = parseJpegChunk(chunk(0xdeadbeef, 1, 3, [0xff, 0xd8]));
  assert.equal(parsed.ts, 0xdeadbeef);
  assert.equal(parsed.index, 1);
  assert.equal(parsed.count, 3);
  assert.deepEqual([...parsed.data], [0xff, 0xd8]);
});

test("parseJpegChunk rejects malformed messages", () => {
  assert.equal(parseJpegChunk("text"), null);
  assert.equal(parseJpegChunk(new ArrayBuffer(8)), null);
  assert.equal(parseJpegChunk(chunk(1, 2, 2, [1])), null);
});

test("chunks of one frame assemble in order", () => {
  const assembler = createJpegAssembler();
  assert.equal(acceptJpegChunk(assembler, parseJpegChunk(chunk(90, 0, 2, [1, 2])), 5), null);
  const frame = acceptJpegChunk(assembler, parseJpegChunk(chunk(90, 1, 2, [3])), 7);
  assert.equal(frame.ts, 90);
  assert.equal(frame.bytes, 3);
  assert.equal(frame.receivedAt, 7);
  assert.deepEqual(frame.parts.map((part) => [...part]), [[1, 2], [3]]);
  assert.equal(assembler.incomplete, 0);
});

test("a new timestamp discards an unfinished frame and counts it", () => {
  const assembler = createJpegAssembler();
  acceptJpegChunk(assembler, parseJpegChunk(chunk(90, 0, 2, [1])), 0);
  const frame = acceptJpegChunk(assembler, parseJpegChunk(chunk(180, 0, 1, [9])), 1);
  assert.equal(frame.ts, 180);
  assert.equal(assembler.incomplete, 1);
  // A completed frame is not counted when the next one starts.
  acceptJpegChunk(assembler, parseJpegChunk(chunk(270, 0, 1, [9])), 2);
  assert.equal(assembler.incomplete, 1);
});

test("a repeated chunk does not complete a frame", () => {
  const assembler = createJpegAssembler();
  acceptJpegChunk(assembler, parseJpegChunk(chunk(90, 0, 2, [1])), 0);
  assert.equal(acceptJpegChunk(assembler, parseJpegChunk(chunk(90, 0, 2, [1])), 0), null);
});

test("the newest frame with queued metadata is presented and older ones dropped", () => {
  const pending = [
    { ts: 1, receivedAt: 100 },
    { ts: 2, receivedAt: 133 },
    { ts: 3, receivedAt: 166 },
  ];
  const selected = selectFrameToPresent(pending, (ts) => ts === 2, 300, 170);
  assert.equal(selected.frame.ts, 2);
  assert.equal(selected.dropped, 1);
  assert.deepEqual(selected.remaining, [{ ts: 3, receivedAt: 166 }]);
});

test("a frame without metadata waits the video sync buffer", () => {
  const pending = [{ ts: 1, receivedAt: 100 }];
  assert.equal(selectFrameToPresent(pending, () => false, 300, 399), null);
  assert.equal(selectFrameToPresent(pending, () => false, 300, 400).frame.ts, 1);
  assert.equal(selectFrameToPresent(pending, () => false, 0, 100).frame.ts, 1);
  assert.equal(selectFrameToPresent([], () => true, 300, 400), null);
});
