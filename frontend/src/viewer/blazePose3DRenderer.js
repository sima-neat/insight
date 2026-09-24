import { auxiliaryRendererRegistry } from "./auxiliaryVisualization.js";

export const BLAZEPOSE_CONNECTIONS = [
  ["nose", "left_eye_inner"], ["left_eye_inner", "left_eye"], ["left_eye", "left_eye_outer"],
  ["left_eye_outer", "left_ear"], ["nose", "right_eye_inner"], ["right_eye_inner", "right_eye"],
  ["right_eye", "right_eye_outer"], ["right_eye_outer", "right_ear"], ["mouth_left", "mouth_right"],
  ["left_shoulder", "right_shoulder"], ["left_shoulder", "left_elbow"], ["left_elbow", "left_wrist"],
  ["left_wrist", "left_pinky"], ["left_wrist", "left_index"], ["left_wrist", "left_thumb"],
  ["left_pinky", "left_index"], ["right_shoulder", "right_elbow"], ["right_elbow", "right_wrist"],
  ["right_wrist", "right_pinky"], ["right_wrist", "right_index"], ["right_wrist", "right_thumb"],
  ["right_pinky", "right_index"], ["left_shoulder", "left_hip"], ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"], ["left_hip", "left_knee"], ["left_knee", "left_ankle"],
  ["left_ankle", "left_heel"], ["left_heel", "left_foot_index"], ["left_ankle", "left_foot_index"],
  ["right_hip", "right_knee"], ["right_knee", "right_ankle"], ["right_ankle", "right_heel"],
  ["right_heel", "right_foot_index"], ["right_ankle", "right_foot_index"],
];

const POSE_COLORS = ["#38bdf8", "#fb7185", "#4ade80", "#facc15", "#c084fc", "#fb923c"];
const MIN_CONFIDENCE = 0.3;
const DEFAULT_YAW = -Math.PI / 4;
const DEFAULT_PITCH = Math.PI / 9;
const MIN_PITCH = -Math.PI * 0.48;
const MAX_PITCH = Math.PI * 0.48;
const MIN_ORBIT_SPEED = 5;
const MAX_ORBIT_SPEED = 90;
const CUBE_MIN_EXTENT = 0.5;
const RTP_CLOCK_RATE = 90000;
const DEFAULT_FRAME_INTERVAL_SECONDS = 1 / 30;
const MAX_SMOOTHING_GAP_SECONDS = 0.25;
const SMOOTHING_MIN_CUTOFF = 2.5;
const SMOOTHING_BETA = 1;
const SMOOTHING_DERIVATIVE_CUTOFF = 1;

const CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const CUBE_FACES = [
  [0, 1, 2, 3], [4, 5, 6, 7],
  [0, 1, 5, 4], [2, 3, 7, 6],
  [1, 2, 6, 5], [3, 0, 4, 7],
];

export const DEFAULT_BLAZEPOSE_VIEW_SETTINGS = Object.freeze({
  showReferenceCube: true,
  autoRotate: true,
  rotationSpeed: 25,
  paused: false,
  stabilizePose: true,
  yaw: DEFAULT_YAW,
  pitch: DEFAULT_PITCH,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeBlazePoseViewSettings(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    showReferenceCube:
      typeof candidate.showReferenceCube === "boolean"
        ? candidate.showReferenceCube
        : DEFAULT_BLAZEPOSE_VIEW_SETTINGS.showReferenceCube,
    autoRotate:
      typeof candidate.autoRotate === "boolean"
        ? candidate.autoRotate
        : DEFAULT_BLAZEPOSE_VIEW_SETTINGS.autoRotate,
    rotationSpeed: clamp(
      finiteOr(candidate.rotationSpeed, DEFAULT_BLAZEPOSE_VIEW_SETTINGS.rotationSpeed),
      MIN_ORBIT_SPEED,
      MAX_ORBIT_SPEED,
    ),
    paused:
      typeof candidate.paused === "boolean"
        ? candidate.paused
        : DEFAULT_BLAZEPOSE_VIEW_SETTINGS.paused,
    stabilizePose:
      typeof candidate.stabilizePose === "boolean"
        ? candidate.stabilizePose
        : DEFAULT_BLAZEPOSE_VIEW_SETTINGS.stabilizePose,
    yaw: finiteOr(candidate.yaw, DEFAULT_YAW),
    pitch: clamp(finiteOr(candidate.pitch, DEFAULT_PITCH), MIN_PITCH, MAX_PITCH),
  };
}

function normalizeWorldPoint(point) {
  const x = Number(point?.x);
  const y = -Number(point?.y);
  const z = Number(point?.z);
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

function lowPassAlpha(cutoff, intervalSeconds) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / intervalSeconds);
}

