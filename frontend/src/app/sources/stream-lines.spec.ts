import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, throwError } from 'rxjs';
import {
  ApiRequestError,
  messageOf,
  postStreamedText,
  splitLines,
  withRequestErrors,
  type StreamEvent,
} from './stream-lines';

describe('splitLines', () => {
  it('returns the complete lines and keeps the unfinished one pending', () => {
    expect(splitLines('', 'one\ntwo\nthr')).toEqual({ lines: ['one', 'two'], pending: 'thr' });
  });

  it('joins a line that spans two chunks', () => {
    const first = splitLines('', 'Optimizing clip.mp4: 4');
    expect(first).toEqual({ lines: [], pending: 'Optimizing clip.mp4: 4' });
    expect(splitLines(first.pending, '2% (00:10 / 00:25)\nnext')).toEqual({
      lines: ['Optimizing clip.mp4: 42% (00:10 / 00:25)'],
      pending: 'next',
    });
  });

  it('reads CRLF, also when the break falls between two chunks', () => {
    const first = splitLines('', 'one\r');
    expect(first).toEqual({ lines: [], pending: 'one\r' });
    expect(splitLines(first.pending, '\ntwo\r\n')).toEqual({ lines: ['one', 'two'], pending: '' });
  });

  it('skips blank lines', () => {
    expect(splitLines('', 'one\n\n  \ntwo\n')).toEqual({ lines: ['one', 'two'], pending: '' });
  });

  it('has nothing to return for an empty chunk', () => {
    expect(splitLines('half', '')).toEqual({ lines: [], pending: 'half' });
  });
});

