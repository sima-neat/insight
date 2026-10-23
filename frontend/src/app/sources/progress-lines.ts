/**
 * Parsers for the progress lines Flask prints into its streamed text responses (Inv-SM section 4).
 * Each takes one line, as `postStreamedText` emits them, and returns what to show: a title, a
 * detail and a percent (null while indeterminate), or the failure the line reports.
 *
 * The server answers HTTP 200 even when an upload or import fails, so a failure arrives as a line
 * and these parsers are the only way to tell it from a success. Every line the server prints on a
 * failure is matched; #170 matched only two of the upload ones and showed the rest as success.
 *
 * Titles carry no scope or subject ("1/3", the file's name): the caller knows both and the
 * server's own lines carry what it knows.
 */

export interface Progress {
  title: string;
  detail: string;
  /** 0..100, or null while the length of the work is unknown. */
  percent: number | null;
}

export interface ProgressFailure {
  /** The server's message, ready to show. */
  failed: string;
}

export function isProgressFailure(result: Progress | ProgressFailure): result is ProgressFailure {
  return 'failed' in result;
}

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
// was not prepared, which #170 already treated as failed for FFmpeg.
const UPLOAD_FAILURE =
  /^(?:No file provided\.|Failed to extract archive:|FFmpeg conversion failed|FFmpeg is not installed|FFprobe is not installed)/;

const OPTIMIZING_PERCENT = /^Optimizing .*?:\s+(\d+)%\s+\(([^)]+)\)/;
const OPTIMIZING_ELAPSED = /^Optimizing .*?:\s+(.+ processed)$/;
const OPTIMIZING_START = /^Optimizing (.+?) for low-latency/;
const OPTIMIZED = /^Optimized (.+?):/;

/** `POST /api/upload/media`. */
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
 */
export function prepareProgress(line: string): Progress | ProgressFailure | null {
  const text = line.trim();
  if (!text) return null;
  if (PREPARE_ERROR.test(text)) return { failed: text.replace(PREPARE_ERROR, '') };

  const progress = PREPARE_PROGRESS.exec(text);
  if (progress) {
    const seconds = Number(progress[1]);
    const total = Number(progress[2]);
    const known = total > 0;
    return {
      title: 'Encoding rendition…',
      detail: known ? `${progress[1]} / ${progress[2]} s` : `${progress[1]} s`,
      // Capped below 100: the rendition is not ready, and the stream not started, until the end.
      percent: known ? Math.min(99, Math.floor((seconds / total) * 100)) : null,
    };
  }
  const encoding = PREPARE_ENCODING.exec(text);
  if (encoding) {
    return { title: `Encoding ${encoding[1]} fps rendition…`, detail: encoding[2], percent: null };
  }
  for (const title of ['Reusing rendition', 'Rendition ready']) {
    if (text.startsWith(`${title}:`))
      return { title, detail: after(text, `${title}:`), percent: null };
  }
  return { title: text, detail: '', percent: null };
}
