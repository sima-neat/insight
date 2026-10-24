import type { Slot, SlotExternal, SlotPull, SlotPullStatus, SlotReader } from '../../sources/api';
import type { Progress } from '../../sources/progress-lines';
import type { Camera } from '../../sources/webcam-publishing';

/**
 * What the Streaming page shows of a slot, worked out from the server's answer (Inv-SM §1.2) and
 * what only this browser knows: the camera picked for a webcam slot and an encode in progress.
 * Pure functions, so the list computes its rows once per answer and the slot's panel says the
 * same things in the same words.
 */

/** The kind of source in a slot: a file, a camera, an external publisher or a pulled stream. */
export type SlotKind = 'VID' | 'CAM' | 'EXT' | 'URL' | '';

/** The theme's status colour a state chip takes. */
export type SlotTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

export interface SlotStateView {
  readonly label: string;
  readonly tone: SlotTone;
}

/** One row of the slot list: a column each, ready to show. */
export interface SlotRow {
  readonly slot: Slot;
  /** `srcN`. */
  readonly name: string;
  readonly kind: SlotKind;
  readonly source: string;
  readonly state: SlotStateView;
  readonly rate: string;
  readonly codec: string;
  /** Why the codec cannot be decoded downstream; null when it can or is not known. */
  readonly codecWarning: string | null;
}

/** What only this browser knows about a slot. */
export interface SlotLocal {
  /** The camera this browser picked for a webcam slot. */
  readonly camera?: Camera;
  /** The rendition `SlotsService.prepare` is encoding for the slot's start. */
  readonly encode?: Progress;
}

const IDLE: SlotStateView = { label: 'Idle', tone: 'neutral' };
const LIVE: SlotStateView = { label: 'Live', tone: 'success' };
const ENCODING: SlotStateView = { label: 'Encoding', tone: 'info' };
const EXTERNAL: SlotStateView = { label: 'External', tone: 'info' };
const PULL_STATES: Record<SlotPullStatus, SlotStateView> = {
  connecting: { label: 'Connecting…', tone: 'neutral' },
  live: { label: 'Pulled', tone: 'success' },
  unreachable: { label: 'Unreachable', tone: 'warning' },
  auth_failed: { label: 'Auth failed', tone: 'danger' },
};

/** The codecs Insight streams (#170's `STREAMING_CODECS`); any other on the wire reads in capitals. */
const CODEC_LABELS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  h265: 'H.265',
  mjpeg: 'MJPEG',
  unknown: 'Unknown',
};

/** #170's names for the protocols MediaMTX reports a publisher by; others read in capitals. */
const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  rtsp: 'RTSP',
  rtsps: 'RTSPS',
  webrtc: 'WebRTC',
  srt: 'SRT',
  rtmp: 'RTMP',
  rtmps: 'RTMPS',
};

/** What a cell shows for a value there is none of, as #170 does. */
const NONE = '-';

/** A file or a webcam is assigned; a pull or an external publisher may sit over either. */
export function isAssigned(slot: Slot): boolean {
  return slot.type === 'webcam' || slot.file !== '';
}

/** What the "In use" filter shows: a slot that is assigned, external or pulled. */
export function isInUse(slot: Slot): boolean {
  return isAssigned(slot) || slot.state === 'external' || slot.state === 'pulled';
}

export function slotName(slot: Slot): string {
  return `src${slot.index}`;
}

/** An external publisher or a pull shows over the assignment it leaves in place underneath. */
export function slotKind(slot: Slot): SlotKind {
  if (slot.state === 'external') return 'EXT';
  if (slot.state === 'pulled') return 'URL';
  if (slot.type === 'webcam') return 'CAM';
  return slot.file ? 'VID' : '';
}

export function slotState(slot: Slot, encode?: Progress): SlotStateView {
  if (slot.state === 'external') return EXTERNAL;
  if (slot.state === 'pulled') return PULL_STATES[slot.pull?.status ?? 'connecting'];
  if (encode) return ENCODING;
  return slot.state === 'playing' ? LIVE : IDLE;
}

