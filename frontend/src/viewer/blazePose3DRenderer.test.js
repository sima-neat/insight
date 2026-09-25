import assert from "node:assert/strict";
import test from "node:test";

import {
  BLAZEPOSE_BODY_COLORS,
  DEFAULT_BLAZEPOSE_VIEW_SETTINGS,
  blazePoseBodyRegion,
  createBlazePose3DSession,
  drawBlazePose3D,
  normalizeBlazePoseViewSettings,
  projectWorldPoint,
} from "./blazePose3DRenderer.js";

function recordingContext() {
  const calls = [];
  const context = {
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
  for (const property of ["fillStyle", "strokeStyle", "font", "textAlign", "textBaseline", "globalAlpha", "lineWidth", "lineCap"]) {
    Object.defineProperty(context, property, {
      set(value) { calls.push([property, value]); },
    });
  }
  return context;
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
  assert.equal(ctx.calls.filter(([name, , , radius]) => name === "arc" && radius === 3.1).length, 3);
});

test("low-confidence 3D joints fade instead of dropping out", () => {
  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 240, height: 180 }, {
    poses: [{
      keypoints: [
        { name: "left_shoulder", x: -0.2, y: -0.4, z: 0.1, confidence: 0 },
        { name: "left_elbow", x: -0.4, y: 0, z: 0.2, confidence: 0 },
      ],
    }],
  }, { showReferenceCube: false });

  assert.ok(ctx.calls.some(([name]) => name === "lineTo"));
  assert.ok(ctx.calls.some(([name, value]) => name === "globalAlpha" && value > 0 && value < 0.9));
});

test("BlazePose 3D renderer colors anatomical regions and labels the legend", () => {
  assert.equal(blazePoseBodyRegion("nose"), "head");
  assert.equal(blazePoseBodyRegion("left_wrist"), "left");
  assert.equal(blazePoseBodyRegion("right_ankle"), "right");
  assert.equal(blazePoseBodyRegion("unknown"), "torso");

  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 480, height: 280 }, {
    poses: [{
      keypoints: [
        { name: "nose", x: 0, y: -0.8, z: 0 },
        { name: "left_eye_inner", x: -0.03, y: -0.82, z: 0 },
        { name: "left_shoulder", x: -0.2, y: -0.4, z: 0 },
        { name: "right_shoulder", x: 0.2, y: -0.4, z: 0 },
        { name: "left_elbow", x: -0.4, y: 0, z: 0 },
        { name: "right_elbow", x: 0.4, y: 0, z: 0 },
      ],
    }],
  }, { showReferenceCube: false });

  const appliedColors = new Set(ctx.calls
    .filter(([name]) => name === "fillStyle" || name === "strokeStyle")
    .map(([, value]) => value));
  assert.deepEqual(
    new Set(Object.values(BLAZEPOSE_BODY_COLORS).filter((color) => appliedColors.has(color))),
    new Set(Object.values(BLAZEPOSE_BODY_COLORS)),
  );
  assert.deepEqual(
    ctx.calls.filter(([name, text]) => name === "fillText" && ["Head", "Torso", "Left", "Right"].includes(text)).map(([, text]) => text),
    ["Head", "Torso", "Left", "Right"],
  );
});

test("multiple poses retain distinct identity accents around anatomical colors", () => {
  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 200, height: 160 }, {
    poses: [0, 1].map((index) => ({
      id: `pose_${index + 1}`,
      keypoints: [
        { name: "left_shoulder", x: -0.4 + index * 0.6, y: -0.2, z: 0 },
        { name: "left_elbow", x: -0.5 + index * 0.6, y: 0.1, z: 0 },
      ],
    })),
  }, { showReferenceCube: false });

  const strokes = new Set(ctx.calls
    .filter(([name]) => name === "strokeStyle")
    .map(([, value]) => value));
  assert.ok(strokes.has("#f8fafc"));
  assert.ok(strokes.has("#4ade80"));
  assert.ok(strokes.has(BLAZEPOSE_BODY_COLORS.left));
});

test("metric camera framing does not move a keypoint when pose bounds change", () => {
  const compactPose = {
    poses: [{ keypoints: [{ name: "left_shoulder", x: -0.2, y: -0.4, z: 0.1 }] }],
  };
  const extendedPose = {
    poses: [{ keypoints: [
      ...compactPose.poses[0].keypoints,
      { name: "left_wrist", x: -1.1, y: 0.8, z: 0.6 },
    ] }],
  };
  const compact = recordingContext();
  const extended = recordingContext();

  drawBlazePose3D(compact, { width: 240, height: 180 }, compactPose, { showReferenceCube: false });
  drawBlazePose3D(extended, { width: 240, height: 180 }, extendedPose, { showReferenceCube: false });

  const stablePoint = compact.calls.find(([name]) => name === "arc")?.slice(1, 3);
  assert.ok(stablePoint);
  assert.ok(extended.calls
    .filter(([name]) => name === "arc")
    .some((call) => call[1] === stablePoint[0] && call[2] === stablePoint[1]));
});

test("custom reference centers use the same coordinate normalization as landmarks", () => {
  const ctx = recordingContext();
  drawBlazePose3D(ctx, { width: 200, height: 160 }, {
    view: { center: { x: 0, y: 1, z: 0 }, half_extent: 0.5 },
    poses: [{ keypoints: [{ name: "nose", x: 0, y: 1, z: 0 }] }],
  }, { showReferenceCube: false, camera: { yaw: 0, pitch: 0 } });

  const landmark = ctx.calls.find(([name, , , radius]) => name === "arc" && radius === 3.1);
  assert.ok(landmark);
  assert.equal(landmark[1], 100);
  assert.equal(landmark[2], 80);
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
  assert.equal("autoRotate" in normalized, false);
  assert.equal("rotationSpeed" in normalized, false);
  assert.equal("paused" in normalized, false);
  assert.equal("stabilizePose" in normalized, false);
  assert.equal(normalized.yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.ok(normalized.pitch < Math.PI / 2);
});

test("the 3D session does not animate independently from pose frames", () => {
  const session = createBlazePose3DSession();
  const payload = { poses: [{ keypoints: [{ name: "nose", x: 0, y: 0, z: 0 }] }] };
  const initialYaw = session.snapshot().yaw;

  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 0 });
  session.draw(recordingContext(), { width: 120, height: 90 }, payload, { animationTimeMs: 100 });
  assert.equal(session.snapshot().yaw, initialYaw);
  assert.equal(session.isAnimating(), false);
  assert.deepEqual(session.getControls().map(({ id }) => id), ["showReferenceCube", "resetCamera"]);
});

test("viewer configuration can update a live renderer session", () => {
  let drawRequests = 0;
  const session = createBlazePose3DSession({
    requestDraw() { drawRequests += 1; },
  });

  session.applySettings({
    showReferenceCube: false,
    yaw: Math.PI / 2,
    pitch: 0,
  });

  assert.equal(session.snapshot().showReferenceCube, false);
  assert.equal(session.snapshot().yaw, Math.PI / 2);
  assert.equal(session.snapshot().pitch, 0);
  assert.equal(session.getControls().find(({ id }) => id === "showReferenceCube").value, false);
  assert.equal(drawRequests, 1);
});

test("manual drag persists a fixed camera angle and reset restores the default", () => {
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
  assert.notEqual(session.snapshot().yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.equal(saved.length, 1);
  assert.ok(drawRequests >= 3);

  session.applyControl("resetCamera");
  assert.equal(session.snapshot().yaw, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.yaw);
  assert.equal(session.snapshot().pitch, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.pitch);
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
