/**
 * The camera preview as a state machine driven by the backend's session, and the steps around it,
 * as pure functions with their requests injected (#170's `peripherals/model.js`, copy per
 * Inv-PB §2.3). `CameraPreview` composes them; keeping them pure lets every interleaving of the
 * user and the board's answers be tested without a page.
 *
 * The backend runs at most one preview per Insight, across all tabs, and its MJPEG stream has one
 * reader: a second tab shows the preview as running elsewhere, with Stop (Inv-PB §4.3).
 */

import { BoardProblem } from '../board/board-error';
import type { DeviceChip } from './devices';
import type { CameraModeChoice, PreviewSession } from './api';
import { rateLabel, sameSelection } from './camera-modes';

export type PreviewStatus = 'idle' | 'starting' | 'live' | 'elsewhere' | 'stopping' | 'error';

/**
 * What the preview shows. `session` is the backend's, once a start answered or one was adopted;
 * a start has none until the board sent its first frame. `error` is why the last start failed or
 * the stream ended, or why a stop failed (the preview then stays live).
 */
export interface PreviewState {
  status: PreviewStatus;
  session: PreviewSession | null;
  error: BoardProblem | null;
}

/**
 * What happened to the preview. An event tagged `for` a session id applies only while the state
 * holds that session: a late answer about an earlier preview must not touch a newer one.
 */
export type PreviewEvent =
  | { type: 'start' }
  /** A session this page did not start: a reload, another tab, a refused start. */
  | { type: 'adopt'; session: PreviewSession | null }
  /** A start's answer. */
  | { type: 'session'; session: PreviewSession | null }
  /** Untagged while a start is still out: there is no session id to stop yet. */
  | { type: 'stopping'; for?: string; session?: PreviewSession | null }
  | { type: 'stopped'; for: string }
  /** `from`: what the preview was before the stop, which it returns to. */
  | { type: 'stop-failed'; for: string; from: 'live' | 'elsewhere'; error: BoardProblem }
  | { type: 'camera-fps'; for: string; fps: number }
  /** This page's stream was refused because another page shows it. */
  | { type: 'elsewhere'; for: string; session: PreviewSession }
  /** The backend no longer runs the session; nothing is left to stop. */
  | { type: 'ended'; for: string; error: BoardProblem }
  | { type: 'failed'; for?: string; error: BoardProblem }
  | { type: 'reset' };

/** The preview events of the given types. */
export type PreviewEventOf<T extends PreviewEvent['type']> = Extract<PreviewEvent, { type: T }>;

/** A mode as the page shows it for a camera: the camera's item id with the mode. */
export interface CameraSelection extends CameraModeChoice {
  id: string;
}

/** What the page shows now: the camera, the board generation and the selected mode. */
export interface PreviewView {
  cameraId: string | null;
  generation: number | null;
  selection: CameraSelection | null;
}

/** A start as it was sent: for which camera, board generation and mode. */
export interface PreviewRequested {
  cameraId: string;
  generation: number | null;
  mode: CameraSelection;
}

/**
 * The requests and the page a start works with (`runPreviewStart`). `lookup` answers the running
 * session, null when none runs or the read failed. `stop` resolves whether the session stopped.
 * `reloadBoard` re-reads the board when an answer names a generation the page does not know.
 */
export interface PreviewStartDeps {
  post(mode: CameraSelection): Promise<PreviewSession>;
  lookup(): Promise<PreviewSession | null>;
  stop(session: PreviewSession): Promise<boolean>;
  start(mode: CameraSelection): unknown;
  adopt(session: PreviewSession): void;
  dispatch(event: PreviewEvent): void;
  view(): PreviewView;
  normalize(failure: unknown): BoardProblem;
  reloadBoard(): void;
}

/** A read of the backend's running session (`CameraPreview.current()`); rejects when it failed. */
export type PreviewRead = () => Promise<PreviewSession | null>;

/** What paces a watch: calls `tick` repeatedly from `start` until `stop`. */
export interface PreviewTimer {
  start(tick: () => void): void;
  stop(): void;
}

/** An error the preview shows, with one recovery line and what else the panel says about it. */
export interface PreviewErrorInfo {
  code: string;
  message: string;
  /** The backend's own hint; the panel shows it, or `action` when there is none. */
  hint: string;
  action: string;
  /** For `preview_active`: the camera the running preview is on. */
  otherCamera: string;
  /** The board's output, for the folded "Board output". */
  detail: string;
}

/** How often a live preview's page reads GET /api/peripherals/preview, which never contacts the board. */
export const PREVIEW_POLL_MS = 2500;

