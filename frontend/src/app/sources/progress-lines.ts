/**
 * Parsers for the progress lines Flask prints into its streamed text responses (Inv-SM section 4).
 * Each takes one line, as `postStreamedText` emits them, and returns what to show: a title, a
 * detail and a percent (null while indeterminate), or the failure the line reports.
 *
 * The server answers HTTP 200 even when an upload or import fails, so a failure arrives as a line
 * and these parsers are the only way to tell it from a success. Every line the server prints on a
 * failure is matched; #170 matched only two of the upload ones and showed the rest as success.
 *
 * What a caller must do, because the lines alone do not say it:
 * - **A `failed` line is not the end.** The server keeps going: an archive upload moves on to its
 *   next file after `FFmpeg conversion failed` and still prints `Upload complete.`. Read to the
 *   stream's `done`, record the first failure per request, and never unsubscribe on `failed`:
 *   unsubscribing makes the server stop its subprocesses and abandon the remaining files.
 * - **A failure spans several lines.** yt-dlp and FFmpeg failures print up to four diagnostic
 *   lines after the first, which would parse as ordinary progress and overwrite a failure shown
 *   from the first line. Collect the request's lines and take the full message from
 *   `failureText` once the stream is done.
 * - **A failed upload may still have saved the file.** The FFmpeg and FFprobe "not installed;
 *   keeping original" lines fail the upload (the file is saved but not prepared for streaming).
 *   Refresh the media library after every upload, whatever its outcome.
 * - **A Replace restarts the slots it stopped**, and prints `Restarted srcN.` or `Could not
 *   restart srcN: <reason>` per slot. The second is a warning to show (`restartWarning`), not a
 *   failure: the upload itself is in place.
 * - **Titles carry no scope or subject** ("1/3", the file's name): the caller knows both, and the
 *   server's own lines carry what it knows. Prepare lines are the exception that needs state:
 *   merge them with `mergePrepareProgress`.
 */

import { formatFpsProgress } from './fps';

export interface Progress {
  title: string;
  detail: string;
  /** 0..100, or null while the length of the work is unknown. */
  percent: number | null;
  /**
   * The encoder a rendition encode runs with (prepare lines only), kept so that the progress lines
   * after it can name it in their detail, as #170's "0:25 / 1:00 · libx264" did.
   */
  encoder?: string;
}

export interface ProgressFailure {
  /** The server's message, ready to show. */
  failed: string;
}

export function isProgressFailure(result: Progress | ProgressFailure): result is ProgressFailure {
  return 'failed' in result;
}

/** What a bare `Error:` line, which carries no message, fails with. */
const EMPTY_ERROR = 'The server reported an error.';

const BYTES_PER_MB = 1024 * 1024;

const megabytes = (bytes: number): string => (bytes / BYTES_PER_MB).toFixed(1);

/** The text after a `Prefix:` the line is known to start with. */
const after = (line: string, prefix: string): string => line.slice(prefix.length).trim();

/** Runs `parse` on a trimmed, non-blank line, once `failure` has not recognised it as a failure. */
function parseLine(
  line: string,
  failure: RegExp,
  parse: (line: string) => Progress,
): Progress | ProgressFailure | null {
  const text = line.trim();
  if (!text) return null;
  return failure.test(text) ? { failed: text } : parse(text);
}

// Lines the upload route (and the optimiser it runs) prints when a file or archive is unusable.
// The FFmpeg and FFprobe "not installed" lines say "keeping original": the upload is saved but
// was not prepared, which #170 already treated as failed for FFmpeg. A missing file is a 400
// before the stream starts, not a line.
const UPLOAD_FAILURE =
  /^(?:Failed to save upload:|Failed to extract archive:|FFmpeg conversion failed|FFmpeg is not installed|FFprobe is not installed)/;

const OPTIMIZING_PERCENT = /^Optimizing .*?:\s+(\d+)%\s+\(([^)]+)\)/;
const OPTIMIZING_ELAPSED = /^Optimizing .*?:\s+(.+ processed)$/;
const OPTIMIZING_START = /^Optimizing (.+?) for low-latency/;
const OPTIMIZED = /^Optimized (.+?):/;

/**
 * `POST /api/upload/media`. A failed line does not mean the file is gone: see the header on
 * refreshing the library and on reading on after a failure.
 */
