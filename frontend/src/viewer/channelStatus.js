const CODEC_LABELS = { H264: "H.264", H265: "H.265" };

// resolveCodecLabel reports the negotiated codec for an inbound-rtp report, or
// null while it cannot be determined. The report only carries a codecId, so the
// encoding name comes from the codec report it points at. Returning null rather
// than a guess keeps an incorrect codec off the tile before one is known.
export function resolveCodecLabel(stats, report) {
  if (!report?.codecId || typeof stats?.get !== "function") return null;
  const mimeType = stats.get(report.codecId)?.mimeType;
  if (typeof mimeType !== "string") return null;
  const encoding = mimeType.split("/")[1]?.toUpperCase();
  if (!encoding) return null;
  return CODEC_LABELS[encoding] ?? encoding;
}

// channelLabel prefixes every tile status, with the codec once it is known.
export function channelLabel(index, codec) {
  return codec ? `Channel ${index} | ${codec}` : `Channel ${index}`;
}

export function formatChannelStatus({ index, codec, width, height, fps, bitrate, messageRate }) {
  return `${channelLabel(index, codec)} | ${width}x${height} | ${fps} fps | ${bitrate} kbps | ${messageRate} msgs/sec`;
}
