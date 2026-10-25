import { Injectable, signal, type WritableSignal } from '@angular/core';
import type { OverviewCardId } from './telemetry';

/**
 * Where the user left Stats, so that coming back from another page finds it as it was. Provided in
 * root because the page is created afresh on every visit; kept in memory only, so a reload starts
 * over, as #170 did. Like `PeripheralsSession` for Peripherals.
 */
@Injectable({ providedIn: 'root' })
export class StatsSession {
  /**
   * The overview card whose area is open; null while none is chosen, when the panel's area is
   * Thermal.
   */
  readonly card: WritableSignal<OverviewCardId | null> = signal(null);
  /** The thermal group chosen in the Thermal area; null before the first choice. */
  readonly thermalGroup: WritableSignal<string | null> = signal(null);
  /** The id of the run selected in Runs, whose detail the panel shows; null before any is. */
  readonly run: WritableSignal<string | null> = signal(null);
  /**
   * The ids of the runs ticked in Runs, in the order they were ticked: Compare takes the first as
   * its baseline.
   */
  readonly checkedRuns: WritableSignal<readonly string[]> = signal([]);

  /** The board generation `run` and `checkedRuns` were chosen on; undefined before the first. */
  private runsGeneration: number | undefined = undefined;

  /**
   * Follows the board the page shows. The selected and ticked runs are ids on the board they were
   * chosen on, so another board (a new generation, switched to here or while Stats was away)
   * starts with none rather than with ids its own runs may not have.
   */
  followBoard(generation: number): void {
    if (this.runsGeneration !== undefined && generation !== this.runsGeneration) {
      this.run.set(null);
      this.checkedRuns.set([]);
    }
    this.runsGeneration = generation;
  }
}