function filterAxis(state, value, intervalSeconds) {
  if (!state) return { raw: value, filtered: value, derivative: 0 };
  const rawDerivative = (value - state.raw) / intervalSeconds;
  const derivativeAlpha = lowPassAlpha(SMOOTHING_DERIVATIVE_CUTOFF, intervalSeconds);
  const derivative = derivativeAlpha * rawDerivative + (1 - derivativeAlpha) * state.derivative;
  const cutoff = SMOOTHING_MIN_CUTOFF + SMOOTHING_BETA * Math.abs(derivative);
  const valueAlpha = lowPassAlpha(cutoff, intervalSeconds);
  return {
    raw: value,
    filtered: valueAlpha * value + (1 - valueAlpha) * state.filtered,
    derivative,
  };
}

function rtpIntervalSeconds(current, previous) {
  if (!Number.isInteger(current) || !Number.isInteger(previous)) return DEFAULT_FRAME_INTERVAL_SECONDS;
  const delta = ((current >>> 0) - (previous >>> 0)) >>> 0;
  if (delta === 0 || delta > 0x7fffffff) return DEFAULT_FRAME_INTERVAL_SECONDS;
  return delta / RTP_CLOCK_RATE;
}

export function createBlazePosePoseSmoother() {
  let states = new Map();
  let previousRtpTimestamp = null;
  let previousInput = null;
  let previousOutput = null;

  const reset = () => {
    states = new Map();
    previousRtpTimestamp = null;
    previousInput = null;
    previousOutput = null;
  };

  const filter = (payload, rtpTimestamp) => {
    if (payload === previousInput && previousOutput) return previousOutput;
    if (!Array.isArray(payload?.poses) || payload.poses.length === 0) {
      previousInput = payload;
      previousOutput = payload;
      previousRtpTimestamp = rtpTimestamp;
      return payload;
    }

    let intervalSeconds = rtpIntervalSeconds(rtpTimestamp, previousRtpTimestamp);
    if (intervalSeconds > MAX_SMOOTHING_GAP_SECONDS) {
      states = new Map();
      intervalSeconds = DEFAULT_FRAME_INTERVAL_SECONDS;
    }
    intervalSeconds = clamp(intervalSeconds, 1 / 240, MAX_SMOOTHING_GAP_SECONDS);
    const activePoseIds = new Set();
    const poses = payload.poses.map((pose, poseIndex) => {
      const poseId = String(pose?.id ?? `pose_${poseIndex + 1}`);
      activePoseIds.add(poseId);
      const pointStates = states.get(poseId) ?? new Map();
      const activePointNames = new Set();
      const keypoints = Array.isArray(pose?.keypoints) ? pose.keypoints.map((point) => {
        const name = typeof point?.name === "string" ? point.name : null;
        const x = Number(point?.x);
        const y = Number(point?.y);
        const z = Number(point?.z);
        if (!name || ![x, y, z].every(Number.isFinite)) return point;
        activePointNames.add(name);
        const previous = pointStates.get(name);
        const next = {
          x: filterAxis(previous?.x, x, intervalSeconds),
          y: filterAxis(previous?.y, y, intervalSeconds),
          z: filterAxis(previous?.z, z, intervalSeconds),
        };
        pointStates.set(name, next);
        return { ...point, x: next.x.filtered, y: next.y.filtered, z: next.z.filtered };
      }) : pose?.keypoints;
      for (const name of pointStates.keys()) {
        if (!activePointNames.has(name)) pointStates.delete(name);
      }
      states.set(poseId, pointStates);
      return { ...pose, keypoints };
    });
    for (const poseId of states.keys()) {
      if (!activePoseIds.has(poseId)) states.delete(poseId);
    }

    previousInput = payload;
    previousOutput = { ...payload, poses };
    previousRtpTimestamp = rtpTimestamp;
    return previousOutput;
  };

  return { filter, reset };
}

