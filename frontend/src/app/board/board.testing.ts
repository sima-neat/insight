import { computed, getDebugNode, signal } from '@angular/core';
import { NeatRailItem } from '@sima/neat-ui';
import type { PeripheralSnapshot } from '../peripherals/api';
import type { BoardState, BoardTarget, ShellInfo } from './api';
import type { BoardProblem } from './board-error';

/** A board state in the shape `GET /api/board` answers, with what a test does not care about filled in. */
export function boardState(overrides: Partial<BoardState> = {}): BoardState {
  return {
    target: null,
    saved: null,
    defaults: { on_board: false, sdk_env: null },
    generation: 1,
    status: { state: 'unknown', checked_at: null, error: null },
    board: null,
    ...overrides,
  };
}

/** The SDK-paired DevKit as `GET /api/board` names it. */
export const DEVKIT: BoardTarget = {
  mode: 'ssh',
  source: 'sdk-env',
  host: '192.168.1.20',
  port: 22,
  user: 'sima',
  label: 'sima@192.168.1.20',
};

/** The shell details of the SDK-paired DevKit with webssh installed: Open shell can sign in by itself. */
export function shellInfo(overrides: Partial<ShellInfo> = {}): ShellInfo {
  return {
    configured: true,
    devkit_ip: '192.168.1.20',
    button_label: 'DevKit: 192.168.1.20',
    available: true,
    running: false,
    webssh_port: 8022,
    webssh_host_port: 8022,
    default_username: 'sima',
    credentials_prefilled: true,
    launch_supported: true,
    launch_url: 'https://localhost:8022/?hostname=192.168.1.20',
    ...overrides,
  };
}

/** `BoardService` with its state set by the test and its calls recorded. */
export class FakeBoard {
  readonly state = signal<BoardState | null>(null);
  readonly error = signal<BoardProblem | null>(null);
  readonly checking = signal(false);
  readonly generation = computed(() => this.state()?.generation ?? null);
  readonly reload = vi.fn(async () => undefined);
  readonly select = vi.fn<() => Promise<BoardState>>();
  readonly test = vi.fn<() => Promise<BoardState>>();
  readonly trustHostKey = vi.fn<() => Promise<BoardState>>();
  readonly shellInfo = vi.fn<() => Promise<ShellInfo | null>>(async () => null);
  readonly startShell = vi.fn<() => Promise<ShellInfo>>();
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
