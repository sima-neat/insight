import { HttpClient } from '@angular/common/http';
import { computed, DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';
import { LatestOnly } from '../polling';
import { withRequestErrors } from '../sources/stream-lines';
import {
  boardUrl,
  selectedTarget,
  type BoardList,
  type BoardTarget,
  type SshAddress,
  type TrustHostKeyRequest,
} from './api';
import { problemOf, type BoardProblem } from './board-error';

const BOARDS_URL = '/api/boards';

/**
 * The selected board, as one service for the whole app: the rail's board block, the board dialog,
 * Peripherals and Stats read the same state and reload it here. Page code never fetches
 * `/api/boards` itself.
 *
 * **The board's id.** Every board route names the board by its `id` (`boardUrl`), which is what
 * tells two boards apart: a request for a board that is no longer selected is answered 404
 * `not_found`, and an answer is about the board whose id it was sent with. Code that holds
 * something of a board keeps the id it asked with and drops what it holds when `id` changes.
 *
 * **Reads.** `GET /api/boards` never connects to the board, so it is cheap. It is read once when
 * the service is created, whenever the window regains focus (another tab or a terminal may have
 * changed the board meanwhile) unless a read is already out, and when a caller asks; never on a
 * timer. Answers can arrive out of order, so a read's answer is dropped once a newer read was
 * answered or an action applied its state since the read was sent: it describes a moment that is
 * past.
 *
 * **The check on load.** A read never connects, so a board never connected to would stay "Not
 * checked". The first read of an app load that gets an answer therefore runs `check()` when a
 * board is selected and its state is unknown, silently: a failure only lands in the state (the
 * block shows Error). Later reads, focus included, never check; "Check again" is the user's. While
 * a check is out, `checking` says so, and the block reads Checking… rather than Not checked: over
 * SSH a check takes seconds, and a full timeout when the board is unreachable.
 *
 * **Actions.** Select, Use default, Check again and Trust each answer with the fresh boards, which
 * win over every read still out. A failed action reloads the state (it may have recorded the
 * failure) and then rejects with its `BoardProblem`, an `Error` whose message `messageOf` gives.
 */
@Injectable({ providedIn: 'root' })
export class BoardService {
  private readonly http = inject(HttpClient);

  private readonly stateValue = signal<BoardList | null>(null);
  /** The last good answer of the boards; null until the first one. */
  readonly state = this.stateValue.asReadonly();

  private readonly errorValue = signal<BoardProblem | null>(null);
  /**
   * The newest read failed; cleared by the next good answer. A failed action is not a failed
   * read: it rejects instead. With no `state`, the board could not be read at all; with both,
   * `state` is the last one known.
   */
  readonly error = this.errorValue.asReadonly();

  /** The selected board with its status and identity; null while none is (or nothing was read). */
  readonly selected = computed(() => this.state()?.selected ?? null);

  /** The selected board's id, which every board route takes; null while none is selected. */
  readonly id = computed(() => this.selected()?.id ?? null);

  /** Where the selected board is: its mode, source and SSH address; null while none is selected. */
  readonly target = computed<BoardTarget | null>(() => selectedTarget(this.state()));

  private readonly checksOut = signal(0);
  /**
   * A connection check (`check()`: the load's or Check again) is out, until its answer is applied
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
   * Reads the boards. Resolves once the answer is applied or dropped; never rejects, since a
   * failure is reported in `error`. A failure is reported only while no newer read is out: that
   * one is what says whether the board can be read.
   */
  async reload(): Promise<void> {
    const request = this.latest.next();
    this.readsOut++;
    try {
      const state = await firstValueFrom(
        this.http.get<BoardList>(BOARDS_URL).pipe(withRequestErrors()),
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

  /** Enters a board by its SSH address and selects it. */
  select(address: SshAddress): Promise<BoardList> {
    return this.act(this.http.post<BoardList>(BOARDS_URL, address));
  }

  /**
   * Forgets the board entered by hand, so the selection falls back to the board Insight runs on,
   * else the SDK's DevKit ("Use default"). Rejects without asking when no board was entered.
   */
  forget(): Promise<BoardList> {
    const entered = this.state()?.boards.find((board) => board.source === 'manual');
    if (!entered) return Promise.reject(problemOf(new Error('No board was entered by hand.')));
    return this.act(this.http.delete<BoardList>(boardUrl(entered.id)));
  }

  /** Connects to the selected board over SSH and reads its identity ("Check again"). */
  async check(): Promise<BoardList> {
    const id = this.id();
    if (id === null) throw problemOf(new Error('No board is selected.'));
    this.checksOut.update((count) => count + 1);
    try {
      // A board changed while the check was out (Select answered meanwhile) is not the one checked.
      return await this.act(
        this.http.post<BoardList>(boardUrl(id, 'check'), {}),
        (state) => state.selected?.id === this.id(),
      );
    } finally {
      this.checksOut.update((count) => count - 1);
    }
  }

  /** Trusts the host key a reflashed board presented; `fingerprint` must be the presented one. */
  trustHostKey(fingerprint: string): Promise<BoardList> {
    const id = this.id();
    if (id === null) return Promise.reject(problemOf(new Error('No board is selected.')));
    const body: TrustHostKeyRequest = { fingerprint };
    return this.act(this.http.post<BoardList>(boardUrl(id, 'trust-host-key'), body));
  }

  /**
   * Checks the connection the first time a read is answered, if there is a board whose state is
   * unknown. The failure is dropped on purpose: `act` reloads the state it recorded, which the
   * block shows, and a toast for a check the user did not ask for would only nag.
   */
  private checkOnce(state: BoardList): void {
    if (this.checkDecided) return;
    this.checkDecided = true;
    if (state.selected?.status.state === 'unknown') this.check().catch(() => undefined);
  }

  private async act(
    call: Observable<BoardList>,
    current: (state: BoardList) => boolean = () => true,
  ): Promise<BoardList> {
    let state: BoardList;
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

  private apply(state: BoardList): void {
    this.stateValue.set(state);
    this.errorValue.set(null);
  }
}