function projectNormalizedPoint(world, camera) {
  const yawX = Math.cos(camera.yaw) * world.x + Math.sin(camera.yaw) * world.z;
  const yawZ = -Math.sin(camera.yaw) * world.x + Math.cos(camera.yaw) * world.z;
  return {
    x: yawX,
    y: Math.cos(camera.pitch) * world.y - Math.sin(camera.pitch) * yawZ,
    depth: Math.sin(camera.pitch) * world.y + Math.cos(camera.pitch) * yawZ,
  };
}

export function projectWorldPoint(point, camera = DEFAULT_BLAZEPOSE_VIEW_SETTINGS) {
  const world = normalizeWorldPoint(point);
  return world ? projectNormalizedPoint(world, normalizeBlazePoseViewSettings(camera)) : null;
}

function normalizedPoses(payload) {
  if (!Array.isArray(payload?.poses)) return [];
  return payload.poses.map((pose, poseIndex) => {
    const points = new Map();
    if (Array.isArray(pose?.keypoints)) {
      for (const point of pose.keypoints) {
        if (typeof point?.name !== "string" || (point.confidence ?? 1) < MIN_CONFIDENCE) continue;
        const normalized = normalizeWorldPoint(point);
        if (normalized) points.set(point.name, normalized);
      }
    }
    return {
      id: pose?.id ?? `pose_${poseIndex + 1}`,
      points,
      color: POSE_COLORS[poseIndex % POSE_COLORS.length],
    };
  }).filter((pose) => pose.points.size > 0);
}

function poseBounds(poses) {
  const points = poses.flatMap((pose) => [...pose.points.values()]);
  const axis = (name) => points.map((point) => point[name]);
  const minX = Math.min(...axis("x"));
  const maxX = Math.max(...axis("x"));
  const minY = Math.min(...axis("y"));
  const maxY = Math.max(...axis("y"));
  const minZ = Math.min(...axis("z"));
  const maxZ = Math.max(...axis("z"));
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function referenceCube(bounds) {
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
  const extent = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
    CUBE_MIN_EXTENT,
  ) * 0.68;
  return [
    { x: center.x - extent, y: center.y - extent, z: center.z - extent },
    { x: center.x + extent, y: center.y - extent, z: center.z - extent },
    { x: center.x + extent, y: center.y + extent, z: center.z - extent },
    { x: center.x - extent, y: center.y + extent, z: center.z - extent },
    { x: center.x - extent, y: center.y - extent, z: center.z + extent },
    { x: center.x + extent, y: center.y - extent, z: center.z + extent },
    { x: center.x + extent, y: center.y + extent, z: center.z + extent },
    { x: center.x - extent, y: center.y + extent, z: center.z + extent },
  ];
}

function fitProjection(points, width, height) {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const rangeX = Math.max(maxX - minX, 0.25);
  const rangeY = Math.max(maxY - minY, 0.25);
  const scale = Math.min((width * 0.78) / rangeX, (height * 0.78) / rangeY);
  return {
    point(point) {
      return {
        x: width / 2 + (point.x - (minX + maxX) / 2) * scale,
        y: height / 2 - (point.y - (minY + maxY) / 2) * scale,
        depth: point.depth,
      };
    },
  };
}

function drawEmpty(ctx, width, height) {
  ctx.fillStyle = "rgba(226, 232, 240, 0.72)";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("No 3D pose for this frame", width / 2, height / 2);
}

