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
}
