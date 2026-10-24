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
import { countLabel, isScanned } from './devices';

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
  /**
   * Why the last scan of the current board failed; cleared when the next scan starts and when a
   * snapshot of another board generation is applied (the service outlives the page, and an old
   * board's failure says nothing about the new one).
   */
  readonly scanError = this.scanErrorValue.asReadonly();
  /** The board generation `scanError` was a scan of. */
  private scanErrorGeneration: number | null = null;

  private readonly latest = new LatestOnly();
  /** The scan running or queued last, and the board generation it was started for. */
  private running: { generation: number | null; done: Promise<void> } | null = null;
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
      if (this.latest.accept(request)) this.apply(snapshot);
    } catch (failure) {
      // A failure answers for the reads sent before it as well, as a success would.
      if (!this.latest.isNewest(request) || !this.latest.accept(request)) return;
      const problem = problemOf(failure);
      if (problem.code !== 'no_target') throw problem;
    }
  }

  /**
   * Scans the selected board. Resolves when the scan ended and the board was reloaded; never
   * rejects, since a failure is reported in `scanError`. A call while a scan of the same board
   * runs joins it: the backend would coalesce a second request into the running scan anyway.
   */
  refresh(): Promise<void> {
    return this.scanFor(this.board.generation());
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
    void this.scanFor(board.generation);
  }

  /**
   * Joins the running scan when it is one of `generation`; otherwise queues a scan after it. A
   * scan started for an earlier board answers for that board only, and the backend runs one scan
   * at a time, so joining it would leave the new board unscanned.
   */
  private scanFor(generation: number | null): Promise<void> {
    const running = this.running;
    if (running && running.generation === generation) return running.done;
    // With nothing running, the request goes out now, so `scanning` is set when this returns. A
    // queued scan whose board was left again while it waited is skipped: the scan queued after it
    // is for the board now selected.
    const started = running
      ? running.done.then(() => (this.isPast(generation) ? undefined : this.scan(generation)))
      : this.scan(generation);
    const entry: { generation: number | null; done: Promise<void> } = {
      generation,
      done: started.finally(() => {
        if (this.running === entry) this.running = null;
      }),
    };
    this.running = entry;
    return entry.done;
  }

  private async scan(generation: number | null): Promise<void> {
    this.scanningValue.set(Date.now());
    this.scanErrorValue.set(null);
    try {
      const snapshot = await firstValueFrom(
        this.http.post<PeripheralSnapshot>(REFRESH_URL, {}).pipe(withRequestErrors()),
      );
      if (!this.isPast(snapshot.generation)) {
        // Reads still out were answered from the cache before this scan and would undo it.
        this.latest.discard();
        this.apply(snapshot);
        this.toasts.status(scanCompleteMessage(snapshot));
      }
    } catch (failure) {
      // A scan of a board the user has left failed for that board, typically because it changed.
      if (!this.isPast(generation)) {
        this.scanErrorValue.set(problemOf(failure));
        this.scanErrorGeneration = generation;
      }
    } finally {
      this.scanningValue.set(null);
    }
    await this.board.reload();
  }

  /**
   * An answer for this generation describes a board the user has left (Review Focus 1, never
   * apply a previous generation): it is older than the selected board's. Only the board's
   * generation decides, never the shown snapshot's: the counter starts over when Insight
   * restarts, and the board's re-read is what moves it, so a snapshot from before a restart must
   * not block every answer after it. A generation newer than the board's is applied: the board
   * service has not read the change yet (the scan reloads it right after). Unknown either way
   * (`null`) is not past.
   */
  private isPast(generation: number | null): boolean {
    const selected = this.board.generation();
    return generation !== null && selected !== null && generation < selected;
  }

  private apply(snapshot: PeripheralSnapshot): void {
    if (this.isPast(snapshot.generation)) return;
    this.snapshotValue.set(snapshot);
    if (this.scanErrorGeneration !== snapshot.generation) this.scanErrorValue.set(null);
  }
}

/** #170's toast (Inv-PB §2.2): "Scan complete: 2 cameras, 1 microphone on sima@192.168.2.2.". */
function scanCompleteMessage(snapshot: PeripheralSnapshot): string {
  const count = (kind: string) => snapshot.items.filter((item) => item.kind === kind).length;
  const found = `${countLabel(count('camera'), 'camera')}, ${countLabel(count('microphone'), 'microphone')}`;
  return `Scan complete: ${found} on ${snapshot.board.label || 'the board'}.`;
}
