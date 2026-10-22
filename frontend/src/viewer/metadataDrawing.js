const MAX_CANVAS_PIXEL_RATIO = 2;
const warnedStrategies = new Set();
const roiMetadataTypes = new Set(["object-detection", "segmentation", "tracking"]);
const configurableMetadataTypes = new Set([
  "object-detection",
  "tracking",
  "pose-estimation",
  "segmentation",
  "classification",
]);

export function hasDrawableMetadata(message, settings) {
  const type = message?.type;
  const data = message?.data;
  const showRoi = settings?.general?.showRoi !== false && roiMetadataTypes.has(type);
  if (configurableMetadataTypes.has(type) && settings?.type?.visible === false) {
    return type === "tracking" || showRoi;
  }

  switch (type) {
    case "object-detection": {
      const threshold = settings?.type?.confidenceThreshold ?? 0;
      return showRoi
        || (Array.isArray(data?.objects)
          && data.objects.some((object) => (object?.confidence ?? 1) >= threshold));
    }
    case "classification":
      return Array.isArray(data?.top_classes) && data.top_classes.length > 0;
    case "pose-estimation":
      return Array.isArray(data?.poses) && data.poses.length > 0;
    case "segmentation":
      return showRoi || (Array.isArray(data?.segments) && data.segments.length > 0);
    case "tracking":
      return showRoi || Array.isArray(data?.tracks);
    default:
      return Boolean(type);
  }
}

// Sizes the canvas for the screen's pixel density and keeps drawing in CSS
// pixels, which the draw strategies measure with clientWidth/clientHeight.
export function prepareOverlayCanvas(ctx, canvas, devicePixelRatio) {
  const pixelRatio = Math.min(MAX_CANVAS_PIXEL_RATIO, Math.max(1, devicePixelRatio || 1));
  const width = Math.round(canvas.clientWidth * pixelRatio);
  const height = Math.round(canvas.clientHeight * pixelRatio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

// Draws the current video frame into the overlay canvas, letterboxed like the
// <video> element. The browser shows the frame and its overlays together; an
// overlay drawn over the <video> element appears one display refresh after its
// frame.
export function drawVideoFrame(ctx, canvas, video) {
  const { scaleX, scaleY, offsetX, offsetY } = window.computeScaleAndOffset(video, canvas);
  ctx.drawImage(video, offsetX, offsetY, video.videoWidth * scaleX, video.videoHeight * scaleY);
}

export function drawMetadata(ctx, canvas, message, video, channelIndex, drawContext) {
  const strategies = window.drawStrategies;
  const type = message?.type;
  if (typeof type !== "string" || !strategies || !Object.prototype.hasOwnProperty.call(strategies, type)) return;
  const strategy = strategies[type];
  if (typeof strategy !== "function") return;
  ctx.save();
  try {
    strategy(ctx, canvas, message?.data, video, channelIndex, drawContext);
  } catch (error) {
    const key = `${channelIndex}:${type}`;
    if (!warnedStrategies.has(key)) {
      warnedStrategies.add(key);
      console.warn(`metadata: channel ${channelIndex} failed to draw ${type}`, error);
    }
  } finally {
    ctx.restore();
  }
}
