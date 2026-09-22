import assert from "node:assert/strict";
import test from "node:test";

import {
  closeAllWebcamSessions,
  sessionIdFromDeleteUrl,
  pinH264,
  createDisconnectWatcher,
  closeWebcamSession,
  confirmWebcamPublishing,
  describeWebcamError,
  publishWebcamOffer,
  resolveDeleteUrl,
  selectH264Codecs,
} from "./webcamPublishing.js";

function fakePeerConnection(overrides = {}) {
  return {
    iceGatheringState: "new",
    localDescription: null,
    async createOffer() {
      return { type: "offer", sdp: "v=0\r\n" };
    },
    async setLocalDescription(offer) {
      this.localDescription = offer;
      this.iceGatheringState = "gathering";
    },
    addEventListener() {
      throw new Error("must not wait for gathering; it blocks on the STUN server");
    },
    ...overrides,
  };
}

function response({ ok = true, status = 201, body = "v=0\r\n", location = null } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => (name === "Location" ? location : null) },
    async text() {
      return body;
    },
  };
}

test("the webcam offer is posted without waiting for candidate gathering", async () => {
  const peerConnection = fakePeerConnection();
  let request;

  const { answerSdp } = await publishWebcamOffer(
    peerConnection,
    "https://insight.local:8889/src1/whip",
    async (url, options) => {
      request = { url, options };
      return response({ body: "v=0\r\nanswer" });
    },
  );

  assert.equal(request.url, "https://insight.local:8889/src1/whip");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/sdp");
  assert.equal(request.options.body, "v=0\r\n");
  assert.equal(peerConnection.iceGatheringState, "gathering", "posted before gathering finished");
  assert.equal(answerSdp, "v=0\r\nanswer");
});