export function slotSource(slot: Slot, camera?: Camera): string {
  if (slot.state === 'external' && slot.external) return externalChip(slot.external);
  if (slot.state === 'pulled' && slot.pull) return pullChip(slot.pull);
  // After a reload a webcam slot has no camera until one is picked again in this browser.
  if (slot.type === 'webcam') return camera?.label ?? 'Select a camera';
  return slot.file || 'Not assigned';
}

/**
 * The chips below are #170's (`externalSource.js`) word for word. An external publisher:
 * `⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps`, leaving out the address and the video
 * while they are not known.
 */
export function externalChip(external: SlotExternal): string {
  const parts = [protocolLabel(external.protocol)];
  if (external.address) parts.push(external.address);
  const video = dimensionsText(external);
  if (video) parts.push(video);
  return `⇢ ${parts.join(' · ')}`;
}

/**
 * A pull always names the camera it pulls from, so a row that cannot reach it says which:
 * `⇠ RTSP · 10.0.0.7:554 · ` and then the video while live, or what the pull is doing about it.
 */
export function pullChip(pull: SlotPull): string {
  const parts = [protocolLabel(pull.scheme), pull.host || NONE];
  switch (pull.status) {
    case 'live': {
      const video = dimensionsText(pull);
      if (video) parts.push(video);
      break;
    }
    case 'unreachable':
      parts.push(pull.error ? `retrying… (${pull.error})` : 'retrying…');
      break;
    case 'auth_failed':
      parts.push(pull.error || PULL_STATES.auth_failed.label);
      break;
    case 'connecting':
      parts.push('connecting…');
      break;
  }
  return `⇠ ${parts.join(' · ')}`;
}

export function protocolLabel(protocol: string): string {
  if (!protocol) return NONE;
  return PROTOCOL_LABELS[protocol] ?? protocol.toUpperCase();
}

/** `1280×720 · 30 fps`, each part only once it is known; empty before either is. */
export function dimensionsText(stream: {
  width: number | null;
  height: number | null;
  fps: number | null;
}): string {
  const parts: string[] = [];
  if (stream.width && stream.height) parts.push(`${stream.width}×${stream.height}`);
  if (stream.fps) parts.push(`${stream.fps} fps`);
  return parts.join(' · ');
}

/**
 * The rate the slot streams at. A file at a rate other than its own streams a rendition; a webcam
 * always goes out at the normalizer's rate, which the server does not report, so it shows none.
 */
export function slotRate(slot: Slot, encode?: Progress): string {
  if (slot.state === 'external') return fpsText(slot.external?.fps);
  if (slot.state === 'pulled') {
    if (slot.pull?.status === 'unreachable') return 'retrying…';
    return slot.pull?.status === 'live' ? fpsText(slot.pull.fps) : '';
  }
  if (encode) return encode.percent === null ? 'encoding' : `encoding ${encode.percent}%`;
  if (slot.type === 'webcam' || !slot.file) return '';
  const fps = slot.fps ?? slot.native_fps;
  if (fps == null) return '';
  const rendition = slot.fps != null && slot.native_fps != null && slot.fps !== slot.native_fps;
  return rendition ? `${fps} fps · rendition` : `${fps} fps`;
}

