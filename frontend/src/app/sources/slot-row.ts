import type { NeatTone } from '@sima/neat-ui';
import type { Slot, SlotPublisher, SlotPull, SlotReader } from '../api.generated';
import { customRate } from './fps';
import type { Progress } from './jobs';
import type { Camera } from './webcam-publishing';

/**
 * What the app shows of a slot, worked out from the server's answer (`GET /api/slots`) and what
 * only this browser knows: the camera picked for a webcam slot and a start in flight. Pure
 * functions, so Streaming's list computes its rows once per answer, and its slot panel, Media's
 * "In use" and the import dialog's warnings name slots, states and codecs in the same words.
 */

/** The kind of source in a slot: a file, a camera, an external publisher or a pulled stream. */
export type SlotKind = 'VID' | 'CAM' | 'EXT' | 'URL' | '';

export interface SlotStateView {
  readonly label: string;
  /** The theme's status colour the state's chip takes. */
  readonly tone: NeatTone;
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

/** What only this browser knows about a slot, and how far its encode has got. */
export interface SlotLocal {
  /** The camera this browser picked for a webcam slot. */
  readonly camera?: Camera;
  /** The rendition being encoded for the slot's start (`SlotsService.encodes`). */
  readonly encode?: Progress;
  /** A start of the slot is in flight: from the click until the server has answered. */
  readonly starting?: boolean;
}

/*
 * Each state's words and tone, in one place: the state chip shows the tone, and Streaming's list
 * tints the slot's row with the same one (an idle row, neutral, stays plain).
 */
const IDLE: SlotStateView = { label: 'Idle', tone: 'neutral' };
const LIVE: SlotStateView = { label: 'Live', tone: 'success' };
const ENCODING: SlotStateView = { label: 'Encoding', tone: 'info' };
const STARTING: SlotStateView = { label: 'Starting…', tone: 'info' };
const FAILED: SlotStateView = { label: 'Failed', tone: 'danger' };
const EXTERNAL: SlotStateView = { label: 'External', tone: 'highlight' };
const PULL_STATES: Record<SlotPull['status'], SlotStateView> = {
  connecting: { label: 'Connecting…', tone: 'info' },
  live: LIVE,
  unreachable: { label: 'Unreachable', tone: 'warning' },
  auth_failed: { label: 'Auth failed', tone: 'danger' },
  needs_credentials: { label: 'Needs URL', tone: 'warning' },
  stopped: { label: 'Stopped', tone: 'neutral' },
};

/** The codecs Insight streams (#170's `STREAMING_CODECS`); any other on the wire reads in capitals. */
const CODEC_LABELS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  h265: 'H.265',
  // The media catalog's name for H.265.
  hevc: 'H.265',
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

/**
 * What a warning about the slots using some files adds when the slots could not be fetched again
 * before it (ruling Q16): the slots it names are the last known ones. Media's delete and the
 * import dialog's name clash say it alike.
 */
export const SLOTS_NOT_CHECKED = 'Could not check which slots use these files.';

/** What a cell shows for a value there is none of, as #170 does. */
const NONE = '-';

/** A file, a camera to pull or a webcam is assigned; an external publisher may sit over it. */
export function isAssigned(slot: Slot): boolean {
  return slot.kind !== 'none';
}

/** What the "In use" filter shows: a slot that is assigned or held by an external publisher. */
export function isInUse(slot: Slot): boolean {
  return isAssigned(slot) || slot.state === 'external';
}

export function slotName(slot: Slot): string {
  return `src${slot.n}`;
}

/** An external publisher shows over the assignment it leaves in place underneath. */
export function slotKind(slot: Slot): SlotKind {
  if (slot.state === 'external') return 'EXT';
  switch (slot.kind) {
    case 'pull':
      return 'URL';
    case 'webcam':
      return 'CAM';
    case 'file':
      return 'VID';
    default:
      return '';
  }
}

/**
 * A pull says how its connection stands. Otherwise an encode reads Encoding, and a start in flight
 * reads Starting… until the server says the slot is on its way; a publisher holds the slot
 * whatever is being started.
 */
export function slotState(slot: Slot, encode?: Progress, starting = false): SlotStateView {
  if (slot.state === 'external') return EXTERNAL;
  if (slot.kind === 'pull' && slot.pull) {
    if (slot.pull.status === 'stopped') return starting ? STARTING : IDLE;
    return PULL_STATES[slot.pull.status];
  }
  if (encode || slot.state === 'preparing') return ENCODING;
  switch (slot.state) {
    case 'live':
      return LIVE;
    case 'starting':
      return STARTING;
    case 'failed':
      return FAILED;
    default:
      return starting ? STARTING : IDLE;
  }
}

export function slotSource(slot: Slot, camera?: Camera): string {
  if (slot.state === 'external' && slot.publisher) return externalChip(slot.publisher);
  if (slot.kind === 'pull' && slot.pull) return pullChip(slot.pull, slot.publisher);
  // After a reload a webcam slot has no camera until one is picked again in this browser.
  if (slot.kind === 'webcam') return camera?.label ?? 'Select a camera';
  return slot.file || 'Not assigned';
}

/**
 * The chips below are #170's (`externalSource.js`) word for word. An external publisher:
 * `⇢ RTSP · 192.168.1.20 · 1280×720 · 30 fps`, leaving out the address and the video while they
 * are not known.
 */
export function externalChip(publisher: SlotPublisher): string {
  const parts = [protocolLabel(publisher.protocol)];
  if (publisher.address) parts.push(publisher.address);
  const video = dimensionsText(publisher);
  if (video) parts.push(video);
  return `⇢ ${parts.join(' · ')}`;
}

/**
 * A pull always names the camera it pulls from, so a row that cannot reach it says which:
 * `⇠ RTSP · 10.0.0.7:554 · ` and then the video while live, or what the pull is doing about it.
 */
export function pullChip(pull: SlotPull, publisher?: SlotPublisher): string {
  const parts = [protocolLabel(pull.scheme), pull.host || NONE];
  switch (pull.status) {
    case 'live': {
      const video = publisher ? dimensionsText(publisher) : '';
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
    case 'needs_credentials':
      parts.push('stream URL needed again');
      break;
    case 'stopped':
      parts.push('stopped');
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
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
}): string {
  const parts: string[] = [];
  if (stream.width && stream.height) parts.push(`${stream.width}×${stream.height}`);
  if (stream.fps) parts.push(fpsText(stream.fps));
  return parts.join(' · ');
}

/**
 * The rate the slot streams at. A file at a rate other than its own streams a rendition; a webcam
 * always goes out at the normalizer's rate, which the server does not report, so it shows none.
 */
export function slotRate(slot: Slot, encode?: Progress): string {
  if (slot.state === 'external') return fpsText(slot.publisher?.fps);
  if (slot.kind === 'pull') {
    if (slot.pull?.status === 'unreachable') return 'retrying…';
    return slot.pull?.status === 'live' ? fpsText(slot.publisher?.fps) : '';
  }
  if (encode) return encode.percent === null ? 'encoding' : `encoding ${encode.percent}%`;
  if (slot.kind !== 'file') return '';
  const fps = slot.fps ?? slot.native_fps;
  if (fps === undefined) return '';
  return customRate(slot) !== null ? `${fps} fps · rendition` : `${fps} fps`;
}

export function codecLabel(codec: string | undefined): string {
  if (!codec) return NONE;
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

/** The codec on the wire or of the assigned file; "-" while there is none to name, as in #170. */
export function slotCodec(slot: Slot): string {
  if (slot.state === 'external') return codecLabel(slot.codec);
  if (slot.kind === 'pull') return slot.pull?.status === 'live' ? codecLabel(slot.codec) : NONE;
  return isAssigned(slot) ? codecLabel(slot.codec) : NONE;
}

/**
 * #170's warning for a stream Neat pipelines cannot decode, or null. Only an external publisher,
 * or a pull while live, can carry one.
 */
export function codecWarning(slot: Slot): string | null {
  const held = slot.state === 'external' || (slot.kind === 'pull' && slot.pull?.status === 'live');
  return held && slot.publisher?.codec_supported === false
    ? `${codecLabel(slot.codec)} cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.`
    : null;
}

/** The pull status's label, as the slot's details say it. */
export function pullStatusLabel(pull: SlotPull): string {
  return PULL_STATES[pull.status].label;
}

/**
 * Whether the slot has a stream to watch: MediaMTX has it, from Insight's publisher, a pulled
 * camera, a webcam or an external publisher. The server's preview route serves exactly these.
 */
export function isLive(slot: Slot): boolean {
  return slot.state === 'live' || slot.state === 'external';
}

/**
 * Whether the slot is on: the user started it (`run`), so Stop is what it offers. A webcam is
 * on while a browser publishes it, since the server keeps a webcam slot started from its
 * assignment on, waiting for a browser.
 */
export function isRunning(slot: Slot): boolean {
  if (slot.kind === 'webcam') return slot.state === 'live' || slot.state === 'starting';
  return slot.run;
}

/**
 * What a slot puts out (#170's "Output" line): `RTSP / H.264 · 25 fps`, the rate being the one set,
 * else the file's own; an MJPEG stream also goes out over HTTP. A webcam always goes out at the
 * normalizer's rate, which the server does not report.
 */
export function slotOutput(slot: Slot): string {
  const protocols = slot.urls.http_mjpeg ? 'RTSP and HTTP' : 'RTSP';
  const base = `${protocols} / ${codecLabel(slot.codec)}`;
  const fps = slot.kind === 'file' ? (slot.fps ?? slot.native_fps) : undefined;
  return fps === undefined ? base : `${base} · ${fps} fps`;
}

/**
 * The rest are #170's (`externalSource.js`) as well. The preview of a live slot: `token` makes a
 * new request (another slot, a retry), and `since` changes with the publisher's session, so a
 * publisher that reconnected between two polls gets a new image rather than the ended one.
 */
export function previewSrc(n: number, token: number, since?: string | null): string {
  return `/api/slots/${n}/preview.mjpg?t=${token}${since ? `&s=${encodeURIComponent(since)}` : ''}`;
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
export function readersText(readers: readonly SlotReader[]): string {
  if (readers.length === 0) return '0';
  return `${readers.length} · ${readers.map((r) => r.label || r.address || r.protocol).join(', ')}`;
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
    state: slotState(slot, local.encode, local.starting),
    rate: slotRate(slot, local.encode),
    codec: slotCodec(slot),
    codecWarning: codecWarning(slot),
  };
}

/** A rate in whole frames per second; a stream's measured rate (29.97) reads as its nearest. */
function fpsText(fps: number | undefined): string {
  return fps === undefined ? '' : `${Math.round(fps)} fps`;
}
