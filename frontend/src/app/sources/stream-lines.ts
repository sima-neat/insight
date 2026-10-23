import { HttpClient, HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import { catchError, defer, mergeMap, Observable, throwError } from 'rxjs';

/**
 * What a streamed text request reports, in order: the request body's upload progress (an upload
 * only), each line of the response as the server prints it, and `done` once the response ended.
 * `total` is null when the browser cannot tell the size of the upload.
 */
export type StreamEvent =
  | { kind: 'upload'; loaded: number; total: number | null }
  | { kind: 'line'; text: string }
  | { kind: 'done' };

/**
 * A non-2xx answer or a failed connection. `message` is the server's `error` or `message`;
 * `body` is its JSON body untouched (null when there was none), so a caller can read what the
 * message does not carry, such as the `conflict` of an upload's 409. `status` is 0 when the
 * server could not be reached.
 */
export class StreamRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'StreamRequestError';
  }
}

/**
 * Splits streamed text into lines. `pending` is the unfinished line carried over from the last
 * chunk (start with ''); the returned `pending` is the one to carry into the next. Blank lines
 * are dropped. Flush the last line, which has no break after it, with `splitLines(pending, '\n')`.
 */
export function splitLines(pending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = (pending + chunk).split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim() !== ''), pending: rest };
}

/**
 * POSTs `body` (JSON for an object, multipart for a `FormData`) and reads the text response line
 * by line while it arrives. Flask prints progress into these responses and keeps answering 200
 * when the work fails, so the lines, not the status, say how it went (see `progress-lines.ts`).
 *
 * Unsubscribing aborts the request, and the server stops its subprocesses when the connection
 * drops: that is how an import is cancelled.
 */
export function postStreamedText(
  http: HttpClient,
  url: string,
  body: FormData | object,
): Observable<StreamEvent> {
  return defer(() => {
    // `partialText` and the final body are both the whole text so far, not the part that is new:
    // `read` is how much of it has been split into lines already.
    let read = 0;
    let pending = '';

    const asEvents = (lines: string[]): StreamEvent[] =>
      lines.map((line) => ({ kind: 'line', text: line }));

    const linesIn = (text: string): StreamEvent[] => {
      const split = splitLines(pending, text.slice(read));
      read = text.length;
      pending = split.pending;
      return asEvents(split.lines);
    };

    return http
      .post(url, body, { observe: 'events', reportProgress: true, responseType: 'text' })
      .pipe(
        mergeMap((event: HttpEvent<string>): StreamEvent[] => {
          switch (event.type) {
            case HttpEventType.UploadProgress:
              return [{ kind: 'upload', loaded: event.loaded, total: event.total ?? null }];
            case HttpEventType.DownloadProgress:
              return event.partialText === undefined ? [] : linesIn(event.partialText);
            case HttpEventType.Response: {
              // The body also covers a response that arrived without any download progress.
              const lines = linesIn(event.body ?? '');
              // The last line has no break after it: the end of the response ends it.
              return [...lines, ...asEvents(splitLines(pending, '\n').lines), { kind: 'done' }];
            }
            default:
              return [];
          }
        }),
        // Anything that is not an HTTP answer (an interceptor's error, say) is not ours to reword.
        catchError((failure: unknown) =>
          throwError(() =>
            failure instanceof HttpErrorResponse ? requestError(failure) : failure,
          ),
        ),
      );
  });
}

function requestError(failure: HttpErrorResponse): StreamRequestError {
  const body = jsonBody(failure.error);
  const message = body?.['error'] || body?.['message'];
  if (typeof message === 'string' && message) {
    return new StreamRequestError(failure.status, message, body);
  }
  const fallback =
    failure.status === 0 ? 'Could not reach the server.' : `Request failed: ${failure.status}`;
  return new StreamRequestError(failure.status, fallback, body);
}

/** The body of an error answer, which arrives as text because the request asked for text. */
function jsonBody(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
