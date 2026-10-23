/**
 * Request and response shapes of Flask's `/api/mediasrc*`, `/api/media*` and import endpoints,
 * as the baseline documents them (Inv-SM section 2, `neat_insight/openapi.json`). Types only: the
 * services that call the endpoints hold the logic.
 *
 * Slot indexes are one-based (1..48), unlike the Viewer's zero-based channels. Streamed text
 * endpoints (`/api/upload/media`, the two imports, `/api/mediasrc/prepare`) have no response type
 * here: their lines are read with `postStreamedText` and parsed in `progress-lines.ts`.
 */

/** Any non-2xx JSON answer: `error` is the message to show (some routes use `message`). */
export interface ApiError {
  error?: string;
  message?: string;
}

export interface SuccessResponse {
  success: true;
}

// ---------------------------------------------------------------------------------------------
// Streaming sources (`/api/mediasrc*`)
// ---------------------------------------------------------------------------------------------

/**
 * `stopped` is "Idle" in the UI. `external` and `pulled` are derived per request and never
 * persisted: another publisher holds the slot, or Insight pulls a network stream into it.
 */
export type SlotState = 'playing' | 'stopped' | 'external' | 'pulled';

export type SlotTransport = 'rtsp' | 'http';

/** A `file` slot streams a media-library path; a `webcam` slot is published by a browser over WHIP. */
export type SlotType = 'file' | 'webcam';

export interface SlotReader {
  /** For example rtsp, webrtc or srt. */
  protocol: string;
  address: string | null;
  /** Present for Insight's own preview reader. */
  label?: string;
}

export interface SlotUrls {
  rtsp?: string;
  http_mjpeg?: string;
  /** Webcam slots only. */
  whip?: string;
}

/** The non-Insight publisher holding a slot; present only when `state` is `external`. */
export interface SlotExternal {
  /** rtsp, rtsps, webrtc, srt, rtmp, rtmps or MediaMTX's raw source type. */
  protocol: string;
  address: string | null;
  /** RFC 3339 time the path became ready. */
  since: string | null;
  /** False when Neat pipelines cannot decode the stream's codec. */
  codec_supported: boolean;
  width: number | null;
  height: number | null;
  /** Null until the one-time probe completes or when it failed. */
  fps: number | null;
  bitrate_bps: number | null;
}

export type SlotPullStatus = 'connecting' | 'live' | 'unreachable' | 'auth_failed';

/** The network stream Insight pulls into a slot; present only when `state` is `pulled`. Never carries credentials. */
export interface SlotPull {
  status: SlotPullStatus;
  scheme: 'rtsp' | 'rtsps';
  /** `host:port` of the source. */
  host: string;
  /** Path and query of the source URL, query values shown as `***`. */
  path: string;
  /** Short explanation for `unreachable` and `auth_failed`. */
  error: string | null;
  /** RFC 3339 time the path became ready; null until live. */
  since: string | null;
  codec_supported: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate_bps: number | null;
}

/** One entry of the 48-slot array `GET /api/mediasrc` returns. */
export interface Slot {
  index: number;
  /** Assigned media-library path; empty for an unassigned slot. */
  file: string;
  state: SlotState;
  /** Empty while unassigned or when the codec is unknown. */
  transport: SlotTransport | '';
  /** Codec of the assigned media; the codec on the wire while external (any lower-cased MediaMTX track name) or pulled (`none` until live). */
  codec: string;
  type: SlotType;
  /** Transports the detected codec allows. */
  allowed_transports: SlotTransport[];
  urls: SlotUrls;
  readers: SlotReader[];
  external?: SlotExternal;
  pull?: SlotPull;
  /** Requested output frame rate; null streams at the source rate. */
  fps?: number | null;
  /** Frame rate probed from the media, rounded; null until probed or when undetectable. */
  native_fps?: number | null;
  /** The file the running stream reads: the source or a `.renditions/` file. Null when stopped. */
  active_file?: string | null;
}

/** A webcam this browser has already closed, so the server verifies the session instead of kicking it. */
export interface ReleasedWebcam {
  index: number;
  /** The `Id` header of the WHIP POST. */
  session: string;
}

export interface SlotRequest {
  index: number;
}

/** Fields of a release claim, shared by every route that may end a webcam's publisher. */
export interface PublisherRelease {
  publisher_released?: boolean;
  /** Required with `publisher_released`. */
  publisher_session?: string;
}

/**
 * `file: ''` clears the slot. Omitting `fps` keeps it while the file stays and resets it when the
 * file changes; `null` streams at the source rate.
 */
export interface AssignRequest extends SlotRequest, PublisherRelease {
  file: string;
  transport?: SlotTransport;
  fps?: number | null;
}

export interface AssignWebcamRequest extends SlotRequest, PublisherRelease {}

export interface AssignWebcamResponse extends SuccessResponse {
  source: Slot;
}

/** `expect_type` makes the server answer 410 when another tab changed the slot's type meanwhile. */
export interface StartRequest extends SlotRequest {
  expect_type?: SlotType;
}

export interface StopRequest extends SlotRequest, PublisherRelease {}

export interface StartBulkRequest {
  count: number;
}

/** Starts the first `count` assigned slots in index order, skipping external and pulled ones. */
export interface BulkStartResult {
  success: boolean;
  requested: number;
  targeted: number;
  started: number[];
  already_running: number[];
  errors: { index: number; error: string }[];
  skipped_external: number[];
  skipped_pulled: number[];
  message: string;
  started_or_running: number;
}

/** Body of the bulk routes that may end webcam publishers (stop-all, reset, auto-assign-all). */
export interface BulkRequest {
  released_webcams?: ReleasedWebcam[];
}