describe('postStreamedText', () => {
  const URL = '/api/import/youtube';
  let http: HttpClient;
  let controller: HttpTestingController;
  let events: StreamEvent[];
  let error: unknown;
  let completed: boolean;
  let subscription: { unsubscribe(): void };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    events = [];
    error = undefined;
    completed = false;
  });

  afterEach(() => controller.verify());

  function post(body: object = { url: 'https://youtu.be/abc' }): TestRequest {
    subscription = postStreamedText(http, URL, body).subscribe({
      next: (event) => events.push(event),
      error: (e: unknown) => (error = e),
      complete: () => (completed = true),
    });
    return controller.expectOne(URL);
  }

  const download = (request: TestRequest, partialText: string) =>
    request.event({
      type: HttpEventType.DownloadProgress,
      loaded: partialText.length,
      partialText,
    });
  const finish = (request: TestRequest, body: string) => request.flush(body);

  it('posts JSON with progress events and text as the response type', () => {
    const request = post({ url: 'https://youtu.be/xyz' });

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ url: 'https://youtu.be/xyz' });
    expect(request.request.detectContentTypeHeader()).toBe('application/json');
    expect(request.request.reportProgress).toBe(true);
    expect(request.request.responseType).toBe('text');
    request.flush('');
  });

  it('emits each line once even when a line spans two chunks, then done', () => {
    const request = post();

    // partialText is cumulative: every event repeats what the one before carried.
    download(request, 'Validating YouTube video: abc\nDownloading YouTube video: 4');
    download(request, 'Validating YouTube video: abc\nDownloading YouTube video: 42%\nSav');
    download(
      request,
      'Validating YouTube video: abc\nDownloading YouTube video: 42%\nSaved YouTube media to a.mp4\n',
    );
    finish(
      request,
      'Validating YouTube video: abc\nDownloading YouTube video: 42%\nSaved YouTube media to a.mp4\n',
    );

    expect(events).toEqual([
      { kind: 'line', text: 'Validating YouTube video: abc' },
      { kind: 'line', text: 'Downloading YouTube video: 42%' },
      { kind: 'line', text: 'Saved YouTube media to a.mp4' },
      { kind: 'done' },
    ]);
    expect(completed).toBe(true);
  });

  it('flushes a last line that has no line break when the response ends', () => {
    const request = post();
    download(request, 'Saved YouTube media to a.mp4\nYouTube import comp');
    finish(request, 'Saved YouTube media to a.mp4\nYouTube import complete.');

    expect(events).toEqual([
      { kind: 'line', text: 'Saved YouTube media to a.mp4' },
      { kind: 'line', text: 'YouTube import complete.' },
      { kind: 'done' },
    ]);
  });

  it('reads the lines from the response when no download progress arrived', () => {
    const request = post();
    request.flush('YouTube import complete.\n');
    expect(events).toEqual([{ kind: 'line', text: 'YouTube import complete.' }, { kind: 'done' }]);
  });

  it('does not emit a line twice when the response repeats what progress already carried', () => {
    const request = post();
    download(request, 'one\ntwo\n');
    download(request, 'one\ntwo\n');
    finish(request, 'one\ntwo\n');
    expect(events.filter((event) => event.kind === 'line')).toHaveLength(2);
  });

  it('emits done for an empty response', () => {
    post().flush('');
    expect(events).toEqual([{ kind: 'done' }]);
  });

  it('errors with the JSON body of a refusal intact', () => {
    const refusal = { error: 'This video is a live stream.', live_status: 'is_live' };
    post().flush(JSON.stringify(refusal), { status: 400, statusText: 'Bad Request' });

    expect(error).toBeInstanceOf(ApiRequestError);
    const failure = error as ApiRequestError;
    expect(failure.status).toBe(400);
    expect(failure.message).toBe('This video is a live stream.');
    expect(failure.body).toEqual(refusal);
    expect(events).toEqual([]);
    expect(completed).toBe(false);
  });

  it('errors with the server message of a 500', () => {
    post().flush(JSON.stringify({ error: 'yt-dlp exploded' }), {
      status: 500,
      statusText: 'Internal Server Error',
    });
    expect(error).toMatchObject({ status: 500, message: 'yt-dlp exploded' });
  });

  it('reads the message from `message` when there is no `error`', () => {
    post().flush(JSON.stringify({ message: 'Try again' }), {
      status: 503,
      statusText: 'Unavailable',
    });
    expect(error).toMatchObject({ status: 503, message: 'Try again' });
  });

  it('falls back to the status when the body is not JSON', () => {
    post().flush('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' });
    expect(error).toMatchObject({ status: 502, message: 'Request failed: 502', body: null });
  });

  it('errors when the connection fails, after the lines already read', () => {
    const request = post();
    download(request, 'Downloading YouTube video: 12%\nDownloading YouTube video: 1');
    request.error(new ProgressEvent('error'));

    expect(events).toEqual([{ kind: 'line', text: 'Downloading YouTube video: 12%' }]);
    expect(error).toMatchObject({ status: 0, body: null, message: 'Could not reach the server.' });
  });

  it('aborts the request when the subscriber unsubscribes', () => {
    const request = post();
    download(request, 'one\n');
    subscription.unsubscribe();

    expect(request.cancelled).toBe(true);
    expect(events).toEqual([{ kind: 'line', text: 'one' }]);
  });

  it('starts each subscription with a fresh line buffer', () => {
    const lines$ = postStreamedText(http, URL, { url: 'https://youtu.be/abc' });
    const first: StreamEvent[] = [];
    const second: StreamEvent[] = [];

    lines$.subscribe((event) => first.push(event));
    controller.expectOne(URL).flush('a\nb');
    lines$.subscribe((event) => second.push(event));
    controller.expectOne(URL).flush('c\n');

    expect(first.filter((event) => event.kind === 'line')).toEqual([
      { kind: 'line', text: 'a' },
      { kind: 'line', text: 'b' },
    ]);
    expect(second.filter((event) => event.kind === 'line')).toEqual([{ kind: 'line', text: 'c' }]);
  });
});

describe('postStreamedText with an error that is not an HTTP answer', () => {
  it('passes it on as it is', () => {
    const boom = new Error('boom');
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([() => throwError(() => boom)]))],
    });
    let error: unknown;

    postStreamedText(TestBed.inject(HttpClient), '/api/x', {}).subscribe({
      error: (e: unknown) => (error = e),
    });

    expect(error).toBe(boom);
  });
});

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

  it("reads the old backend's error string, which has no code or hint", async () => {
    const body = { error: 'Not a YouTube link.' };
    const failure = await failureOf(new HttpErrorResponse({ status: 400, error: body }));

    expect(failure).toMatchObject({ status: 400, message: 'Not a YouTube link.', body });
    expect(failure).toMatchObject({ code: null, hint: null });
    expect(messageOf(failure)).toBe('Not a YouTube link.');
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
