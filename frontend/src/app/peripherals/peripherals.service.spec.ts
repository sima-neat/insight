import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardState } from '../board/api';
import { BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import type { PeripheralItem, PeripheralSnapshot } from './api';
import { PeripheralsService } from './peripherals.service';

const LOAD_URL = '/api/peripherals';
const REFRESH_URL = '/api/peripherals/refresh';

/** The fields of an item the service reads; the rest of the shape is the device model's concern. */
function item(kind: string, id: string): PeripheralItem {
  return {
    id,
    kind,
    connection: 'usb',
    name: id,
    device: {},
    availability: { state: 'unknown', users: [], reason: null },
    notes: [],
    errors: [],
  };
}

function snapshot(
  generation: number,
  items: PeripheralItem[] | null,
  label = 'sima@192.168.2.2',
): PeripheralSnapshot {
  const scanned = items !== null;
  return {
    board: {
      label,
      source: 'manual',
      hostname: null,
      machine: null,
      build_version: null,
      fingerprint: null,
    },
    generation,
    scan_id: scanned ? `7:${generation}` : null,
    scanned_at: scanned ? '2026-10-25T10:00:00Z' : null,
    ...(scanned ? { scan_ms: 1200 } : {}),
    items: items ?? [],
    issues: [],
    changes: null,
    camera_setup: null,
  };
}

function board(generation: number, withTarget = true): BoardState {
  return {
    target: withTarget
      ? {
          mode: 'ssh',
          source: 'manual',
          host: '192.168.2.2',
          port: 22,
          user: 'sima',
          label: 'sima@192.168.2.2',
        }
      : null,
    saved: null,
    defaults: { on_board: false, sdk_env: null },
    generation,
    status: { state: 'unknown', checked_at: null, error: null },
    board: null,
  };
}

const unreachable = {
  error: 'Could not connect to sima@192.168.2.2.',
  code: 'unreachable',
  hint: 'Check that the board is on.',
};
const badGateway = { status: 502, statusText: 'Bad Gateway' };

/** Lets the promise chains behind a flushed request run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('PeripheralsService', () => {
  let http: HttpTestingController;
  let boardReload: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** The selected board's generation, as `BoardService.generation()` reports it. */
  const boardGeneration = signal<number | null>(1);
  let toasts: { status: ReturnType<typeof vi.fn<(message: string) => void>> };
  let service: PeripheralsService;

  beforeEach(() => {
    boardReload = vi.fn(() => Promise.resolve());
    boardGeneration.set(1);
    toasts = { status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: BoardService,
          useValue: { reload: boardReload, generation: boardGeneration.asReadonly() },
        },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(PeripheralsService);
  });

  afterEach(() => http.verify());

  /** The refreshes now pending; they are taken, so a second call returns only newer ones. */
  function refreshes() {
    return http.match((request) => request.method === 'POST' && request.url === REFRESH_URL);
  }

  it('load keeps the newest answer and ignores no_target; another failure rejects with its problem', async () => {
    expect(service.snapshot()).toBeNull();
    const first = service.load();
    const second = service.load();
    const [older, newer] = http.match(LOAD_URL);
    newer.flush(snapshot(2, null));
    await second;
    older.flush(snapshot(1, null));
    await first;
    expect(service.snapshot()?.generation).toBe(2);

    // No board selected: the page says so from the board state, not from this request.
    const none = service.load();
    http
      .expectOne(LOAD_URL)
      .flush(
        { error: 'No board is selected.', code: 'no_target', hint: 'Enter the board.' },
        { status: 409, statusText: 'Conflict' },
      );
    await expect(none).resolves.toBeUndefined();
    expect(service.snapshot()?.generation).toBe(2);

    const failed = service.load();
    http.expectOne(LOAD_URL).flush({ error: 'Insight broke.', code: 'internal' }, badGateway);
    const problem = await failed.then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(problem).toBeInstanceOf(BoardProblem);
    expect((problem as BoardProblem).code).toBe('internal');
    expect(service.snapshot()?.generation).toBe(2);

    // A newer read that failed still answered for the older one, which is not applied after it.
    const older2 = service.load();
    const newer2 = service.load();
    const [slow, fast] = http.match(LOAD_URL);
    fast.flush(
      { error: 'No board is selected.', code: 'no_target', hint: 'Enter the board.' },
      { status: 409, statusText: 'Conflict' },
    );
    await newer2;
    slow.flush(snapshot(2, [item('camera', 'c1')]));
    await older2;
    expect(service.snapshot()?.scan_id).toBeNull();
  });

  it('refresh reloads the board after success and failure, and concurrent calls share one request', async () => {
    const before = Date.now();
    const first = service.refresh();
    const second = service.refresh();
    expect(second).toBe(first);
    expect(service.scanning()).toBeGreaterThanOrEqual(before);
    const [scan] = refreshes();
    expect(refreshes()).toHaveLength(0);
    expect(boardReload).not.toHaveBeenCalled();

    scan.flush(snapshot(1, [item('camera', 'c1'), item('camera', 'c2'), item('microphone', 'm1')]));
    await first;
    expect(service.snapshot()?.scan_id).toBe('7:1');
    expect(service.scanning()).toBeNull();
    expect(service.scanError()).toBeNull();
    expect(toasts.status).toHaveBeenCalledWith(
      'Scan complete: 2 cameras, 1 microphone on sima@192.168.2.2.',
    );
    expect(boardReload).toHaveBeenCalledTimes(1);

    // The scan updates the board's status: a failed one reloads it too, and keeps the last snapshot.
    const failed = service.refresh();
    expect(failed).not.toBe(first);
    refreshes()[0].flush(unreachable, badGateway);
    await expect(failed).resolves.toBeUndefined();
    expect(service.scanError()).toBeInstanceOf(BoardProblem);
    expect(service.scanError()?.code).toBe('unreachable');
    expect(service.scanError()?.message).toBe(unreachable.error);
    expect(service.snapshot()?.scan_id).toBe('7:1');
    expect(service.scanning()).toBeNull();
    expect(boardReload).toHaveBeenCalledTimes(2);
    expect(toasts.status).toHaveBeenCalledTimes(1);

    // The next scan starts without the old failure.
    const again = service.refresh();
    expect(service.scanError()).toBeNull();
    refreshes()[0].flush(snapshot(1, [], ''));
    await again;
    expect(toasts.status).toHaveBeenLastCalledWith(
      'Scan complete: 0 cameras, 0 microphones on the board.',
    );
  });

  it('a scan wins over a read that was sent before it answered', async () => {
    const load = service.load();
    const scan = service.refresh();
    refreshes()[0].flush(snapshot(1, [item('camera', 'c1')]));
    await scan;
    http.expectOne(LOAD_URL).flush(snapshot(1, null));
    await load;
    expect(service.snapshot()?.scan_id).toBe('7:1');
  });

  it('scanOnce scans an unscanned board once per generation and never repeats a failed auto scan', async () => {
    // Nothing loaded yet: there is nothing to say whether the board was scanned.
    service.scanOnce(board(1));
    expect(refreshes()).toHaveLength(0);

    const load = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(1, null));
    await load;
    // No target, or a snapshot loaded for another board: no scan.
    service.scanOnce(board(1, false));
    service.scanOnce(board(2));
    expect(refreshes()).toHaveLength(0);

    service.scanOnce(board(1));
    service.scanOnce(board(1));
    const [failed] = refreshes();
    expect(refreshes()).toHaveLength(0);
    failed.flush(unreachable, badGateway);
    await tick();
    expect(service.scanError()?.code).toBe('unreachable');

    // Coming back to the page (the snapshot reloaded, still unscanned) does not scan again.
    const reload = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(1, null));
    await reload;
    service.scanOnce(board(1));
    expect(refreshes()).toHaveLength(0);
    // The failure is still this board's, and still shown.
    expect(service.scanError()?.code).toBe('unreachable');

    // Another board is scanned once, and a scanned snapshot never scans by itself.
    boardGeneration.set(2);
    const next = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(2, null));
    await next;
    service.scanOnce(board(2));
    refreshes()[0].flush(snapshot(2, [item('camera', 'c1')]));
    await tick();
    service.scanOnce(board(2));
    expect(refreshes()).toHaveLength(0);

    boardGeneration.set(3);
    const scanned = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(3, [item('camera', 'c1')]));
    await scanned;
    service.scanOnce(board(3));
    expect(refreshes()).toHaveLength(0);
  });

  // Review Focus 1: a scan can take half a minute, and the board can change meanwhile.
  it("a scan for a board the user has left is never applied and does not use up the new board's first scan", async () => {
    boardGeneration.set(3);
    const first = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(3, null));
    await first;
    service.scanOnce(board(3));
    const [old] = refreshes();

    // The board changes, and the page is entered again for it.
    boardGeneration.set(4);
    const reload = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(4, null));
    await reload;
    service.scanOnce(board(4));
    // The backend runs one scan at a time: the new board's waits for the old one.
    expect(refreshes()).toHaveLength(0);

    old.flush(snapshot(3, [item('camera', 'c1')]));
    await tick();
    expect(service.snapshot()?.generation).toBe(4);
    expect(service.snapshot()?.scan_id).toBeNull();
    expect(toasts.status).not.toHaveBeenCalled();

    const [scan] = refreshes();
    expect(scan).toBeDefined();
    scan.flush(snapshot(4, [item('camera', 'c1')], 'sima@192.168.2.9'));
    await tick();
    expect(service.snapshot()?.generation).toBe(4);
    expect(service.snapshot()?.scan_id).toBe('7:4');
    expect(toasts.status).toHaveBeenCalledExactlyOnceWith(
      'Scan complete: 1 camera, 0 microphones on sima@192.168.2.9.',
    );
  });

  it("a scan failure is the scanned board's: not reported for another, and gone once another board's snapshot is in", async () => {
    // The old board's scan fails because the board changed under it.
    const old = service.refresh();
    boardGeneration.set(2);
    refreshes()[0].flush(
      {
        error: 'The selected board changed while this request was running.',
        code: 'stale_snapshot',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await old;
    expect(service.scanError()).toBeNull();

    // A failure of the current board's scan shows until a snapshot of another board is applied.
    const failed = service.refresh();
    refreshes()[0].flush(unreachable, badGateway);
    await failed;
    expect(service.scanError()?.code).toBe('unreachable');
    const same = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(2, null));
    await same;
    expect(service.scanError()?.code).toBe('unreachable');
    boardGeneration.set(3);
    const other = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(3, null));
    await other;
    expect(service.scanError()).toBeNull();
  });

  // The board generation is a counter in Insight's memory: it starts over when Insight restarts,
  // while this app keeps running.
  it('after an Insight restart, answers for the restarted board apply although its generation is lower', async () => {
    boardGeneration.set(7);
    const before = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(7, [item('camera', 'c1')]));
    await before;

    // The board is re-read (on focus) from the restarted Insight.
    boardGeneration.set(1);
    const after = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(1, null));
    await after;
    expect(service.snapshot()?.generation).toBe(1);
    expect(service.snapshot()?.scan_id).toBeNull();

    service.scanOnce(board(1));
    refreshes()[0].flush(snapshot(1, [item('microphone', 'm1')]));
    await tick();
    expect(service.snapshot()?.scan_id).toBe('7:1');
    expect(toasts.status).toHaveBeenCalledExactlyOnceWith(
      'Scan complete: 0 cameras, 1 microphone on sima@192.168.2.2.',
    );
  });

  it('a scan queued for a board the user has left again is skipped: two switches scan the last board once', async () => {
    boardGeneration.set(3);
    const first = service.load();
    http.expectOne(LOAD_URL).flush(snapshot(3, null));
    await first;
    service.scanOnce(board(3));
    const [old] = refreshes();

    for (const generation of [4, 5]) {
      boardGeneration.set(generation);
      const entered = service.load();
      http.expectOne(LOAD_URL).flush(snapshot(generation, null));
      await entered;
      service.scanOnce(board(generation));
    }
    expect(refreshes()).toHaveLength(0);

    old.flush(
      {
        error: 'The selected board changed while this request was running.',
        code: 'stale_snapshot',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await tick();
    const [scan] = refreshes();
    expect(scan).toBeDefined();
    scan.flush(snapshot(5, [item('camera', 'c1')]));
    await tick();
    expect(refreshes()).toHaveLength(0);
    expect(service.snapshot()?.scan_id).toBe('7:5');
    expect(service.scanError()).toBeNull();
    expect(toasts.status).toHaveBeenCalledTimes(1);
  });
});
