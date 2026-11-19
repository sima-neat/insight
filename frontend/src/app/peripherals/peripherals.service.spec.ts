import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Peripherals } from '../api.generated';
import { boardUrl } from '../board/api';
import { BoardProblem } from '../board/board-error';
import { BoardService } from '../board/board.service';
import { PeripheralsService } from './peripherals.service';

const OBSERVED = '2026-11-19T01:00:00Z';

/** Board `n`, as the boards answer names it. */
const boardId = (n: number) => `ssh:sima@192.168.2.${n}:22`;
const loadUrl = (n: number) => boardUrl(boardId(n), 'peripherals');
const refreshUrl = (n: number) => boardUrl(boardId(n), 'peripherals/refresh');

/** A device of Sentinel's catalog, with only what the service's toast counts. */
function device(type: 'camera' | 'microphone', id: string): Record<string, unknown> {
  return type === 'camera'
    ? { id, type, backend: 'v4l2', model: id, modes: [] }
    : { id, type, backend: 'alsa', connection: 'usb', name: id, modes: [] };
}

/**
 * The peripherals answer: no scan for `null`, otherwise a scan of Sentinel's catalog whose
 * revision a test tells scans apart by (`scanId`).
 */
function answer(revision: number | null, devices: Record<string, unknown>[] = []): Peripherals {
  if (revision === null) return { scan: null };
  return {
    scan: {
      scanned_at: OBSERVED,
      scan_ms: 3400,
      catalog: { revision, observed_at: OBSERVED, devices, errors: [], board: null },
      changes: null,
    },
  };
}
const scanId = (revision: number) => `${revision}:${OBSERVED}`;

/** The error shape the server answers with. */
const failure = (code: string, message: string, hint?: string) => ({
  error: { code, message, ...(hint ? { hint } : {}) },
});
const unreachable = failure(
  'unreachable',
  'Could not connect to sima@192.168.2.1.',
  'Check that the board is on.',
);
const badGateway = { status: 502, statusText: 'Bad Gateway' };
const notFound = { status: 404, statusText: 'Not Found' };

