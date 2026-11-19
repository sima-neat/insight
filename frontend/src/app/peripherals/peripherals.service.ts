import { HttpClient } from '@angular/common/http';
import { effect, inject, Injectable, signal } from '@angular/core';
import { NeatToasts } from '@sima/neat-ui/toast';
import { firstValueFrom } from 'rxjs';
import { boardUrl } from '../board/api';
import { BOARD_GONE_CODES, problemOf, type BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { LatestOnly } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type { Peripherals, PeripheralSnapshot, SnapshotBoard } from './api';
import { snapshotOf } from './catalog';
import { countLabel } from './devices';

/**
 * The selected board's peripheral scan, for the whole app: Peripherals lists it, and the board
 * dialog reads the camera setup from it. Root-provided, so the scan outlives a visit to the page.
 * The server answers SiMa Sentinel's catalog as it wrote it; the device model the page shows is
 * built from it here (`snapshotOf`).
 *
 * **Reads.** `GET .../peripherals` never contacts the board: it answers the server's last scan of
 * the board, or none before the first. Only the newest answer is applied, none sent before a scan
 * answered, and none for a board that is no longer selected.
 *
 * **Scans.** `POST .../peripherals/refresh` runs SiMa Sentinel's rescan on the board, which can
 * take seconds; the server stops a running camera preview first. A scan also connects to the
 * board, which updates the board's status, so the boards are reloaded after every scan.
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
  /**
   * When the scan of the board now asked for started (epoch ms), for its "Scanning… N s"; null
   * while none runs or waits. A scan queued behind another board's counts from when it was
   * queued, and again from when its own request goes out, never with the old board's time. It
   * stays set between the two, so the count does not blink off while the old scan ends.
   */
  readonly scanning = this.scanningValue.asReadonly();

  private readonly scanErrorValue = signal<BoardProblem | null>(null);
  /**
   * Why the last scan of the selected board failed; cleared when the next scan starts and when
   * another board is selected, or a snapshot of one is applied (the service outlives the page, and
   * an old board's failure says nothing about the new one: it must not stand beside "Board changed
   * — refresh", offering the old board's settings).
   */
  readonly scanError = this.scanErrorValue.asReadonly();
  /** The board `scanError` was a scan of. */
  private scanErrorBoard: string | null = null;

  private readonly latest = new LatestOnly();
  /** The scan running or queued last, and the board it was started for. */
  private running: { board: string; done: Promise<void> } | null = null;

  constructor() {
    // Watched for as long as the app runs, so that a board change drops the old board's failure
    // while the page is not shown too (the boards are re-read on focus).
    effect(() => this.noteBoard(this.board.id()));
  }

  /**
   * Reads the selected board's last scan. Resolves once the answer is applied or dropped, and at
   * once without a board (the boards already say so). A board replaced meanwhile (`not_found`)
   * reloads the boards rather than failing. Any other failure rejects with its `BoardProblem`
   * while no newer read was sent, since that one would answer for it.
   */
  async load(): Promise<void> {
    const board = this.selectedBoard();
    if (!board) return;
    const request = this.latest.next();
    try {
      const answer = await firstValueFrom(
        this.http.get<Peripherals>(boardUrl(board.id, 'peripherals')).pipe(withRequestErrors()),
      );
      if (this.latest.accept(request)) this.apply(snapshotOf(board, answer));
    } catch (failure) {
      // A failure answers for the reads sent before it as well, as a success would.
      if (!this.latest.isNewest(request) || !this.latest.accept(request)) return;
      const problem = problemOf(failure);
      if (!BOARD_GONE_CODES.has(problem.code)) throw problem;
      await this.board.reload();
    }
  }

  /**
   * Scans the selected board. Resolves when the scan ended and the boards were reloaded; never
   * rejects, since a failure is reported in `scanError`. A call while a scan of the same board
   * runs joins it: the server would coalesce a second request into the running scan anyway.
   */
  refresh(): Promise<void> {
    return this.scanFor(this.selectedBoard(), true);
  }

  /**
   * The scan of a visit to Peripherals: whenever the page is entered with a board selected and the
   * loaded snapshot is that board's. Scanned or not, failed before or not: the devices change
   * under the page, and a scan is the only way to see it. Never on a timer, since a scan takes
   * seconds and stops a running camera preview. Call it after `load()`; a call while a scan of the
   * board runs joins it (`scanFor`). Resolves when the scan ended (at once when none was due),
   * never rejecting, so that the page can start a preview only after the scan stopped any. A
   * visit's scan is silent when it succeeds: a toast on every navigation would be noise, and the
   * list changing says it. A failure shows in `scanError` as for Refresh.
   */
  scanOnVisit(): Promise<void> {
    const board = this.selectedBoard();
    this.noteBoard(board?.id ?? null);
    const snapshot = this.snapshotValue();
    if (!board || snapshot?.board.id !== board.id) return Promise.resolve();
    return this.scanFor(board, false);
  }

  /** The selected board as a snapshot names it; null while none is selected. */
  private selectedBoard(): SnapshotBoard | null {
    const selected = this.board.selected();
    return selected ? { id: selected.id, label: selected.label } : null;
  }

  /**
   * Joins the running scan when it is one of `board` (whatever it announces); otherwise queues a
   * scan after it, which toasts its result when `announce`. A scan started for an earlier board
   * answers for that board only, and the server runs one scan at a time, so joining it would
   * leave the new board unscanned.
   */
  private scanFor(board: SnapshotBoard | null, announce: boolean): Promise<void> {
    if (!board) return Promise.resolve();
    const running = this.running;
    if (running && running.board === board.id) return running.done;
    // With nothing running, the request goes out now, so `scanning` is set when this returns. A
    // queued scan whose board was left again while it waited is skipped: the scan queued after it
    // is for the board now selected. A queued scan counts from now: the running one is another
    // board's, whose time says nothing about this one.
    if (running) this.scanningValue.set(Date.now());
    const started = running
      ? running.done.then(() => (this.isPast(board.id) ? undefined : this.scan(board, announce)))
      : this.scan(board, announce);
    const entry = {
      board: board.id,
      done: started.finally(() => {
        if (this.running !== entry) return;
        this.running = null;
        this.scanningValue.set(null);
      }),
    };
    this.running = entry;
    return entry.done;
  }

  private async scan(board: SnapshotBoard, announce: boolean): Promise<void> {
    this.scanningValue.set(Date.now());
    this.scanErrorValue.set(null);
    try {
      const answer = await firstValueFrom(
        this.http
          .post<Peripherals>(boardUrl(board.id, 'peripherals/refresh'), {})
          .pipe(withRequestErrors()),
      );
      if (!this.isPast(board.id)) {
        // Reads still out were answered from the server's last scan before this one.
        this.latest.discard();
        const snapshot = snapshotOf(board, answer);
        this.apply(snapshot);
        if (announce) this.toasts.status(scanCompleteMessage(snapshot));
      }
    } catch (failure) {
      // A scan of a board the user has left failed for that board, typically because it changed.
      if (!this.isPast(board.id)) {
        this.scanErrorValue.set(problemOf(failure));
        this.scanErrorBoard = board.id;
      }
    }
    // `scanning` is cleared once no scan is queued after this one (`scanFor`).
    await this.board.reload();
  }

  /** An answer for this board describes one the user has left: another one is selected now. */
  private isPast(board: string): boolean {
    const selected = this.board.id();
    return selected !== null && board !== selected;
  }

  /**
   * Notes the selected board: a scan failure of another board is dropped (`scanError`), since an
   * old board's failure says nothing about the new one.
   */
  private noteBoard(board: string | null): void {
    if (board === null) return;
    if (this.scanErrorBoard !== board) this.scanErrorValue.set(null);
  }

  private apply(snapshot: PeripheralSnapshot): void {
    if (this.isPast(snapshot.board.id)) return;
    this.snapshotValue.set(snapshot);
    if (this.scanErrorBoard !== snapshot.board.id) this.scanErrorValue.set(null);
  }
}

/** The toast of a Refresh: "Scan complete: 2 cameras, 1 microphone on sima@192.168.2.2.". */
function scanCompleteMessage(snapshot: PeripheralSnapshot): string {
  const count = (kind: string) => snapshot.items.filter((item) => item.kind === kind).length;
  const found = `${countLabel(count('camera'), 'camera')}, ${countLabel(count('microphone'), 'microphone')}`;
  return `Scan complete: ${found} on ${snapshot.board.label || 'the board'}.`;
}
