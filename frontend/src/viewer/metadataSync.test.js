import assert from "node:assert/strict";
import test from "node:test";

import {
  applyVideoSyncBuffer,
  createMetadataQueue,
  enqueueMetadata,
  metadataQueueSnapshot,
  resetLatenessWindow,
  takeMetadataForFrame,
} from "./metadataSync.js";

test("video synchronization configures the browser receiver jitter target", () => {
  const receiver = { jitterBufferTarget: 0 };

  assert.deepEqual(applyVideoSyncBuffer(receiver, 350), {
    supported: true,
    applied: true,
    targetMs: 350,
  });
  assert.equal(receiver.jitterBufferTarget, 350);
});

test("video synchronization reports unsupported browser receivers", () => {
  assert.deepEqual(applyVideoSyncBuffer({}, 350), {
    supported: false,
    applied: false,
    targetMs: null,
  });
});

test("timestamped metadata is selected only for its decoded RTP frame", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 4321, 0, 20), []);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20)[0]?.data, message);
  assert.deepEqual(takeMetadataForFrame(queue, 1234, 0, 20), []);
});

test("metadata without a source timestamp falls back to the next video frame", () => {
  const queue = createMetadataQueue();
  const message = { type: "classification", data: { top_classes: [] } };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 1234, 20, 0)[0]?.data, message);
});

test("timestamped metadata falls back when the decoded frame has no RTP timestamp", () => {
  const queue = createMetadataQueue();
  const message = {
    type: "object-detection",
    data: { objects: [] },
    _insight: { rtp_timestamp: 1234 },
  };

  enqueueMetadata(queue, message, 10);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 20)[0]?.data, message);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
});

test("missing frame identity selects the newest arrival across metadata queues", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "timestamped", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "untimestamped" }, 20);

  assert.equal(takeMetadataForFrame(queue, undefined, 0, 30)[0]?.data.value, "untimestamped");
  assert.deepEqual(metadataQueueSnapshot(queue), {
    timestampMatches: 0,
    arrivalFallbacks: 1,
    frameMisses: 0,
    expired: 0,
    evicted: 0,
    untimestampedReceived: 1,
    late: 0,
    timestampedPending: 0,
    arrivalPending: 0,
    recentLateShare: null,
    recentLatenessMedianMs: null,
    recentLatenessP90Ms: null,
    recentLatenessMaxMs: null,
  });
});

test("timestamped metadata queue evicts its oldest entry at capacity", () => {
  const queue = createMetadataQueue();

  for (let timestamp = 0; timestamp <= 300; timestamp += 1) {
    enqueueMetadata(queue, { _insight: { rtp_timestamp: timestamp } }, timestamp);
  }

  assert.deepEqual(takeMetadataForFrame(queue, 0, 0, 300), []);
  assert.equal(takeMetadataForFrame(queue, 1, 0, 300)[0]?.data._insight.rtp_timestamp, 1);
});

test("fallback keeps all types from only the most recently received frame", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 0xffffffff } }, 10);
  const tracking = { type: "tracking", _insight: { rtp_timestamp: 0 } };
  const detection = { type: "object-detection", _insight: { rtp_timestamp: 0 } };
  enqueueMetadata(queue, tracking, 20);
  enqueueMetadata(queue, detection, 21);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 30).map((item) => item.data), [tracking, detection]);
  assert.equal(queue.timestampedEntries, 0);
  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 31), []);
});

test("fallback uses arrival time when a frame receives another metadata type", () => {
  const queue = createMetadataQueue();
  const pose = { type: "pose-estimation", _insight: { rtp_timestamp: 1 } };
  const tracking = { type: "tracking", _insight: { rtp_timestamp: 1 } };
  enqueueMetadata(queue, pose, 10);
  enqueueMetadata(queue, { type: "classification", _insight: { rtp_timestamp: 2 } }, 20);
  enqueueMetadata(queue, tracking, 30);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 40).map((item) => item.data), [pose, tracking]);
});

test("fallback never combines timestamped and untimestamped metadata", () => {
  for (const arrivalTime of [10, 20, 30]) {
    const queue = createMetadataQueue();
    const timestamped = { type: "tracking", _insight: { rtp_timestamp: 1 } };
    const untimestamped = { type: "pose-estimation" };
    enqueueMetadata(queue, timestamped, 20);
    enqueueMetadata(queue, untimestamped, arrivalTime);

    const expected = arrivalTime >= 20 ? untimestamped : timestamped;
    assert.deepEqual(takeMetadataForFrame(queue, undefined, 0, 40).map((item) => item.data), [expected]);
    assert.equal(queue.timestampedEntries, 0);
    assert.equal(queue.arrival.length, 0);
  }
});

