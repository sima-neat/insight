import { computed, getDebugNode, signal } from '@angular/core';
import { NeatRailItem } from '@sima/neat-ui';
import type { PeripheralSnapshot } from '../peripherals/api';
import { selectedTarget, type BoardList, type BoardTarget, type SelectedBoard } from './api';
import type { BoardProblem } from './board-error';

/** The SDK-paired DevKit as `GET /api/boards` names it. */
export const DEVKIT: BoardTarget = {
  id: 'ssh:sima@192.168.1.20:22',
  mode: 'ssh',
  source: 'sdk-env',
  host: '192.168.1.20',
  port: 22,
  user: 'sima',
  label: 'sima@192.168.1.20',
};

/** The board Insight runs on, as `GET /api/boards` names it. */
export const LOCAL: BoardTarget = {
  id: 'local',
  mode: 'local',
  source: 'on-board',
  label: 'This board',
};

/** A board entered by hand on another port, as `GET /api/boards` names it. */
export const MANUAL: BoardTarget = {
  id: 'ssh:sima@10.0.0.5:2222',
  mode: 'ssh',
  source: 'manual',
  host: '10.0.0.5',
  port: 2222,
  user: 'sima',
  label: 'sima@10.0.0.5:2222',
};

/** `target` as the selected board, not checked yet, with what a test does not care about filled in. */
export function selectedBoard(
  target: BoardTarget = DEVKIT,
  overrides: Partial<SelectedBoard> = {},
): SelectedBoard {
  const ssh =
    target.mode === 'ssh'
      ? `ssh ${target.port && target.port !== 22 ? `-p ${target.port} ` : ''}${target.user}@${target.host}`
      : undefined;
  return {
    id: target.id,
    label: target.label,
    status: { state: 'unknown' },
    identity: null,
    ...(ssh ? { ssh } : {}),
    ...overrides,
  };
}

/**
 * The boards in the shape `GET /api/boards` answers: `selected` the first of `boards` unless
 * given (null for none), and no board at all by default.
 */
export function boardList(
  boards: readonly BoardTarget[] = [],
  selected: SelectedBoard | null = boards.length ? selectedBoard(boards[0]) : null,
): BoardList {
  return { boards, selected };
}

/** The boards with `target` selected and its selection's `overrides` (status, identity). */
export function boardWith(
  target: BoardTarget = DEVKIT,
  overrides: Partial<SelectedBoard> = {},
): BoardList {
  return boardList([target], selectedBoard(target, overrides));
}

/** `BoardService` with its state set by the test and its calls recorded. */
export class FakeBoard {
  readonly state = signal<BoardList | null>(null);
  readonly error = signal<BoardProblem | null>(null);
  readonly checking = signal(false);
  readonly selected = computed(() => this.state()?.selected ?? null);
  readonly id = computed(() => this.selected()?.id ?? null);
  readonly target = computed(() => selectedTarget(this.state()));
  readonly reload = vi.fn(async () => undefined);
  readonly select = vi.fn<() => Promise<BoardList>>();
  readonly forget = vi.fn<() => Promise<BoardList>>();
  readonly check = vi.fn<() => Promise<BoardList>>();
  readonly trustHostKey = vi.fn<() => Promise<BoardList>>();
}

/**
 * `PeripheralsService` as the board dialog uses it: the snapshot and the read it asks for.
 */
export class FakePeripherals {
  readonly snapshot = signal<PeripheralSnapshot | null>(null);
  readonly load = vi.fn(async () => undefined);
}

/** A promise the test settles itself, for answers that arrive out of order. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The kit's rail item behind a board block's button: what the app gave it through its inputs
 * (`label`, `text`, `detail`, `tone`), which is the app's part. How the kit draws them is the
 * kit's to test.
 */
export function railItem(button: HTMLElement): NeatRailItem {
  return getDebugNode(button)!.injector.get(NeatRailItem);
}
