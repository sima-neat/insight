import assert from "node:assert/strict";
import test from "node:test";

import { bufferSettleMs, lateNoticeDetails, nextWarningActive, suggestedBufferMs } from "./metadataLateness.js";

test("the warning turns on when half of the messages are late", () => {
  assert.equal(nextWarningActive(false, 0.5), true);
  assert.equal(nextWarningActive(false, 0.92), true);
});

test("the warning stays off below half", () => {
  assert.equal(nextWarningActive(false, 0.49), false);
});

test("the warning turns off only below a tenth", () => {
  assert.equal(nextWarningActive(true, 0.1), true);
  assert.equal(nextWarningActive(true, 0.3), true);
  assert.equal(nextWarningActive(true, 0.09), false);
  assert.equal(nextWarningActive(true, 0), false);
});

test("the warning keeps its state while no share can be calculated", () => {
  assert.equal(nextWarningActive(true, null), true);
  assert.equal(nextWarningActive(false, null), false);
  assert.equal(nextWarningActive(true, undefined), true);
});

test("the suggested buffer covers the lateness plus a margin, in 50 ms steps", () => {
  assert.equal(suggestedBufferMs(350, 195), 600);
  assert.equal(suggestedBufferMs(350, 150), 550);
  assert.equal(suggestedBufferMs(350, 151), 600);
});

test("the suggested buffer is always above the current buffer", () => {
  assert.equal(suggestedBufferMs(350, 0), 400);
  assert.equal(suggestedBufferMs(0, 0), 50);
  assert.equal(suggestedBufferMs(375, 0.4), 450);
});

test("there is no suggestion above the 4000 ms maximum", () => {
  assert.equal(suggestedBufferMs(3000, 950), 4000);
  assert.equal(suggestedBufferMs(3000, 951), null);
  assert.equal(suggestedBufferMs(4000, 0), null);
});

test("there is no suggestion without a lateness measurement", () => {
  assert.equal(suggestedBufferMs(350, null), null);
  assert.equal(suggestedBufferMs(350, Number.NaN), null);
  assert.equal(suggestedBufferMs(undefined, 100), null);
});

test("notice details carry the panel values", () => {
  const snapshot = { recentLateShare: 0.918, recentLatenessMedianMs: 153.4, recentLatenessP90Ms: 195 };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, 350), {
    latenessMs: 153,
    latePercent: 92,
    bufferMs: 350,
    suggestedBufferMs: 600,
    blockedBy: null,
    globalAction: { kind: "raise", valueMs: 600 },
  });
});

test("the global action raises when the followed value is below the suggestion", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 150, recentLatenessP90Ms: 195 };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, 500).globalAction, { kind: "raise", valueMs: 600 });
});

test("the global action follows when the followed value is above the suggestion", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 150, recentLatenessP90Ms: 195 };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, 1000).globalAction, { kind: "follow", valueMs: 1000 });
});

test("the global action follows when the followed value equals the suggestion", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 150, recentLatenessP90Ms: 195 };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, 600).globalAction, { kind: "follow", valueMs: 600 });
});

test("there is no global action without a suggestion", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 1200, recentLatenessP90Ms: 1300 };

  assert.equal(lateNoticeDetails(snapshot, 3000, true, 350).globalAction, null);
  assert.equal(lateNoticeDetails(snapshot, 350, false, 350).globalAction, null);
});

test("the global action raises when the followed value is missing", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 150, recentLatenessP90Ms: 195 };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true).globalAction, { kind: "raise", valueMs: 600 });
  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, null).globalAction, { kind: "raise", valueMs: 600 });
  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, Number.NaN).globalAction, { kind: "raise", valueMs: 600 });
});

test("notice details name the maximum as the blocker", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 1200, recentLatenessP90Ms: 1300 };

  const details = lateNoticeDetails(snapshot, 3000, true);
  assert.equal(details.suggestedBufferMs, null);
  assert.equal(details.blockedBy, "maximum");
});

test("notice details name the browser as the blocker", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: 150, recentLatenessP90Ms: 150 };

  const details = lateNoticeDetails(snapshot, 350, false);
  assert.equal(details.suggestedBufferMs, null);
  assert.equal(details.blockedBy, "unsupported");
});

test("notice details survive a window without lateness samples", () => {
  const snapshot = { recentLateShare: 1, recentLatenessMedianMs: null, recentLatenessP90Ms: null };

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true, 350), {
    latenessMs: null,
    latePercent: 100,
    bufferMs: 350,
    suggestedBufferMs: null,
    blockedBy: "maximum",
    globalAction: null,
  });
});

test("a raised buffer needs time to settle, in proportion to the raise", () => {
  assert.equal(bufferSettleMs(350, 600), 3500);
  assert.equal(bufferSettleMs(0, 4000), 41000);
});

test("a lowered or unchanged buffer settles after the base time", () => {
  assert.equal(bufferSettleMs(600, 350), 1000);
  assert.equal(bufferSettleMs(350, 350), 1000);
});

test("the settle time survives values that are not numbers", () => {
  assert.equal(bufferSettleMs(undefined, 600), 1000);
  assert.equal(bufferSettleMs(350, Number.NaN), 1000);
});
