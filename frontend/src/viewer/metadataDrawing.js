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
