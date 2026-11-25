import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, throwError } from 'rxjs';
import { ApiRequestError, messageOf, withRequestErrors } from './api-errors';

describe('withRequestErrors', () => {
  /** What the operator makes of a failure, as a caller of a JSON request sees it. */
  const failureOf = (failure: unknown): Promise<unknown> =>
    firstValueFrom(throwError(() => failure).pipe(withRequestErrors())).catch(
      (error: unknown) => error,
    );

  it("reads the server's error shape, which Angular has parsed already, with its code and hint", async () => {
    const body = {
      error: {
        code: 'slot_busy',
        message: 'src2 is in use by an external publisher (rtsp 10.0.0.9).',
        hint: 'Use Take over to disconnect it.',
      },
    };
    const failure = await failureOf(
      new HttpErrorResponse({ status: 409, statusText: 'Conflict', error: body }),
    );

    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({
      status: 409,
      message: 'src2 is in use by an external publisher (rtsp 10.0.0.9).',
      code: 'slot_busy',
      hint: 'Use Take over to disconnect it.',
      body,
    });
    expect(messageOf(failure)).toBe(
      'src2 is in use by an external publisher (rtsp 10.0.0.9). Use Take over to disconnect it.',
    );
  });

  it('reads an error shape sent as text, as a request for text gets it', async () => {
    const body = { error: { code: 'slot_not_live', message: 'src3 is not live.' } };
    const failure = await failureOf(
      new HttpErrorResponse({ status: 409, error: JSON.stringify(body) }),
    );

    expect(failure).toMatchObject({ status: 409, message: 'src3 is not live.', body });
    expect(failure).toMatchObject({ code: 'slot_not_live', hint: null });
    expect(messageOf(failure)).toBe('src3 is not live.');
  });

  it('takes a body without the error shape for no message, and keeps it', async () => {
    const body = { error: 'not the shape', message: 'nor this' };
    const failure = await failureOf(new HttpErrorResponse({ status: 400, error: body }));

    expect(failure).toMatchObject({ status: 400, message: 'Request failed: 400', body });
    expect(failure).toMatchObject({ code: null, hint: null });
  });

  it('falls back to the status when the answer was not JSON, and when no answer came', async () => {
    expect(
      await failureOf(new HttpErrorResponse({ status: 502, error: '<html>Bad Gateway</html>' })),
    ).toMatchObject({ status: 502, message: 'Request failed: 502', body: null });
    expect(await failureOf(new HttpErrorResponse({ status: 0 }))).toMatchObject({
      status: 0,
      message: 'Could not reach the server.',
    });
  });

  it('does not take the event of a lost connection for a body', async () => {
    const failure = await failureOf(
      new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
    );
    expect(failure).toMatchObject({ status: 0, body: null });
  });

  it('leaves anything else as it is', async () => {
    const boom = new Error('boom');
    expect(await failureOf(boom)).toBe(boom);
  });
});
