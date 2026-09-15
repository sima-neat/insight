export function drawMetadata(ctx, canvas, message, video, channelIndex, drawContext) {
  const strategy = window.drawStrategies?.[message?.type];
  if (!strategy) return;
  ctx.save();
  try {
    strategy(ctx, canvas, message?.data, video, channelIndex, drawContext);
  } finally {
    ctx.restore();
  }
}