export function uploadProgress(line: string): Progress | ProgressFailure | null {
  return parseLine(line, UPLOAD_FAILURE, (text) => {
    const percent = OPTIMIZING_PERCENT.exec(text);
    if (percent) {
      return { title: 'Preparing media', detail: percent[2], percent: Number(percent[1]) };
    }
    const elapsed = OPTIMIZING_ELAPSED.exec(text);
    if (elapsed) return { title: 'Preparing media', detail: elapsed[1], percent: null };
    if (text.startsWith('Optimizing ')) {
      return {
        title: 'Preparing media',
        detail: OPTIMIZING_START.exec(text)?.[1] ?? '',
        percent: null,
      };
    }
    if (text.startsWith('Preparing file ')) {
      return {
        title: 'Scanning upload',
        detail: `File ${after(text, 'Preparing file')}`,
        percent: null,
      };
    }
    if (text.startsWith('Optimized ')) {
      return { title: 'Prepared media', detail: OPTIMIZED.exec(text)?.[1] ?? '', percent: 100 };
    }
    if (text.startsWith('Saved archive')) {
      return { title: 'Uploading archive', detail: '', percent: null };
    }
    if (text === 'Archive extracted.') {
      return { title: 'Archive extracted', detail: '', percent: null };
    }
    return { title: 'Uploading media', detail: text, percent: null };
  });
}

const CATALOG_FAILURE = /^(?:Catalog import failed:|Checksum mismatch|Size mismatch)/;

const CATALOG_DOWNLOADING = 'Downloading catalog asset:';
const CATALOG_PERCENT = /^Downloading catalog asset:\s+(\d+)%\s+\((\d+) \/ (\d+) bytes\)/;
const CATALOG_UNKNOWN_TOTAL = /^Downloading catalog asset:\s+(\d+) bytes downloaded$/;

/** `POST /api/import/media-catalog`. The server counts bytes; the detail shows MB. */
export function catalogProgress(line: string): Progress | ProgressFailure | null {
  return parseLine(line, CATALOG_FAILURE, (text) => {
    const importing = 'Importing catalog asset';
    const percent = CATALOG_PERCENT.exec(text);
    if (percent) {
      const detail = `${megabytes(Number(percent[2]))} / ${megabytes(Number(percent[3]))} MB`;
      return { title: importing, detail, percent: Number(percent[1]) };
    }
    const downloaded = CATALOG_UNKNOWN_TOTAL.exec(text);
    if (downloaded) {
      return {
        title: importing,
        detail: `${megabytes(Number(downloaded[1]))} MB downloaded`,
        percent: null,
      };
    }
    if (text.startsWith(CATALOG_DOWNLOADING)) {
      return { title: importing, detail: after(text, CATALOG_DOWNLOADING), percent: null };
    }
    if (text.startsWith('Saved catalog asset to ')) {
      return {
        title: 'Catalog asset saved',
        detail: after(text, 'Saved catalog asset to'),
        percent: 100,
      };
    }
    if (text === 'Catalog import complete.') {
      return { title: 'Catalog import complete', detail: '', percent: 100 };
    }
    return { title: importing, detail: text, percent: null };
  });
}

const YOUTUBE_FAILURE = /^YouTube import failed:/;

// The three phases print `Phase: N% (elapsed / total)`, or `Phase: <note>` before any progress.
// Capturing is only printed for a live stream, which validation refuses today.
const YOUTUBE_PHASES = [
  'Capturing YouTube clip',
  'Downloading YouTube video',
  'Preparing YouTube media',
].map((title) => ({ title, percent: new RegExp(`^${title}:\\s+(\\d+)%(?:\\s+\\(([^)]+)\\))?`) }));

/** `POST /api/import/youtube`. */
export function youtubeProgress(line: string): Progress | ProgressFailure | null {
  return parseLine(line, YOUTUBE_FAILURE, (text) => {
    for (const phase of YOUTUBE_PHASES) {
      const percent = phase.percent.exec(text);
      if (percent) {
        return { title: phase.title, detail: percent[2] ?? '', percent: Number(percent[1]) };
      }
      if (text.startsWith(`${phase.title}:`)) {
        return { title: phase.title, detail: after(text, `${phase.title}:`), percent: null };
      }
    }
    if (text.startsWith('Saved YouTube media to ')) {
      return {
        title: 'YouTube media saved',
        detail: after(text, 'Saved YouTube media to'),
        percent: 100,
      };
    }
    if (text === 'YouTube import complete.') {
      return { title: 'YouTube import complete', detail: '', percent: 100 };
    }
    return { title: 'Importing YouTube video', detail: text, percent: null };
  });
}