test("untimestamped fallback returns only the latest message without inferring a shared frame", () => {
  for (const frameTimestamp of [undefined, 42]) {
    const queue = createMetadataQueue();
    enqueueMetadata(queue, { type: "pose-estimation" }, 10);
    const latest = { type: "tracking" };
    enqueueMetadata(queue, latest, 20);

    assert.deepEqual(takeMetadataForFrame(queue, frameTimestamp, 0, 30).map((item) => item.data), [latest]);
  }
});

test("an exact frame match takes precedence over newer fallback metadata", () => {
  const queue = createMetadataQueue();
  const exact = { type: "pose-estimation", _insight: { rtp_timestamp: 1 } };
  enqueueMetadata(queue, exact, 10);
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 2 } }, 20);
  enqueueMetadata(queue, { type: "classification" }, 30);

  assert.deepEqual(takeMetadataForFrame(queue, 1, 0, 40).map((item) => item.data), [exact]);
  assert.equal(queue.timestampedEntries, 1);
  assert.equal(queue.arrival.length, 1);
});

test("fallback excludes expired types from its selected frame", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { type: "classification", _insight: { rtp_timestamp: 2 } }, 20);
  const tracking = { type: "tracking", _insight: { rtp_timestamp: 1 } };
  enqueueMetadata(queue, tracking, 40);

  assert.deepEqual(takeMetadataForFrame(queue, undefined, 50, 60).map((item) => item.data), [tracking]);
  assert.equal(queue.stats.expired, 1);
  assert.equal(queue.timestampedEntries, 0);
});

test("configured retention expires unmatched timestamped metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.deepEqual(takeMetadataForFrame(queue, 1234, 5000, 5011), []);
});

test("zero retention keeps metadata until match or capacity eviction", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 500_000)[0]?.data._insight.rtp_timestamp, 1234);
});

test("duplicate RTP timestamp keeps the newest metadata", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1234 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1234 } }, 20);

  assert.equal(takeMetadataForFrame(queue, 1234, 0, 30)[0]?.data.value, "new");
});

test("replacing a timestamp keeps retention ordered by newest arrival", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { value: "old", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { value: "expired", _insight: { rtp_timestamp: 2 } }, 10);
  enqueueMetadata(queue, { value: "new", _insight: { rtp_timestamp: 1 } }, 20);

  assert.deepEqual(takeMetadataForFrame(queue, 2, 15, 30), []);
  assert.equal(takeMetadataForFrame(queue, 1, 15, 30)[0]?.data.value, "new");
});

test("metadata queue reports exact timestamp matches", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 1234 } }, 10);

  takeMetadataForFrame(queue, 1234, 0, 20);

  assert.equal(metadataQueueSnapshot(queue).timestampMatches, 1);
});

test("pending diagnostics count messages across types and frames", () => {
  const queue = createMetadataQueue();
  for (const type of ["pose-estimation", "tracking"]) {
    enqueueMetadata(queue, { type, _insight: { rtp_timestamp: 1 } }, 10);
  }
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 2);

  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 1 } }, 20);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 2);
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 2 } }, 30);
  enqueueMetadata(queue, { type: "classification" }, 40);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 3);
  assert.equal(metadataQueueSnapshot(queue).arrivalPending, 1);

  takeMetadataForFrame(queue, 1, 0, 50);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
  takeMetadataForFrame(queue, undefined, 0, 60);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
  assert.equal(metadataQueueSnapshot(queue).arrivalPending, 0);
});

test("metadata queue reports fallback, misses, expiry, and capacity eviction", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "classification" }, 0);
  takeMetadataForFrame(queue, 1, 0, 1);
  takeMetadataForFrame(queue, 2, 0, 2);
  enqueueMetadata(queue, { _insight: { rtp_timestamp: 3 } }, 0);
  takeMetadataForFrame(queue, 4, 1, 2);
  for (let timestamp = 10; timestamp <= 310; timestamp += 1) {
    enqueueMetadata(queue, { _insight: { rtp_timestamp: timestamp } }, timestamp);
  }

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.arrivalFallbacks, 1);
  assert.equal(snapshot.frameMisses, 2);
  assert.equal(snapshot.expired, 1);
  assert.equal(snapshot.evicted, 1);
  assert.equal(snapshot.untimestampedReceived, 1);
  assert.equal(snapshot.timestampedPending, 300);
});

