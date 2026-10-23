import {
  HttpClient,
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
import { throwError } from 'rxjs';
import { postStreamedText, splitLines, StreamRequestError, type StreamEvent } from './stream-lines';

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
  const URL = '/api/mediasrc/prepare';
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

  function post(body: FormData | object = { index: 1 }): TestRequest {
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

  it('posts with progress events and text as the response type', () => {
    const body = new FormData();
    const request = post(body);

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBe(body);
    expect(request.request.reportProgress).toBe(true);
    expect(request.request.responseType).toBe('text');
    request.flush('');
  });

  it('sends an object as JSON', () => {
    const request = post({ index: 3 });
    expect(request.request.body).toEqual({ index: 3 });
    expect(request.request.detectContentTypeHeader()).toBe('application/json');
    request.flush('');
  });

  it('emits upload progress, then each line once even when a line spans two chunks, then done', () => {
    const request = post();

    request.event({ type: HttpEventType.UploadProgress, loaded: 512, total: 2048 });
    request.event({ type: HttpEventType.UploadProgress, loaded: 2048, total: 2048 });
    // partialText is cumulative: every event repeats what the one before carried.
    download(request, 'Preparing file 1/1: a.mp4\nOptimizing a.mp4: 4');
    download(request, 'Preparing file 1/1: a.mp4\nOptimizing a.mp4: 42% (00:10 / 00:25)\nOptim');
    download(
      request,
      'Preparing file 1/1: a.mp4\nOptimizing a.mp4: 42% (00:10 / 00:25)\nOptimized a.mp4\n',
    );
    finish(
      request,
      'Preparing file 1/1: a.mp4\nOptimizing a.mp4: 42% (00:10 / 00:25)\nOptimized a.mp4\n',
    );

    expect(events).toEqual([
      { kind: 'upload', loaded: 512, total: 2048 },
      { kind: 'upload', loaded: 2048, total: 2048 },
      { kind: 'line', text: 'Preparing file 1/1: a.mp4' },
      { kind: 'line', text: 'Optimizing a.mp4: 42% (00:10 / 00:25)' },
      { kind: 'line', text: 'Optimized a.mp4' },
      { kind: 'done' },
    ]);
    expect(completed).toBe(true);
  });

  it('reports an unknown upload size as null', () => {
    const request = post();
    request.event({ type: HttpEventType.UploadProgress, loaded: 100 });
    request.flush('');
    expect(events[0]).toEqual({ kind: 'upload', loaded: 100, total: null });
  });

  it('flushes a last line that has no line break when the response ends', () => {
    const request = post();
    download(request, 'Saved archive\nUpload comp');
    finish(request, 'Saved archive\nUpload complete.');

    expect(events).toEqual([
      { kind: 'line', text: 'Saved archive' },
      { kind: 'line', text: 'Upload complete.' },
      { kind: 'done' },
    ]);
  });

  it('reads the lines from the response when no download progress arrived', () => {
    const request = post();
    request.flush('Rendition ready: a\n');
    expect(events).toEqual([{ kind: 'line', text: 'Rendition ready: a' }, { kind: 'done' }]);
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

  it('errors with the JSON body of a 409 intact', () => {
    const conflict = {
      error: 'A file with this name exists.',
      conflict: { existing: 'a.mp4', suggested: 'a_2.mp4' },
    };
    post().flush(JSON.stringify(conflict), { status: 409, statusText: 'Conflict' });

    expect(error).toBeInstanceOf(StreamRequestError);
    const failure = error as StreamRequestError;
    expect(failure.status).toBe(409);
    expect(failure.message).toBe('A file with this name exists.');
    expect(failure.body).toEqual(conflict);
    expect(events).toEqual([]);
    expect(completed).toBe(false);
  });

  it('errors with the server message of a 500', () => {
    post().flush(JSON.stringify({ error: 'ffmpeg exploded' }), {
      status: 500,
      statusText: 'Internal Server Error',
    });
    expect(error).toMatchObject({ status: 500, message: 'ffmpeg exploded' });
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
    download(request, 'Encoding a.mp4 at 15 fps (libx264)...\nprogress 1.0');
    request.error(new ProgressEvent('error'));

    expect(events).toEqual([{ kind: 'line', text: 'Encoding a.mp4 at 15 fps (libx264)...' }]);
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
    const lines$ = postStreamedText(http, URL, { index: 1 });
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
