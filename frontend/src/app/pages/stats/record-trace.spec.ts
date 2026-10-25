import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { BoardProblem } from '../../board/board-error';
import type { RunMetadata, TraceRequest } from '../../stats/api';
import { ACTIVE_TRACE } from '../../stats/runs.testing';
import { failureOf, type SentinelAction, type SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { RecordTrace } from './record-trace';

/** The part of `SentinelRuns` the toolbar uses, with the changes as spies. */
class FakeRuns {
  readonly trace = signal<RunMetadata | null>(null);
  readonly traceBusy = signal<'start' | 'stop' | null>(null);
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

  it('while a trace records, says so with its name and elapsed time, and Stop stops it', async () => {
    vi.setSystemTime(Date.parse(ACTIVE_TRACE.started_at) + 34_400);
    runs.trace.set(ACTIVE_TRACE);
    await render();

    expect(text(root().querySelector('.recording'))).toBe('Recording · compiler-v2-bench · 0:34');
    expect(button(root(), 'Record')).toBeUndefined();
    vi.advanceTimersByTime(1000);
    await settle();
    expect(text(root().querySelector('.recording'))).toBe('Recording · compiler-v2-bench · 0:35');

    await click(button(root(), 'Stop')!);
    expect(runs.stopTrace).toHaveBeenCalledOnce();
  });

  it('Stop is disabled while a start or stop is out', async () => {
    runs.trace.set(ACTIVE_TRACE);
    runs.traceBusy.set('stop');
    await render();

    expect(button(root(), 'Stop')?.disabled).toBe(true);
  });

  it('a failed stop toasts its title', async () => {
    runs.stopTrace.mockResolvedValue(failure('trace_conflict', 'stop'));
    runs.trace.set(ACTIVE_TRACE);
    await render();

    await click(button(root(), 'Stop')!);
    expect(toasts.error).toHaveBeenCalledWith('The trace changed before it was stopped');
  });
});
