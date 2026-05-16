// --- drawing.js ---
// Modular drawing functions based on metadata type, scaled to match canvas display size

const CANVAS_FONT_FAMILY = '"Roboto Condensed", "Arial Narrow", "Segoe UI", Arial, sans-serif';
const FONT = `14px ${CANVAS_FONT_FAMILY}`;
const FONT_LARGE = `16px ${CANVAS_FONT_FAMILY}`;
const TRACK_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#ca8a04",
  "#9333ea",
  "#0891b2",
  "#ea580c",
  "#4f46e5",
  "#be123c",
  "#0f766e"
];
const TRACK_FALLBACK_COLOR = "#f8fafc";

const COCO_SKELETON = [
  ['nose', 'left_eye'], ['nose', 'right_eye'],
  ['left_eye', 'left_ear'], ['right_eye', 'right_ear'],
  ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'], ['right_knee', 'right_ankle']
];


function computeScaleAndOffset(video, canvas) {
  const containerWidth = canvas.clientWidth;
  const containerHeight = canvas.clientHeight;
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;

  if (!videoWidth || !videoHeight) return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

  const videoAspect = videoWidth / videoHeight;
  const containerAspect = containerWidth / containerHeight;

  let drawWidth, drawHeight, offsetX, offsetY;

  if (containerAspect > videoAspect) {
    // container is wider than video → letterbox left/right
    drawHeight = containerHeight;
    drawWidth = videoAspect * drawHeight;
    offsetX = (containerWidth - drawWidth) / 2;
    offsetY = 0;
  } else {
    // container is taller than video → letterbox top/bottom
    drawWidth = containerWidth;
    drawHeight = drawWidth / videoAspect;
    offsetX = 0;
    offsetY = (containerHeight - drawHeight) / 2;
  }

  const scaleX = drawWidth / videoWidth;
  const scaleY = drawHeight / videoHeight;

  return { scaleX, scaleY, offsetX, offsetY };
}

function colorForTrackId(id) {
  if (id === null || id === undefined || id === "") return TRACK_FALLBACK_COLOR;

  const text = String(id);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return TRACK_COLORS[hash % TRACK_COLORS.length];
}

function drawTrackLabel(ctx, text, x, y, color) {
  ctx.font = FONT;
  const paddingX = 4;
  const paddingY = 3;
  const metrics = ctx.measureText(text);
  const width = metrics.width + paddingX * 2;
  const height = 18;
  const labelY = Math.max(height + 2, y);

  ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
  ctx.fillRect(x, labelY - height, width, height);
  ctx.fillStyle = color;
  ctx.fillText(text, x + paddingX, labelY - paddingY);
}

function resolveViewerDrawSettings(index, metadataType) {
  if (typeof window.resolveTypeSettings === "function") {
    return window.resolveTypeSettings(index, metadataType);
  }
  return { general: { metadataDelay: 0, showRoi: true }, type: {} };
}

function loadRoiPolygons(index) {
  try {
    const raw = localStorage.getItem(`viewerROI_${index}`);
    const polygons = raw ? JSON.parse(raw) : [];
    return Array.isArray(polygons) ? polygons : [];
  } catch (_err) {
    return [];
  }
}

function scaledRoiPoints(points, video, scale) {
  if (!Array.isArray(points)) return [];
  return points.map(p => [
    p.x * video.videoWidth * scale.scaleX + scale.offsetX,
    p.y * video.videoHeight * scale.scaleY + scale.offsetY
  ]);
}

