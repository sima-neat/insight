import assert from "node:assert/strict";
import test from "node:test";

import { channelLabel, formatChannelStatus, resolveCodecLabel } from "./channelStatus.js";

function statsWith(codecId, codecReport) {
  return new Map([[codecId, codecReport]]);
}

test("resolves the negotiated codec through the report's codecId", () => {
  const stats = statsWith("C1", { type: "codec", mimeType: "video/H265" });
  assert.equal(resolveCodecLabel(stats, { codecId: "C1" }), "H.265");

  const h264 = statsWith("C2", { type: "codec", mimeType: "video/H264" });
  assert.equal(resolveCodecLabel(h264, { codecId: "C2" }), "H.264");
});

test("encoding names are matched case-insensitively", () => {
  const stats = statsWith("C1", { mimeType: "video/h265" });
  assert.equal(resolveCodecLabel(stats, { codecId: "C1" }), "H.265");
});

test("an unrecognized encoding is shown as reported rather than hidden", () => {
  const stats = statsWith("C1", { mimeType: "video/VP8" });
  assert.equal(resolveCodecLabel(stats, { codecId: "C1" }), "VP8");
});

test("codec stays unknown when it cannot be resolved", () => {
  const stats = statsWith("C1", { mimeType: "video/H265" });
  assert.equal(resolveCodecLabel(stats, {}), null, "no codecId on the report");
  assert.equal(resolveCodecLabel(stats, { codecId: "missing" }), null, "codecId not in stats");
  assert.equal(resolveCodecLabel(statsWith("C1", {}), { codecId: "C1" }), null, "no mimeType");
  assert.equal(resolveCodecLabel(undefined, { codecId: "C1" }), null, "no stats");
});

test("status shows the codec immediately after the channel", () => {
  const status = formatChannelStatus({
    index: 7,
    codec: "H.265",
    width: 1280,
    height: 720,
    fps: "30.0",
    bitrate: "4200.0",
    messageRate: 30,
  });
  assert.equal(status, "Channel 7 | H.265 | 1280x720 | 30.0 fps | 4200.0 kbps | 30 msgs/sec");
});

test("status omits the codec segment while the codec is unknown", () => {
  const status = formatChannelStatus({
    index: 7,
    codec: null,
    width: 1280,
    height: 720,
    fps: "30.0",
    bitrate: "4200.0",
    messageRate: 30,
  });
  assert.equal(status, "Channel 7 | 1280x720 | 30.0 fps | 4200.0 kbps | 30 msgs/sec");
});

test("the unsupported-decoder warning carries the codec when known", () => {
  assert.equal(
    `${channelLabel(7, "H.265")} | Codec not supported by this browser`,
    "Channel 7 | H.265 | Codec not supported by this browser",
  );
  assert.equal(
    `${channelLabel(7, null)} | Codec not supported by this browser`,
    "Channel 7 | Codec not supported by this browser",
  );
});
