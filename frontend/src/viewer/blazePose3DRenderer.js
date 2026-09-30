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

export const BLAZEPOSE_BODY_COLORS = Object.freeze({
  head: "#facc15",
  torso: "#c084fc",
  left: "#fb7185",
  right: "#38bdf8",
});
const BODY_COLOR_LEGEND = [
  ["head", "Head"],
  ["torso", "Torso"],
  ["left", "Left"],
  ["right", "Right"],
];
const POSE_ACCENT_COLORS = ["#f8fafc", "#4ade80", "#fb923c", "#e879f9", "#2dd4bf", "#f87171"];
const HEAD_LANDMARKS = new Set([
  "nose", "left_eye_inner", "left_eye", "left_eye_outer", "left_ear",
  "right_eye_inner", "right_eye", "right_eye_outer", "right_ear",
  "mouth_left", "mouth_right",
]);
const TORSO_CONNECTIONS = new Set([
  "left_shoulder:right_shoulder",
  "left_shoulder:left_hip",
  "right_shoulder:right_hip",
  "left_hip:right_hip",
]);
const MIN_CONFIDENCE = 0.3;
const DEFAULT_YAW = -Math.PI / 4;
const DEFAULT_PITCH = Math.PI / 9;
const MIN_PITCH = -Math.PI * 0.48;
const MAX_PITCH = Math.PI * 0.48;
const CUBE_MIN_EXTENT = 0.5;
const DEFAULT_REFERENCE_HALF_EXTENT = 1.2;
const MAX_REFERENCE_HALF_EXTENT = 10;

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

export function blazePoseBodyRegion(name) {
  if (HEAD_LANDMARKS.has(name)) return "head";
  if (typeof name === "string" && name.startsWith("left_")) return "left";
  if (typeof name === "string" && name.startsWith("right_")) return "right";
  return "torso";
}

function connectionBodyRegion(fromName, toName) {
  if (TORSO_CONNECTIONS.has(`${fromName}:${toName}`)) return "torso";
  const fromRegion = blazePoseBodyRegion(fromName);
  const toRegion = blazePoseBodyRegion(toName);
  return fromRegion === toRegion ? fromRegion : "torso";
}

const BLAZEPOSE_RENDER_CONNECTIONS = BLAZEPOSE_CONNECTIONS.map(([fromName, toName]) => ({
  fromName,
  toName,
  color: BLAZEPOSE_BODY_COLORS[connectionBodyRegion(fromName, toName)],
}));

function projectionCamera(settings) {
  const camera = normalizeBlazePoseViewSettings(settings);
  return {
    yawCos: Math.cos(camera.yaw),
    yawSin: Math.sin(camera.yaw),
    pitchCos: Math.cos(camera.pitch),
    pitchSin: Math.sin(camera.pitch),
  };
}

function projectNormalizedPoint(world, camera) {
  const yawX = camera.yawCos * world.x + camera.yawSin * world.z;
  const yawZ = -camera.yawSin * world.x + camera.yawCos * world.z;
  return {
    x: yawX,
    y: camera.pitchCos * world.y - camera.pitchSin * yawZ,
    depth: camera.pitchSin * world.y + camera.pitchCos * yawZ,
  };
}

export function projectWorldPoint(point, camera = DEFAULT_BLAZEPOSE_VIEW_SETTINGS) {
  const world = normalizeWorldPoint(point);
  return world ? projectNormalizedPoint(world, projectionCamera(camera)) : null;
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
      accent: POSE_ACCENT_COLORS[poseIndex % POSE_ACCENT_COLORS.length],
    };
  }).filter((pose) => pose.points.size > 0);
}

function referenceFrame(payload) {
  const requested = payload?.view;
  const center = {
    x: finiteOr(requested?.center?.x, 0),
    y: finiteOr(requested?.center?.y, 0),
    z: finiteOr(requested?.center?.z, 0),
  };
  const halfExtent = clamp(
    finiteOr(requested?.half_extent, DEFAULT_REFERENCE_HALF_EXTENT),
    CUBE_MIN_EXTENT,
    MAX_REFERENCE_HALF_EXTENT,
  );
  return { center, halfExtent };
}

