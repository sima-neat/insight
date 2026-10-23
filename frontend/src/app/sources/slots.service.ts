import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { defer, finalize, firstValueFrom, Observable, tap, timeout, throwError } from 'rxjs';
import { LatestOnly, visiblePoller } from '../polling';
import type {
  AssignRequest,
  AssignWebcamRequest,
  AssignWebcamResponse,
  AutoAssignResult,
  BulkRequest,
  BulkStartResult,
  PullRequest,
  ReleasedWebcam,
  RenditionsCleared,
  RenditionUsage,
  ResetResult,
  Slot,
  StartBulkRequest,
  StartRequest,
  StopAllResult,
  StopRequest,
  SuccessResponse,
  TakeoverResponse,
} from './api';
import { isProgressFailure, mergePrepareProgress, type Progress } from './progress-lines';
import {
  ApiRequestError,
  postStreamedText,
  withRequestErrors,
  type StreamEvent,
} from './stream-lines';

const SLOTS_URL = '/api/mediasrc';
const RENDITIONS_URL = '/api/mediasrc/renditions';
const POLL_INTERVAL_MS = 2000;
/** A fetch of the slots that has not answered by then counts as failed: it must not stall polling. */
const FETCH_TIMEOUT_MS = 10_000;
/** What an encode shows before the server's first line (#170's label). */
const PREPARING: Progress = { title: 'Preparing rendition…', detail: '', percent: null };

/**
 * Whether `next` shows a slot streaming at a frame rate other than the file's, that did not
 * stream at that rate in `previous`: the server has just encoded, or reused, a rendition for it.
 */
function startedCustomFps(previous: readonly Slot[] | null, next: readonly Slot[]): boolean {
  /** The frame rate a playing slot streams at when it is not the file's own, else null. */
  const customFps = (slot: Slot | undefined): number | null =>
    slot?.state === 'playing' && slot.fps != null && slot.fps !== slot.native_fps ? slot.fps : null;
  return next.some((slot) => {
    const fps = customFps(slot);
    return fps !== null && fps !== customFps(previous?.find((old) => old.index === slot.index));
  });
}

/**
 * The 48 streaming slots, as one service for the whole app: Streaming shows and acts on them,
 * Media shows which files they use, and the pickers need the same answer. Page code never fetches
 * `/api/mediasrc` itself.
 *
 * **Polling.** The slots are polled every 2 s while at least one page holds a `watch()` and the
 * page is visible; a hidden tab asks again the moment it shows. A poll is skipped while a request
 * is in flight, and the newest answer always wins over an older one that arrives later. A poll
 * that fails (or does not answer within 10 s) keeps the last answer and sets `unavailable` until
 * one succeeds: the next one tries again.
 *
 * **Actions.** Each maps to one endpoint and resolves with its response, or rejects with a
 * `ApiRequestError` carrying the server's message (its `body` keeps what the message does not,
 * such as the pull route's `reason`). Whatever the outcome, the slots are fetched again before the
 * action settles: another tab or a publisher may have changed the slot (a 409 or 410 says so), and
 * what the caller sees next must be what the server holds. A poll sent before an action settled
 * may have been answered from before it, so its answer is dropped.
 */
@Injectable({ providedIn: 'root' })
export class SlotsService {
  private readonly http = inject(HttpClient);

  private readonly slotsState = signal<readonly Slot[] | null>(null);
  /** The newest answer; null before the first one. */
  readonly slots = this.slotsState.asReadonly();

  private readonly unavailableState = signal(false);
  /**
   * The newest fetch of the slots failed, so `slots` may be out of date (or, before any answer,
   * absent) until a fetch succeeds again. A page should say so rather than show a stale slot
   * as if it were current.
   */
  readonly unavailable = this.unavailableState.asReadonly();

  private readonly renditionsState = signal<RenditionUsage | null>(null);
  /** The stored FPS renditions, as of the last `refreshRenditions()` or action that changes them. */
  readonly renditions = this.renditionsState.asReadonly();

  private readonly encodesState = signal<ReadonlyMap<number, Progress>>(new Map());
  /**
   * The FPS renditions being encoded, by slot: how far each `prepare` has got, merged from the
   * server's lines. The server knows nothing of an encode until it has finished (the slot stays
   * stopped), so this is the only place it shows; the list and the slot's panel read it alike.
   */
  readonly encodes = this.encodesState.asReadonly();

  private readonly slotsByFile = computed(() => {
    const byFile = new Map<string, Slot[]>();
    for (const slot of this.slots() ?? []) {
      if (slot.file) byFile.set(slot.file, [...(byFile.get(slot.file) ?? []), slot]);
    }
    return byFile;
  });

