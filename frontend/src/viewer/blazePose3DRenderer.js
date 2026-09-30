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
const YAW = -Math.PI / 4;
const PITCH = Math.PI / 9;

export function projectWorldPoint(point) {
  const x = Number(point?.x);
  const y = -Number(point?.y);
  const z = Number(point?.z);
  if (![x, y, z].every(Number.isFinite)) return null;

  const yawX = Math.cos(YAW) * x + Math.sin(YAW) * z;
  const yawZ = -Math.sin(YAW) * x + Math.cos(YAW) * z;
  return {
    x: yawX,
    y: Math.cos(PITCH) * y - Math.sin(PITCH) * yawZ,
    depth: Math.sin(PITCH) * y + Math.cos(PITCH) * yawZ,
  };
}

function normalizedPoses(payload) {
  if (!Array.isArray(payload?.poses)) return [];
  return payload.poses.map((pose, poseIndex) => {
    const points = new Map();
    if (Array.isArray(pose?.keypoints)) {
      for (const point of pose.keypoints) {
        if (typeof point?.name !== "string" || (point.confidence ?? 1) < MIN_CONFIDENCE) continue;
        const projected = projectWorldPoint(point);
        if (projected) points.set(point.name, projected);
      }
    }
    return { id: pose?.id ?? `pose_${poseIndex + 1}`, points, color: POSE_COLORS[poseIndex % POSE_COLORS.length] };
  }).filter((pose) => pose.points.size > 0);
}

function fitProjection(poses, width, height) {
  const points = poses.flatMap((pose) => [...pose.points.values()]);
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

export function drawBlazePose3D(ctx, viewport, payload) {
  const width = viewport?.width ?? 0;
  const height = viewport?.height ?? 0;
  if (width <= 0 || height <= 0) return;

  const poses = normalizedPoses(payload);
  if (poses.length === 0) {
    drawEmpty(ctx, width, height);
    return;
  }

  const projection = fitProjection(poses, width, height);
  const segments = [];
  for (const pose of poses) {
    for (const [fromName, toName] of BLAZEPOSE_CONNECTIONS) {
      const from = pose.points.get(fromName);
      const to = pose.points.get(toName);
      if (!from || !to) continue;
      segments.push({
        from: projection.point(from),
        to: projection.point(to),
        color: pose.color,
        depth: (from.depth + to.depth) / 2,
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

  const projectedPoints = poses.flatMap((pose) =>
    [...pose.points.values()].map((point) => ({ ...projection.point(point), color: pose.color })),
  ).sort((left, right) => left.depth - right.depth);
  for (const point of projectedPoints) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.8, 0, 2 * Math.PI);
    ctx.fillStyle = point.color;
    ctx.globalAlpha = 1;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

auxiliaryRendererRegistry.register("blazepose-3d", {
  title: "3D Pose",
  draw: drawBlazePose3D,
});
