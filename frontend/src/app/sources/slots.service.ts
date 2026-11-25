import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom, Observable, type Subscription, timeout, throwError } from 'rxjs';
import type {
  AutoAssignResult,
  Job,
  RenditionsCleared,
  RenditionUsage,
  Slot,
  SlotAssignment,
  SlotList,
  SlotStartRequest,
  SlotStartResult,
  SlotStopResult,
} from '../api.generated';
import { LatestOnly, visiblePoller } from '../polling';
import { JobEvents, jobProgress, type Progress } from './jobs';
import { ApiRequestError, withRequestErrors } from './api-errors';
import type { WebcamRate } from './webcam-capture';

const SLOTS_URL = '/api/slots';
const RENDITIONS_URL = '/api/renditions';
const POLL_INTERVAL_MS = 2000;
/** A fetch of the slots that has not answered by then counts as failed: it must not stall polling. */
const FETCH_TIMEOUT_MS = 10_000;
/** What a slot's rendition encode is called while it runs, in the list and in the slot's panel. */
const ENCODING_TITLE = 'Encoding rendition…';
/** What an encode shows before its first event. */
const PREPARING: Progress = { title: ENCODING_TITLE, detail: '', percent: null };

/** A camera to pull: its RTSP or RTSPS URL, and credentials that replace any the URL holds. */
export interface PullRequest {
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
}

/**
 * The 48 streaming slots, as one service for the whole app: Streaming shows and acts on them,
 * Media shows which files they use, and the pickers need the same answer. Page code never fetches
 * `/api/slots` itself.
 *
 * **Polling.** The slots are polled every 2 s while at least one page holds a `watch()` and the
 * page is visible; a hidden tab asks again the moment it shows. A poll is skipped while a request
 * is in flight, and the newest answer always wins over an older one that arrives later. A poll
 * that fails (or does not answer within 10 s) keeps the last answer and sets `unavailable` until
 * one succeeds: the next one tries again.
 *
 * **Encodes.** A file slot started at a frame rate other than its file's is `preparing` while the
 * server encodes its rendition, naming the encode's job. The service follows the job of every
 * preparing slot an answer shows, whoever started it, and `encodes` says how far each has got;
 * when a job ends, the slots and the rendition usage are fetched again.
 *
 * **Actions.** Each maps to one route and resolves with its answer, or rejects with an
 * `ApiRequestError` carrying the server's message and code. Whatever the outcome, the slots are
 * fetched again before the action settles: another tab or a publisher may have changed the slot,
 * and what the caller sees next must be what the server holds. A poll sent before an action
 * settled may have been answered from before it, so its answer is dropped.
 */
@Injectable({ providedIn: 'root' })
export class SlotsService {
  private readonly http = inject(HttpClient);
  private readonly jobEvents = inject(JobEvents);

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

  private readonly jobsState = signal<ReadonlyMap<string, Job>>(new Map());
  /**
   * How far the rendition encode of each preparing slot has got, by slot number, from its job's
   * events; an encode whose first event has not come shows as just begun. The list and the slot's
   * panel read it alike.
   */
  readonly encodes = computed<ReadonlyMap<number, Progress>>(() => {
    const jobs = this.jobsState();
    const encodes = new Map<number, Progress>();
    for (const slot of this.slots() ?? []) {
      if (slot.state !== 'preparing') continue;
      const job = slot.job ? jobs.get(slot.job) : undefined;
      encodes.set(slot.n, job ? jobProgress(job, ENCODING_TITLE) : PREPARING);
    }
    return encodes;
  });

  private readonly slotsByFile = computed(() => {
    const byFile = new Map<string, Slot[]>();
    for (const slot of this.slots() ?? []) {
      if (slot.file) byFile.set(slot.file, [...(byFile.get(slot.file) ?? []), slot]);
    }
    return byFile;
  });

