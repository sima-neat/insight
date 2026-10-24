import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import { firstValueFrom } from 'rxjs';
import { BoardService } from '../board/board.service';
import { PeripheralsService } from '../peripherals/peripherals.service';
import { withRequestErrors } from '../sources/stream-lines';
import type { SentinelInstallResult } from './api';
import { failureOf, type SentinelFailure } from './sentinel-failure';

const INSTALL_URL = '/api/sentinel/install';

/** How an install ended; `generation` is the board it was run on. */
export type InstallOutcome =
  | { generation: number; ok: true; log: string }
  | { generation: number; ok: false; failure: SentinelFailure };

/**
 * Installs Sentinel on the board, for the whole app. Root-provided because the install takes
 * minutes and leaving Stats must not lose it: the request belongs to no page, so a page's
 * destruction cannot cancel it. A reload or another tab cannot find out about a running install,
 * since the backend has no install-status read; this is the only place that knows.
 *
 * The request has no client timeout: the backend gives the installer 900 s and answers when it
 * ends.
 */
@Injectable({ providedIn: 'root' })
export class SentinelInstall {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly peripherals = inject(PeripheralsService);
  private readonly toasts = inject(NeatToasts);

  private readonly runningValue = signal<{ generation: number; label: string } | null>(null);
  /**
   * The install now running and the board it runs on, which may not be the selected one: the
   * backend runs on whichever board was selected when it started, and the user may switch while it
   * runs. Null while none runs.
   */
  readonly running = this.runningValue.asReadonly();

  private readonly outcomeValue = signal<InstallOutcome | null>(null);
  /** How the last install ended, until the next one starts; null before any. */
  readonly outcome = this.outcomeValue.asReadonly();

  /**
   * Installs Sentinel on the board of `generation`, named `label` in what is said about it. Does
   * nothing while an install runs: the backend runs one at a time. Resolves when the install ended
   * and the board was reloaded; never rejects, since a failure is reported in `outcome`.
   */
  async install(generation: number, label: string): Promise<void> {
    if (this.runningValue() !== null) return;
    this.outcomeValue.set(null);
    this.runningValue.set({ generation, label });
    let outcome: InstallOutcome;
    try {
      const result = await firstValueFrom(
        this.http
          .post<SentinelInstallResult>(INSTALL_URL, {}, { params: { generation } })
          .pipe(withRequestErrors()),
      );
      outcome = { generation, ok: true, log: result.log };
    } catch (error) {
      outcome = { generation, ok: false, failure: failureOf(error, generation, 'install') };
    }
    if (outcome.ok) {
      this.toasts.status(`Sentinel installed on ${label}.`);
      // Peripherals scans through Sentinel, so a scan from before the install found nothing or
      // failed. The next visit to the page scans again, not a scan nobody is looking at.
      this.peripherals.rescanOnNextVisit(generation);
    } else {
      this.toasts.error(outcome.failure.problem.message);
    }
    this.outcomeValue.set(outcome);
    this.runningValue.set(null);
    // The daemon's state, and the board's status, changed either way: a failed installer may
    // still have left the service running.
    await this.board.reload();
  }
}