function drawRoiPolygons(ctx, roiPolygons, video, scale) {
  roiPolygons.forEach(({ points, type }) => {
    const absPoints = scaledRoiPoints(points, video, scale);
    if (absPoints.length < 3) return;

    ctx.beginPath();
    ctx.moveTo(absPoints[0][0], absPoints[0][1]);
    for (let i = 1; i < absPoints.length; i += 1) {
      ctx.lineTo(absPoints[i][0], absPoints[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = type === "inclusion" ? "rgba(0,255,0,0.1)" : "rgba(255,0,0,0.1)";
    ctx.strokeStyle = type === "inclusion" ? "green" : "red";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  });
}

function pointInsidePolygon(x, y, polygon, video, scale) {
  const pts = scaledRoiPoints(polygon.points, video, scale);
  if (pts.length < 3) return false;

  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-6) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isInsideAnyPolygon(x, y, polygons, video, scale) {
  return polygons.some(polygon => pointInsidePolygon(x, y, polygon, video, scale));
}

function boxCenter(box, scale) {
  const [x, y, w, h] = box;
  return {
    x: (x + w / 2) * scale.scaleX + scale.offsetX,
    y: (y + h / 2) * scale.scaleY + scale.offsetY
  };
}

function passesRoiFilter(box, roiPolygons, video, scale, applyRoiFiltering) {
  if (!applyRoiFiltering) return true;
  const inclusionPolygons = roiPolygons.filter(p => p.type === "inclusion");
  const exclusionPolygons = roiPolygons.filter(p => p.type === "exclusion");
  const center = boxCenter(box, scale);
  const insideInclusion = inclusionPolygons.length === 0 ||
    isInsideAnyPolygon(center.x, center.y, inclusionPolygons, video, scale);
  const insideExclusion = isInsideAnyPolygon(center.x, center.y, exclusionPolygons, video, scale);
  return insideInclusion && !insideExclusion;
}

function drawTrackHistoryPath(ctx, points, scale, color, alpha = 0.72) {
  if (!Array.isArray(points) || points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = alpha;
  ctx.setLineDash([]);
  ctx.beginPath();
  points.forEach((point, pointIndex) => {
    const x = point.x * scale.scaleX + scale.offsetX;
    const y = point.y * scale.scaleY + scale.offsetY;
    if (pointIndex === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
  ctx.restore();
}

function updateTrackHistory(trackHistory, channelIndex, tracks, now, historySettings) {
  if (!trackHistory || !Array.isArray(tracks)) return;
  if (historySettings?.enabled === false) {
    trackHistory.forEach((_entry, key) => {
      if (Number(key.split(":")[0]) === channelIndex) trackHistory.delete(key);
    });
    return;
  }

  const rawTrailLength = Number(historySettings?.trailLength);
  const rawLostTrackTtlMs = Number(historySettings?.lostTrackTtlMs);
  const trailLength = Math.max(1, Number.isFinite(rawTrailLength) ? rawTrailLength : 10);
  const lostTrackTtlMs = Math.max(0, Number.isFinite(rawLostTrackTtlMs) ? rawLostTrackTtlMs : 2000);
  const currentKeys = new Set();

  tracks.forEach((track) => {
    if (track?.id == null || !Array.isArray(track.bbox) || track.bbox.length < 4) return;
    const [x, y, width, height] = track.bbox;
    if (![x, y, width, height].every(Number.isFinite)) return;

    const key = `${channelIndex}:${track.id}`;
    currentKeys.add(key);
    const entry = trackHistory.get(key) || { points: [] };
    entry.points = [...entry.points, { x: x + width / 2, y: y + height / 2, ts: now }].slice(-trailLength);
    entry.lastSeen = now;
    trackHistory.set(key, entry);
  });

  trackHistory.forEach((entry, key) => {
    if (Number(key.split(":")[0]) !== channelIndex) return;
    if (!currentKeys.has(key) && now - (entry.lastSeen ?? 0) > lostTrackTtlMs) {
      trackHistory.delete(key);
    }
  });
}

window.drawStrategies = {
  "object-detection": (ctx, canvas, data, video, index, drawContext = {}) => {
    if (!data?.objects) return;

    const settings = drawContext.settings || resolveViewerDrawSettings(index, "object-detection");
    const objectStyles = {};
    (settings.type.objects || []).forEach(entry => {
      objectStyles[entry.label] = entry;
    });

    const defaultStyle = objectStyles["default"];
    const threshold = settings.type.confidenceThreshold ?? 0;
    const showRoi = settings.general.showRoi !== false;
    const applyRoiFiltering = settings.general.applyRoiFiltering !== false;

    const roiPolygons = loadRoiPolygons(index);
    const scale = computeScaleAndOffset(video, canvas);
    const { scaleX, scaleY, offsetX, offsetY } = scale;
    if (showRoi) {
      drawRoiPolygons(ctx, roiPolygons, video, scale);
    }

    data.objects.forEach(obj => {
      if (obj.confidence < threshold) return;

      const [x, y, w, h] = obj.bbox;
      if (!passesRoiFilter([x, y, w, h], roiPolygons, video, scale, applyRoiFiltering)) return;

      const style = objectStyles[obj.label] || defaultStyle;

      ctx.strokeStyle = style?.color || 'lime';
      ctx.lineWidth = style?.width || 2;
      ctx.setLineDash(style?.style === "dashed" ? [6, 4] :
        style?.style === "dotted" ? [2, 2] : []);
      ctx.font = "14px sans-serif";
      ctx.fillStyle = style?.color || 'lime';

      ctx.strokeRect(x * scaleX + offsetX, y * scaleY + offsetY, w * scaleX, h * scaleY);
      const label = `${obj.label} (${Math.round(obj.confidence * 100)}%)`;
      ctx.fillText(label, (x + 2) * scaleX + offsetX, (y - 6) * scaleY + offsetY);
    });
  },


  "classification": (ctx, canvas, data, video, index, drawContext = {}) => {
    if (!data?.top_classes) return;

    const settings = drawContext.settings || resolveViewerDrawSettings(index, "classification");
    const labelColor = settings.type.classificationColor || 'yellow';
    const font = settings.type.classificationFont || FONT_LARGE;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.font = font;
    ctx.fillStyle = labelColor;

    data.top_classes.slice(0, 3).forEach((cls, i) => {
      ctx.fillText(`${cls.label} (${Math.round(cls.confidence * 100)}%)`, 10 * scaleX + offsetX, (20 + i * 20) * scaleY + offsetY);
    });
  },

  "pose-estimation": (ctx, canvas, data, video, index, drawContext = {}) => {
    if (!data?.poses) return;

    const settings = drawContext.settings || resolveViewerDrawSettings(index, "pose-estimation");
    const strokeColor = settings.type.poseStrokeColor || 'aqua';
    const fillColor = settings.type.poseFillColor || 'aqua';
    const font = settings.type.poseFont || FONT;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;
    ctx.lineWidth = 2;
    ctx.font = font;

    data.poses.forEach(pose => {
      const kpMap = Object.fromEntries(pose.keypoints.map(kp => [kp.name, kp]));

      COCO_SKELETON.forEach(([a, b]) => {
        const kpA = kpMap[a], kpB = kpMap[b];
        if (kpA && kpB && kpA.confidence > 0.3 && kpB.confidence > 0.3) {
          ctx.beginPath();
          ctx.moveTo(kpA.x * scaleX + offsetX, kpA.y * scaleY + offsetY);
          ctx.lineTo(kpB.x * scaleX + offsetX, kpB.y * scaleY + offsetY);
          ctx.stroke();
        }
      });

      pose.keypoints.forEach(kp => {
        if (kp.confidence > 0.3) {
          ctx.beginPath();
          ctx.arc(kp.x * scaleX + offsetX, kp.y * scaleY + offsetY, 3, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillText(kp.name, (kp.x + 4) * scaleX + offsetX, (kp.y - 4) * scaleY + offsetY);
        }
      });
    });
  },

  "segmentation": (ctx, canvas, data, video, index, drawContext = {}) => {
    if (!data?.segments) return;

    const settings = drawContext.settings || resolveViewerDrawSettings(index, "segmentation");
    const strokeColor = settings.type.segmentationStrokeColor || 'orange';
    const lineWidth = settings.type.segmentationLineWidth || 2;
    const font = settings.type.segmentationFont || FONT;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.font = font;

    data.segments.forEach(seg => {
      if (seg.mask_format === "polygon") {
        const poly = seg.mask;
        if (!Array.isArray(poly) || poly.length < 3) return;

        ctx.beginPath();
        ctx.moveTo(poly[0][0] * scaleX + offsetX, poly[0][1] * scaleY + offsetY);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i][0] * scaleX + offsetX, poly[i][1] * scaleY + offsetY);
        }
        ctx.closePath();
        ctx.stroke();
      } else if (seg.mask_format === "rle") {
        ctx.fillText(`RLE mask (${seg.label})`, 10 * scaleX + offsetX, (canvas.height - 10) * scaleY + offsetY);
      }
    });
  },

  "tracking": (ctx, canvas, data, video, index, drawContext = {}) => {
    if (!Array.isArray(data?.tracks)) return;

    const scale = computeScaleAndOffset(video, canvas);
    const { scaleX, scaleY, offsetX, offsetY } = scale;
    const trackHistory = drawContext.trackHistory;
    const settings = drawContext.settings || resolveViewerDrawSettings(index, "tracking");
    const threshold = settings.type.confidenceThreshold ?? 0;
    const historySettings = settings.type.history || {};
    const showTrackHistory = historySettings.enabled !== false;
    const showRoi = settings.general.showRoi !== false;
    const applyRoiFiltering = settings.general.applyRoiFiltering !== false;
    const roiPolygons = loadRoiPolygons(index);
    const visibleTracks = data.tracks.filter((track) => {
      if (!Array.isArray(track?.bbox) || track.bbox.length < 4) return;
      const [x, y, w, h] = track.bbox;
      if (![x, y, w, h].every(Number.isFinite)) return;
      if ((track.confidence ?? 1) < threshold) return;
      return passesRoiFilter([x, y, w, h], roiPolygons, video, scale, applyRoiFiltering);
    });

    if (showRoi) {
      drawRoiPolygons(ctx, roiPolygons, video, scale);
    }

    updateTrackHistory(trackHistory, index, visibleTracks, drawContext.now || performance.now(), historySettings);

    const activeKeys = new Set(
      visibleTracks
        .filter(track => track.id !== null && track.id !== undefined)
        .map(track => `${index}:${track.id}`)
    );

    if (showTrackHistory && trackHistory) {
      trackHistory.forEach((entry, key) => {
        if (Number(key.split(":")[0]) !== index) return;
        const trackId = key.substring(key.indexOf(":") + 1);
        drawTrackHistoryPath(ctx, entry.points, scale, colorForTrackId(trackId), activeKeys.has(key) ? 0.72 : 0.35);
      });
    }

    visibleTracks.forEach((track) => {
      const [x, y, w, h] = track.bbox;
      const color = colorForTrackId(track.id);
      const left = x * scaleX + offsetX;
      const top = y * scaleY + offsetY;
      const width = w * scaleX;
      const height = h * scaleY;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(left, top, width, height);

      const confidence =
        typeof track.confidence === "number" ? ` (${Math.round(track.confidence * 100)}%)` : "";
      const idText = track.id === null || track.id === undefined ? "" : ` #${track.id}`;
      const label = `${track.label || "track"}${idText}${confidence}`;
      drawTrackLabel(ctx, label, left, top - 6, color);
    });
  }
};