export const PREVIEW_IDLE: PreviewState = Object.freeze({
  status: 'idle',
  session: null,
  error: null,
});

/** #170's status labels; its tones mapped to the kit's, as `devices.ts` maps them. */
const PREVIEW_STATUS: Record<PreviewStatus, DeviceChip> = {
  idle: { label: 'Not running', tone: 'neutral' },
  starting: { label: 'Starting…', tone: 'info' },
  live: { label: 'Live', tone: 'success' },
  elsewhere: { label: 'In another tab', tone: 'info' },
  stopping: { label: 'Stopping…', tone: 'info' },
  error: { label: 'Could not start', tone: 'danger' },
};

const PREVIEW_ERROR_ACTIONS: Readonly<Record<string, string>> = {
  camera_in_use:
    'Stop that process on the board yourself, then start the preview again. Insight never stops it for you.',
  preview_active: 'Stop the preview that is already running, then start this one.',
  invalid_request: 'Choose a mode Insight lists as Available; this one was rejected.',
  mode_adjusted:
    'Pick the size libcamera streams at. The board lists the requested size, but its libcamera pipeline does not output it.',
  command_failed:
    'The preview pipeline could not start on the board. The board output below says why.',
  stale_snapshot: 'The board changed after this scan. Refresh, then start the preview again.',
};

/** The events of a stop. */
const STOP_EVENTS: ReadonlySet<PreviewEvent['type']> = new Set([
  'stopping',
  'stopped',
  'stop-failed',
]);

export function previewStatus(state: PreviewState): DeviceChip {
  return PREVIEW_STATUS[state.status];
}

/** The session's stream, only as the same-origin API path Insight serves it on; null for anything else. */
export function previewStreamUrl(session: PreviewSession | null): string | null {
  const url = session?.stream_url ?? '';
  return /^\/api\/peripherals\/cameras\/preview\/[A-Za-z0-9_-]+\/stream$/.test(url) ? url : null;
}

export function nextPreviewState(current: PreviewState, event: PreviewEvent): PreviewState {
  switch (event.type) {
    case 'start':
      return { status: 'starting', session: null, error: null };
    case 'adopt': {
      const session = event.session;
      if (!session || session.state === 'stopped') return PREVIEW_IDLE;
      // The stream has one viewer: when another page shows it, this one offers Stop, not a second stream.
      if (session.viewer) return { status: 'elsewhere', session, error: null };
      return { status: 'live', session, error: null };
    }
    case 'session': {
      const session = event.session;
      if (!session) return PREVIEW_IDLE;
      // A response for a session already replaced or stopped must not revive it.
      if (current.session && current.session.id !== session.id) return current;
      if (current.status === 'idle' || current.status === 'error') return current;
      if (session.state === 'stopped') return PREVIEW_IDLE;
      if (current.status === 'stopping' || current.status === 'elsewhere') {
        return { status: current.status, session, error: null };
      }
      return { status: 'live', session, error: null };
    }
    case 'stopping':
      if (outOfDate(current, event)) return current;
      return { status: 'stopping', session: current.session ?? event.session ?? null, error: null };
    case 'stopped':
      if (outOfDate(current, event)) return current;
      return PREVIEW_IDLE;
    case 'stop-failed':
      if (outOfDate(current, event)) return current;
      // The board may still be streaming: keep the preview and its Stop, with the failure, as it
      // was. One another tab shows stays that tab's: it must not become this page's live preview.
      return { status: event.from, session: current.session, error: event.error };
    case 'camera-fps':
      // The rate the camera runs at, for the running session only; unchanged, the state is kept as is.
      if (
        !current.session ||
        outOfDate(current, event) ||
        current.session.camera_fps === event.fps
      ) {
        return current;
      }
      return { ...current, session: { ...current.session, camera_fps: event.fps } };
    case 'elsewhere':
      // Only a live pane changes: a Stop in progress is left alone.
      if (outOfDate(current, event) || current.status !== 'live') return current;
      return { status: 'elsewhere', session: event.session, error: null };
    case 'ended':
      if (outOfDate(current, event)) return current;
      // One shown in another page ended there: this page has nothing to explain. One this page is
      // stopping ended because of that stop (closing the stream ends it), so it is a stop, not a failure.
      if (current.status === 'elsewhere' || current.status === 'stopping') return PREVIEW_IDLE;
      return { status: 'idle', session: null, error: event.error };
    case 'failed':
      if (outOfDate(current, event)) return current;
      return { status: 'error', session: null, error: event.error };
    case 'reset':
      return PREVIEW_IDLE;
  }
}

