export function drawMetadata(ctx, canvas, message, video, channelIndex, drawContext) {
  const strategies = window.drawStrategies;
  const type = message?.type;
  if (typeof type !== "string" || !strategies || !Object.prototype.hasOwnProperty.call(strategies, type)) return;
  const strategy = strategies[type];
  if (typeof strategy !== "function") return;
  ctx.save();
  try {
    strategy(ctx, canvas, message?.data, video, channelIndex, drawContext);
  } finally {
    ctx.restore();
  }
}