function referenceCube({ center, halfExtent }) {
  return [
    { x: center.x - halfExtent, y: center.y - halfExtent, z: center.z - halfExtent },
    { x: center.x + halfExtent, y: center.y - halfExtent, z: center.z - halfExtent },
    { x: center.x + halfExtent, y: center.y + halfExtent, z: center.z - halfExtent },
    { x: center.x - halfExtent, y: center.y + halfExtent, z: center.z - halfExtent },
    { x: center.x - halfExtent, y: center.y - halfExtent, z: center.z + halfExtent },
    { x: center.x + halfExtent, y: center.y - halfExtent, z: center.z + halfExtent },
    { x: center.x + halfExtent, y: center.y + halfExtent, z: center.z + halfExtent },
    { x: center.x - halfExtent, y: center.y + halfExtent, z: center.z + halfExtent },
  ];
}

function fitProjection(points, width, height) {
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const rangeX = Math.max(maxX - minX, 0.25);
  const rangeY = Math.max(maxY - minY, 0.25);
  const scale = Math.min((width * 0.88) / rangeX, (height * 0.88) / rangeY);
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
  ctx.fillStyle = "rgba(226, 232, 240, 0.68)";
  ctx.font = '500 11px "Roboto Condensed", sans-serif';
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
    ctx.fillStyle = "rgba(56, 189, 248, 0.025)";
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(148, 163, 184, 0.48)";
  ctx.lineWidth = 1;
  for (const [fromIndex, toIndex] of CUBE_EDGES) {
    ctx.beginPath();
    ctx.moveTo(vertices[fromIndex].x, vertices[fromIndex].y);
    ctx.lineTo(vertices[toIndex].x, vertices[toIndex].y);
    ctx.stroke();
  }

  const labels = [[1, "X"], [3, "Y"], [4, "Z"]];
  ctx.fillStyle = "rgba(226, 232, 240, 0.72)";
  ctx.font = '600 10px "Roboto Condensed", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [index, label] of labels) {
    ctx.fillText(label, vertices[index].x, vertices[index].y);
  }
}

function drawBodyColorLegend(ctx, width, height) {
  if (width < 240 || height < 180) return;
  const gap = 54;
  const startX = Math.max(12, width - BODY_COLOR_LEGEND.length * gap - 4);
  const y = height - 12;
  ctx.font = '600 9px "Roboto Condensed", sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const [index, [region, label]] of BODY_COLOR_LEGEND.entries()) {
    const x = startX + index * gap;
    ctx.beginPath();
    ctx.arc(x, y, 2.7, 0, 2 * Math.PI);
    ctx.fillStyle = BLAZEPOSE_BODY_COLORS[region];
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.fillStyle = "rgba(226, 232, 240, 0.82)";
    ctx.fillText(label, x + 6, y);
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

  const camera = projectionCamera(frame.camera);
  const projectedPoses = poses.map((pose) => ({
    ...pose,
    points: new Map([...pose.points].map(([name, point]) => [
      name,
      projectNormalizedPoint(point, camera),
    ])),
  }));
  const projectedCube = referenceCube(referenceFrame(payload))
    .map((point) => projectNormalizedPoint(point, camera));
  const projection = fitProjection(projectedCube, width, height);
  const screenPoses = projectedPoses.map((pose) => ({
    ...pose,
    points: new Map([...pose.points].map(([name, point]) => [name, projection.point(point)])),
  }));

  if (frame.showReferenceCube !== false) {
    drawReferenceCube(ctx, projectedCube.map((point) => projection.point(point)));
  }

  const segments = [];
  for (const pose of screenPoses) {
    for (const { fromName, toName, color } of BLAZEPOSE_RENDER_CONNECTIONS) {
      const from = pose.points.get(fromName);
      const to = pose.points.get(toName);
      if (!from || !to) continue;
      segments.push({
        from,
        to,
        color,
        accent: pose.accent,
        depth: (from.depth + to.depth) / 2,
      });
    }
  }
  segments.sort((left, right) => left.depth - right.depth);

  const distinguishPoses = screenPoses.length > 1;
  ctx.lineCap = "round";
  for (const segment of segments) {
    ctx.beginPath();
    ctx.moveTo(segment.from.x, segment.from.y);
    ctx.lineTo(segment.to.x, segment.to.y);
    ctx.strokeStyle = distinguishPoses ? segment.accent : "rgba(2, 6, 23, 0.74)";
    ctx.globalAlpha = 1;
    ctx.lineWidth = 4.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(segment.from.x, segment.from.y);
    ctx.lineTo(segment.to.x, segment.to.y);
    ctx.strokeStyle = segment.color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.35;
    ctx.stroke();
  }

  const points = screenPoses.flatMap((pose) =>
    [...pose.points].map(([name, point]) => ({
      ...point,
      color: BLAZEPOSE_BODY_COLORS[blazePoseBodyRegion(name)],
      accent: pose.accent,
    })),
  ).sort((left, right) => left.depth - right.depth);
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.1, 0, 2 * Math.PI);
    ctx.fillStyle = point.color;
    ctx.strokeStyle = distinguishPoses ? point.accent : "rgba(2, 6, 23, 0.9)";
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 1;
    ctx.fill();
    ctx.stroke();
  }
  drawBodyColorLegend(ctx, width, height);
  ctx.globalAlpha = 1;
  return true;
}