/** What stop-all, reset and auto-assign-all report alike. */
export interface BulkResult extends SuccessResponse {
  skipped_external: number[];
  skipped_pulled: number[];
  /** Webcams the server could not confirm closed; their slots stay marked as webcams. */
  unconfirmed_webcams: number[];
  /** Slots another request reassigned while this one ran, left as they are now. */
  changed_sources: number[];
  message: string;
}

export interface StopAllResult extends BulkResult {
  stopped_count: number;
  stopped_pulled: number[];
}

export interface ResetResult extends BulkResult {
  stopped_pulled: number[];
}

export interface AutoAssignResult extends BulkResult {
  assigned_count: number;
  source_count: number;
  available_files: number;
}

export interface TakeoverResponse extends SuccessResponse {
  index: number;
}

/** Credentials typed in the URL are accepted; `username` and `password` win over them. The answer is the enriched slot. */
export interface PullRequest extends SlotRequest {
  url: string;
  username?: string;
  password?: string;
}

/** The 400 body when the camera refused the credentials (or needs some); nothing was configured. */
export interface PullAuthFailedBody extends ApiError {
  reason: 'auth_failed';
}

export interface RenditionUsage {
  count: number;
  bytes: number;
}

export interface RenditionsCleared {
  removed: number;
  freed_bytes: number;
  /** Renditions kept because a playing slot uses them. */
  kept: string[];
}

export interface ServerIp {
  ip: string;
}

// ---------------------------------------------------------------------------------------------
// Media library (`/api/media*`, `/api/delete-media`, `/api/upload/media`)
// ---------------------------------------------------------------------------------------------

export interface MediaFile {
  /** Basename. */
  name: string;
  /** Relative media-library path, accepted by every other media route. */
  path: string;
  type: 'file';
  /** Whether the streamer accepts the file by extension. */
  streamable: boolean;
}

export interface MediaFolder {
  /** Basename with a leading slash, for example `/catalog`. */
  name: string;
  path: string;
  type: 'folder';
  /** Streamable files anywhere beneath the folder. */
  streamable_count: number;
  children: MediaNode[];
}

/** `GET /api/media-files`: folders first, case-insensitive; hidden entries and `__MACOSX` are left out. */
export type MediaNode = MediaFile | MediaFolder;

export interface MediaPathRequest {
  path: string;
}

interface MediaInfoBase {
  /** Basename of the probed file. */
  filename: string;
  size_bytes: number;
}

export interface ImageMediaInfo extends MediaInfoBase {
  type: 'image';
  width: number;
  height: number;
  /** Pixel mode, for example `RGB`. */
  mode: string;
  format: string;
}

export interface VideoMediaInfo extends MediaInfoBase {
  type: 'video';
  /** Display name, for example `H.264`. */
  codec: string;
  normalized_codec: 'h264' | 'h265' | 'mjpeg' | 'unknown' | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** Often rational, for example `30000/1001`. */
  frame_rate: string | null;
}

export interface UnknownMediaInfo extends MediaInfoBase {
  type: 'unknown';
}

export type MediaInfo = ImageMediaInfo | VideoMediaInfo | UnknownMediaInfo;

export interface MediaDeleteResponse {
  message: string;
}

/** What `/api/upload/media` does with a name that exists already (an archive clashes on its folder). */
export type UploadOnConflict = 'ask' | 'replace' | 'keep_both';

/** The 409 body for a clash when `on_conflict` is absent or `ask`; nothing was saved. */
export interface UploadConflictBody extends ApiError {
  conflict: {
    /** Relative path of what exists. */
    existing: string;
    /** Relative path `keep_both` would save under. */
    suggested: string;
  };
}

// ---------------------------------------------------------------------------------------------
// Catalog import (`/api/media-catalog`, `/api/import/media-catalog`)
// ---------------------------------------------------------------------------------------------

export interface CatalogSource {
  id: string;
  title: string;
  description: string;
  file: string;
  url: string;
}

/** One rendition in the published catalog index, enriched by Flask with the download `url`. */
export interface CatalogAsset {
  source_id: string;
  source_title: string;
  /** For example `720p30`; `preview_320p30` is the preview clip, not an importable variant. */
  profile: string;
  /** True for the preview clip a source's detail shows. */
  preview: boolean;
  /** h264, hevc or mjpeg as the index names them. */
  codec: string;
  container: string;
  fps: number;
  target_height: number;
  /** Catalog path, what the import request sends. */
  path: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  url: string;
}

export interface CatalogIndex {
  schema: string | null;
  generated_at: string | null;
  index_url: string;
  base_url: string;
  sources: CatalogSource[];
  assets: CatalogAsset[];
}

export interface CatalogImportRequest {
  path: string;
}

// ---------------------------------------------------------------------------------------------
// YouTube import (`/api/import/youtube*`)
// ---------------------------------------------------------------------------------------------

export type YoutubeTarget = '1080p30' | '720p30' | '480p30';

export interface YoutubeValidateRequest {
  url: string;
}

/** Live and upcoming streams are refused (400), so a preview is always of a regular video. */
export interface YoutubePreview {
  video_id: string;
  normalized_url: string;
  embed_url: string;
  thumbnail_url: string;
  /** Seconds, from a `?t=` in the link. */
  clip_start?: number;
  title: string;
  duration: number | null;
  is_live: boolean;
  live_status: string;
}

export interface YoutubeImportRequest {
  url: string;
  target: YoutubeTarget;
  /** Seconds, `MM:SS` or `HH:MM:SS`. */
  clip_start: string | number;
  /** Seconds, at most 300. */
  clip_duration: number;
}
