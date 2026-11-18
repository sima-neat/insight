import { HttpClient, HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import {
  catchError,
  defer,
  mergeMap,
  MonoTypeOperatorFunction,
  Observable,
  throwError,
} from 'rxjs';

/**
 * What a streamed text request reports, in order: each line of the response as the server prints
 * it, and `done` once the response ended.
 */
export type StreamEvent = { kind: 'line'; text: string } | { kind: 'done' };

/**
 * A non-2xx answer or a failed connection of any API request. `message` is the server's: the
 * `error.message` of the server's error shape (`{error: {code, message, hint?}}`), or the `error`
 * or `message` string the old backend's routes answer with. `body` is the JSON body untouched
 * (null when there was none), so a caller can read what the message does not carry, such as the
 * `conflict` of an upload's 409. `status` is 0 when the server could not be reached.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The error shape's `code`, a stable word to branch on; null for an answer without one. */
  get code(): string | null {
    return this.detail('code');
  }

  /** The error shape's `hint`, what to do about it; null when the server gave none. */
  get hint(): string | null {
    return this.detail('hint');
  }

  private detail(field: 'code' | 'hint'): string | null {
    const error = this.body?.['error'];
    if (typeof error !== 'object' || error === null) return null;
    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' && value ? value : null;
  }
}

/**
 * The message to show for a failure: an `Error`'s message (an `ApiRequestError` carries the
 * server's, followed by its hint when it has one), anything else as text. Every caller that
 * reports a failure words it this way.
 */
export function messageOf(failure: unknown): string {
  if (failure instanceof ApiRequestError && failure.hint) {
    return `${failure.message} ${failure.hint}`;
  }
  return failure instanceof Error ? failure.message : String(failure);
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
 * POSTs `body` as JSON and reads the text response line by line while it arrives: the old Flask
 * backend's YouTube import prints its progress into it and keeps answering 200 when the work
 * fails, so the lines, not the status, say how it went (see `progress-lines.ts`).
 *
 * Unsubscribing aborts the request, and the server stops its subprocesses when the connection
 * drops: that is how an import is cancelled.
 */
export function postStreamedText(
  http: HttpClient,
  url: string,
  body: object,
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
        withRequestErrors(),
      );
  });
}

/**
 * Makes a failed request throw a `ApiRequestError` for an HTTP answer or a lost connection,
 * and anything else (an interceptor's error, say) as it is, since it is not ours to reword. Every
 * call to the API reports its failures this way, JSON or streamed.
 */
export function withRequestErrors<T>(): MonoTypeOperatorFunction<T> {
  return catchError((failure: unknown) =>
    throwError(() => (failure instanceof HttpErrorResponse ? requestError(failure) : failure)),
  );
}

function requestError(failure: HttpErrorResponse): ApiRequestError {
  const body = jsonBody(failure.error);
  const message = serverMessage(body);
  if (message) {
    return new ApiRequestError(failure.status, message, body);
  }
  const fallback =
    failure.status === 0 ? 'Could not reach the server.' : `Request failed: ${failure.status}`;
  return new ApiRequestError(failure.status, fallback, body);
}

/**
 * The message an error body carries: the server's error shape names it `error.message`; the old
 * backend's routes answer `error` or `message` as a string. Null when there is none.
 */
function serverMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.['error'];
  const message =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['message']
      : error || body?.['message'];
  return typeof message === 'string' && message ? message : null;
}

/**
 * The JSON object an error answer carries. It arrives as text when the request asked for text, as
 * the parsed object when the request expected JSON, and as text again when that was not JSON. A
 * failed connection carries a `ProgressEvent` instead, which is no body: only a plain object is.
 */
function jsonBody(body: unknown): Record<string, unknown> | null {
  let parsed = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return typeof parsed === 'object' &&
    parsed !== null &&
    Object.getPrototypeOf(parsed) === Object.prototype
    ? (parsed as Record<string, unknown>)
    : null;
}