export function codecLabel(codec: string): string {
  if (!codec) return NONE;
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

/** The codec on the wire or of the assigned media; "-" while there is none to name, as in #170. */
export function slotCodec(slot: Slot): string {
  if (slot.state === 'pulled') return slot.pull?.status === 'live' ? codecLabel(slot.codec) : NONE;
  if (slot.state === 'external') return codecLabel(slot.codec);
  return isAssigned(slot) ? codecLabel(slot.codec) : NONE;
}

/**
 * #170's warning for a stream Neat pipelines cannot decode, or null. Only an external publisher,
 * or a pull while live, can carry one.
 */
export function codecWarning(slot: Slot): string | null {
  const stream =
    slot.state === 'external'
      ? slot.external
      : slot.state === 'pulled' && slot.pull?.status === 'live'
        ? slot.pull
        : undefined;
  return stream?.codec_supported === false
    ? `${codecLabel(slot.codec)} cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.`
    : null;
}

/** The pull status's label, as the state chip shows it. */
export function pullStatusLabel(pull: SlotPull): string {
  return PULL_STATES[pull.status].label;
}

/**
 * Whether the slot has a stream to watch: Insight streams it, a publisher holds it, or a pull
 * receives video. The server's preview route serves exactly these.
 */
export function isLive(slot: Slot): boolean {
  return (
    slot.state === 'playing' ||
    slot.state === 'external' ||
    (slot.state === 'pulled' && slot.pull?.status === 'live')
  );
}

/**
 * The URL a reader opens the slot at (#170's Copy URL): the RTSP URL the server reports, with the
 * SDK's mapped port, or the HTTP MJPEG one for a slot on that transport. Null when the server
 * reports none.
 */
export function streamUrl(slot: Slot): string | null {
  if (slot.transport === 'http')
    return slot.urls.http_mjpeg ?? `/stream/http/src${slot.index}.mjpg`;
  return slot.urls.rtsp ?? null;
}

/**
 * What a file or webcam slot puts out (#170's "Output" line): `RTSP / H.264 · 25 fps`, the rate
 * being the one set, else the file's own. A webcam always goes out at the normalizer's rate, which
 * the server does not report.
 */
export function slotOutput(slot: Slot): string {
  const base = `${slot.transport ? slot.transport.toUpperCase() : NONE} / ${codecLabel(slot.codec)}`;
  const fps = slot.type === 'file' ? (slot.fps ?? slot.native_fps) : null;
  return fps == null ? base : `${base} · ${fps} fps`;
}

/**
 * The rest are #170's (`externalSource.js`) as well. The preview of a live slot: `token` makes a
 * new request (another slot, a retry), and `since` changes with the publisher's session, so a
 * publisher that reconnected between two polls gets a new image rather than the ended one.
 */
export function previewSrc(index: number, token: number, since?: string | null): string {
  return `/stream/preview/src${index}.mjpg?t=${token}${since ? `&s=${encodeURIComponent(since)}` : ''}`;
}

/** How long a stream has been live, `12m 04s` or `1h 02m`; "-" while unknown. */
export function liveFor(sinceIso: string | null | undefined, nowMs: number): string {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  if (!Number.isFinite(since)) return NONE;
  const total = Math.max(0, Math.floor((nowMs - since) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatBitrate(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return NONE;
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbit/s`;
  return `${Math.round(bps / 1000)} kbit/s`;
}

/** `2 · 10.42.0.79, insight preview`: the count, then each reader by label, address or protocol. */
export function readersText(readers: readonly SlotReader[] | undefined): string {
  const list = readers ?? [];
  if (list.length === 0) return '0';
  return `${list.length} · ${list.map((r) => r.label || r.address || r.protocol).join(', ')}`;
}

/** Where a pull reads from, built from the server's record, which never carries credentials. */
export function pullSourceText(pull: Pick<SlotPull, 'scheme' | 'host' | 'path'>): string {
  return `${pull.scheme || 'rtsp'}://${pull.host || ''}${pull.path || ''}`;
}

export function slotRow(slot: Slot, local: SlotLocal = {}): SlotRow {
  return {
    slot,
    name: slotName(slot),
    kind: slotKind(slot),
    source: slotSource(slot, local.camera),
    state: slotState(slot, local.encode),
    rate: slotRate(slot, local.encode),
    codec: slotCodec(slot),
    codecWarning: codecWarning(slot),
  };
}

function fpsText(fps: number | null | undefined): string {
  return fps == null ? '' : `${fps} fps`;
}
