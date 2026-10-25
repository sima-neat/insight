import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { BoardProblem } from '../../board/board-error';
import { deferred } from '../../board/board.testing';
import type { RunMetadata, RunSummary, TraceRequest } from '../../stats/api';
import { ACTIVE_TRACE, RECORDING_RUN } from '../../stats/runs.testing';
import { failureOf, type SentinelAction, type SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { RecordTrace } from './record-trace';

/** The part of `SentinelRuns` the toolbar uses, with the changes as spies. */
class FakeRuns {
  readonly trace = signal<RunMetadata | null>(null);
  readonly traceSummary = signal<RunSummary | null>(null);
  readonly traceReadAt = signal<number | null>(null);
  readonly traceBusy = signal<'start' | 'stop' | null>(null);
  readonly traceFailure = signal<SentinelFailure | null>(null);
  readonly startTrace = vi.fn<(request: TraceRequest) => Promise<SentinelFailure | null>>(
    async () => null,
  );
  readonly stopTrace = vi.fn<() => Promise<SentinelFailure | null>>(async () => null);
}

/** A failure of `code` as `SentinelRuns` resolves it for `action`. */
function failure(code: string, action: SentinelAction, hint = ''): SentinelFailure {
  return failureOf(new BoardProblem(`Failed with ${code}.`, code, hint, {}), 7, action);
}

/** The control as the toolbar holds it. */
@Component({ imports: [RecordTrace], template: '<app-record-trace />' })
class Toolbar {}

describe('RecordTrace', () => {
  let runs: FakeRuns;
  let toasts: { error: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Toolbar>;

  beforeEach(() => {
    // The clock's interval and the time; Angular renders on real timeouts.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    // 08:41 local time: the name the popover offers is made from it.
    vi.setSystemTime(new Date(2026, 9, 25, 8, 41, 10));
    runs = new FakeRuns();
    toasts = { error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: SentinelRuns, useValue: runs },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
    vi.useRealTimers();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (scope: ParentNode, name: string): HTMLButtonElement | undefined =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name);
  const panel = (): HTMLElement | null =>
    document.querySelector('[role="dialog"][aria-label="Start a trace"]');
  const field = (label: string): HTMLElement =>
    [...panel()!.querySelectorAll<HTMLElement>('neat-field')].find(
      (element) => text(element.querySelector('label > span')) === label,
    )!;
  const input = (label: string): HTMLInputElement => field(label).querySelector('input')!;
  const errorOf = (label: string): string => text(field(label).querySelector('neat-error-note'));
  const announcement = (): string => text(root().querySelector('app-announcement'));

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  async function type(label: string, value: string): Promise<void> {
    const element = input(label);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  /** Renders the control as the toolbar does, under the time and trace set so far. */
  async function render(): Promise<void> {
    fixture = TestBed.createComponent(Toolbar);
    await settle();
  }

  async function openPopover(): Promise<void> {
    await render();
    await click(button(root(), 'Record')!);
  }

  it('Record opens the popover with the name made from the time, the optional fields and the note', async () => {
    await openPopover();

    expect(panel()).not.toBeNull();
    expect(input('Name').value).toBe('run-2026-10-25-0841');
    expect(input('Note (optional)').value).toBe('');
    expect(input('Tags (optional, comma separated)').value).toBe('');
    expect(text(panel())).toContain(
      'A trace records the board while your workload runs and is saved on the board as a run you can reopen and compare.',
    );
    expect(button(panel()!, 'Cancel')).toBeDefined();
    expect(button(panel()!, 'Start')).toBeDefined();
  });

  it('offers a fresh name each time it opens', async () => {
    await openPopover();
    await type('Name', 'mine');
    await click(button(panel()!, 'Cancel')!);
    expect(panel()).toBeNull();

    vi.setSystemTime(new Date(2026, 9, 25, 9, 2, 0));
    await click(button(root(), 'Record')!);
    expect(input('Name').value).toBe('run-2026-10-25-0902');
  });

  it('Start with an empty name says so in the Name field and sends nothing', async () => {
    await openPopover();
    await type('Name', '   ');
    await click(button(panel()!, 'Start')!);

    expect(errorOf('Name')).toBe('Name the trace so you can find its run later.');
    expect(input('Name').getAttribute('aria-invalid')).toBe('true');
    expect(runs.startTrace).not.toHaveBeenCalled();
    expect(panel()).not.toBeNull();
  });

  it('shows a note or tags problem in its own field', async () => {
    await openPopover();
    await type('Note (optional)', 'x'.repeat(513));
    await click(button(panel()!, 'Start')!);
    expect(errorOf('Note (optional)')).toBe('The note can be at most 512 characters.');
    expect(errorOf('Name')).toBe('');

    await type('Note (optional)', 'short');
    await type('Tags (optional, comma separated)', 'y'.repeat(81));
    await click(button(panel()!, 'Start')!);
    expect(errorOf('Note (optional)')).toBe('');
    expect(errorOf('Tags (optional, comma separated)')).toBe('A tag can be at most 80 characters.');
    expect(runs.startTrace).not.toHaveBeenCalled();
  });

  it('a valid Start sends the trimmed name, note and tags and closes', async () => {
    await openPopover();
    await type('Name', '  yolo26-int4 ');
    await type('Note (optional)', ' before the NMS change ');
    await type('Tags (optional, comma separated)', 'compiler-v2, yolo26,, compiler-v2');
    await click(button(panel()!, 'Start')!);

    expect(runs.startTrace).toHaveBeenCalledExactlyOnceWith({
      name: 'yolo26-int4',
      note: 'before the NMS change',
      tags: ['compiler-v2', 'yolo26'],
    });
    expect(panel()).toBeNull();
  });

  it('leaves an empty note and empty tags out of the request', async () => {
    await openPopover();
    await type('Note (optional)', '  ');
    await type('Tags (optional, comma separated)', ' , ');
    await click(button(panel()!, 'Start')!);

    expect(runs.startTrace).toHaveBeenCalledExactlyOnceWith({ name: 'run-2026-10-25-0841' });
  });

  it('validates the note as it is sent, trimmed', async () => {
    await openPopover();
    await type('Note (optional)', `  ${'x'.repeat(512)}  `);
    await click(button(panel()!, 'Start')!);

    expect(runs.startTrace).toHaveBeenCalledExactlyOnceWith({
      name: 'run-2026-10-25-0841',
      note: 'x'.repeat(512),
    });
    expect(panel()).toBeNull();
  });

  it('a refused start shows its title and hint in the popover, which stays open', async () => {
    runs.startTrace.mockResolvedValue(
      failure('trace_conflict', 'start', 'Stop the running trace first.'),
    );
    await openPopover();
    await click(button(panel()!, 'Start')!);

    expect(panel()).not.toBeNull();
    expect(text(panel()!.querySelector('neat-error-note'))).toBe('That trace cannot start');
    expect(text(panel())).toContain('Stop the running trace first.');
  });

  it('a start refused after the popover was closed toasts its title', async () => {
    const answer = deferred<SentinelFailure | null>();
    runs.startTrace.mockReturnValue(answer.promise);
    await openPopover();
    await click(button(panel()!, 'Start')!);
    await click(button(panel()!, 'Cancel')!);
    expect(panel()).toBeNull();

    answer.resolve(failure('trace_conflict', 'start'));
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('That trace cannot start');
    expect(panel()).toBeNull();
  });

  it('a trace that appears while the popover is open closes it for good', async () => {
    await openPopover();
    // The 30 s read finds a trace started from the CLI: Stop replaces Record and its popover.
    runs.trace.set(ACTIVE_TRACE);
    runs.traceReadAt.set(Date.now());
    await settle();
    expect(panel()).toBeNull();
    expect(button(root(), 'Record')).toBeUndefined();

    // Once it ends, Record comes back closed, without taking the focus.
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    runs.trace.set(null);
    runs.traceReadAt.set(null);
    await settle();
    expect(button(root(), 'Record')).toBeDefined();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('a start refused after a trace replaced the popover toasts its title', async () => {
    const answer = deferred<SentinelFailure | null>();
    runs.startTrace.mockReturnValue(answer.promise);
    await openPopover();
    await click(button(panel()!, 'Start')!);
    // The conflict re-reads the trace, which shows another trace recording before the answer.
    runs.trace.set(ACTIVE_TRACE);
    await settle();
    expect(panel()).toBeNull();

    answer.resolve(failure('trace_conflict', 'start'));
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('That trace cannot start');
    runs.trace.set(null);
    await settle();
    expect(panel()).toBeNull();
  });

  it('a successful start is announced with the trace’s name', async () => {
    await openPopover();
    expect(announcement()).toBe('');
    await type('Name', ' bench-1 ');
    // The start answers with the trace it started, which the toolbar then shows.
    runs.startTrace.mockImplementation(async () => {
      runs.trace.set(ACTIVE_TRACE);
      return null;
    });
    await click(button(panel()!, 'Start')!);
    expect(announcement()).toBe('Recording bench-1');

    // Stopped, the line no longer says so.
    runs.trace.set(null);
    await settle();
    expect(announcement()).toBe('');
  });

  /** Shows `trace` recording, as read `readAgo` ms ago with `summary`. */
  async function recording(
    summary: RunSummary | null,
    readAgo: number,
    trace: RunMetadata = ACTIVE_TRACE,
  ): Promise<void> {
    runs.trace.set(trace);
    runs.traceSummary.set(summary);
    runs.traceReadAt.set(Date.now() - readAgo);
    await render();
  }

  // Exact, spaces and all: the line is laid out as text.
  const recordingLine = (): string | null | undefined =>
    root().querySelector('.recording')?.textContent;

  it('while a trace records, says so with its name and the time it has recorded, and Stop stops it', async () => {
    // A summary of 34 s, read 5 s ago.
    await recording({ ...RECORDING_RUN, duration_ms: 34_000 }, 5000);

    expect(recordingLine()).toBe('Recording · compiler-v2-bench · 0:39');
    expect(button(root(), 'Record')).toBeUndefined();
    vi.advanceTimersByTime(1000);
    await settle();
    expect(recordingLine()).toBe('Recording · compiler-v2-bench · 0:40');

    await click(button(root(), 'Stop')!);
    expect(runs.stopTrace).toHaveBeenCalledOnce();
  });

  it.each(['2025-03-01T00:00:00.123456789Z', '2027-01-01T00:00:00Z'])(
    'the time recorded does not depend on the board’s clock (started %s)',
    async (startedAt) => {
      await recording({ ...RECORDING_RUN, duration_ms: 34_000, started_at: startedAt }, 5000, {
        ...ACTIVE_TRACE,
        started_at: startedAt,
      });

      expect(recordingLine()).toBe('Recording · compiler-v2-bench · 0:39');
    },
  );

  it('while the trace cannot be read, leaves the time out rather than counting on', async () => {
    await recording({ ...RECORDING_RUN, duration_ms: 34_000 }, 5000);
    runs.traceFailure.set(failure('timeout', 'read'));
    await settle();
    expect(recordingLine()).toBe('Recording · compiler-v2-bench');

    runs.traceFailure.set(null);
    await settle();
    expect(recordingLine()).toBe('Recording · compiler-v2-bench · 0:39');
  });

  it('Stop is named for what it stops', async () => {
    await recording(RECORDING_RUN, 0);
    expect(button(root(), 'Stop')!.getAttribute('aria-label')).toBe('Stop the trace');
  });

  it('right after a start, with no summary yet, counts from the start’s answer', async () => {
    await recording(null, 3000);

    expect(recordingLine()).toBe('Recording · compiler-v2-bench · 0:03');
  });

  it('Stop waits while a start or stop is out, and keeps the focus', async () => {
    await recording(RECORDING_RUN, 0);
    runs.traceBusy.set('start');
    await settle();
    const stop = button(root(), 'Stop')!;
    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    await click(stop);
    expect(runs.stopTrace).not.toHaveBeenCalled();
  });

  it('a failed stop toasts its title and leaves the focus on Stop', async () => {
    const answer = deferred<SentinelFailure | null>();
    runs.stopTrace.mockImplementation(() => {
      runs.traceBusy.set('stop');
      return answer.promise.finally(() => runs.traceBusy.set(null));
    });
    await recording(RECORDING_RUN, 0);

    const stop = button(root(), 'Stop')!;
    stop.focus();
    await click(stop);
    expect(stop.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(stop);

    answer.resolve(failure('trace_conflict', 'stop'));
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('The trace changed before it was stopped');
    expect(document.activeElement).toBe(button(root(), 'Stop'));
  });
});