test("one frame keeps metadata of every type, not just the last to arrive", () => {
  const queue = createMetadataQueue();
  const pose = {
    type: "pose-estimation",
    data: { poses: [] },
    _insight: { rtp_timestamp: 4242 },
  };
  const tracking = {
    type: "tracking",
    data: { tracks: [] },
    _insight: { rtp_timestamp: 4242 },
  };

  enqueueMetadata(queue, pose, 10);
  enqueueMetadata(queue, tracking, 11);

  const items = takeMetadataForFrame(queue, 4242, 0, 12);
  assert.deepEqual(
    items.map((item) => item.data.type).sort(),
    ["pose-estimation", "tracking"],
  );
});

test("metadata types for one frame expire independently", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 7 } }, 0);
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 7 } }, 40);

  // Retention 50 at t=60: pose (age 60) is gone, tracking (age 20) is not.
  takeMetadataForFrame(queue, 8, 50, 60);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
  const items = takeMetadataForFrame(queue, 7, 50, 60);
  assert.deepEqual(items.map((item) => item.data.type), ["tracking"]);
  assert.equal(metadataQueueSnapshot(queue).expired, 1);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
});

test("replacing a type preserves the draw order of the retained arrivals", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "object-detection", _insight: { rtp_timestamp: 1 } }, 10);
  const pose = { type: "pose-estimation", _insight: { rtp_timestamp: 1 } };
  enqueueMetadata(queue, pose, 20);
  const replacement = { type: "object-detection", value: "updated", _insight: { rtp_timestamp: 1 } };
  enqueueMetadata(queue, replacement, 30);

  assert.equal(queue.timestampedEntries, 2);
  assert.deepEqual(takeMetadataForFrame(queue, 1, 0, 40).map((item) => item.data), [pose, replacement]);
});

test("a stale type does not hide behind a fresher frame", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 1 } }, 0);
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 2 } }, 10);
  // Frame 1 moves behind frame 2 on this arrival, so its stale pose sits
  // after a frame whose entries are all fresh.
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 1 } }, 40);

  const items = takeMetadataForFrame(queue, 1, 50, 55);
  assert.deepEqual(items.map((item) => item.data.type), ["tracking"]);
  assert.equal(metadataQueueSnapshot(queue).expired, 1);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
});

test("distinct types on one unmatched frame cannot exceed queue capacity", () => {
  const queue = createMetadataQueue();
  for (let i = 0; i < 300; i += 1) {
    enqueueMetadata(queue, { type: `type-${i}`, _insight: { rtp_timestamp: 7 } }, i);
  }
  assert.equal(metadataQueueSnapshot(queue).evicted, 0);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 300);

  enqueueMetadata(queue, { type: "overflow", _insight: { rtp_timestamp: 7 } }, 300);
  assert.equal(metadataQueueSnapshot(queue).evicted, 301);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 0);
  assert.deepEqual(takeMetadataForFrame(queue, 7, 0, 301), []);
});

test("queue capacity counts types across frames and replaces duplicates", () => {
  const queue = createMetadataQueue();
  for (let timestamp = 0; timestamp < 150; timestamp += 1) {
    for (const type of ["pose-estimation", "tracking"]) {
      enqueueMetadata(queue, { type, _insight: { rtp_timestamp: timestamp } }, timestamp);
    }
  }
  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 149 } }, 150);
  assert.equal(metadataQueueSnapshot(queue).evicted, 0);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 300);

  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 150 } }, 151);
  assert.equal(metadataQueueSnapshot(queue).evicted, 2);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 299);
  assert.deepEqual(takeMetadataForFrame(queue, 0, 0, 152), []);
  assert.equal(takeMetadataForFrame(queue, 1, 0, 152).length, 2);
});

test("matching, fallback, and expiry release timestamped queue capacity", () => {
  for (const release of ["match", "fallback", "expiry"]) {
    const queue = createMetadataQueue();
    enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 7 } }, 0);
    if (release === "match") takeMetadataForFrame(queue, 7, 0, 10);
    if (release === "fallback") takeMetadataForFrame(queue, undefined, 0, 10);
    if (release === "expiry") takeMetadataForFrame(queue, 8, 5, 10);

    for (let timestamp = 100; timestamp < 400; timestamp += 1) {
      enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: timestamp } }, 20);
    }
    assert.equal(metadataQueueSnapshot(queue).evicted, 0, release);
    assert.equal(takeMetadataForFrame(queue, 100, 0, 21).length, 1, release);
  }
});

