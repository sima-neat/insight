import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { finalize, firstValueFrom, Observable } from 'rxjs';
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
import { postStreamedText, withRequestErrors, type StreamEvent } from './stream-lines';

const SLOTS_URL = '/api/mediasrc';
const RENDITIONS_URL = '/api/mediasrc/renditions';
const POLL_INTERVAL_MS = 2000;

/**
 * The 48 streaming slots, as one service for the whole app: Streaming shows and acts on them,
 * Media shows which files they use, and the pickers need the same answer. Page code never fetches
 * `/api/mediasrc` itself.
 *
 * **Polling.** The slots are polled every 2 s while at least one page holds a `watch()` and the
 * page is visible; a hidden tab asks again the moment it shows. A poll is skipped while a request
 * is in flight, and the newest answer always wins over an older one that arrives later. A poll
 * that fails changes nothing: the next one tries again.
 *
 * **Actions.** Each maps to one endpoint and resolves with its response, or rejects with a
 * `StreamRequestError` carrying the server's message (its `body` keeps what the message does not,
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

  private readonly renditionsState = signal<RenditionUsage | null>(null);
  /** The stored FPS renditions, as of the last `refreshRenditions()` or action that changes them. */
  readonly renditions = this.renditionsState.asReadonly();

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
   * with the server's message when the request failed.
   */
  async refresh(): Promise<void> {
    const request = this.latest.next();
    this.inFlight++;
    try {
      const slots = await firstValueFrom(
        this.http.get<Slot[]>(SLOTS_URL).pipe(withRequestErrors()),
      );
      if (this.latest.accept(request)) this.slotsState.set(slots);
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
   * rendition usage are fetched again however it ends.
   */
  prepare(index: number): Observable<StreamEvent> {
    return postStreamedText(this.http, `${SLOTS_URL}/prepare`, { index }).pipe(
      finalize(() => void this.refreshAfterChange({ renditions: true })),
    );
  }

  /** A file slot that still lacks its rendition encodes it first, which is why the usage is fetched again. */
  start(request: StartRequest): Promise<SuccessResponse> {
    return this.act(this.http.post<SuccessResponse>(`${SLOTS_URL}/start`, request), {
      renditions: true,
    });
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
      await this.refreshAfterChange(options);
    }
  }

  private async refreshAfterChange({
    renditions = false,
  }: {
    renditions?: boolean;
  }): Promise<void> {
    this.latest.discard();
    const fetches = [this.refresh()];
    if (renditions) fetches.push(this.refreshRenditions());
    await Promise.allSettled(fetches);
  }
}