export function createBlazePose3DSession({ initialSettings, onSettingsChange, requestDraw } = {}) {
  let settings = normalizeBlazePoseViewSettings(initialSettings);
  let drag = null;
  let destroyed = false;

  const snapshot = () => ({ ...settings });
  const notify = (persist = true) => {
    if (destroyed) return;
    if (persist && typeof onSettingsChange === "function") onSettingsChange(snapshot());
    if (typeof requestDraw === "function") requestDraw();
  };
  return {
    draw(ctx, viewport, payload, frame = {}) {
      if (destroyed) return;
      drawBlazePose3D(ctx, viewport, payload, {
        ...frame,
        camera: settings,
        showReferenceCube: settings.showReferenceCube,
      });
    },
    isAnimating() {
      return false;
    },
    getControls() {
      return [
        { id: "showReferenceCube", type: "toggle", label: "Cube", value: settings.showReferenceCube },
        { id: "resetCamera", type: "action", label: "Reset view" },
      ];
    },
    applySettings(nextSettings) {
      if (destroyed || !nextSettings || typeof nextSettings !== "object") return;
      settings = normalizeBlazePoseViewSettings({ ...settings, ...nextSettings });
      notify(false);
    },
    applyControl(id, value) {
      if (destroyed) return;
      switch (id) {
        case "showReferenceCube":
          settings.showReferenceCube = Boolean(value);
          break;
        case "resetCamera":
          settings = {
            ...settings,
            yaw: DEFAULT_YAW,
            pitch: DEFAULT_PITCH,
          };
          break;
        default:
          return;
      }
      notify();
    },
    pointerDown({ x, y, pointerId }) {
      if (destroyed || ![x, y].every(Number.isFinite)) return false;
      drag = { x, y, pointerId };
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
    },
  };
}

auxiliaryRendererRegistry.register("blazepose-3d", {
  title: "3D Pose",
  draw: drawBlazePose3D,
  createSession: createBlazePose3DSession,
  viewerSettings: {
    toSession(settings) {
      return {
        showReferenceCube: settings.showReferenceBox !== false,
        yaw: settings.yawDegrees * Math.PI / 180,
        pitch: settings.pitchDegrees * Math.PI / 180,
      };
    },
    toViewer(settings, current) {
      return {
        ...current,
        showReferenceBox: settings.showReferenceCube !== false,
        yawDegrees: Math.round(settings.yaw * 180 / Math.PI),
        pitchDegrees: Math.round(settings.pitch * 180 / Math.PI),
      };
    },
  },
});
