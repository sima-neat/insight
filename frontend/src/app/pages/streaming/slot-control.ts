import { computed, inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../../sources/api';
import { CamerasService } from '../../sources/cameras.service';
import {
  allCommitsSucceeded,
  type CommitResult,
  needsRendition,
  withCommittedFps,
} from '../../sources/fps';
import { failureText } from '../../sources/progress-lines';
import { SlotsService } from '../../sources/slots.service';

/** How a start ended: started, cancelled while encoding, or skipped because its rate commit failed. */
export type StartOutcome = 'started' | 'cancelled' | 'skipped';

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The Streaming side panel's work on a slot that has to outlive the panel: the panel shows one
 * slot and is built afresh for each, while a frame-rate commit, an encode or a start goes on when
 * another slot is selected, or the page is left and come back to (Cancel encoding must still
 * reach the encode). Root-provided for that reason; only the lazy Streaming page imports it.
 *
 * **Frame-rate commits** (#170's `commitFps`). The stepper commits when its field is left, so a
 * click on Start, or on Start… for a bulk start, comes right after a commit that has not landed.
 * Both wait for it, so the server starts the rate just chosen and the start does not race the
 * assignment on the server; neither sends anything when it was refused. A refusal is reported
 * here, once, whoever waits for it.
 *
 * **Starting** a file slot at a rate other than its own encodes the rendition first
 * (`SlotsService.prepare`, whose progress the list and the panel show), then starts it. The encode
 * can be cancelled; the start then ends quietly.
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

  private readonly preparingState = signal<ReadonlySet<number>>(new Set());
  /** Slots whose start is encoding a rendition, which Cancel encoding can stop. */
  readonly preparing = this.preparingState.asReadonly();

  private readonly commits = new Map<number, Promise<CommitResult>>();
  /** How to cancel each running encode: it ends the request and settles its start as cancelled. */
  private readonly cancels = new Map<number, () => void>();

  /**
   * Sets the slot's output frame rate (null: the file's own), with the file and transport it has,
   * as #170 did. Resolves with the outcome; a refusal is shown as an error toast.
   *
   * Through `SlotsService.assign`, not `CamerasService.assignFile`: the stepper only shows for a
   * slot with a file, never a webcam, and a commit must not count as a slot change, which would
   * make a bulk start refuse ("Waiting for a source change…") rather than wait for it.
   */
  commitFps(slot: Slot, fps: number | null): Promise<CommitResult> {
    const index = slot.index;
    const commit: Promise<CommitResult> = this.slots
      .assign({ index, file: slot.file, transport: slot.transport || 'rtsp', fps })
      .then(
        (): CommitResult => ({ ok: true, fps }),
        (failure: unknown): CommitResult => {
          this.toasts.error(messageOf(failure));
          return { ok: false };
        },
      )
      .finally(() => {
        if (this.commits.get(index) === commit) this.commits.delete(index);
      });
    this.commits.set(index, commit);
    return commit;
  }

  /** Waits for every rate commit in flight; resolves whether all of them landed. */
  async commitsSettled(): Promise<boolean> {
    return allCommitsSucceeded(await Promise.all(this.commits.values()));
  }

  /**
   * Starts the slot as it is once its rate commit, if any, has landed: a webcam by publishing this
   * browser's camera, a file at its own rate directly, at another rate after encoding the
   * rendition. Rejects with a message to show.
   */
  start(index: number): Promise<StartOutcome> {
    // Taken before `run`, which waits for it too and by then the commit is no longer pending.
    const pending = this.commits.get(index);
    return this.run(index, async () => {
      const current = this.slots.slots()?.find((slot) => slot.index === index);
      const slot = withCommittedFps(current, pending ? await pending : undefined);
      if (!slot) return 'skipped';
      if (slot.type === 'webcam') {
        await this.cameras.publish(index);
        return 'started';
      }
      if (!needsRendition(slot)) {
        await this.slots.start({ index });
        return 'started';
      }
      if ((await this.prepare(index, slot.fps!)) === 'cancelled') return 'cancelled';
      await this.slots.startAfterPrepare(index);
      return 'started';
    });
  }

  /** Stops the slot's encode; its start then ends as cancelled. Does nothing when none runs. */
  cancelEncoding(index: number): void {
    this.cancels.get(index)?.();
  }

  /**
   * Runs work on a slot with the slot `busy` until it settles. It starts once a rate commit on its
   * way to the slot has landed: a commit posts the file the slot had, and work running beside it
   * (a Clear, another file, a camera) could be undone by it. The commit itself is not `busy`: the
   * click on Start that follows the blur which commits must still go through.
   */
  async run<T>(index: number, work: () => Promise<T>): Promise<T> {
    this.adjustBusy(index, 1);
    try {
      await this.commits.get(index);
      return await work();
    } finally {
      this.adjustBusy(index, -1);
    }
  }

  /**
   * Encodes the slot's rendition and resolves once it is ready, or as cancelled. A refused request
   * rejects with the server's message; a failure the server reports in its lines (the response is
   * still a 200) rejects with #170's message for it.
   */
  private prepare(index: number, fps: number): Promise<'done' | 'cancelled'> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const end = () => {
        this.cancels.delete(index);
        this.setPreparing(index, false);
      };
      this.cancels.set(index, () => {
        subscription.unsubscribe();
        end();
        resolve('cancelled');
      });
      this.setPreparing(index, true);
      const subscription = this.slots.prepare(index).subscribe({
        next: (event) => {
          if (event.kind === 'line') lines.push(event.text);
        },
        error: (failure: unknown) => {
          end();
          reject(failure);
        },
        complete: () => {
          end();
          const failed = failureText(lines);
          if (failed === null) resolve('done');
          else
            reject(
              new Error(
                `Encoding src${index} at ${fps} fps failed. Partial output was removed; the source file is unchanged. ${failed}`,
              ),
            );
        },
      });
    });
  }

  private setPreparing(index: number, preparing: boolean): void {
    this.preparingState.update((all) => {
      const next = new Set(all);
      if (preparing) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  private adjustBusy(index: number, by: 1 | -1): void {
    this.busyCounts.update((counts) => {
      const next = new Map(counts);
      const count = (counts.get(index) ?? 0) + by;
      if (count > 0) next.set(index, count);
      else next.delete(index);
      return next;
    });
  }
}