test("a rejected publish reports the HTTP status", async () => {
  await assert.rejects(
    publishWebcamOffer(fakePeerConnection(), "https://insight.local:8889/src1/whip", async () =>
      response({ ok: false, status: 400 }),
    ),
    (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("the session delete URL is resolved against the publish URL", async () => {
  const { deleteUrl } = await publishWebcamOffer(
    fakePeerConnection(),
    "https://insight.local:8889/src1/whip",
    async () => response({ location: "/src1/whip/session/abc123" }),
  );

  assert.equal(deleteUrl, "https://insight.local:8889/src1/whip/session/abc123");
});

test("a missing Location does not fail the publish", async () => {
  const { deleteUrl, answerSdp } = await publishWebcamOffer(
    fakePeerConnection(),
    "https://insight.local:8889/src1/whip",
    async () => response({ location: null, body: "v=0\r\nanswer" }),
  );

  assert.equal(deleteUrl, null);
  assert.equal(answerSdp, "v=0\r\nanswer", "the publish itself still succeeded");
});

test("an unresolvable Location yields no delete URL rather than throwing", () => {
  // A relative Location resolves against any valid base, so the only way to
  // reach the null path is a base URL that is not itself absolute.
  assert.equal(resolveDeleteUrl("/session/abc", "not-a-valid-base"), null);
  assert.equal(resolveDeleteUrl("", "https://insight.local:8889/src1/whip"), null);
});

test("resolveDeleteUrl keeps an absolute Location as given", () => {
  assert.equal(
    resolveDeleteUrl("https://other.host:8889/x/y", "https://insight.local:8889/src1/whip"),
    "https://other.host:8889/x/y",
  );
});

test("only H.264 codecs are selected for the transceiver", () => {
  const capabilities = {
    codecs: [
      { mimeType: "video/VP8" },
      { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
      { mimeType: "video/h264", sdpFmtpLine: "profile-level-id=640c1f" },
      { mimeType: "video/H265" },
      { mimeType: "video/H264X" },
    ],
  };

  const selected = selectH264Codecs(capabilities);

  assert.deepEqual(
    selected.map((codec) => codec.mimeType),
    ["video/H264", "video/h264"],
  );
});

test("selectH264Codecs tolerates a browser without getCapabilities", () => {
  assert.deepEqual(selectH264Codecs(undefined), []);
  assert.deepEqual(selectH264Codecs({}), []);
});

test("publishing is confirmed as soon as MediaMTX reports the path", async () => {
  let calls = 0;
  const slept = [];

  const result = await confirmWebcamPublishing(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("Webcam is not publishing yet");
      return "started";
    },
    { intervalMs: 250, sleep: async (ms) => slept.push(ms), now: () => 0 },
  );

  assert.equal(result, "started");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [250, 250], "waited between attempts, not before the first");
});

test("a webcam that never publishes reports the real error, not a timeout string", async () => {
  let clock = 0;

  await assert.rejects(
    confirmWebcamPublishing(
      async () => {
        throw new Error("Webcam is not publishing yet");
      },
      {
        timeoutMs: 1000,
        intervalMs: 250,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
    (error) => {
      assert.equal(error.message, "Webcam is not publishing yet");
      return true;
    },
  );
});

test("confirmation stops at the deadline instead of retrying forever", async () => {
  let clock = 0;
  let calls = 0;

  await assert.rejects(
    confirmWebcamPublishing(
      async () => {
        calls += 1;
        throw new Error("nope");
      },
      {
        timeoutMs: 1000,
        intervalMs: 250,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
    /nope/,
  );

  // 5 attempts at t=0,250,500,750,1000; the one at the deadline is the last.
  assert.equal(calls, 5);
});

test("a first-attempt success never sleeps", async () => {
  let slept = false;

  const result = await confirmWebcamPublishing(async () => "started", {
    sleep: async () => {
      slept = true;
    },
    now: () => 0,
  });

  assert.equal(result, "started");
  assert.equal(slept, false);
});

test("webcam failures are described in terms the user can act on", () => {
  assert.match(describeWebcamError({ name: "NotAllowedError" }), /permission was denied/);
  assert.match(describeWebcamError({ name: "SecurityError" }), /permission was denied/);
  assert.match(describeWebcamError({ name: "NotFoundError" }), /no longer available/);
  assert.match(describeWebcamError({ name: "OverconstrainedError" }), /no longer available/);
  assert.match(describeWebcamError({ name: "NotReadableError" }), /in use by another application/);
});

test("an unrecognized failure keeps its own message", () => {
  assert.equal(
    describeWebcamError(new Error("Webcam publish was rejected (HTTP 500).")),
    "Webcam publish was rejected (HTTP 500).",
  );
  assert.equal(describeWebcamError(undefined), "Webcam publishing failed.");
});

function fakeSession({ deleteUrl = null } = {}) {
  const stopped = [];
  return {
    stopped,
    closed: { pc: false },
    deleteUrl,
    stream: { getTracks: () => [{ stop: () => stopped.push("a") }, { stop: () => stopped.push("b") }] },
    pc: { close() { this._closed = true; } },
  };
}

test("closing a session stops the camera and closes the peer connection", () => {
  const s = fakeSession();
  assert.equal(closeWebcamSession(s, async () => ({})), true);
  assert.deepEqual(s.stopped, ["a", "b"], "every track released, so the OS frees the camera");
  assert.equal(s.pc._closed, true);
});

test("closing a session tells MediaMTX to drop the path", () => {
  const calls = [];
  const s = fakeSession({ deleteUrl: "https://insight.local:8889/src1/whip/session/a" });

  closeWebcamSession(s, async (url, opts) => { calls.push([url, opts.method]); return {}; });

  assert.deepEqual(calls, [["https://insight.local:8889/src1/whip/session/a", "DELETE"]]);
});

test("a failing DELETE does not break teardown", () => {
  const s = fakeSession({ deleteUrl: "https://insight.local:8889/x" });
  assert.doesNotThrow(() => closeWebcamSession(s, () => { throw new Error("offline"); }));
  assert.equal(s.pc._closed, true, "the peer connection still closed, which is what ends the media");
});

test("closing nothing is harmless", () => {
  assert.equal(closeWebcamSession(null, async () => ({})), false);
  assert.deepEqual(closeAllWebcamSessions(null, async () => ({})), []);
});

test("a bulk action releases every camera and empties the registry", () => {
  // Stop All / Reset / Auto Assign: Insight cannot end these publishes itself,
  // so anything left here keeps streaming while the UI says stopped.
  const sessions = new Map([[1, fakeSession()], [3, fakeSession()], [7, fakeSession()]]);
  const all = Array.from(sessions.values());

  const closed = closeAllWebcamSessions(sessions, async () => ({}));

  assert.deepEqual(closed, [1, 3, 7]);
  assert.equal(sessions.size, 0, "registry emptied, so nothing is left publishing");
  for (const s of all) {
    assert.deepEqual(s.stopped, ["a", "b"]);
    assert.equal(s.pc._closed, true);
  }
});

function watcherHarness(opts = {}) {
  const lost = [];
  let seq = 0;
  const timers = new Map();
  const w = createDisconnectWatcher({
    onLost: (reason) => lost.push(reason),
    graceMs: 10000,
    setTimer: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    ...opts,
  });
  return { w, lost, timers, fire: () => { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}

test("a brief disconnect that recovers does not stop the source", () => {
  const { w, lost, timers } = watcherHarness();

  w.update("disconnected");
  assert.equal(timers.size, 1, "a grace period is pending, not an immediate teardown");
  assert.deepEqual(lost, []);

  w.update("connected");
  assert.equal(timers.size, 0, "grace period cancelled on recovery");
  assert.deepEqual(lost, [], "the source survived the blip");
});

test("a disconnect that never recovers ends the session", () => {
  const { w, lost, fire } = watcherHarness();

  w.update("disconnected");
  fire();

  assert.deepEqual(lost, ["disconnected"]);
});

test("failed and closed are acted on immediately", () => {
  for (const state of ["failed", "closed"]) {
    const { w, lost, timers } = watcherHarness();
    w.update(state);
    assert.deepEqual(lost, [state]);
    assert.equal(timers.size, 0, "no point waiting out a terminal state");
  }
});

test("repeated disconnect events do not stack grace periods", () => {
  const { w, timers } = watcherHarness();

  w.update("disconnected");
  w.update("disconnected");
  w.update("disconnected");

  assert.equal(timers.size, 1);
});

test("a disconnect followed by failure ends it at once", () => {
  const { w, lost, timers } = watcherHarness();

  w.update("disconnected");
  w.update("failed");

  assert.deepEqual(lost, ["failed"]);
  assert.equal(timers.size, 0, "the pending grace period was cancelled");
});

test("cancelling the watcher drops a pending grace period", () => {
  const { w, lost, timers, fire } = watcherHarness();

  w.update("disconnected");
  w.cancel();
  fire();

  assert.equal(timers.size, 0);
  assert.deepEqual(lost, [], "a teardown already under way must not fire it again");
});

test("H.264 is pinned on the transceiver when the browser offers it", () => {
  let pinned = null;
  const transceiver = { setCodecPreferences: (c) => { pinned = c; } };
  const caps = { codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }] };

  const chosen = pinH264(transceiver, caps);

  assert.deepEqual(pinned.map((c) => c.mimeType), ["video/H264"]);
  assert.deepEqual(chosen.map((c) => c.mimeType), ["video/H264"]);
});

test("a browser with no H.264 is rejected rather than publishing VP8 as H.264", () => {
  const transceiver = { setCodecPreferences: () => {} };

  assert.throws(
    () => pinH264(transceiver, { codecs: [{ mimeType: "video/VP8" }] }),
    /cannot publish H\.264/,
  );
});

test("a browser without setCodecPreferences is rejected", () => {
  const caps = { codecs: [{ mimeType: "video/H264" }] };

  assert.throws(() => pinH264(undefined, caps), /cannot choose a video codec/);
  assert.throws(() => pinH264({}, caps), /cannot choose a video codec/);
});

test("a terminal failure stops the retry loop immediately", () => {
  // A slot reassigned mid-start will never become what we are waiting for.
  let calls = 0;
  const slept = [];
  const superseded = { superseded: true };

  return assert.rejects(
    confirmWebcamPublishing(
      async () => { calls += 1; throw superseded; },
      {
        isTerminal: (e) => Boolean(e?.superseded),
        sleep: async (ms) => slept.push(ms),
        now: () => 0,
      },
    ),
    (e) => e === superseded,
  ).then(() => {
    assert.equal(calls, 1, "no retry after a terminal failure");
    assert.deepEqual(slept, [], "and no waiting either");
  });
});

test("an ordinary failure still retries to the deadline", async () => {
  let clock = 0;
  let calls = 0;

  await assert.rejects(
    confirmWebcamPublishing(
      async () => { calls += 1; throw new Error("not publishing yet"); },
      {
        isTerminal: (e) => Boolean(e?.superseded),
        timeoutMs: 500,
        intervalMs: 250,
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
      },
    ),
    /not publishing yet/,
  );

  assert.equal(calls, 3, "retried as before");
});

test("the session id is the last segment of the WHIP resource", () => {
  assert.equal(
    sessionIdFromDeleteUrl("https://insight.local:8889/src1/whip/b5840975-9d5b-4948-bcab-070af869bb50"),
    "b5840975-9d5b-4948-bcab-070af869bb50",
  );
  assert.equal(sessionIdFromDeleteUrl("https://insight.local:8889/src1/whip/abc/"), "abc");
});

test("no session id without a delete url", () => {
  assert.equal(sessionIdFromDeleteUrl(null), null);
  assert.equal(sessionIdFromDeleteUrl(""), null);
  assert.equal(sessionIdFromDeleteUrl("not a url"), null);
});

test("publishing returns the session id alongside the delete url", async () => {
  const { deleteUrl, sessionId } = await publishWebcamOffer(
    fakePeerConnection(),
    "https://insight.local:8889/src1/whip",
    async () => response({ location: "/src1/whip/session-9" }),
  );

  assert.equal(deleteUrl, "https://insight.local:8889/src1/whip/session-9");
  assert.equal(sessionId, "session-9");
});
