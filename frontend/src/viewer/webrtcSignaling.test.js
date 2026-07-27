import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableWebRTCAnswerError,
  requestWebRTCAnswer,
} from "../../../webrtc/static/js/webrtcSignaling.js";

test("viewer posts the offer without waiting for candidate gathering", async () => {
  const offer = { type: "offer", sdp: "v=0\r\n" };
  const answer = { type: "answer", sdp: "v=0\r\n" };
  const peerConnection = {
    iceGatheringState: "new",
    localDescription: null,
    async createOffer() {
      return offer;
    },
    async setLocalDescription(description) {
      this.localDescription = description;
      this.iceGatheringState = "gathering";
    },
    addEventListener() {
      throw new Error("must not subscribe to gathering; mDNS candidates delay vf");
    },
  };

  let request;
  const received = await requestWebRTCAnswer(peerConnection, "/offer?channel=7", async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return answer; } };
  });

  assert.equal(request.url, "/offer?channel=7");
  assert.deepEqual(JSON.parse(request.options.body), offer);
  assert.equal(peerConnection.iceGatheringState, "gathering", "posted before gathering finished");
  assert.deepEqual(received, answer);
});

test("viewer answer errors expose the HTTP status", async () => {
  const peerConnection = {
    iceGatheringState: "complete",
    localDescription: null,
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\n" };
    },
    async setLocalDescription(offer) {
      this.localDescription = offer;
    },
  };

  await assert.rejects(
    requestWebRTCAnswer(peerConnection, "/offer?channel=7", async () => ({
      ok: false,
      status: 503,
    })),
    (error) => {
      assert.equal(error.message, "HTTP 503");
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("only an explicit client rejection is permanent", () => {
  assert.equal(isRetryableWebRTCAnswerError({ status: 503 }), true);
  assert.equal(isRetryableWebRTCAnswerError({ status: 500 }), true);
  assert.equal(isRetryableWebRTCAnswerError(new Error("network error")), true);
  assert.equal(isRetryableWebRTCAnswerError(undefined), true);
  assert.equal(isRetryableWebRTCAnswerError({ status: 400 }), false);
  assert.equal(isRetryableWebRTCAnswerError({ status: 404 }), false);
});
