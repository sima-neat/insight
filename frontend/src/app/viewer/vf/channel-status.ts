/** What a channel's connection is doing, for its status line. */
export interface VfStatus {
  /**
   * `connecting` until the first stats sample of a connected session, `connected` from then on,
   * `waiting` while the server has no stream to give (it retries), `failed` once the server
   * rejected the offer for good.
   */
  phase: 'connecting' | 'waiting' | 'failed' | 'connected';
  /** The negotiated codec, such as `H.264`; null until the browser reports it. */
  codec: string | null;
  /** The decoded frame size, null until the browser reports it. */
  width: number | null;
  height: number | null;
  /** Decoded frames per second, null until the browser reports it. */
  fps: number | null;
  /** The received bitrate in kilobits per second over the last stats interval. */
  kbps: number;
  /** Valid metadata messages per second, as the tile counts them. */
  messagesPerSecond: number;
  /** What the status line says while `phase` is `failed`. */
  failure?: string;
}

const CODEC_LABELS: Readonly<Record<string, string>> = { H264: 'H.264', H265: 'H.265' };

/**
 * The negotiated codec of an inbound-rtp report, or null while it cannot be determined. The report
 * only carries a codecId, so the encoding name comes from the codec report it points at. Returning
 * null rather than a guess keeps an incorrect codec off the tile before one is known.
 */
export function resolveCodecLabel(
  stats: Pick<ReadonlyMap<string, unknown>, 'get'> | undefined,
  report: { codecId?: string },
): string | null {
  if (!report.codecId || stats === undefined) return null;
  const mimeType = (stats.get(report.codecId) as { mimeType?: unknown } | undefined)?.mimeType;
  if (typeof mimeType !== 'string') return null;
  const encoding = mimeType.split('/')[1]?.toUpperCase();
  if (!encoding) return null;
  return CODEC_LABELS[encoding] ?? encoding;
}

/**
 * The status line's text for an offer Insight's server rejected for good. It answers 415
 * (`codec_unsupported`) when the browser's offer lacks the channel's codec, which a raw "HTTP 415"
 * would not tell anyone.
 */
export function offerFailureText(httpStatus: number): string {
  return httpStatus === 415
    ? 'Codec not supported by this browser'
    : `Connection failed: HTTP ${httpStatus}`;
}

/**
 * The tile's status text: `<codec> · <W>×<H> · <fps> fps · <kbps> kb/s · <n> msg/s` while
 * connected, or what keeps the channel from playing. The channel number is the tile's label, so it
 * is not repeated here; while connecting the label is all there is to show.
 */
export function formatChannelStatus(status: VfStatus): string {
  const codec = status.codec ? `${status.codec} · ` : '';
  switch (status.phase) {
    case 'connecting':
      return '';
    case 'waiting':
      return 'Waiting for stream';
    case 'failed':
      return `${codec}${status.failure ?? 'Connection failed'}`;
    case 'connected': {
      const size = `${status.width ?? '?'}×${status.height ?? '?'}`;
      const fps = status.fps === null ? 'N/A' : status.fps.toFixed(1);
      return `${codec}${size} · ${fps} fps · ${status.kbps.toFixed(1)} kb/s · ${status.messagesPerSecond} msg/s`;
    }
  }
}
