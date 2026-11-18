/**
 * Request and response shapes of the YouTube import, `/api/import/youtube*`, which the old Flask
 * backend still serves (the server passes it on). Types only. Every other route the sources and
 * the media library call is described in the server's API document, whose types are
 * `api.generated.ts` (`npm run api:types`).
 *
 * The import itself is a streamed text response: its lines are read with `postStreamedText` and
 * parsed in `progress-lines.ts`.
 */

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