/**
 * Whether a start the page sent no longer matches what the page shows: the camera, the board, or
 * the mode changed while the board was starting it. Its outcome then belongs to none of them.
 */
export function startSuperseded(requested: PreviewRequested, latest: PreviewView): boolean {
  if (requested.cameraId !== latest.cameraId) return true;
  if (otherGeneration(requested.generation, latest.generation)) return true;
  return !sameSelection(requested.mode, latest.selection);
}

/**
 * The mode to start once a restart's stop finished: the mode selected now, which the user may
 * have changed again while the stop ran. None when the camera or the board changed meanwhile.
 */
export function restartSelection(
  requested: Pick<PreviewRequested, 'cameraId' | 'generation'>,
  latest: PreviewView,
): CameraSelection | null {
  if (requested.cameraId !== latest.cameraId) return null;
  if (otherGeneration(requested.generation, latest.generation)) return null;
  return latest.selection?.id === requested.cameraId ? latest.selection : null;
}

/**
 * One start of a preview, from its POST to what the pane shows. The user can change the camera,
 * the board or the mode while any request is in flight, so every step that resumes after an
 * await reads `view()` again and acts only for what is shown then.
 */
export async function runPreviewStart(
  requested: PreviewRequested,
  deps: PreviewStartDeps,
): Promise<void> {
  deps.dispatch({ type: 'start' });
  let session: PreviewSession;
  try {
    session = await deps.post(requested.mode);
  } catch (failure) {
    // Like a start that succeeded too late: once superseded, its failure says nothing about what
    // the pane now shows.
    if (startSuperseded(requested, deps.view())) return deps.dispatch({ type: 'reset' });
    const error = deps.normalize(failure);
    // Another tab started a preview after this page loaded: show that one, with its Stop.
    const running = error.code === 'preview_active' ? await deps.lookup() : null;
    if (startSuperseded(requested, deps.view())) return deps.dispatch({ type: 'reset' });
    const existing = sessionToAdopt(error, running);
    return existing ? deps.adopt(existing) : deps.dispatch({ type: 'failed', error });
  }
  // A session for a camera, board or mode no longer shown would label one camera's video as
  // another's, or disagree with the menus: it is stopped instead.
  const latest = deps.view();
  if (sessionMatches(session, latest.cameraId, latest.generation, latest.selection)) {
    return deps.dispatch({ type: 'session', session });
  }
  // A session of another board generation than the one shown is never restarted: while the page
  // still shows the generation the start was sent for, the board moved without the page knowing
  // (Insight restarted, or a client changed the board while this window kept the focus), and a
  // restart would get the same answer again, starting and killing the camera each time. The
  // board is re-read instead, so the page learns of the change.
  const otherBoard = otherGeneration(session.generation, latest.generation);
  if (otherBoard && !otherGeneration(requested.generation, latest.generation)) deps.reloadBoard();
  if (!(await deps.stop(session))) return;
  // The mode may have changed again while the stop ran: start the one selected now, or nothing
  // when the camera or board changed.
  const next = otherBoard ? null : restartSelection(requested, deps.view());
  if (next) await deps.start(next);
  else deps.dispatch({ type: 'reset' });
}

/**
 * A preview streams the mode it was started with. When the menus of its camera move, the picture
 * and the menus disagree until it is restarted on the new mode; another camera's menus never
 * touch it.
 */
export function previewNeedsRestart(
  state: PreviewState,
  cameraId: string,
  next: CameraModeChoice | null,
): boolean {
  const session = state.session;
  if (!next || !session) return false;
  if (state.status !== 'starting' && state.status !== 'live') return false;
  if (session.camera_id !== cameraId) return false;
  return !sameSelection(session.mode, next);
}

/**
 * The event for a stream that ended: the backend stops a preview whose stream ends, so the
 * preview is over, with the reason shown.
 */
export function streamEndedEvent(sessionId: string): PreviewEventOf<'ended'> {
  return {
    type: 'ended',
    for: sessionId,
    error: new BoardProblem(
      'The preview stream stopped.',
      'stream_ended',
      'Start the preview again. If it keeps stopping, check the camera connection on the board.',
      {},
    ),
  };
}

/**
 * The event for an `<img>` that could not load the stream. The backend gives a stream one viewer
 * and refuses the next: two pages that both found the preview unclaimed both try, and the one
 * refused shows it as running in another tab while the backend still runs it with a viewer.
 * Otherwise the stream is over.
 */
