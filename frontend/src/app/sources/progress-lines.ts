/**
 * Parsers for the progress lines the old Flask backend prints into the YouTube import's streamed
 * text response, the one import that still reports this way (the server's uploads and catalog
 * imports are jobs, `jobs.ts`). Each takes one line, as `postStreamedText` emits them, and
 * returns what to show: a title, a detail and a percent (null while indeterminate), or the
 * failure the line reports.
 *
 * The server answers HTTP 200 even when the import fails, so a failure arrives as a line and these
 * parsers are the only way to tell it from a success. What a caller must do, because the lines
 * alone do not say it:
 * - **A failure spans several lines.** yt-dlp and FFmpeg failures print up to four diagnostic
 *   lines after the first, which would parse as ordinary progress and overwrite a failure shown
 *   from the first line. Collect the request's lines and take the full message from
 *   `failureText` once the stream is done.
 * - **A failed import may still have saved the file.** Refresh the media library after every
 *   import, whatever its outcome.
 * - **Titles carry no scope or subject** (the target): the caller knows it, and the server's own
 *   lines carry what it knows.
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

/** The text after a `Prefix:` the line is known to start with. */
const after = (line: string, prefix: string): string => line.slice(prefix.length).trim();

const YOUTUBE_FAILURE = /^YouTube import failed:/;

/** Where the server says it saved the import, followed by the library path itself. */
const SAVED = 'Saved YouTube media to ';

// The three phases print `Phase: N% (elapsed / total)`, or `Phase: <note>` before any progress.
// Capturing is only printed for a live stream, which validation refuses today.
const YOUTUBE_PHASES = [
  'Capturing YouTube clip',
  'Downloading YouTube video',
  'Preparing YouTube media',
].map((title) => ({ title, percent: new RegExp(`^${title}:\\s+(\\d+)%(?:\\s+\\(([^)]+)\\))?`) }));

/** `POST /api/import/youtube`. */
export function youtubeProgress(line: string): Progress | ProgressFailure | null {
  const text = line.trim();
  if (!text) return null;
  if (YOUTUBE_FAILURE.test(text)) return { failed: text };
  for (const phase of YOUTUBE_PHASES) {
    const percent = phase.percent.exec(text);
    if (percent) {
      return { title: phase.title, detail: percent[2] ?? '', percent: Number(percent[1]) };
    }
    if (text.startsWith(`${phase.title}:`)) {
      return { title: phase.title, detail: after(text, `${phase.title}:`), percent: null };
    }
  }
  if (text.startsWith(SAVED)) {
    return { title: 'YouTube media saved', detail: after(text, SAVED), percent: 100 };
  }
  if (text === 'YouTube import complete.') {
    return { title: 'YouTube import complete', detail: '', percent: 100 };
  }
  return { title: 'Importing YouTube video', detail: text, percent: null };
}

// Lines the server prints that are not the diagnostics of a failure before them.
const SERVER_LINE =
  /^(?:Downloading |Capturing |Preparing YouTube |Validating YouTube |Saved |YouTube import complete\.)/;

/**
 * The message of the first failure in the lines of one finished response, or null when none
 * failed. It includes the diagnostic lines the server prints under a failure (yt-dlp's and
 * FFmpeg's last four), up to the next line the server prints itself, joined by line breaks.
 */
export function failureText(lines: readonly string[]): string | null {
  const texts = lines.map((line) => line.trim()).filter(Boolean);
  const first = texts.findIndex((text) => YOUTUBE_FAILURE.test(text));
  if (first < 0) return null;

  const message = [texts[first]];
  for (const text of texts.slice(first + 1)) {
    if (SERVER_LINE.test(text) || YOUTUBE_FAILURE.test(text)) break;
    message.push(text);
  }
  return message.join('\n');
}

/** The library path a line says was saved, or null for any other line. */
export function savedPath(line: string): string | null {
  const text = line.trim();
  return text.startsWith(SAVED) ? after(text, SAVED) || null : null;
}
