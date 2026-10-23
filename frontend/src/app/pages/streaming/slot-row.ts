import type { Slot, SlotExternal, SlotPull, SlotPullStatus } from '../../sources/api';
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

/** The server's codec names; anything else on the wire (`av1`, `vp9`) reads in capitals. */
const CODEC_LABELS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  h265: 'H.265',
  hevc: 'H.265',
  mjpeg: 'MJPEG',
  unknown: 'Unknown',
};

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

/** `⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps`, leaving out what is not known yet. */
export function externalChip(external: SlotExternal): string {
  const parts = [
    external.protocol.toUpperCase(),
    external.address,
    dimensions(external),
    fpsText(external.fps),
  ];
  return `⇢ ${parts.filter(Boolean).join(' · ')}`;
}

/** `⇠ RTSP · 10.0.0.7:554 · 1920×1080` while live, else what the pull is doing about it. */
export function pullChip(pull: SlotPull): string {
  switch (pull.status) {
    case 'live':
      return `⇠ ${[pull.scheme.toUpperCase(), pull.host, dimensions(pull)].filter(Boolean).join(' · ')}`;
    case 'unreachable':
      return pull.error ? `retrying… (${pull.error})` : 'retrying…';
    case 'auth_failed':
      return pull.error ?? PULL_STATES.auth_failed.label;
    case 'connecting':
      return 'connecting…';
  }
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
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

/** The codec on the wire or of the assigned media; empty while there is none to name. */
export function slotCodec(slot: Slot): string {
  if (slot.state === 'pulled' && slot.pull?.status !== 'live') return '';
  if (slot.state !== 'external' && slot.state !== 'pulled' && !isAssigned(slot)) return '';
  return slot.codec && slot.codec !== 'none' ? codecLabel(slot.codec) : '';
}

/** #170's warning for a stream Neat pipelines cannot decode, or null. Only publishers and pulls can carry one. */
export function codecWarning(slot: Slot): string | null {
  const supported =
    slot.state === 'external'
      ? slot.external?.codec_supported
      : slot.state === 'pulled'
        ? slot.pull?.codec_supported
        : true;
  const codec = slotCodec(slot);
  return codec && supported === false
    ? `${codec} cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.`
    : null;
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

function dimensions(stream: { width: number | null; height: number | null }): string | null {
  return stream.width && stream.height ? `${stream.width}×${stream.height}` : null;
}

function fpsText(fps: number | null | undefined): string {
  return fps == null ? '' : `${fps} fps`;
}
