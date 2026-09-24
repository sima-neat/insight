import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BLAZEPOSE_VIEW_SETTINGS,
  createBlazePose3DSession,
  createBlazePosePoseSmoother,
  drawBlazePose3D,
  normalizeBlazePoseViewSettings,
  projectWorldPoint,
} from "./blazePose3DRenderer.js";

function recordingContext() {
  const calls = [];
  return {
    calls,
    beginPath() { calls.push(["beginPath"]); },
    moveTo(x, y) { calls.push(["moveTo", x, y]); },
    lineTo(x, y) { calls.push(["lineTo", x, y]); },
    closePath() { calls.push(["closePath"]); },
    stroke() { calls.push(["stroke"]); },
    arc(x, y, radius) { calls.push(["arc", x, y, radius]); },
    fill() { calls.push(["fill"]); },
    fillText(text) { calls.push(["fillText", text]); },
  };
}

test("the native projection preserves depth as a visible screen displacement", () => {
  const near = projectWorldPoint({ x: 0, y: 0, z: 0 });
  const deep = projectWorldPoint({ x: 0, y: 0, z: 1 });

  assert.ok(near);
  assert.ok(deep);
  assert.notEqual(near.x, deep.x);
  assert.notEqual(near.y, deep.y);
});

test("BlazePose 3D renderer draws connected world keypoints", () => {
  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 240, height: 180 }, {
    poses: [{
      id: "pose_1",
      keypoints: [
        { name: "left_shoulder", x: -0.2, y: -0.4, z: 0.1, confidence: 0.9 },
        { name: "left_elbow", x: -0.4, y: 0, z: 0.2, confidence: 0.8 },
        { name: "left_wrist", x: -0.5, y: 0.4, z: 0.3, confidence: 0.95 },
      ],
    }],
  });

  assert.ok(ctx.calls.some(([name]) => name === "lineTo"));
  assert.equal(ctx.calls.filter(([name]) => name === "arc").length, 3);
});

test("BlazePose 3D renderer draws an optional labeled reference cube", () => {
  const payload = {
    poses: [{
      keypoints: [
        { name: "left_shoulder", x: -0.2, y: -0.4, z: 0.1 },
        { name: "left_elbow", x: -0.4, y: 0, z: 0.2 },
      ],
    }],
  };
  const withCube = recordingContext();
  const withoutCube = recordingContext();

  drawBlazePose3D(withCube, { width: 240, height: 180 }, payload);
  drawBlazePose3D(withoutCube, { width: 240, height: 180 }, payload, { showReferenceCube: false });

  assert.deepEqual(
    withCube.calls.filter(([name, text]) => name === "fillText" && ["X", "Y", "Z"].includes(text)).map((call) => call[1]),
    ["X", "Y", "Z"],
  );
  assert.equal(withCube.calls.filter(([name]) => name === "closePath").length, 6);
  assert.equal(withoutCube.calls.filter(([name]) => name === "closePath").length, 0);
});

test("empty or invalid BlazePose payloads render a stable empty state", () => {
  for (const payload of [{}, { poses: [] }, { poses: [{ keypoints: [{ name: "nose", x: "bad" }] }] }]) {
    const ctx = recordingContext();
    assert.doesNotThrow(() => drawBlazePose3D(ctx, { width: 120, height: 90 }, payload));
    assert.ok(ctx.calls.some(([name, text]) => name === "fillText" && /No 3D pose/.test(text)));
  }
});

test("malformed pose data does not keep a renderer animation loop alive", () => {
  const session = createBlazePose3DSession();
  session.draw(recordingContext(), { width: 120, height: 90 }, { poses: [{ keypoints: [] }] }, {
    animationTimeMs: 0,
  });

  assert.equal(session.isAnimating(), false);
});

