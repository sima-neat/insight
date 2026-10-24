import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import { firstValueFrom } from 'rxjs';
import type { BoardState } from '../board/api';
import { problemOf, type BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { LatestOnly } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type { PeripheralSnapshot } from './api';
import { isScanned } from './devices';

const SNAPSHOT_URL = '/api/peripherals';
const REFRESH_URL = '/api/peripherals/refresh';

/**
 * The selected board's peripheral scan, for the whole app: Peripherals lists it, and the board
 * dialog reads the camera setup from it. Root-provided, so the scan and the record of automatic
 * scans outlive a visit to the page.
 *
 * **Reads.** `GET /api/peripherals` never contacts the board: it answers the backend's cached
 * scan of the current board generation, or an empty snapshot before any. Only the newest answer
 * is applied, and none sent before a scan answered.
 *
 * **Scans.** `POST /api/peripherals/refresh` runs SiMa Sentinel's rescan on the board, which can
 * take seconds; the backend stops a running camera preview first. A scan also connects to the
 * board, which updates the board's status and identity, so the board is reloaded after every scan.
 */
@Injectable({ providedIn: 'root' })
export class PeripheralsService {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly toasts = inject(NeatToasts);

  private readonly snapshotValue = signal<PeripheralSnapshot | null>(null);
  /** The last snapshot read or scanned; null until the first answer. */
  readonly snapshot = this.snapshotValue.asReadonly();

  private readonly scanningValue = signal<number | null>(null);
  /** When the running scan started (epoch ms), for its "Scanning… N s"; null while none runs. */
  readonly scanning = this.scanningValue.asReadonly();

  private readonly scanErrorValue = signal<BoardProblem | null>(null);
  /** Why the last scan failed; cleared when the next one starts. */
  readonly scanError = this.scanErrorValue.asReadonly();

  private readonly latest = new LatestOnly();
  private running: Promise<void> | null = null;
  /**
   * The board generations scanned by `scanOnce` in this app session. A generation is recorded
   * when its scan starts, so a failed automatic scan is not repeated on the next visit (#170
   * repeated it on every mount, Inv-PB §6.9); Refresh is the way to try again.
   */
  private readonly autoScanned = new Set<number>();

  /**
   * Reads the current snapshot. Resolves once the answer is applied or dropped. No board selected
   * (`no_target`) is not a failure here: the board state already says so. Any other failure
   * rejects with its `BoardProblem` while no newer read was sent, since that one would answer for
   * it.
   */
  async load(): Promise<void> {
    const request = this.latest.next();
    try {
      const snapshot = await firstValueFrom(
        this.http.get<PeripheralSnapshot>(SNAPSHOT_URL).pipe(withRequestErrors()),
      );
      if (this.latest.accept(request)) this.snapshotValue.set(snapshot);
    } catch (failure) {
      const problem = problemOf(failure);
      if (problem.code !== 'no_target' && this.latest.isNewest(request)) throw problem;
    }
  }

  /**
   * Scans the board. Resolves when the scan ended and the board was reloaded; never rejects,
   * since a failure is reported in `scanError`. A call while a scan runs joins it: the backend
   * would coalesce a second request into the running scan anyway.
   */
  refresh(): Promise<void> {
    this.running ??= this.scan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * The automatic first scan of a board, once per board generation in this app session: it scans
   * when the board has a target and the loaded snapshot is that generation's and unscanned. Call
   * it after `load()`.
   */
  scanOnce(board: BoardState): void {
    const snapshot = this.snapshotValue();
    if (!board.target || snapshot === null) return;
    if (snapshot.generation !== board.generation || isScanned(snapshot)) return;
    if (this.autoScanned.has(board.generation)) return;
    this.autoScanned.add(board.generation);
    void this.refresh();
  }

  private async scan(): Promise<void> {
    this.scanningValue.set(Date.now());
    this.scanErrorValue.set(null);
    try {
      const snapshot = await firstValueFrom(
        this.http.post<PeripheralSnapshot>(REFRESH_URL, {}).pipe(withRequestErrors()),
      );
      // Reads still out were answered from the cache before this scan and would undo it.
      this.latest.discard();
      this.snapshotValue.set(snapshot);
      this.toasts.status(scanCompleteMessage(snapshot));
    } catch (failure) {
      this.scanErrorValue.set(problemOf(failure));
    } finally {
      this.scanningValue.set(null);
    }
    await this.board.reload();
  }
}

/** #170's toast (Inv-PB §2.2): "Scan complete: 2 cameras, 1 microphone on sima@192.168.2.2.". */
function scanCompleteMessage(snapshot: PeripheralSnapshot): string {
  const count = (kind: string) => snapshot.items.filter((item) => item.kind === kind).length;
  const found = `${countLabel(count('camera'), 'camera')}, ${countLabel(count('microphone'), 'microphone')}`;
  return `Scan complete: ${found} on ${snapshot.board.label || 'the board'}.`;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
