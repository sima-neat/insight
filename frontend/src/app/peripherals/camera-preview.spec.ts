import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { boardState, DEVKIT, FakeBoard } from '../board/board.testing';
import type { PreviewSession } from './api';
import { CameraPreview } from './camera-preview';
import { imx477, previewSession, sel, usb } from './cameras.testing';
import { PREVIEW_POLL_MS } from './preview-state';

const PREVIEW_URL = '/api/peripherals/preview';
const START_URL = '/api/peripherals/cameras/preview';
const stopUrl = (id: string) => `/api/peripherals/cameras/preview/${id}/stop`;

const mode30 = sel('NV12', 1920, 1080, 30);
const mode60 = sel('NV12', 1920, 1080, 60);
const live30 = previewSession();
const live60 = previewSession({
  id: '9a2d',
  mode: mode60,
  stream_url: '/api/peripherals/cameras/preview/9a2d/stream',
});
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
    board.state.set(boardState({ target: DEVKIT, generation: 3 }));
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

  /** Answers the preview read the watch sends, with the backend's current session. */
  async function answerRead(session: PreviewSession | null): Promise<void> {
    http.expectOne({ method: 'GET', url: PREVIEW_URL }).flush({ session });
    await settle();
  }

  /** Answers the start sent last, after checking the camera and mode it asked for. */
  async function answerStart(session: PreviewSession, wanted = mode30): Promise<void> {
    const request = http.expectOne({ method: 'POST', url: START_URL });
    expect(request.request.body).toEqual({ id: imx477.id, ...wanted });
    request.flush({ session });
    await settle();
  }

  async function answerStop(id: string): Promise<void> {
    http.expectOne({ method: 'POST', url: stopUrl(id) }).flush({ session: null });
    await settle();
  }

  /** A live preview of the imx477 in 1920×1080 at 30 fps, started elsewhere and taken up here. */
  async function adoptLive(session: PreviewSession = live30): Promise<void> {
    preview.adopt(session);
    await answerRead(session);
  }

  it('reads the running preview from GET /api/peripherals/preview, and rejects when it cannot', async () => {
    const found = preview.current();
    http.expectOne({ method: 'GET', url: PREVIEW_URL }).flush({ session: live30 });
    await expect(found).resolves.toEqual(live30);

    const none = preview.current();
    http.expectOne(PREVIEW_URL).flush({ session: null });
    await expect(none).resolves.toBeNull();

    const failed = preview.current();
    http.expectOne(PREVIEW_URL).flush({ error: 'Bad gateway', code: 'unreachable' }, badGateway);
    await expect(failed).rejects.toBeInstanceOf(BoardProblem);
  });

  it('starts the camera in the mode asked for and shows the session live', async () => {
    const started = preview.start(imx477, mode30, 3);
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
    const started = preview.start(imx477, mode30, 3);
    http
      .expectOne({ method: 'POST', url: START_URL })
      .flush(
        { error: 'A preview is already running.', code: 'preview_active', camera_id: imx477.id },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    await answerRead(other);
    await started;
    expect(preview.state()).toEqual({ status: 'elsewhere', session: other, error: null });
    // A preview shown in another tab is watched too, so this one returns to idle when it ends there.
    await answerRead(other);
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
    await answerStop(live30.id);
    await answerStart(live60, mode60);
    await changed;
    expect(preview.state()).toEqual({ status: 'live', session: live60, error: null });
    await answerRead(live60);
  });

  it('a start that answers for a mode no longer shown is stopped and the shown mode started', async () => {
    const started = preview.start(imx477, mode30, 3);
    // Picked while the board was starting 30 fps; nothing to stop yet.
    await preview.changeMode(imx477, mode60);
    http.expectNone({ method: 'POST', url: stopUrl(live30.id) });
    await answerStart(live30);
    await answerStop(live30.id);
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

  it('a board change ends the shown preview without an error, since the backend stopped it', async () => {
    await adoptLive();
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    TestBed.tick();
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
  });

  it('Stop posts the stop; a stop that fails keeps the preview and says why, so it can be retried', async () => {
    await adoptLive();
    const stopping = preview.stop();
    expect(preview.state().status).toBe('stopping');
    http
      .expectOne({ method: 'POST', url: stopUrl(live30.id) })
      .flush({ error: 'SSH failed', code: 'unreachable' }, badGateway);
    await stopping;
    expect(preview.state().status).toBe('live');
    expect(preview.state().error?.message).toBe('SSH failed');
    await answerRead(live30);

    const retried = preview.stop();
    http.expectOne(stopUrl(live30.id)).flush({ session: { ...live30, state: 'stopped' } });
    await retried;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
  });

  it('Stop while the board starts the preview reads as stopping and stops the session once it answers', async () => {
    const started = preview.start(imx477, mode30, 3);
    await preview.stop();
    expect(preview.state().status).toBe('stopping');
    await answerStart(live30);
    await answerStop(live30.id);
    await started;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
  });

  it('a start answered for a board generation the page does not know is stopped once and the board re-read', async () => {
    // The page shows generation 3; the backend already runs 4 (Insight restarted, or a client
    // changed the board while this window kept the focus, so no focus re-read came).
    const started = preview.start(imx477, mode30, 3);
    await answerStart(previewSession({ generation: 4 }));
    expect(board.reload).toHaveBeenCalledTimes(1);
    await answerStop(live30.id);
    await started;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    http.expectNone({ method: 'POST', url: START_URL });
  });

  it('a board change while the board starts the preview stops the late session and starts nothing', async () => {
    const started = preview.start(imx477, mode30, 3);
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    TestBed.tick();
    await answerStart(live30);
    await answerStop(live30.id);
    await started;
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    http.expectNone({ method: 'POST', url: START_URL });
    // The page already knows of the change, so there is nothing to re-read.
    expect(board.reload).not.toHaveBeenCalled();
  });

  it('a failed Stop of a preview shown in another tab keeps it there with the failure', async () => {
    const shown = { ...live30, viewer: true };
    await adoptLive(shown);
    const stopping = preview.stop();
    http
      .expectOne({ method: 'POST', url: stopUrl(shown.id) })
      .flush({ error: 'SSH failed', code: 'unreachable' }, badGateway);
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
    await answerStop(live30.id);
    await left;
    expect(preview.state().status).toBe('idle');

    const started = preview.start(imx477, mode30, 3);
    await preview.leave();
    expect(preview.state().status).toBe('stopping');
    await answerStart(live30);
    await answerStop(live30.id);
    await started;
    expect(preview.state().status).toBe('idle');
    http.expectNone({ method: 'POST', url: START_URL });

    await adoptLive({ ...live30, viewer: true });
    await preview.leave();
    expect(preview.state()).toEqual({ status: 'idle', session: null, error: null });
    http.expectNone(() => true);
  });

  it('release stops a live preview and a start still in flight once its session id arrives', async () => {
    await adoptLive();
    preview.release();
    await answerStop(live30.id);
    vi.advanceTimersByTime(PREVIEW_POLL_MS * 2);
    http.expectNone(PREVIEW_URL);

    // Leaving while the board starts a preview (another visit's controller): its session is stopped
    // the moment it answers, not left to the backend's 15 s reaper, and nothing is started again.
    const leaving = TestBed.runInInjectionContext(() => new CameraPreview());
    const started = leaving.start(imx477, mode30, 3);
    leaving.release();
    http.expectNone({ method: 'POST', url: stopUrl(live30.id) });
    await answerStart(live30);
    await answerStop(live30.id);
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
    http
      .expectOne(stopUrl(live30.id))
      .flush({ error: 'SSH failed', code: 'unreachable' }, badGateway);
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
});
