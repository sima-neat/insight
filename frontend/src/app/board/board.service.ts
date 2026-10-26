import { HttpClient } from '@angular/common/http';
import { computed, DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import { LatestOnly } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import type { BoardSelectRequest, BoardState, ShellInfo, TrustHostKeyRequest } from './api';
import { problemOf, type BoardProblem } from './board-error';

const BOARD_URL = '/api/board';
const SHELL_URL = '/api/devkit-shell';

/**
 * The selected board, as one service for the whole app: the top bar's pill, the board dialog,
 * Peripherals and Stats read the same state and reload it here. Page code never fetches
 * `/api/board` itself.
 *
 * **Reads.** `GET /api/board` never connects to the board, so it is cheap. It is read once when
 * the service is created, whenever the window regains focus (another tab or a terminal may have
 * changed the board meanwhile) unless a read is already out, and when a caller asks; never on a
 * timer (spec, "Board refresh").
 * Answers can arrive out of order, so a read's answer is dropped once a newer read was answered or
 * an action applied its state since the read was sent: it describes a moment that is past.
 *
 * **The check on load.** A read never connects, so a board never connected to would stay "Not
 * checked". The first read of an app load that gets an answer therefore runs `test()` when a board
 * is selected and its state is unknown, silently: a failure only lands in the state (the pill
 * shows Error). Later reads, focus included, never check; "Check again" is the user's. While a
 * check is out, `checking` says so, and the pill reads Checking… rather than Not checked: over
 * SSH a check takes seconds, and a full timeout when the board is unreachable.
 *
 * **Actions.** Select, Check again and Trust each answer with the fresh board state, which wins
 * over every read still out. A failed action reloads the state (it may have recorded the failure)
 * and then rejects with its `BoardProblem`, an `Error` whose message `messageOf` gives.
 */
@Injectable({ providedIn: 'root' })
export class BoardService {
  private readonly http = inject(HttpClient);

  private readonly stateValue = signal<BoardState | null>(null);
  /** The last good answer; null until the first one. */
  readonly state = this.stateValue.asReadonly();

  private readonly errorValue = signal<BoardProblem | null>(null);
  /**
   * The newest read failed; cleared by the next good answer. A failed action is not a failed
   * read: it rejects instead. With no `state`, the board could not be read at all; with both,
   * `state` is the last one known.
   */
  readonly error = this.errorValue.asReadonly();

  /** The board generation of `state`; answers that name another one are about another board. */
  readonly generation = computed(() => this.state()?.generation ?? null);

  private readonly checksOut = signal(0);
  /**
   * A connection check (`test()`: the load's or Check again) is out, until its answer is applied
   * or, after a failure, the state it recorded is re-read.
   */
  readonly checking = computed(() => this.checksOut() > 0);

  private readonly latest = new LatestOnly();
  /** Reads sent and not settled yet. */
  private readsOut = 0;
  /** The load's one check was decided: the first answered read either started it or found no need. */
  private checkDecided = false;

  constructor() {
    void this.reload();
    const window = inject(DOCUMENT).defaultView;
    if (window) {
      // A read still out answers for this focus too: alt-tabbing, or the focus some browsers
      // fire right after load, would otherwise stack reads that the newest one supersedes.
      const onFocus = () => {
        if (this.readsOut === 0) void this.reload();
      };
      window.addEventListener('focus', onFocus);
      inject(DestroyRef).onDestroy(() => window.removeEventListener('focus', onFocus));
    }
  }

  /**
   * Reads the board state. Resolves once the answer is applied or dropped; never rejects, since a
   * failure is reported in `error`. A failure is reported only while no newer read is out: that
   * one is what says whether the board can be read.
   */
  async reload(): Promise<void> {
    const request = this.latest.next();
    this.readsOut++;
    try {
      const state = await firstValueFrom(
        this.http.get<BoardState>(BOARD_URL).pipe(withRequestErrors()),
      );
      if (this.latest.accept(request)) {
        this.apply(state);
        this.checkOnce(state);
      }
    } catch (failure) {
      if (this.latest.isNewest(request) && this.latest.accept(request)) {
        this.errorValue.set(problemOf(failure));
      }
    } finally {
      this.readsOut--;
    }
  }

  /** Saves a manual target, or with `{reset: true}` clears it to fall back to the default. */
  select(request: BoardSelectRequest): Promise<BoardState> {
    return this.act(this.http.post<BoardState>(`${BOARD_URL}/select`, request));
  }

  /** Connects to the board over SSH and reads its identity ("Check again"). */
  async test(): Promise<BoardState> {
    this.checksOut.update((count) => count + 1);
    try {
      // A board changed while the check was out (Select answered meanwhile) is not the one checked.
      return await this.act(
        this.http.post<BoardState>(`${BOARD_URL}/test`, {}),
        (state) => this.generation() === null || state.generation === this.generation(),
      );
    } finally {
      this.checksOut.update((count) => count - 1);
    }
  }

  /** Trusts the host key a reflashed board presented; `fingerprint` must be the presented one. */
  trustHostKey(fingerprint: string): Promise<BoardState> {
    const body: TrustHostKeyRequest = { fingerprint };
    return this.act(this.http.post<BoardState>(`${BOARD_URL}/trust-host-key`, body));
  }

  /**
   * The browser shell's details for the selected board; null when they could not be read, which
   * hides the shell. The answer carries the launch URL with the SDK's default password, so it is
   * read only when the board dialog needs it, never at app start (spec, "Shell URL").
   */
  shellInfo(): Promise<ShellInfo | null> {
    return firstValueFrom(this.http.get<ShellInfo>(SHELL_URL).pipe(withRequestErrors())).catch(
      () => null,
    );
  }

  /**
   * Starts webssh (if it is not running) and answers the shell's details with the launch URL.
   * Rejects with an `ApiRequestError` carrying the server's message.
   */
  startShell(): Promise<ShellInfo> {
    return firstValueFrom(
      this.http.post<ShellInfo>(`${SHELL_URL}/start`, {}).pipe(withRequestErrors()),
    );
  }

  /**
   * Checks the connection the first time a read is answered, if there is a board whose state is
   * unknown. The failure is dropped on purpose: `act` reloads the state it recorded, which the
   * pill shows, and a toast for a check the user did not ask for would only nag.
   */
  private checkOnce(state: BoardState): void {
    if (this.checkDecided) return;
    this.checkDecided = true;
    if (state.target && state.status.state === 'unknown') this.test().catch(() => undefined);
  }

  private async act(
    call: Observable<BoardState>,
    current: (state: BoardState) => boolean = () => true,
  ): Promise<BoardState> {
    let state: BoardState;
    try {
      state = await firstValueFrom(call.pipe(withRequestErrors()));
    } catch (failure) {
      await this.reload();
      throw problemOf(failure);
    }
    // An answer about a board that is no longer the selected one is returned, not applied.
    if (!current(state)) return state;
    // Reads still out were sent before this answer and may describe the board from before it.
    this.latest.discard();
    this.apply(state);
    return state;
  }

  private apply(state: BoardState): void {
    this.stateValue.set(state);
    this.errorValue.set(null);
  }
}
