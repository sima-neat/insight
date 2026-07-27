import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableWebRTCAnswerError,
  requestWebRTCAnswer,
} from "../../../webrtc/static/js/webrtcSignaling.js";

test("viewer submits the gathered local description", async () => {
  const initialOffer = { type: "offer", sdp: "v=0\r\n" };
  const gatheredOffer = {
    type: "offer",
    sdp: "v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n",
  };
  const answer = { type: "answer", sdp: "v=0\r\n" };
  const gatheringListeners = new Set();
  const peerConnection = {
    iceGatheringState: "new",
    localDescription: null,
    async createOffer() {
      return initialOffer;
    },
    async setLocalDescription(offer) {
      this.localDescription = offer;
      this.iceGatheringState = "gathering";
    },
    addEventListener(type, listener) {
      assert.equal(type, "icegatheringstatechange");
      gatheringListeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "icegatheringstatechange");
      gatheringListeners.delete(listener);
    },
  };

  let request;
  const negotiation = requestWebRTCAnswer(peerConnection, "/offer?channel=7", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return answer;
      },
    };
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(request, undefined);

  peerConnection.localDescription = gatheredOffer;
  peerConnection.iceGatheringState = "complete";
  for (const listener of gatheringListeners) listener();
  const receivedAnswer = await negotiation;

  assert.equal(request.url, "/offer?channel=7");
  assert.deepEqual(JSON.parse(request.options.body), gatheredOffer);
  assert.deepEqual(receivedAnswer, answer);
  assert.equal(gatheringListeners.size, 0);
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
