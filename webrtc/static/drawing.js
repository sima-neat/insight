// --- drawing.js ---
// Modular drawing functions based on metadata type, scaled to match canvas display size

const FONT = '14px "Roboto Condensed", sans-serif';
const FONT_LARGE = '16px "Roboto Condensed", sans-serif';

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

window.drawStrategies = {
 "object-detection": (ctx, canvas, data, video, index) => {
    if (!data?.objects) return;

    const scope = `channel_${index}`;
    const scopedSettings = JSON.parse(localStorage.getItem(`viewerSettings_${scope}`) || "{}");
    const globalSettings = JSON.parse(localStorage.getItem(`viewerSettings_global`) || "{}");

    // Merge scoped and global object styles
    const objectStyles = {};
    (globalSettings.objects || []).forEach(entry => {
      objectStyles[entry.label] = entry;
    });
    (scopedSettings.objects || []).forEach(entry => {
      objectStyles[entry.label] = entry;
    });

    const defaultStyle = objectStyles["default"];
    const threshold = scopedSettings.confidenceThreshold ?? globalSettings.confidenceThreshold ?? 0;
    const showRoi = scopedSettings.showRoi ?? globalSettings.showRoi ?? true;

    // Load ROI polygons from localStorage
    const roiKey = `viewerROI_${index}`;
    const roiRaw = localStorage.getItem(roiKey);
    const roiPolygons = roiRaw ? JSON.parse(roiRaw) : [];
    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw ROI polygons
      if (showRoi) {
      roiPolygons.forEach(({ points, type }) => {
        const absPoints = points.map(p => [
          p.x * video.videoWidth * scaleX + offsetX,
          p.y * video.videoHeight * scaleY + offsetY
        ]);
        if (absPoints.length < 3) return;

        ctx.beginPath();
        ctx.moveTo(absPoints[0][0], absPoints[0][1]);
        for (let i = 1; i < absPoints.length; i++) {
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

    function isInsideAnyPolygon(x, y, polygons) {
      return polygons.some(polygon => {
        const pts = polygon.points.map(p => [
          p.x * video.videoWidth * scaleX + offsetX,
          p.y * video.videoHeight * scaleY + offsetY
        ]);

        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i][0], yi = pts[i][1];
          const xj = pts[j][0], yj = pts[j][1];
          const intersect = ((yi > y) !== (yj > y)) &&
                            (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-6) + xi);
          if (intersect) inside = !inside;
        }

        return inside;
      });
    }

    function getObjectCenter(obj, video, scaleX, scaleY, offsetX, offsetY, isNormalized = false) {
      let [x, y, w, h] = obj.bbox;

      if (isNormalized) {
        x *= video.videoWidth;
        y *= video.videoHeight;
        w *= video.videoWidth;
        h *= video.videoHeight;
      }

      const cx = (x + w / 2) * scaleX + offsetX;
      const cy = (y + h / 2) * scaleY + offsetY;
      return { cx, cy };
    }


    const inclusionPolygons = roiPolygons.filter(p => p.type === "inclusion");
    const exclusionPolygons = roiPolygons.filter(p => p.type === "exclusion");

    data.objects.forEach(obj => {
      if (obj.confidence < threshold) return;

      const [x, y, w, h] = obj.bbox;
      const { cx, cy } = getObjectCenter(obj, video, scaleX, scaleY, offsetX, offsetY, false);
      const insideInclusion = inclusionPolygons.length === 0 || isInsideAnyPolygon(cx, cy, inclusionPolygons);
      const insideExclusion = isInsideAnyPolygon(cx, cy, exclusionPolygons);

      if (!insideInclusion || insideExclusion) return;

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


  "classification": (ctx, canvas, data, video, index) => {
    if (!data?.top_classes) return;

    const scope = `channel_${index}`;
    const scopedSettings = JSON.parse(localStorage.getItem(`viewerSettings_${scope}`) || "{}");
    const globalSettings = JSON.parse(localStorage.getItem(`viewerSettings_global`) || "{}");

    // Fallback order: scoped > global > default
    const labelColor = scopedSettings.classificationColor || globalSettings.classificationColor || 'yellow';
    const font = scopedSettings.classificationFont || globalSettings.classificationFont || FONT_LARGE;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.fillStyle = labelColor;

    data.top_classes.slice(0, 3).forEach((cls, i) => {
      ctx.fillText(`${cls.label} (${Math.round(cls.confidence * 100)}%)`, 10 * scaleX + offsetX, (20 + i * 20) * scaleY + offsetY);
    });
  },

  "pose-estimation": (ctx, canvas, data, video, index) => {
    if (!data?.poses) return;

    const scope = `channel_${index}`;
    const scopedSettings = JSON.parse(localStorage.getItem(`viewerSettings_${scope}`) || "{}");
    const globalSettings = JSON.parse(localStorage.getItem(`viewerSettings_global`) || "{}");

    // Fallback order: scoped > global > default
    const strokeColor = scopedSettings.poseStrokeColor || globalSettings.poseStrokeColor || 'aqua';
    const fillColor = scopedSettings.poseFillColor || globalSettings.poseFillColor || 'aqua';
    const font = scopedSettings.poseFont || globalSettings.poseFont || FONT;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
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

  "segmentation": (ctx, canvas, data, video, index) => {
    if (!data?.segments) return;

    const scope = `channel_${index}`;
    const scopedSettings = JSON.parse(localStorage.getItem(`viewerSettings_${scope}`) || "{}");
    const globalSettings = JSON.parse(localStorage.getItem(`viewerSettings_global`) || "{}");

    // Use per-channel settings with fallbacks
    const strokeColor = scopedSettings.segmentationStrokeColor || globalSettings.segmentationStrokeColor || 'orange';
    const lineWidth = scopedSettings.segmentationLineWidth || globalSettings.segmentationLineWidth || 2;
    const font = scopedSettings.segmentationFont || globalSettings.segmentationFont || FONT;

    const { scaleX, scaleY, offsetX, offsetY } = computeScaleAndOffset(video, canvas);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
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
  }
};