function drawReferenceCube(ctx, vertices) {
  const faces = CUBE_FACES.map((indices) => ({
    indices,
    depth: indices.reduce((total, index) => total + vertices[index].depth, 0) / indices.length,
  })).sort((left, right) => left.depth - right.depth);

  for (const face of faces) {
    ctx.beginPath();
    face.indices.forEach((index, position) => {
      const vertex = vertices[index];
      if (position === 0) ctx.moveTo(vertex.x, vertex.y);
      else ctx.lineTo(vertex.x, vertex.y);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(56, 189, 248, 0.035)";
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(148, 163, 184, 0.58)";
  ctx.lineWidth = 1;
  for (const [fromIndex, toIndex] of CUBE_EDGES) {
    ctx.beginPath();
    ctx.moveTo(vertices[fromIndex].x, vertices[fromIndex].y);
    ctx.lineTo(vertices[toIndex].x, vertices[toIndex].y);
    ctx.stroke();
  }

  const labels = [[1, "X"], [3, "Y"], [4, "Z"]];
  ctx.fillStyle = "rgba(226, 232, 240, 0.78)";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [index, label] of labels) {
    ctx.fillText(label, vertices[index].x, vertices[index].y);
  }
}

export function drawBlazePose3D(ctx, viewport, payload, frame = {}) {
  const width = viewport?.width ?? 0;
  const height = viewport?.height ?? 0;
  if (width <= 0 || height <= 0) return false;

  const poses = normalizedPoses(payload);
  if (poses.length === 0) {
    drawEmpty(ctx, width, height);
    return false;
  }

  const camera = normalizeBlazePoseViewSettings(frame.camera);
  const cube = frame.showReferenceCube === false ? [] : referenceCube(poseBounds(poses));
  const projectedPosePoints = poses.flatMap((pose) =>
    [...pose.points.values()].map((point) => projectNormalizedPoint(point, camera)),
  );
  const projectedCube = cube.map((point) => projectNormalizedPoint(point, camera));
  const projection = fitProjection([...projectedPosePoints, ...projectedCube], width, height);

  if (projectedCube.length > 0) {
    drawReferenceCube(ctx, projectedCube.map((point) => projection.point(point)));
  }

  const segments = [];
  for (const pose of poses) {
    for (const [fromName, toName] of BLAZEPOSE_CONNECTIONS) {
      const from = pose.points.get(fromName);
      const to = pose.points.get(toName);
      if (!from || !to) continue;
      const projectedFrom = projectNormalizedPoint(from, camera);
      const projectedTo = projectNormalizedPoint(to, camera);
      segments.push({
        from: projection.point(projectedFrom),
        to: projection.point(projectedTo),
        color: pose.color,
        depth: (projectedFrom.depth + projectedTo.depth) / 2,
      });
    }
  }
  segments.sort((left, right) => left.depth - right.depth);

  ctx.lineCap = "round";
  for (const segment of segments) {
    ctx.beginPath();
    ctx.moveTo(segment.from.x, segment.from.y);
    ctx.lineTo(segment.to.x, segment.to.y);
    ctx.strokeStyle = segment.color;
    ctx.globalAlpha = 0.82;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const points = poses.flatMap((pose) =>
    [...pose.points.values()].map((point) => {
      const projected = projectNormalizedPoint(point, camera);
      return { ...projection.point(projected), color: pose.color };
    }),
  ).sort((left, right) => left.depth - right.depth);
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.8, 0, 2 * Math.PI);
    ctx.fillStyle = point.color;
    ctx.globalAlpha = 1;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return true;
}

export function createBlazePose3DSession({ initialSettings, onSettingsChange, requestDraw } = {}) {
  let settings = normalizeBlazePoseViewSettings(initialSettings);
  const poseSmoother = createBlazePosePoseSmoother();
  let lastAnimationTime = null;
  let drag = null;
  let destroyed = false;
  let hasRenderablePose = false;

  const snapshot = () => ({ ...settings });
  const notify = (persist = true) => {
    if (destroyed) return;
    if (persist && typeof onSettingsChange === "function") onSettingsChange(snapshot());
    if (typeof requestDraw === "function") requestDraw();
  };
  const stopAnimationClock = () => {
    lastAnimationTime = null;
  };
  const advanceOrbit = (timeMs) => {
    if (!settings.autoRotate || settings.paused || !Number.isFinite(timeMs)) {
      stopAnimationClock();
      return;
    }
    if (lastAnimationTime != null) {
      const elapsedSeconds = clamp((timeMs - lastAnimationTime) / 1000, 0, 0.1);
      settings.yaw += elapsedSeconds * settings.rotationSpeed * Math.PI / 180;
    }
    lastAnimationTime = timeMs;
  };

  return {
    draw(ctx, viewport, payload, frame = {}) {
      if (destroyed) return;
      advanceOrbit(frame.animationTimeMs);
      const renderedPayload = settings.stabilizePose
        ? poseSmoother.filter(payload, frame.rtpTimestamp)
        : payload;
      hasRenderablePose = drawBlazePose3D(ctx, viewport, renderedPayload, {
        ...frame,
        camera: settings,
        showReferenceCube: settings.showReferenceCube,
      });
    },
    isAnimating() {
      return !destroyed && hasRenderablePose && settings.autoRotate && !settings.paused;
    },
    getControls() {
      return [
        { id: "showReferenceCube", type: "toggle", label: "Cube", value: settings.showReferenceCube },
        { id: "stabilizePose", type: "toggle", label: "Stabilize", value: settings.stabilizePose },
        { id: "autoRotate", type: "toggle", label: "Orbit", value: settings.autoRotate },
        {
          id: "rotationSpeed",
          type: "range",
          label: "Speed",
          value: settings.rotationSpeed,
          min: MIN_ORBIT_SPEED,
          max: MAX_ORBIT_SPEED,
          step: 5,
          valueLabel: `${Math.round(settings.rotationSpeed)} deg/s`,
          disabled: !settings.autoRotate,
        },
        {
          id: "paused",
          type: "action",
          label: settings.paused ? "Resume" : "Pause",
          disabled: !settings.autoRotate,
        },
        { id: "resetCamera", type: "action", label: "Reset view" },
      ];
    },
    applySettings(nextSettings) {
      if (destroyed || !nextSettings || typeof nextSettings !== "object") return;
      const wasStabilized = settings.stabilizePose;
      settings = normalizeBlazePoseViewSettings({ ...settings, ...nextSettings });
      if (wasStabilized !== settings.stabilizePose) poseSmoother.reset();
      stopAnimationClock();
      notify(false);
    },
    applyControl(id, value) {
      if (destroyed) return;
      switch (id) {
        case "showReferenceCube":
          settings.showReferenceCube = Boolean(value);
          break;
        case "stabilizePose":
          settings.stabilizePose = Boolean(value);
          poseSmoother.reset();
          break;
        case "autoRotate":
          settings.autoRotate = Boolean(value);
          stopAnimationClock();
          break;
        case "rotationSpeed":
          settings.rotationSpeed = clamp(finiteOr(value, settings.rotationSpeed), MIN_ORBIT_SPEED, MAX_ORBIT_SPEED);
          stopAnimationClock();
          break;
        case "paused":
          if (settings.autoRotate) settings.paused = !settings.paused;
          stopAnimationClock();
          break;
        case "resetCamera":
          settings = {
            ...settings,
            yaw: DEFAULT_YAW,
            pitch: DEFAULT_PITCH,
            paused: false,
          };
          stopAnimationClock();
          break;
        default:
          return;
      }
      notify();
    },
    pointerDown({ x, y, pointerId }) {
      if (destroyed || ![x, y].every(Number.isFinite)) return false;
      drag = { x, y, pointerId };
      settings.paused = true;
      stopAnimationClock();
      notify(false);
      return true;
    },
    pointerMove({ x, y, pointerId }) {
      if (destroyed || !drag || drag.pointerId !== pointerId || ![x, y].every(Number.isFinite)) return false;
      settings.yaw += (x - drag.x) * 0.012;
      settings.pitch = clamp(settings.pitch + (y - drag.y) * 0.012, MIN_PITCH, MAX_PITCH);
      drag = { x, y, pointerId };
      notify(false);
      return true;
    },
    pointerUp({ pointerId }) {
      if (destroyed || !drag || drag.pointerId !== pointerId) return false;
      drag = null;
      notify(true);
      return true;
    },
    snapshot,
    destroy() {
      destroyed = true;
      drag = null;
      hasRenderablePose = false;
      poseSmoother.reset();
      stopAnimationClock();
    },
  };
}

auxiliaryRendererRegistry.register("blazepose-3d", {
  title: "3D Pose",
  draw: drawBlazePose3D,
  createSession: createBlazePose3DSession,
});
