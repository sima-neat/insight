import { computed, inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../../api.generated';
import { CamerasService } from '../../sources/cameras.service';
import { allCommitsSucceeded, type CommitResult } from '../../sources/fps';
import { SlotsService } from '../../sources/slots.service';
import { messageOf } from '../../sources/api-errors';

/** How a start ended: started (the slot is on its way), or skipped because its rate commit failed. */
export type StartOutcome = 'started' | 'skipped';

/** The set with `n` in it or out of it, as a new set. */
function withMember(all: ReadonlySet<number>, n: number, member: boolean): ReadonlySet<number> {
  const next = new Set(all);
  if (member) next.add(n);
  else next.delete(n);
  return next;
}

/**
 * The Streaming side panel's work on a slot that has to outlive the panel: the panel shows one
 * slot and is built afresh for each, while a frame-rate commit or a start goes on when another
 * slot is selected, or the page is left and come back to. Root-provided for that reason; only the
 * lazy Streaming page imports it.
 *
 * **Frame-rate commits.** The frame rate field commits when it is left, so a
 * click on Start, or on Start… for a bulk start, comes right after a commit that has not landed.
 * Both wait for it, so the server starts the rate just chosen and the start does not race the
 * assignment on the server; neither sends anything when it was refused. A refusal is reported
 * here, once, whoever waits for it.
 *
 * **Starting** a file slot at a rate other than its own makes the server encode the rendition
 * first: the slot is `preparing` meanwhile, its progress in `SlotsService.encodes`. Cancel
 * encoding stops the slot, which cancels the encode.
 */
@Injectable({ providedIn: 'root' })
export class SlotControl {
  private readonly slots = inject(SlotsService);
  private readonly cameras = inject(CamerasService);
  private readonly toasts = inject(NeatToasts);

  /** How many panel actions are in flight, per slot. */
  private readonly busyCounts = signal<ReadonlyMap<number, number>>(new Map());
  /**
   * Slots with a panel action in flight, frame-rate commits aside: their controls wait, so a second
   * click cannot race it.
   */
  readonly busy = computed<ReadonlySet<number>>(() => new Set(this.busyCounts().keys()));

  private readonly startingState = signal<ReadonlySet<number>>(new Set());
  /**
   * Slots with a start in flight, from the click to its answer: the list and the panel say
   * Starting… for them. Not `busy`, which every action of the panel marks.
   */
  readonly starting = this.startingState.asReadonly();

  private readonly commits = new Map<number, Promise<CommitResult>>();

  /**
   * Sets the file slot's output frame rate (null: the file's own), with the file it has.
   * Resolves with the outcome; a refusal is shown as an error toast.
   *
   * Through `SlotsService.assignFile`, not `CamerasService.assignFile`: the frame rate field only
   * shows for a slot with a file, never a webcam, and a commit must not count as a slot change,
   * which would make a bulk start refuse ("Waiting for a source change…") rather than wait for it.
   */
  commitFps(slot: Slot, fps: number | null): Promise<CommitResult> {
    const n = slot.n;
    const commit: Promise<CommitResult> = this.slots
      .assignFile(n, slot.file ?? '', fps)
      .then(
        (): CommitResult => ({ ok: true }),
        (failure: unknown): CommitResult => {
          this.toasts.error(messageOf(failure));
          return { ok: false };
        },
      )
      .finally(() => {
        if (this.commits.get(n) === commit) this.commits.delete(n);
      });
    this.commits.set(n, commit);
    return commit;
  }

  /** Waits for every rate commit in flight; resolves whether all of them landed. */
  async commitsSettled(): Promise<boolean> {
    return allCommitsSucceeded(await Promise.all(this.commits.values()));
  }

  /**
   * Starts the slot as it is once its rate commit, if any, has landed: a webcam by publishing this
   * browser's camera, anything else on the server (a file at another rate after its rendition is
   * encoded). Rejects with a message to show.
   */
  async start(n: number): Promise<StartOutcome> {
    // Taken before `run`, which waits for it too and by then the commit is no longer pending.
    const pending = this.commits.get(n);
    this.setStarting(n, true);
    try {
      return await this.run(n, async () => {
        if (pending && !(await pending).ok) return 'skipped';
        const slot = this.slots.slots()?.find((s) => s.n === n);
        if (slot?.kind === 'webcam') await this.cameras.publish(n);
        else await this.slots.start(n);
        return 'started';
      });
    } finally {
      this.setStarting(n, false);
    }
  }

  /** Stops the slot, which cancels its rendition's encode; its start then has nothing to wait for. */
  cancelEncoding(n: number): Promise<unknown> {
    return this.run(n, () => this.slots.stop(n));
  }

  /**
   * Runs work on a slot with the slot `busy` until it settles. It starts once a rate commit on its
   * way to the slot has landed: a commit posts the file the slot had, and work running beside it
   * (a Clear, another file, a camera) could be undone by it. The commit itself is not `busy`: the
   * click on Start that follows the blur which commits must still go through.
   */
  async run<T>(n: number, work: () => Promise<T>): Promise<T> {
    this.adjustBusy(n, 1);
    try {
      await this.commits.get(n);
      return await work();
    } finally {
      this.adjustBusy(n, -1);
    }
  }

  private setStarting(n: number, starting: boolean): void {
    this.startingState.update((all) => withMember(all, n, starting));
  }

  private adjustBusy(n: number, by: 1 | -1): void {
    this.busyCounts.update((counts) => {
      const next = new Map(counts);
      const count = (counts.get(n) ?? 0) + by;
      if (count > 0) next.set(n, count);
      else next.delete(n);
      return next;
    });
  }
}