  private readonly latest = new LatestOnly();
  private readonly latestRenditions = new LatestOnly();
  /** The encode jobs followed, by id, as long as an answer shows a slot preparing with them. */
  private readonly follows = new Map<string, Subscription>();
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
   * Fetches the slots again before a destructive question (a delete, a replace), so the question
   * names the slots as they are now. Resolves whether that worked: on a failure
   * the question goes on with the last known slots and says so. Never rejects.
   */
  recheck(): Promise<boolean> {
    return this.refresh().then(
      () => true,
      () => false,
    );
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
      const list = await firstValueFrom(
        this.http.get<SlotList>(SLOTS_URL).pipe(
          timeout({
            first: FETCH_TIMEOUT_MS,
            with: () =>
              throwError(() => new ApiRequestError(0, 'The server did not answer in time.', null)),
          }),
          withRequestErrors(),
        ),
      );
      if (this.latest.accept(request)) {
        this.slotsState.set(list.slots);
        this.unavailableState.set(false);
        this.followEncodes(list.slots);
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
   * The slots a media file is assigned to, in number order, whatever their state: running, idle,
   * or held by an external publisher (which leaves the assignment under it). This is what "in use"
   * means for deleting or replacing the file.
   */
  assignedTo(path: string): readonly Slot[] {
    return this.slotsByFile().get(path) ?? [];
  }

  /**
   * The slots assigned to a file anywhere below `folder`, in number order: what replacing a folder
   * (an archive upload that clashes on its folder) touches.
   */
  assignedUnder(folder: string): readonly Slot[] {
    const prefix = `${folder}/`;
    return (this.slots() ?? []).filter((slot) => slot.file?.startsWith(prefix));
  }

  /**
   * Makes the slot stream a library file, at `fps` or, without it, at the file's own rate. A slot
   * that streamed a file keeps running with the new one; any other is stopped.
   */
  assignFile(n: number, file: string, fps?: number | null): Promise<Slot> {
    const body: SlotAssignment = fps == null ? { kind: 'file', file } : { kind: 'file', file, fps };
    return this.assign(n, body);
  }

  /**
   * Makes the slot pull a camera, which starts at once. The server probes the camera first and
   * refuses one that rejects the credentials (`pull_auth_failed`) or does not answer
   * (`pull_unreachable`). Answers with the slot, whose `pull` never carries credentials.
   */
  assignPull(n: number, pull: PullRequest): Promise<Slot> {
    return this.assign(n, { kind: 'pull', ...pull });
  }

  /**
   * Makes the slot a browser's webcam streaming at `fps`; the answer's `urls.whip` is where the
   * browser publishes, a URL of that rate's. Assigning it again at another rate disconnects what
   * publishes at the old one.
   */
  assignWebcam(n: number, fps: WebcamRate): Promise<Slot> {
    return this.assign(n, { kind: 'webcam', fps });
  }

  /** Leaves the slot with nothing assigned, and stopped. */
  clear(n: number): Promise<Slot> {
    return this.act(this.http.delete<Slot>(`${SLOTS_URL}/${n}`));
  }

  /**
   * Makes the slot run. A file slot at a rate other than its file's is `preparing` while its
   * rendition is encoded (see `encodes`); it answers before the stream is live.
   */
  start(n: number): Promise<Slot> {
    return this.act(this.http.post<Slot>(`${SLOTS_URL}/${n}/start`, null));
  }

  /**
   * Makes the slot stop, keeping what it is assigned: its encode is cancelled, its pull ended and
   * whatever publishes its webcam disconnected.
   */
  stop(n: number): Promise<Slot> {
    return this.act(this.http.post<Slot>(`${SLOTS_URL}/${n}/stop`, null));
  }

  /** Disconnects the external publisher holding a slot, so its own assignment can run. */
  takeOver(n: number): Promise<Slot> {
    return this.act(this.http.post<Slot>(`${SLOTS_URL}/${n}/take-over`, null));
  }

  /** Starts the first `count` file slots in number order that no external publisher holds. */
  startBulk(count: number): Promise<SlotStartResult> {
    const body: SlotStartRequest = { count };
    return this.act(this.http.post<SlotStartResult>(`${SLOTS_URL}/start`, body));
  }

  /** Stops every slot; external publishers go on. */
  stopAll(): Promise<SlotStopResult> {
    return this.act(this.http.post<SlotStopResult>(`${SLOTS_URL}/stop`, null));
  }

  /** Stops every slot and leaves each with nothing assigned; external publishers go on. */
  reset(): Promise<SlotStopResult> {
    return this.act(this.http.post<SlotStopResult>(`${SLOTS_URL}/reset`, null));
  }

  /** Gives the library's streamable files to the slots, one each; pulls and external slots keep theirs. */
  autoAssign(): Promise<AutoAssignResult> {
    return this.act(this.http.post<AutoAssignResult>(`${SLOTS_URL}/auto-assign`, null));
  }

  /** Removes the renditions no slot streams or is about to. */
  clearRenditions(): Promise<RenditionsCleared> {
    return this.act(this.http.delete<RenditionsCleared>(RENDITIONS_URL), { renditions: true });
  }

  private assign(n: number, body: SlotAssignment): Promise<Slot> {
    return this.act(this.http.put<Slot>(`${SLOTS_URL}/${n}`, body));
  }

  /**
   * Follows the encode of each preparing slot in `slots`, and lets go of those no slot shows any
   * more. A follow that ended stays until then, so an ended job is not followed again. When a job
   * ends the slot moves on (to starting, failed or idle) and a rendition may have been added, so
   * both are fetched again; a follow that failed leaves the slot to say how it stands.
   */
  private followEncodes(slots: readonly Slot[]): void {
    const wanted = new Set(
      slots.flatMap((slot) => (slot.state === 'preparing' && slot.job ? [slot.job] : [])),
    );
    for (const [id, follow] of this.follows) {
      if (wanted.has(id)) continue;
      follow.unsubscribe();
      this.follows.delete(id);
      this.jobsState.update((jobs) => withoutKey(jobs, id));
    }
    for (const id of wanted) {
      if (this.follows.has(id)) continue;
      this.follows.set(
        id,
        this.jobEvents.follow(id).subscribe({
          next: (job) => this.jobsState.update((jobs) => new Map(jobs).set(id, job)),
          complete: () => void this.settleChange({ renditions: true }),
          error: () => undefined,
        }),
      );
    }
  }

  /**
   * Sends an action and settles after the slots (and, for an action that changes them, the
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

function withoutKey<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}