const PREPARE_PROGRESS = /^progress (\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/;
const PREPARE_ENCODING = /^Encoding .+ at (\d+) fps \((.+)\)\.\.\.$/;
const PREPARE_ERROR = /^Error:\s*/;

/**
 * `POST /api/mediasrc/prepare`. A line that is not one of the known ones is the title as it is
 * (the "waiting" and "no rendition needed" lines). An `Error:` line fails with its message
 * alone: the caller words the failure itself ("Encoding src3 at 15 fps failed ...").
 *
 * This parser keeps no state, but #170's display did: a `progress N/T` line only updated the
 * numbers and left the "Encoding 15 fps rendition…" title from the line before. Feed the lines
 * through `mergePrepareProgress` to get that.
 */
export function prepareProgress(line: string): Progress | ProgressFailure | null {
  const text = line.trim();
  if (!text) return null;
  if (PREPARE_ERROR.test(text)) return { failed: text.replace(PREPARE_ERROR, '') || EMPTY_ERROR };

  const progress = PREPARE_PROGRESS.exec(text);
  if (progress) {
    const seconds = Number(progress[1]);
    const total = Number(progress[2]);
    const known = total > 0;
    return {
      title: 'Encoding rendition…',
      detail: formatFpsProgress({ seconds, total: known ? total : null }),
      // Capped below 100: the rendition is not ready, and the stream not started, until the end.
      percent: known ? Math.min(99, Math.floor((seconds / total) * 100)) : null,
    };
  }
  const encoding = PREPARE_ENCODING.exec(text);
  if (encoding) {
    return {
      title: `Encoding ${encoding[1]} fps rendition…`,
      detail: encoding[2],
      percent: null,
      encoder: encoding[2],
    };
  }
  for (const title of ['Reusing rendition', 'Rendition ready']) {
    if (text.startsWith(`${title}:`))
      return { title, detail: after(text, `${title}:`), percent: null };
  }
  return { title: text, detail: '', percent: null };
}

const PREPARE_PROGRESS_TITLE = 'Encoding rendition…';

/**
 * The prepare display after `line`, given what it showed before (null at the start). A bare
 * `progress N/T` line keeps the earlier "Encoding 15 fps rendition…" title and takes the new
 * percent, with the time and the encoder as the detail ("0:25 / 1:00 · libx264"), as #170 did;
 * every other line replaces the display. A blank line leaves it as it was.
 */
export function mergePrepareProgress(
  previous: Progress | null,
  line: string,
): Progress | ProgressFailure | null {
  const next = prepareProgress(line);
  if (next === null) return previous;
  if (
    !isProgressFailure(next) &&
    next.title === PREPARE_PROGRESS_TITLE &&
    previous?.title.startsWith('Encoding ') &&
    previous.title !== PREPARE_PROGRESS_TITLE
  ) {
    const encoder = previous.encoder ? ` · ${previous.encoder}` : '';
    return { ...previous, percent: next.percent, detail: `${next.detail}${encoder}` };
  }
  return next;
}

// Lines the server prints that are not the diagnostics of a failure before them.
const SERVER_LINE =
  /^(?:Preparing file |Optimizing |Optimized |Keeping |Uploaded to |Saved |Archive extracted\.|Upload complete\.|No MP4 files found|Restarted |Could not restart |Downloading |Capturing |Preparing YouTube |Validating YouTube |YouTube import complete\.|Catalog import complete\.|Encoding |progress |Reusing rendition|Rendition ready|Waiting for another rendition|Source frame rate matches)/;

const isFailureLine = (text: string): boolean =>
  UPLOAD_FAILURE.test(text) ||
  CATALOG_FAILURE.test(text) ||
  YOUTUBE_FAILURE.test(text) ||
  PREPARE_ERROR.test(text);

/**
 * The message of the first failure in the lines of one finished response, or null when none
 * failed. It includes the diagnostic lines the server prints under a failure (yt-dlp's and
 * FFmpeg's last four), up to the next line the server prints itself, joined by line breaks. An
 * `Error:` line gives its message without the prefix, as `prepareProgress` does.
 */
export function failureText(lines: readonly string[]): string | null {
  const texts = lines.map((line) => line.trim()).filter(Boolean);
  const first = texts.findIndex(isFailureLine);
  if (first < 0) return null;

  const message = [texts[first].replace(PREPARE_ERROR, '') || EMPTY_ERROR];
  for (const text of texts.slice(first + 1)) {
    if (SERVER_LINE.test(text) || isFailureLine(text)) break;
    message.push(text);
  }
  return message.join('\n');
}

const RESTART_FAILED = 'Could not restart ';

/**
 * The line of a slot that an upload's Replace stopped and could not start again ("Could not
 * restart src4: <reason>"), or null for any other line. It is a warning, not a failure: the upload
 * is in place, but the slot it names is left stopped (ruling Q6).
 */
export function restartWarning(line: string): string | null {
  const text = line.trim();
  return text.startsWith(RESTART_FAILED) ? text : null;
}

// Where the server says it saved what a request brought in. An upload names the absolute path on
// the device, but uploads always land at the library's root (a file, or an archive's folder), so
// the last segment is the library path; the imports print the library path itself.
const SAVED_ABSOLUTE = ['Uploaded to ', 'Saved archive; extracting into '];
const SAVED_RELATIVE = ['Saved catalog asset to ', 'Saved YouTube media to '];

/** The library path a line says was saved, or null for any other line. */
export function savedPath(line: string): string | null {
  const text = line.trim();
  for (const prefix of SAVED_ABSOLUTE) {
    if (text.startsWith(prefix)) return after(text, prefix).split('/').pop() || null;
  }
  for (const prefix of SAVED_RELATIVE) {
    if (text.startsWith(prefix)) return after(text, prefix) || null;
  }
  return null;
}