export async function streamErrorEvent(
  read: PreviewRead,
  sessionId: string,
): Promise<PreviewEventOf<'elsewhere' | 'ended'>> {
  const current = await read().catch(() => null);
  if (current?.id === sessionId && current.state !== 'stopped' && current.viewer) {
    return { type: 'elsewhere', for: sessionId, session: current };
  }
  return streamEndedEvent(sessionId);
}

/**
 * One read of the backend's preview for a live session: the ended event when the backend no
 * longer runs it; while it does, the camera's rate once the backend knows it (a MIPI sensor's
 * arrives after the first frame), else null. A failed read proves nothing, so it ends nothing.
 */
export async function previewStatusEvent(
  read: PreviewRead,
  sessionId: string,
): Promise<PreviewEventOf<'ended' | 'camera-fps'> | null> {
  let current: PreviewSession | null;
  try {
    current = await read();
  } catch {
    return null;
  }
  if (current?.id !== sessionId || current.state === 'stopped') return streamEndedEvent(sessionId);
  return current.camera_fps !== null && rateLabel(current.camera_fps)
    ? { type: 'camera-fps', for: sessionId, fps: current.camera_fps }
    : null;
}

/**
 * Reads a live preview on every tick of `timer` until the backend no longer runs it; then
 * `onEvent` gets the ended event and the timer stops. An `<img>` fires no event when a multipart
 * stream ends cleanly (end of the board stream, the stall timeout, a refresh or board change from
 * elsewhere), so this is how the page learns of it. A read that finds the camera's rate passes it
 * on as a camera-fps event and reading goes on. A tick while a read is out sends no second one.
 * Returns the cancel function, which drops the answer of a read still out.
 */
export function watchPreview(
  read: PreviewRead,
  sessionId: string,
  onEvent: (event: PreviewEvent) => void,
  timer: PreviewTimer,
): () => void {
  let cancelled = false;
  let reading = false;
  const cancel = () => {
    cancelled = true;
    timer.stop();
  };
  timer.start(async () => {
    if (cancelled || reading) return;
    reading = true;
    const event = await previewStatusEvent(read, sessionId);
    reading = false;
    if (cancelled) return;
    if (event?.type === 'ended') cancel();
    if (event) onEvent(event);
  });
  return cancel;
}

/**
 * What the menus show for a preview the page adopts (reload, another tab): its camera and the
 * mode it streams, so they agree with the video. Null when the session names no camera.
 */
export function adoptedSelection(session: PreviewSession): CameraSelection | null {
  if (!session.camera_id) return null;
  const { format, width, height, fps } = session.mode;
  return { id: session.camera_id, format, width, height, fps };
}

/**
 * The running preview a refused start should adopt: another tab started one between this page's
 * load and its start, so the pane shows that preview and its Stop instead of an error.
 */
export function sessionToAdopt(
  error: Pick<BoardProblem, 'code'>,
  session: PreviewSession | null,
): PreviewSession | null {
  if (error.code !== 'preview_active' || !session || session.state === 'stopped') return null;
  return session;
}

/**
 * Whether a session is the one the page shows: its camera, its board generation (when both are
 * known) and, when given, its mode.
 */
export function sessionMatches(
  session: PreviewSession | null,
  cameraId: string | null,
  generation?: number | null,
  selection: CameraModeChoice | null = null,
): boolean {
  if (!session || !cameraId) return false;
  if (session.camera_id !== cameraId) return false;
  if (otherGeneration(session.generation, generation ?? null)) return false;
  return !selection || sameSelection(session.mode, selection);
}

export function previewErrorInfo(error: BoardProblem | null): PreviewErrorInfo | null {
  if (!error) return null;
  const details = error.details;
  const other = record(details['session']) ?? record(details['preview']) ?? {};
  return {
    code: error.code,
    message: error.message,
    hint: error.hint,
    action: PREVIEW_ERROR_ACTIONS[error.code] ?? '',
    otherCamera:
      error.code === 'preview_active' ? text(other['camera_id']) || text(details['camera_id']) : '',
    detail: text(details['detail']),
  };
}

/**
 * Whether an event tagged for a session belongs to an earlier preview. A preview that is still
 * starting holds no session id yet: its own stop must apply, or the page would stay in
 * "Starting…" with nothing to stop; any other tagged event belongs to an earlier preview.
 */
function outOfDate(state: PreviewState, event: PreviewEvent & { for?: string }): boolean {
  if (event.for === undefined) return false;
  if (!state.session) {
    return !(
      (state.status === 'starting' || state.status === 'stopping') &&
      STOP_EVENTS.has(event.type)
    );
  }
  return state.session.id !== event.for;
}

/** Two board generations that are both known and differ; an unknown one matches any. */
function otherGeneration(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a !== b;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
