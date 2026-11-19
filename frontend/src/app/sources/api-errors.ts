import { HttpErrorResponse } from '@angular/common/http';
import { catchError, MonoTypeOperatorFunction, throwError } from 'rxjs';

/**
 * A non-2xx answer or a failed connection of any API request. `message` is the server's: the
 * `error.message` of the server's error shape (`{error: {code, message, hint?}}`). `body` is the
 * JSON body untouched (null when there was none), so a caller can read what the message does not
 * carry, such as the `conflict` of an upload's 409. `status` is 0 when the server could not be
 * reached.
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
 * Makes a failed request throw an `ApiRequestError` for an HTTP answer or a lost connection,
 * and anything else (an interceptor's error, say) as it is, since it is not ours to reword. Every
 * call to the API reports its failures this way.
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

/** The message of the server's error shape, `error.message`; null when the body has none. */
function serverMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.['error'];
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as Record<string, unknown>)['message'];
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