  private readonly latest = new LatestOnly();
  private readonly latestRenditions = new LatestOnly();
  private inFlight = 0;
  private watchers = 0;
  private readonly poller = visiblePoller(POLL_INTERVAL_MS, () => {
    if (this.inFlight === 0) void this.refresh().catch(() => undefined);
  });

  /**
   * Keeps the slots polled until the returned function is called. A page calls it while it is
   * shown; several pages may hold it at once, and polling stops when the last one lets go.
   */
  watch(): () => void {
    this.watchers++;
    this.poller.setActive(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.watchers === 0) this.poller.setActive(false);
    };
  }

  /**
   * Fetches the slots now, even while a poll is in flight: after a change, the answer must not be
   * one asked for before it. Resolves once answered (or superseded by a newer answer); rejects
   * with the server's message when the request failed, which also sets `unavailable` unless a
   * newer request has been sent since.
   */
  async refresh(): Promise<void> {
    const request = this.latest.next();
    this.inFlight++;
    try {
      const slots = await firstValueFrom(
        this.http.get<Slot[]>(SLOTS_URL).pipe(
          timeout({
            first: FETCH_TIMEOUT_MS,
            with: () =>
              throwError(() => new ApiRequestError(0, 'The server did not answer in time.', null)),
          }),
          withRequestErrors(),
        ),
      );
      if (this.latest.accept(request)) {
        const previous = this.slotsState();
        this.slotsState.set(slots);
        this.unavailableState.set(false);
        // The usage changes when a stream starts at a custom rate, also one another tab started.
        if (startedCustomFps(previous, slots)) void this.refreshRenditions().catch(() => undefined);
      }
    } catch (failure) {
      if (this.latest.isNewest(request)) this.unavailableState.set(true);
      throw failure;
    } finally {
      this.inFlight--;
    }
  }

  /** Fetches the rendition usage; rejects with the server's message when the request failed. */
  async refreshRenditions(): Promise<void> {
    const request = this.latestRenditions.next();
    const usage = await firstValueFrom(
      this.http.get<RenditionUsage>(RENDITIONS_URL).pipe(withRequestErrors()),
    );
    if (this.latestRenditions.accept(request)) this.renditionsState.set(usage);
  }

  /**
   * The slots a media file is assigned to, in index order, whatever their state: running, idle,
   * pulled or held by an external publisher (a pull or a takeover leaves the assignment under it).
   * This is what "in use" means for deleting or replacing the file.
   */
  assignedTo(path: string): readonly Slot[] {
    return this.slotsByFile().get(path) ?? [];
  }

  /** `file: ''` clears the slot. */
  assign(request: AssignRequest): Promise<SuccessResponse> {
    return this.act(this.http.post<SuccessResponse>(`${SLOTS_URL}/assign`, request));
  }

  assignWebcam(request: AssignWebcamRequest): Promise<AssignWebcamResponse> {
    return this.act(this.http.post<AssignWebcamResponse>(`${SLOTS_URL}/assign-webcam`, request));
  }

  /**
   * Encodes the FPS rendition a slot needs before it starts. Cold: the request is sent on
   * subscribe, and unsubscribing cancels the encode (the server stops FFmpeg and removes the
   * partial file). Emits the server's lines (read them with `mergePrepareProgress` from
   * `progress-lines.ts`); a refused request errors with the server's message. The slots and the
   * rendition usage are fetched again however it ends. While it runs, `encodes` shows its progress.
   */
  prepare(index: number): Observable<StreamEvent> {
    return defer(() => {
      // Each run knows its entry by identity (a copy, never the shared constant), so a run that
      // ends after a newer one began on the same slot leaves the newer run's progress alone.
      const run = { progress: { ...PREPARING } };
      this.setEncode(index, run.progress);
      return postStreamedText(this.http, `${SLOTS_URL}/prepare`, { index }).pipe(
        tap((event) => {
          // A newer run on the slot has taken its entry over.
          if (event.kind !== 'line' || this.encodes().get(index) !== run.progress) return;
          const next = mergePrepareProgress(run.progress, event.text);
          // A failure is the subscriber's to word; until the run ends it shows what it reached.
          if (next === null || isProgressFailure(next)) return;
          run.progress = next;
          this.setEncode(index, next);
        }),
        // The slot shows as encoding until the slots are fetched again, so it does not flash idle
        // between the encode's end and the answer that shows what the server did next.
        finalize(() => {
          void this.settleChange({ renditions: true }).then(() => {
            if (this.encodes().get(index) === run.progress) this.setEncode(index, null);
          });
        }),
      );
    });
  }

  /** A file slot that still lacks its rendition encodes it first, which is why the usage is fetched again. */
  start(request: StartRequest): Promise<SuccessResponse> {
    return this.act(this.http.post<SuccessResponse>(`${SLOTS_URL}/start`, request), {
      renditions: true,
    });
  }

  /**
   * One attempt of the webcam start's confirm loop: asks the server to start the slot, only if it
   * is still a webcam (410 otherwise). Unlike every other action it does not settle: the loop
   * repeats every 250 ms while MediaMTX has not seen the path, and each refused attempt would
   * otherwise wait for a refetch of the slots and the renditions before the next. The caller
   * settles once, when the loop ends.
   */
  confirmWebcamStart(index: number): Promise<SuccessResponse> {
    const body: StartRequest = { index, expect_type: 'webcam' };
    return firstValueFrom(
      this.http.post<SuccessResponse>(`${SLOTS_URL}/start`, body).pipe(withRequestErrors()),
    );
  }

  /** Starts the first `count` assigned slots in index order, skipping external and pulled ones. */
  startBulk(count: number): Promise<BulkStartResult> {
    const body: StartBulkRequest = { count };
    return this.act(this.http.post<BulkStartResult>(`${SLOTS_URL}/start-bulk`, body), {
      renditions: true,
    });
  }

  stop(request: StopRequest): Promise<SuccessResponse> {
    return this.act(this.http.post<SuccessResponse>(`${SLOTS_URL}/stop`, request));
  }

  /**
   * The bulk actions take the webcams this browser published and has closed already
   * (`CamerasService` supplies them), so the server verifies those sessions instead of kicking them.
   */
  stopAll(releasedWebcams: readonly ReleasedWebcam[]): Promise<StopAllResult> {
    return this.act(
      this.http.post<StopAllResult>(`${SLOTS_URL}/stop-all`, this.bulkBody(releasedWebcams)),
    );
  }

  reset(releasedWebcams: readonly ReleasedWebcam[]): Promise<ResetResult> {
    return this.act(
      this.http.post<ResetResult>(`${SLOTS_URL}/reset`, this.bulkBody(releasedWebcams)),
    );
  }

  autoAssign(releasedWebcams: readonly ReleasedWebcam[]): Promise<AutoAssignResult> {
    return this.act(
      this.http.post<AutoAssignResult>(
        `${SLOTS_URL}/auto-assign-all`,
        this.bulkBody(releasedWebcams),
      ),
    );
  }

  /** Disconnects the external publisher holding a slot; the slot's own assignment reappears. */
  takeOver(index: number): Promise<TakeoverResponse> {
    return this.act(this.http.post<TakeoverResponse>(`${SLOTS_URL}/takeover`, { index }));
  }

  /** Pulls a network stream into the slot. Answers with the slot, enriched with its `pull`. */
  pull(request: PullRequest): Promise<Slot> {
    return this.act(this.http.post<Slot>(`${SLOTS_URL}/pull`, request));
  }

  clearRenditions(): Promise<RenditionsCleared> {
    return this.act(this.http.post<RenditionsCleared>(`${RENDITIONS_URL}/clear`, {}), {
      renditions: true,
    });
  }

  private setEncode(index: number, progress: Progress | null): void {
    this.encodesState.update((all) => {
      const next = new Map(all);
      if (progress) next.set(index, progress);
      else next.delete(index);
      return next;
    });
  }

  private bulkBody(releasedWebcams: readonly ReleasedWebcam[]): BulkRequest {
    return { released_webcams: [...releasedWebcams] };
  }

  /**
   * Sends an action and settles after the slots (and, for an action that can change them, the
   * rendition usage) were fetched again. That fetch failing is not the action failing.
   */
  private async act<T>(call: Observable<T>, options: { renditions?: boolean } = {}): Promise<T> {
    try {
      return await firstValueFrom(call.pipe(withRequestErrors()));
    } finally {
      await this.settleChange(options);
    }
  }

  /**
   * Fetches the slots again (and the rendition usage, for a change that can alter it) once
   * something has changed them, and resolves when that is done, whether or not it worked. Answers
   * to polls sent before the change are dropped: they may describe the slots from before it. Every
   * change to the slots, here or in the library, ends in this.
   */
  async settleChange({ renditions = false }: { renditions?: boolean } = {}): Promise<void> {
    this.latest.discard();
    const fetches = [this.refresh()];
    if (renditions) fetches.push(this.refreshRenditions());
    await Promise.allSettled(fetches);
  }
}
