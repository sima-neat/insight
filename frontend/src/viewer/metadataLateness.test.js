import assert from "node:assert/strict";
import test from "node:test";

import { lateNoticeDetails, nextWarningActive, suggestedBufferMs } from "./metadataLateness.js";

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

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true), {
    latenessMs: 153,
    latePercent: 92,
    bufferMs: 350,
    suggestedBufferMs: 600,
    blockedBy: null,
  });
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

  assert.deepEqual(lateNoticeDetails(snapshot, 350, true), {
    latenessMs: null,
    latePercent: 100,
    bufferMs: 350,
    suggestedBufferMs: null,
    blockedBy: "maximum",
  });
});