test("saved view settings normalize malformed and out-of-range values", () => {
  assert.deepEqual(normalizeBlazePoseViewSettings(null), DEFAULT_BLAZEPOSE_VIEW_SETTINGS);
  const normalized = normalizeBlazePoseViewSettings({
    showReferenceCube: "yes",
    autoRotate: false,
    rotationSpeed: 1000,
    paused: true,
    stabilizePose: false,
    yaw: "bad",
    pitch: 100,
  });

  assert.equal(normalized.showReferenceCube, true);
  assert.equal(normalized.autoRotate, false);
  assert.equal(normalized.rotationSpeed, 90);
  assert.equal(normalized.paused, true);
  assert.equal(normalized.stabilizePose, false);
  assert.equal(normalized.yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.ok(normalized.pitch < Math.PI / 2);
});

test("session orbit timing honors speed, pause, and the auto-orbit toggle", () => {
  const session = createBlazePose3DSession({
    initialSettings: { autoRotate: true, rotationSpeed: 30 },
  });
  const payload = { poses: [{ keypoints: [{ name: "nose", x: 0, y: 0, z: 0 }] }] };
  const initialYaw = session.snapshot().yaw;

  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 0 });
  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 100 });
  assert.ok(Math.abs(session.snapshot().yaw - initialYaw - Math.PI / 60) < 1e-9);
  assert.equal(session.isAnimating(), true);

  session.applyControl("paused");
  const pausedYaw = session.snapshot().yaw;
  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 300 });
  assert.equal(session.snapshot().yaw, pausedYaw);
  assert.equal(session.isAnimating(), false);
  assert.equal(session.getControls().find(({ id }) => id === "paused").label, "Resume");

  session.applyControl("paused");
  session.applyControl("autoRotate", false);
  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 500 });
  assert.equal(session.snapshot().yaw, pausedYaw);
  assert.equal(session.isAnimating(), false);
});

test("viewer configuration can update a live renderer session", () => {
  let drawRequests = 0;
  const session = createBlazePose3DSession({
    initialSettings: { autoRotate: false },
    requestDraw() { drawRequests += 1; },
  });

  session.applySettings({
    showReferenceCube: false,
    yaw: Math.PI / 2,
    pitch: 0,
    stabilizePose: false,
  });

  assert.equal(session.snapshot().showReferenceCube, false);
  assert.equal(session.snapshot().yaw, Math.PI / 2);
  assert.equal(session.snapshot().pitch, 0);
  assert.equal(session.snapshot().stabilizePose, false);
  assert.equal(session.getControls().find(({ id }) => id === "showReferenceCube").value, false);
  assert.equal(drawRequests, 1);
});

test("adaptive stabilization reduces stationary world-landmark jitter", () => {
  const smoother = createBlazePosePoseSmoother();
  const raw = [];
  const filtered = [];
  for (let frame = 0; frame < 60; frame += 1) {
    const x = frame % 2 === 0 ? -0.02 : 0.02;
    raw.push(x);
    const result = smoother.filter({
      poses: [{ id: "pose_1", keypoints: [{ name: "nose", x, y: 0, z: 0 }] }],
    }, frame * 3600);
    filtered.push(result.poses[0].keypoints[0].x);
  }
  const meanStep = (values) => values.slice(1)
    .reduce((total, value, index) => total + Math.abs(value - values[index]), 0) / (values.length - 1);

  assert.ok(meanStep(filtered) < meanStep(raw) * 0.4);
});

test("adaptive stabilization follows a fast pose change without multi-frame lag", () => {
  const smoother = createBlazePosePoseSmoother();
  const payload = (x) => ({
    poses: [{ id: "pose_1", keypoints: [{ name: "nose", x, y: 0, z: 0 }] }],
  });
  smoother.filter(payload(0), 0);
  const firstMovingFrame = smoother.filter(payload(1), 3600).poses[0].keypoints[0].x;
  const secondMovingFrame = smoother.filter(payload(1), 7200).poses[0].keypoints[0].x;

  assert.ok(firstMovingFrame > 0.6);
  assert.ok(secondMovingFrame > 0.85);
});

test("manual drag pauses orbit, persists the angle on release, and reset restores the camera", () => {
  const saved = [];
  let drawRequests = 0;
  const session = createBlazePose3DSession({
    onSettingsChange(settings) { saved.push(settings); },
    requestDraw() { drawRequests += 1; },
  });

  assert.equal(session.pointerDown({ x: 10, y: 20, pointerId: 7 }), true);
  assert.equal(session.pointerMove({ x: 30, y: 5, pointerId: 7 }), true);
  assert.equal(session.pointerMove({ x: 40, y: 5, pointerId: 8 }), false);
  assert.equal(session.pointerUp({ pointerId: 7 }), true);
  assert.equal(session.snapshot().paused, true);
  assert.notEqual(session.snapshot().yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.equal(saved.length, 1);
  assert.ok(drawRequests >= 3);

  session.applyControl("resetCamera");
  assert.equal(session.snapshot().yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.equal(session.snapshot().pitch, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.pitch);
  assert.equal(session.snapshot().paused, false);
});

test("destroyed renderer sessions stop animation and ignore later interaction", () => {
  const session = createBlazePose3DSession();
  session.destroy();

  assert.equal(session.isAnimating(), false);
  assert.equal(session.pointerDown({ x: 1, y: 1, pointerId: 1 }), false);
  const ctx = recordingContext();
  session.draw(ctx, { width: 120, height: 90 }, { poses: [] }, { animationTimeMs: 0 });
  assert.deepEqual(ctx.calls, []);
});