const FRAME_TICKS = 3600; // 40 ms at the 90 kHz RTP clock

function timestamped(rtpTimestamp) {
  return { type: "pose-estimation", data: { poses: [] }, _insight: { rtp_timestamp: rtpTimestamp } };
}

// Presents `count` frames 40 ms apart. Each frame's metadata arrives `latenessMs`
// after the frame when late, or 10 ms before it otherwise.
function playFrames(queue, { count, startFrame = 0, latenessMs = null }) {
  for (let i = startFrame; i < startFrame + count; i += 1) {
    const rtpTimestamp = i * FRAME_TICKS;
    const presentedAt = i * 40;
    if (latenessMs === null) {
      enqueueMetadata(queue, timestamped(rtpTimestamp), presentedAt - 10);
      takeMetadataForFrame(queue, rtpTimestamp, 0, presentedAt);
    } else {
      takeMetadataForFrame(queue, rtpTimestamp, 0, presentedAt);
      enqueueMetadata(queue, timestamped(rtpTimestamp), presentedAt + latenessMs);
    }
  }
}

test("metadata for a frame that was already presented is counted late and not queued", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 9000, 0, 1000);

  enqueueMetadata(queue, timestamped(9000), 1150);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 1);
  assert.equal(snapshot.timestampedPending, 0);
  assert.equal(snapshot.evicted, 0);
  assert.equal(snapshot.recentLatenessMaxMs, 150);
});

test("metadata older than the presented frame is late", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 5 * FRAME_TICKS, 0, 200);
  takeMetadataForFrame(queue, 6 * FRAME_TICKS, 0, 240);

  enqueueMetadata(queue, timestamped(5 * FRAME_TICKS), 300);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 1);
  assert.equal(snapshot.recentLatenessMaxMs, 100);
});

test("metadata newer than the presented frame is still queued and matched", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 9000, 0, 1000);

  enqueueMetadata(queue, timestamped(9000 + FRAME_TICKS), 1010);

  assert.equal(metadataQueueSnapshot(queue).late, 0);
  assert.equal(takeMetadataForFrame(queue, 9000 + FRAME_TICKS, 0, 1040).length, 1);
});

test("no metadata is late before the first frame was presented", () => {
  const queue = createMetadataQueue();

  enqueueMetadata(queue, timestamped(0), 10);

  assert.equal(metadataQueueSnapshot(queue).late, 0);
  assert.equal(metadataQueueSnapshot(queue).timestampedPending, 1);
});

test("late comparison is wrap-safe on 32 bits", () => {
  const afterWrap = createMetadataQueue();
  takeMetadataForFrame(afterWrap, 5, 0, 1000);
  enqueueMetadata(afterWrap, timestamped(0xffffff00), 1100);
  assert.equal(metadataQueueSnapshot(afterWrap).late, 1);

  const beforeWrap = createMetadataQueue();
  takeMetadataForFrame(beforeWrap, 0xfffffff0, 0, 1000);
  enqueueMetadata(beforeWrap, timestamped(16), 1010);
  assert.equal(metadataQueueSnapshot(beforeWrap).late, 0);
  assert.equal(metadataQueueSnapshot(beforeWrap).timestampedPending, 1);
});

test("late is judged against the frame presented last, so a backwards jump recovers", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 900_000, 0, 1000);
  takeMetadataForFrame(queue, 1000, 0, 1040); // source restarted with lower timestamps

  enqueueMetadata(queue, timestamped(1000 + FRAME_TICKS), 1050);

  assert.equal(metadataQueueSnapshot(queue).late, 0);
  assert.equal(takeMetadataForFrame(queue, 1000 + FRAME_TICKS, 0, 1080).length, 1);
});

test("a late message whose frame is no longer remembered counts without a lateness sample", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 0, 0, 0);
  takeMetadataForFrame(queue, 200 * FRAME_TICKS, 0, 8000); // frame 0 is older than the 5 s memory

  enqueueMetadata(queue, timestamped(0), 8010);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 1);
  assert.equal(snapshot.recentLatenessMedianMs, null);
  assert.equal(snapshot.recentLatenessP90Ms, null);
  assert.equal(snapshot.recentLatenessMaxMs, null);
});