/** Lets the promise chains behind a flushed request run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('PeripheralsService', () => {
  let http: HttpTestingController;
  let boardReload: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** The selected board, as `BoardService.selected()` reports it. */
  const selected = signal<{ id: string; label: string } | null>(null);
  let toasts: { status: ReturnType<typeof vi.fn<(message: string) => void>> };
  let service: PeripheralsService;

  /** Selects board `n`; `null` selects none. */
  function select(n: number | null, label = `sima@192.168.2.${n}`): void {
    selected.set(n === null ? null : { id: boardId(n), label });
  }

  beforeEach(() => {
    boardReload = vi.fn(() => Promise.resolve());
    select(1);
    toasts = { status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: BoardService,
          useValue: {
            reload: boardReload,
            selected: selected.asReadonly(),
            id: computed(() => selected()?.id ?? null),
          },
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
    return http.match(
      (request) => request.method === 'POST' && request.url.endsWith('/peripherals/refresh'),
    );
  }

  /** Loads board `n`'s last scan, answered with `revision`. */
  async function load(n: number, revision: number | null): Promise<void> {
    const loaded = service.load();
    http.expectOne(loadUrl(n)).flush(answer(revision));
    await loaded;
  }

  it("load reads the selected board's scan, builds the snapshot of it and keeps the newest answer", async () => {
    expect(service.snapshot()).toBeNull();
    const first = service.load();
    const second = service.load();
    const [older, newer] = http.match(loadUrl(1));
    newer.flush(answer(2, [device('camera', 'c1')]));
    await second;
    older.flush(answer(1));
    await first;
    expect(service.snapshot()).toMatchObject({
      board: { id: boardId(1), label: 'sima@192.168.2.1' },
      scan_id: scanId(2),
      scanned_at: OBSERVED,
      scan_ms: 3400,
      items: [{ id: 'c1', kind: 'camera', connection: 'usb' }],
    });

    // Before the first scan the server answers none: the snapshot is the empty one.
    await load(1, null);
    expect(service.snapshot()).toMatchObject({ scan_id: null, items: [] });

    const failed = service.load();
    http.expectOne(loadUrl(1)).flush(failure('internal_error', 'Insight broke.'), badGateway);
    const problem = await failed.then(
      () => null,
      (error: unknown) => error,
    );
    expect(problem).toBeInstanceOf(BoardProblem);
    expect((problem as BoardProblem).code).toBe('internal_error');
    expect(boardReload).not.toHaveBeenCalled();

    // A newer read that failed still answered for the older one, which is not applied after it.
    const older2 = service.load();
    const newer2 = service.load();
    const [slow, fast] = http.match(loadUrl(1));
    fast.flush(failure('internal_error', 'Insight broke.'), badGateway);
    await expect(newer2).rejects.toBeInstanceOf(BoardProblem);
    slow.flush(answer(3));
    await older2;
    expect(service.snapshot()?.scan_id).toBeNull();
  });

  it('load asks nothing without a board, and reads the boards again for one no longer selected', async () => {
    select(null);
    await expect(service.load()).resolves.toBeUndefined();
    http.expectNone(() => true);

    select(1);
    const gone = service.load();
    http.expectOne(loadUrl(1)).flush(failure('not_found', 'Not the selected board.'), notFound);
    await expect(gone).resolves.toBeUndefined();
    expect(boardReload).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toBeNull();
  });

  it('a read that answers after the board changed is not applied', async () => {
    const loaded = service.load();
    select(2);
    http.expectOne(loadUrl(1)).flush(answer(1));
    await loaded;
    expect(service.snapshot()).toBeNull();
  });

  it('refresh reloads the board after success and failure, and concurrent calls share one request', async () => {
    const before = Date.now();
    const first = service.refresh();
    const second = service.refresh();
    expect(second).toBe(first);
    expect(service.scanning()).toBeGreaterThanOrEqual(before);
    const [scan] = refreshes();
    expect(scan.request.url).toBe(refreshUrl(1));
    expect(refreshes()).toHaveLength(0);
    expect(boardReload).not.toHaveBeenCalled();

    scan.flush(
      answer(1, [device('camera', 'c1'), device('camera', 'c2'), device('microphone', 'm1')]),
    );
    await first;
    expect(service.snapshot()?.scan_id).toBe(scanId(1));
    expect(service.scanning()).toBeNull();
    expect(service.scanError()).toBeNull();
    expect(toasts.status).toHaveBeenCalledWith(
      'Scan complete: 2 cameras, 1 microphone on sima@192.168.2.1.',
    );
    expect(boardReload).toHaveBeenCalledTimes(1);

    // The scan updates the board's status: a failed one reloads it too, and keeps the last snapshot.
    const failed = service.refresh();
    expect(failed).not.toBe(first);
    refreshes()[0].flush(unreachable, badGateway);
    await expect(failed).resolves.toBeUndefined();
    expect(service.scanError()).toBeInstanceOf(BoardProblem);
    expect(service.scanError()?.code).toBe('unreachable');
    expect(service.scanError()?.message).toBe(unreachable.error.message);
    expect(service.snapshot()?.scan_id).toBe(scanId(1));
    expect(service.scanning()).toBeNull();
    expect(boardReload).toHaveBeenCalledTimes(2);
    expect(toasts.status).toHaveBeenCalledTimes(1);

    // The next scan starts without the old failure.
    select(1, '');
    const again = service.refresh();
    expect(service.scanError()).toBeNull();
    refreshes()[0].flush(answer(2));
    await again;
    expect(toasts.status).toHaveBeenLastCalledWith(
      'Scan complete: 0 cameras, 0 microphones on the board.',
    );

    // Without a board there is nothing to scan.
    select(null);
    await service.refresh();
    expect(refreshes()).toHaveLength(0);
  });

  it('a scan wins over a read that was sent before it answered', async () => {
    const loaded = service.load();
    const scan = service.refresh();
    refreshes()[0].flush(answer(1, [device('camera', 'c1')]));
    await scan;
    http.expectOne(loadUrl(1)).flush(answer(null));
    await loaded;
    expect(service.snapshot()?.scan_id).toBe(scanId(1));
  });

  it('scanOnVisit scans on every visit with a board, scanned snapshot or not, and a failed scan does not stop the next visit', async () => {
    // Nothing loaded yet: there is no snapshot of this board to replace.
    void service.scanOnVisit();
    expect(refreshes()).toHaveLength(0);

    await load(1, null);
    // No board, or a snapshot loaded for another board: no scan.
    select(null);
    void service.scanOnVisit();
    select(2);
    void service.scanOnVisit();
    expect(refreshes()).toHaveLength(0);

    // Concurrent scans of one board share one.
    select(1);
    void service.scanOnVisit();
    void service.scanOnVisit();
    const [failed] = refreshes();
    expect(refreshes()).toHaveLength(0);
    failed.flush(unreachable, badGateway);
    await tick();
    expect(service.scanError()?.code).toBe('unreachable');

    // The next visit scans again, though the first scan failed and the snapshot is unscanned.
    await load(1, null);
    void service.scanOnVisit();
    const [second] = refreshes();
    expect(second).toBeDefined();
    second.flush(answer(2, [device('camera', 'c1')]));
    await tick();
    expect(service.scanError()).toBeNull();

    // A scanned snapshot is scanned again on the visit after: the devices may have changed.
    await load(1, 2);
    void service.scanOnVisit();
    expect(refreshes()).toHaveLength(1);
  });

  it('a scan of a visit is silent, and Refresh toasts its result', async () => {
    await load(1, null);
    void service.scanOnVisit();
    refreshes()[0].flush(answer(1, [device('camera', 'c1')]));
    await tick();
    expect(service.snapshot()?.scan_id).toBe(scanId(1));
    expect(toasts.status).not.toHaveBeenCalled();

    void service.refresh();
    refreshes()[0].flush(answer(2, [device('camera', 'c1')]));
    await tick();
    expect(toasts.status).toHaveBeenCalledExactlyOnceWith(
      'Scan complete: 1 camera, 0 microphones on sima@192.168.2.1.',
    );
  });

  // A scan can take half a minute, and the board can change meanwhile.
  it("a scan for a board the user has left is never applied and does not hold up the new board's scan", async () => {
    select(3);
    await load(3, null);
    void service.scanOnVisit();
    const [old] = refreshes();

    // The board changes, and the page is entered again for it.
    select(4);
    await load(4, null);
    void service.scanOnVisit();
    // The server runs one scan at a time: the new board's waits for the old one.
    expect(refreshes()).toHaveLength(0);

    old.flush(answer(1, [device('camera', 'c1')]));
    await tick();
    expect(service.snapshot()?.board.id).toBe(boardId(4));
    expect(service.snapshot()?.scan_id).toBeNull();
    expect(toasts.status).not.toHaveBeenCalled();

    const [scan] = refreshes();
    expect(scan.request.url).toBe(refreshUrl(4));
    scan.flush(answer(2, [device('camera', 'c1')]));
    await tick();
    expect(service.snapshot()?.board.id).toBe(boardId(4));
    expect(service.snapshot()?.scan_id).toBe(scanId(2));
    expect(toasts.status).not.toHaveBeenCalled();
  });

  it("a scan failure is the scanned board's: not reported for another, and gone once another board's snapshot is in", async () => {
    // The old board's scan fails because the board changed under it.
    const old = service.refresh();
    select(2);
    refreshes()[0].flush(failure('not_found', 'Not the selected board.'), notFound);
    await old;
    expect(service.scanError()).toBeNull();

    // A failure of the current board's scan shows until a snapshot of another board is applied.
    const failed = service.refresh();
    refreshes()[0].flush(unreachable, badGateway);
    await failed;
    expect(service.scanError()?.code).toBe('unreachable');
    await load(2, null);
    expect(service.scanError()?.code).toBe('unreachable');
    select(3);
    await load(3, null);
    expect(service.scanError()).toBeNull();
  });

  // The old board's failure must not stand beside "Board changed — refresh".
  it('a scan failure goes as soon as the board changes, before any snapshot of the new board', async () => {
    const failed = service.refresh();
    refreshes()[0].flush(unreachable, badGateway);
    await failed;
    TestBed.tick();
    expect(service.scanError()?.code).toBe('unreachable');

    select(2);
    TestBed.tick();
    expect(service.scanError()).toBeNull();
  });

  it('a scan queued for a board the user has left again is skipped: two switches scan the last board once', async () => {
    select(3);
    await load(3, null);
    void service.scanOnVisit();
    const [old] = refreshes();

    for (const n of [4, 5]) {
      select(n);
      await load(n, null);
      void service.scanOnVisit();
    }
    expect(refreshes()).toHaveLength(0);

    old.flush(failure('not_found', 'Not the selected board.'), notFound);
    await tick();
    const [scan] = refreshes();
    expect(scan.request.url).toBe(refreshUrl(5));
    scan.flush(answer(5, [device('camera', 'c1')]));
    await tick();
    expect(refreshes()).toHaveLength(0);
    expect(service.snapshot()?.scan_id).toBe(scanId(5));
    expect(service.scanError()).toBeNull();
    expect(toasts.status).not.toHaveBeenCalled();
  });

  // A board change waits for the scan running on the board, so a scan of the new board queues
  // behind the old one for at least that scan's board re-read.
  it("Scanning… counts from when this board's scan starts, never the old board's, and does not blink off in between", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.parse('2026-10-25T10:00:00Z');
      vi.setSystemTime(t0);
      select(3);
      await load(3, null);
      void service.scanOnVisit();
      expect(service.scanning()).toBe(t0);
      const [old] = refreshes();

      // The board changes 20 s into the old scan, and the new board's scan is queued.
      vi.setSystemTime(t0 + 20_000);
      select(4);
      await load(4, null);
      void service.scanOnVisit();
      expect(service.scanning()).toBe(t0 + 20_000);

      // The old scan answers; the board re-read after it is still out.
      const reread = deferredReload();
      vi.setSystemTime(t0 + 25_000);
      old.flush(answer(1, [device('camera', 'c1')]));
      await tick();
      expect(refreshes()).toHaveLength(0);
      expect(service.scanning()).not.toBeNull();

      vi.setSystemTime(t0 + 26_000);
      reread.resolve();
      await tick();
      const [scan] = refreshes();
      expect(scan).toBeDefined();
      expect(service.scanning()).toBe(t0 + 26_000);
      scan.flush(answer(2, [device('camera', 'c1')]));
      await tick();
      expect(service.scanning()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /** Holds the board re-read that ends every scan until the test resolves it. */
  function deferredReload(): { resolve(): void } {
    let resolve!: () => void;
    boardReload.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    return { resolve: () => resolve() };
  }
});
