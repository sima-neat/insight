import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { boardUrl } from '../board/api';
import { BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { boardWith, DEVKIT, FakeBoard, MANUAL } from '../board/board.testing';
import type { PreviewSession } from './api';
import { CameraPreview } from './camera-preview';
import { imx477, previewSession, sel, usb } from './cameras.testing';
import { PREVIEW_POLL_MS, previewUrl } from './preview-state';

const BOARD = DEVKIT.id;
const PREVIEW_URL = boardUrl(BOARD, 'cameras/preview');
const startUrl = (camera = imx477.id) =>
  boardUrl(BOARD, `cameras/${encodeURIComponent(camera)}/preview`);
const stopUrl = (session: PreviewSession) =>
  `${previewUrl(session, '/stop')}?preview=${encodeURIComponent(session.id)}`;
/** The error shape the server answers with. */
const failure = (code: string, message: string) => ({ error: { code, message } });

const mode30 = sel('NV12', 1920, 1080, 30);
const mode60 = sel('NV12', 1920, 1080, 60);
const live30 = previewSession();
const live60 = previewSession({ id: '9a2d', mode: mode60 });
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** Lets the promise chains behind a flushed request run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('CameraPreview', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let preview: CameraPreview;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    board = new FakeBoard();
    board.state.set(boardWith(DEVKIT));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        CameraPreview,
        { provide: BoardService, useValue: board },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    preview = TestBed.inject(CameraPreview);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Answers the preview read the watch sends, with the board's current preview. */
  async function answerRead(session: PreviewSession | null): Promise<void> {
    http.expectOne({ method: 'GET', url: PREVIEW_URL }).flush({ preview: session });
    await settle();
  }

  /** Answers the start sent last, after checking the camera and mode it asked for. */
  async function answerStart(session: PreviewSession, wanted = mode30): Promise<void> {
    const request = http.expectOne({ method: 'POST', url: startUrl() });
    expect(request.request.body).toEqual(wanted);
    request.flush({ preview: session });
    await settle();
  }

  /** Expects the stop of `session`, which names it by its id. */
  function expectStop(session: PreviewSession) {
    return http.expectOne(
      (request) => request.method === 'POST' && request.urlWithParams === stopUrl(session),
    );
  }

  async function answerStop(session: PreviewSession): Promise<void> {
    expectStop(session).flush({ preview: null });
    await settle();
  }

  /** A live preview of the imx477 in 1920×1080 at 30 fps, started elsewhere and taken up here. */
  async function adoptLive(session: PreviewSession = live30): Promise<void> {
    preview.adopt(session);
    await answerRead(session);
  }

  it("reads the board's running preview, and rejects when it cannot", async () => {
    const found = preview.current();
    const answered: Partial<PreviewSession> = { ...live30 };
    delete answered.board;
    http.expectOne({ method: 'GET', url: PREVIEW_URL }).flush({ preview: answered });
    // The preview names the board it was read from.
    await expect(found).resolves.toEqual(live30);

    const none = preview.current();
    http.expectOne(PREVIEW_URL).flush({ preview: null });
    await expect(none).resolves.toBeNull();

    const failed = preview.current();
    http.expectOne(PREVIEW_URL).flush(failure('unreachable', 'Bad gateway'), badGateway);
    await expect(failed).rejects.toBeInstanceOf(BoardProblem);

    // No board selected: nothing to read.
    board.state.set(null);
    await expect(preview.current()).resolves.toBeNull();
  });

  it('starts the camera in the mode asked for and shows the session live', async () => {
    const started = preview.start(imx477, mode30, BOARD);
    expect(preview.state().status).toBe('starting');
    await answerStart(live30);
    await started;
    expect(preview.state()).toEqual({ status: 'live', session: live30, error: null });
    await answerRead(live30);
  });

  it('watches a live preview every 2.5 s while the page shows, passes on its rate and ends it once gone', async () => {
    await adoptLive();
    vi.advanceTimersByTime(PREVIEW_POLL_MS - 1);
    http.expectNone(PREVIEW_URL);
    vi.advanceTimersByTime(1);
    await answerRead({ ...live30, camera_fps: 66.18 });
    expect(preview.state().session?.camera_fps).toBe(66.18);

    // A hidden tab reads nothing, and reads at once when it shows again.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 4);
    http.expectNone(PREVIEW_URL);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await answerRead(null);
    expect(preview.state().status).toBe('idle');
    expect(preview.state().error?.message).toBe('The preview stream stopped.');

    // Nothing is left to watch.
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 4);
    http.expectNone(PREVIEW_URL);
  });

  it('a start refused because another tab started a preview adopts that preview', async () => {
    const other = { ...live30, viewer: true };
    const started = preview.start(imx477, mode30, BOARD);
    http
      .expectOne({ method: 'POST', url: startUrl() })
      .flush(failure('preview_active', 'A preview is already running.'), {
        status: 409,
        statusText: 'Conflict',
      });
    await settle();
    await answerRead(other);
    await started;
    expect(preview.state()).toEqual({ status: 'elsewhere', session: other, error: null });
    // A preview shown in another tab is watched too, so this one returns to idle when it ends there.
    await answerRead(other);
  });

  // The page shows every adopted preview, on entry and after a refused start.
  it('an adopted preview is shown by the page first, and one the page cannot show is not adopted', async () => {
    const shown: PreviewSession[] = [];
    let canShow = false;
    preview.onAdopt((session) => {
      shown.push(session);
      return canShow;
    });
    const webcam = { ...live30, id: 'c270', camera: usb.id };
    const refuse = () =>
      http
        .expectOne({ method: 'POST', url: startUrl() })
        .flush(failure('preview_active', 'A preview is already running.'), {
          status: 409,
          statusText: 'Conflict',
        });

    // Not shown: the refusal stays, and nothing is stopped or watched.
    let started = preview.start(imx477, mode30, BOARD);
    refuse();
    await settle();
    await answerRead(webcam);
    await started;
    expect(shown).toEqual([webcam]);
    expect(preview.adopt(webcam)).toBe(false);
    expect(preview.state().status).toBe('error');
    expect(preview.state().error?.code).toBe('preview_active');
    expect(preview.camera()).toBe(imx477.id);

    // Shown: taken up, its camera now the preview's.
    canShow = true;
    started = preview.start(imx477, mode30, BOARD);
    refuse();
    await settle();
    await answerRead(webcam);
    await started;
    expect(shown).toEqual([webcam, webcam, webcam]);
    expect(preview.state()).toEqual({ status: 'live', session: webcam, error: null });
    expect(preview.camera()).toBe(usb.id);
    await answerRead(webcam);
  });

  it('a mode change restarts the live preview on the new mode, and only the camera it shows', async () => {
    await adoptLive();
    // Another camera's menus and the mode already streaming leave the preview alone.
    await preview.changeMode(usb, sel('MJPG', 640, 480, 30));
    await preview.changeMode(imx477, mode30);
    http.expectNone(() => true);
    expect(preview.state().status).toBe('live');

    const changed = preview.changeMode(imx477, mode60);
    expect(preview.state().status).toBe('stopping');
    await answerStop(live30);
    await answerStart(live60, mode60);
    await changed;
    expect(preview.state()).toEqual({ status: 'live', session: live60, error: null });
    await answerRead(live60);
  });

  it('a start that answers for a mode no longer shown is stopped and the shown mode started', async () => {
    const started = preview.start(imx477, mode30, BOARD);
    // Picked while the board was starting 30 fps; nothing to stop yet.
    await preview.changeMode(imx477, mode60);
    http.expectNone((request) => request.urlWithParams === stopUrl(live30));
    await answerStart(live30);
    await answerStop(live30);
    await answerStart(live60, mode60);
    await started;
    expect(preview.state().session?.id).toBe(live60.id);
    await answerRead(live60);
  });

  it('a stream error shows the preview in another tab when a viewer claimed it, else as stopped', async () => {
    await adoptLive({ ...live30, viewer: false });
    const failed = preview.streamFailed();
    await answerRead({ ...live30, viewer: true });
    await failed;
    expect(preview.state().status).toBe('elsewhere');
    expect(preview.state().error).toBeNull();

    preview.adopt({ ...live60, viewer: false });
    await answerRead(live60);
    const ended = preview.streamFailed();
    await answerRead(null);
    await ended;
    expect(preview.state().status).toBe('idle');
    expect(preview.state().error?.code).toBe('stream_ended');
  });

  it('a board change ends the shown preview without an error, since the server stopped it', async () => {
    await adoptLive();
    board.state.set(boardWith(MANUAL));
    TestBed.tick();
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
  });

  it('Stop posts the stop; a stop that fails keeps the preview and says why, so it can be retried', async () => {
    await adoptLive();
    const stopping = preview.stop();
    expect(preview.state().status).toBe('stopping');
    expectStop(live30).flush(failure('unreachable', 'SSH failed'), badGateway);
    await stopping;
    expect(preview.state().status).toBe('live');
    expect(preview.state().error?.message).toBe('SSH failed');
    await answerRead(live30);

    const retried = preview.stop();
    expectStop(live30).flush({ preview: null });
    await retried;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
  });

  it('Stop while the board starts the preview reads as stopping and stops the session once it answers', async () => {
    const started = preview.start(imx477, mode30, BOARD);
    await preview.stop();
    expect(preview.state().status).toBe('stopping');
    await answerStart(live30);
    await answerStop(live30);
    await started;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
  });

  it('a start refused because the board is no longer the selected one reads the boards again', async () => {
    // A client changed the board while this window kept the focus, so no focus re-read came.
    const started = preview.start(imx477, mode30, BOARD);
    http
      .expectOne({ method: 'POST', url: startUrl() })
      .flush(failure('not_found', `${BOARD} is not the selected board.`), {
        status: 404,
        statusText: 'Not Found',
      });
    await started;
    expect(board.reload).toHaveBeenCalledTimes(1);
    expect(preview.state().status).toBe('error');
    expect(preview.state().error?.code).toBe('not_found');
  });

  it('a stop the server answers for a board no longer selected ends the preview there', async () => {
    await adoptLive();
    const stopping = preview.stop();
    expectStop(live30).flush(failure('not_found', 'Not the selected board.'), {
      status: 404,
      statusText: 'Not Found',
    });
    await stopping;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    expect(board.reload).toHaveBeenCalledTimes(1);
  });

  it('a board change while the board starts the preview stops the late session and starts nothing', async () => {
    const started = preview.start(imx477, mode30, BOARD);
    board.state.set(boardWith(MANUAL));
    TestBed.tick();
    await answerStart(live30);
    await answerStop(live30);
    await started;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    http.expectNone({ method: 'POST', url: startUrl() });
    // The page already knows of the change, so there is nothing to re-read.
    expect(board.reload).not.toHaveBeenCalled();
  });

  it('a failed Stop of a preview shown in another tab keeps it there with the failure', async () => {
    const shown = { ...live30, viewer: true };
    await adoptLive(shown);
    const stopping = preview.stop();
    expectStop(shown).flush(failure('unreachable', 'SSH failed'), badGateway);
    await stopping;
    expect(preview.state().status).toBe('elsewhere');
    expect(preview.state().error?.message).toBe('SSH failed');
    await answerRead(shown);

    // Still the other tab's: leaving only lets it go, and a mode change does not restart it.
    await preview.changeMode(imx477, mode60);
    http.expectNone(() => true);
    preview.release();
    expect(preview.state().status).toBe('idle');
    http.expectNone(() => true);
  });

  it("leaving the camera stops this page's preview and a start once it answers, and only forgets one in another tab", async () => {
    await adoptLive();
    const left = preview.leave();
    expect(preview.state().status).toBe('stopping');
    await answerStop(live30);
    await left;
    expect(preview.state().status).toBe('idle');

    const started = preview.start(imx477, mode30, BOARD);
    await preview.leave();
    expect(preview.state().status).toBe('stopping');
    await answerStart(live30);
    await answerStop(live30);
    await started;
    expect(preview.state().status).toBe('idle');
    http.expectNone({ method: 'POST', url: startUrl() });

    await adoptLive({ ...live30, viewer: true });
    await preview.leave();
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    http.expectNone(() => true);
  });

  it("camera names the camera of the page's preview: a start's before it answers, the session's after, none once stopped", async () => {
    expect(preview.camera()).toBeNull();
    const started = preview.start(usb, sel('MJPG', 1280, 720, 30), BOARD);
    // No session yet: the camera is the one the start was asked for.
    expect(preview.camera()).toBe(usb.id);
    http
      .expectOne({ method: 'POST', url: startUrl(usb.id) })
      .flush(failure('camera_in_use', 'Camera busy'), badGateway);
    await started;
    // A failed start stays that camera's, with its failure.
    expect(preview.state().status).toBe('error');
    expect(preview.camera()).toBe(usb.id);

    await adoptLive();
    expect(preview.camera()).toBe(imx477.id);
    const stopping = preview.stop();
    // While it stops, the session still names its camera.
    expect(preview.camera()).toBe(imx477.id);
    await answerStop(live30);
    await stopping;
    expect(preview.camera()).toBeNull();
  });

  it('release stops a live preview and a start still in flight once its session id arrives', async () => {
    await adoptLive();
    preview.release();
    await answerStop(live30);
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
    http.expectNone(PREVIEW_URL);

    // Leaving while the board starts a preview (another visit's controller): its session is stopped
    // the moment it answers, not left to the server's 15 s reaper, and nothing is started again.
    const leaving = TestBed.runInInjectionContext(() => new CameraPreview());
    const started = leaving.start(imx477, mode30, BOARD);
    leaving.release();
    http.expectNone((request) => request.urlWithParams === stopUrl(live30));
    await answerStart(live30);
    await answerStop(live30);
    await started;
    expect(leaving.state().status).toBe('idle');
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
    http.expectNone(() => true);

    // A stop on leaving that fails puts the preview back to live, but the page is gone: nothing is
    // read for it any more (closing its stream with the page stops it on the board).
    const failing = TestBed.runInInjectionContext(() => new CameraPreview());
    failing.adopt(live30);
    await answerRead(live30);
    failing.release();
    expectStop(live30).flush(failure('unreachable', 'SSH failed'), badGateway);
    await settle();
    expect(failing.state().status).toBe('live');
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
    http.expectNone(PREVIEW_URL);
  });

  it('release only forgets a preview shown in another tab', async () => {
    await adoptLive({ ...live30, viewer: true });
    expect(preview.state().status).toBe('elsewhere');
    preview.release();
    expect(preview.state().status).toBe('idle');
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
    http.expectNone(() => true);
  });

  // Coming back to Peripherals while the last visit's start is still out: the next visit waits
  // for this before it reads the preview and starts it again.
  it("release settles once this page's preview has stopped, a start still in flight included", async () => {
    let settled = false;
    const started = preview.start(imx477, mode30, BOARD);
    void preview.release().then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);
    await answerStart(live30);
    expect(settled).toBe(false);
    await answerStop(live30);
    await started;
    expect(settled).toBe(true);

    // A live preview: settled once its stop answered, failed or not.
    const live = TestBed.runInInjectionContext(() => new CameraPreview());
    live.adopt(live30);
    await answerRead(live30);
    let stopped = false;
    void live.release().then(() => (stopped = true));
    await settle();
    expect(stopped).toBe(false);
    expectStop(live30).flush(failure('unreachable', 'SSH failed'), badGateway);
    await settle();
    expect(stopped).toBe(true);

    // Nothing to stop: settled at once.
    const idle = TestBed.runInInjectionContext(() => new CameraPreview());
    await expect(idle.release()).resolves.toBeUndefined();
  });

  it('resumable names the camera, mode and board of a preview this page starts or shows live, and nothing else', async () => {
    expect(preview.resumable()).toBeNull();

    // Starting: what was asked for, on the board shown.
    const started = preview.start(imx477, mode30, BOARD);
    expect(preview.resumable()).toEqual({ cameraId: imx477.id, mode: mode30, board: BOARD });
    await answerStart(live30);
    await started;
    // Live: what the board streams.
    expect(preview.resumable()).toEqual({ cameraId: imx477.id, mode: mode30, board: BOARD });
    await answerRead(live30);

    const stopping = preview.stop();
    expect(preview.resumable()).toBeNull();
    await answerStop(live30);
    await stopping;
    expect(preview.resumable()).toBeNull();

    // Another tab's preview is that tab's to keep.
    await adoptLive({ ...live30, viewer: true });
    expect(preview.resumable()).toBeNull();
    preview.release();
  });

  it('Stop while a stop is out settles with that stop, and so does release after it', async () => {
    await adoptLive();
    const first = preview.stop();
    let second = false;
    void preview.stop().then(() => (second = true));
    await settle();
    expect(second).toBe(false);
    await answerStop(live30);
    await first;
    expect(second).toBe(true);

    // Stop pressed, then the page left while the stop is out: the next visit waits for it.
    const leaving = TestBed.runInInjectionContext(() => new CameraPreview());
    leaving.adopt(live30);
    await answerRead(live30);
    void leaving.stop();
    let released = false;
    void leaving.release().then(() => (released = true));
    await settle();
    expect(released).toBe(false);
    await answerStop(live30);
    expect(released).toBe(true);
  });
});