test("a late message for a frame that was never presented counts without a lateness sample", () => {
  const queue = createMetadataQueue();
  takeMetadataForFrame(queue, 0, 0, 0);
  takeMetadataForFrame(queue, 2 * FRAME_TICKS, 0, 80); // frame 1 was dropped

  enqueueMetadata(queue, timestamped(FRAME_TICKS), 100);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 1);
  assert.equal(snapshot.recentLatenessMaxMs, null);
});

test("late share and lateness describe the recent window", () => {
  const queue = createMetadataQueue();
  playFrames(queue, { count: 5 });
  playFrames(queue, { count: 15, startFrame: 5, latenessMs: 150 });

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.timestampMatches, 5);
  assert.equal(snapshot.late, 15);
  assert.equal(snapshot.recentLateShare, 0.75);
  assert.equal(snapshot.recentLatenessMedianMs, 150);
  assert.equal(snapshot.recentLatenessP90Ms, 150);
  assert.equal(snapshot.recentLatenessMaxMs, 150);
});

test("late share is not calculated from fewer than 10 messages", () => {
  const queue = createMetadataQueue();
  playFrames(queue, { count: 9, latenessMs: 150 });

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 9);
  assert.equal(snapshot.recentLateShare, null);
});

test("the window forgets outcomes older than 5 s of presented frames", () => {
  const queue = createMetadataQueue();
  playFrames(queue, { count: 20, latenessMs: 150 }); // frames at 0..760 ms

  takeMetadataForFrame(queue, 500 * FRAME_TICKS, 0, 20_000);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 20); // cumulative counter is kept
  assert.equal(snapshot.recentLateShare, null);
  assert.equal(snapshot.recentLatenessMaxMs, null);
});

test("the window does not advance while no frame is presented", () => {
  const queue = createMetadataQueue();
  playFrames(queue, { count: 20, latenessMs: 150 });

  // A hidden tab presents no frames; a message arriving a minute later changes nothing.
  enqueueMetadata(queue, timestamped(10_000 * FRAME_TICKS), 60_000);

  assert.equal(metadataQueueSnapshot(queue).recentLateShare, 1);
});

test("resetting the lateness window keeps the cumulative counters", () => {
  const queue = createMetadataQueue();
  playFrames(queue, { count: 20, latenessMs: 150 });

  resetLatenessWindow(queue);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 20);
  assert.equal(snapshot.recentLateShare, null);
  assert.equal(snapshot.recentLatenessMedianMs, null);
});

test("lateness percentiles use the nearest rank", () => {
  const queue = createMetadataQueue();
  for (let i = 0; i < 10; i += 1) {
    takeMetadataForFrame(queue, i * FRAME_TICKS, 0, i * 40);
    enqueueMetadata(queue, timestamped(i * FRAME_TICKS), i * 40 + (i + 1) * 10); // 10..100 ms
  }

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.recentLatenessMedianMs, 50);
  assert.equal(snapshot.recentLatenessP90Ms, 90);
  assert.equal(snapshot.recentLatenessMaxMs, 100);
});

test("a type that arrives after its frame is late although another type was on time", () => {
  const queue = createMetadataQueue();
  enqueueMetadata(queue, { type: "pose-estimation", _insight: { rtp_timestamp: 9000 } }, 990);
  assert.equal(takeMetadataForFrame(queue, 9000, 0, 1000).length, 1);

  enqueueMetadata(queue, { type: "tracking", _insight: { rtp_timestamp: 9000 } }, 1150);

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.late, 1);
  assert.equal(snapshot.timestampedPending, 0);
  assert.equal(snapshot.recentLatenessMaxMs, 150);
});

test("the late share counts every type of a matched frame as one message on time", () => {
  const queue = createMetadataQueue();
  // Six frames with two types each on time, then four frames whose single message is late.
  for (let i = 0; i < 6; i += 1) {
    for (const type of ["pose-estimation", "tracking"]) {
      enqueueMetadata(queue, { type, _insight: { rtp_timestamp: i * FRAME_TICKS } }, i * 40 - 10);
    }
    takeMetadataForFrame(queue, i * FRAME_TICKS, 0, i * 40);
  }
  playFrames(queue, { count: 4, startFrame: 6, latenessMs: 150 });

  const snapshot = metadataQueueSnapshot(queue);
  assert.equal(snapshot.timestampMatches, 6);
  assert.equal(snapshot.late, 4);
  assert.equal(snapshot.recentLateShare, 0.25);
});
