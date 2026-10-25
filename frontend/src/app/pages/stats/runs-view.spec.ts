import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { NeatConfirm, type NeatConfirmOptions } from '@sima/neat-ui/confirm';
import { NeatToasts } from '@sima/neat-ui/toast';
import { AsidePrefs } from '../../aside-prefs';
import { BoardProblem } from '../../board/board-error';
import type { RunSummary } from '../../stats/api';
import { RUNS_LIST } from '../../stats/runs.testing';
import { failureOf, type SentinelFailure } from '../../stats/sentinel-failure';
import { type DeleteOutcome, SentinelRuns } from '../../stats/sentinel-runs';
import { StatsSession } from '../../stats/stats-session';
import { RunsView } from './runs-view';

/** The part of `SentinelRuns` the view uses, with the changes as spies. */
class FakeRuns {
  readonly runs = signal<RunSummary[] | null>(RUNS_LIST);
  readonly runsFailure = signal<SentinelFailure | null>(null);
  readonly rereadRuns = vi.fn();
  readonly deleteRuns = vi.fn<(ids: readonly string[]) => Promise<DeleteOutcome>>(async (ids) => ({
    deleted: [...ids],
    failed: [],
    notTried: [],
  }));
}

/** A delete failure of `code` as `SentinelRuns` resolves it. */
function failure(code: string, hint = '', detail?: string): SentinelFailure {
  const details = detail === undefined ? {} : { detail };
  return failureOf(new BoardProblem(`Failed with ${code}.`, code, hint, details), 7, 'delete');
}

/** `count` finished runs, newest first. */
function finishedRuns(count: number): RunSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...RUNS_LIST[1],
    id: `run-${index}`,
    name: `run ${index}`,
  }));
}

// The fixture's runs: the recording one, then four finished ones, newest first.
const [RECORDING, TES3, HW_SHORT, HW_LONG] = RUNS_LIST;

@Component({ imports: [RunsView], template: '<app-stats-runs />' })
class Host {}

describe('RunsView', () => {
  let runs: FakeRuns;
  let session: StatsSession;
  let confirm: { ask: ReturnType<typeof vi.fn<(options: NeatConfirmOptions) => Promise<boolean>>> };
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let asides: { setOpen: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    // Five minutes after the recording run started on the board.
    vi.setSystemTime(Date.parse('2026-09-25T09:20:00.120Z'));
    // jsdom has no ResizeObserver; the list watches its width to give up the Recorded column.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // jsdom lays nothing out, so no width ever changes.
        }
        disconnect(): void {
          // Nothing was observed.
        }
      },
    );
    runs = new FakeRuns();
    confirm = { ask: vi.fn(async () => true) };
    toasts = { status: vi.fn(), error: vi.fn() };
    asides = { setOpen: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: SentinelRuns, useValue: runs },
        { provide: NeatConfirm, useValue: confirm },
        { provide: NeatToasts, useValue: toasts },
        { provide: AsidePrefs, useValue: asides },
      ],
    });
    session = TestBed.inject(StatsSession);
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const options = (): HTMLElement[] => [
    ...root().querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]'),
  ];
  /** A row as it reads: its cells, one space apart. */
  const rowText = (option: HTMLElement): string =>
    [...option.querySelectorAll('app-cell-text')].map(text).join(' ');
  const optionNamed = (name: string): HTMLElement =>
    options().find((option) => text(option.querySelector('.name')) === name)!;
  const box = (option: HTMLElement): HTMLElement | null =>
    option.querySelector('[data-slot="select-list-check"]');
  const bar = (): HTMLElement | null =>
    root().querySelector('[role="toolbar"][aria-label="Selected runs"]');
  const barButton = (name: string): HTMLButtonElement =>
    [...bar()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name)!;
  const callout = (): HTMLElement | null => root().querySelector('neat-callout');
  const calloutButton = (name: string): HTMLButtonElement =>
    [...callout()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === name)!;

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

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(Host);
    await settle();
  }

  /** Renders the list with `ids` ticked, in that order. */
  async function renderChecked(...ids: string[]): Promise<void> {
    session.checkedRuns.set(ids);
    await render();
  }

  it('lists the runs as Sentinel gives them, the recording one first, with their line and when', async () => {
    await render();

    expect(root().querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Runs');
    expect(options().map(rowText)).toEqual([
      'compiler-v2-bench Recording · 12.0 s · 96 J · 7 samples 5 min ago',
      'tes3 Complete · 8.1 s · 54 J · 4 samples 15 h ago',
      'insight-hw-1790177227 Complete · 6.7 s · 52 J · 4 samples Sep 23',
      'insight-hw-1790177178 Complete · 34.4 s · 275 J · 17 samples Sep 23',
      'baseline-idle Complete · 42.1 s · 306 J · 22 samples Sep 22',
    ]);
    // Nothing is ticked yet, so there is no selection bar.
    expect(bar()).toBeNull();
  });

  it('the recording run has no box: it can be neither compared nor deleted', async () => {
    await render();

    expect(box(optionNamed(RECORDING.name))).toBeNull();
    expect(optionNamed(RECORDING.name).hasAttribute('aria-selected')).toBe(false);
    expect(
      options()
        .slice(1)
        .map((option) => box(option) !== null),
    ).toEqual([true, true, true, true]);
  });

  it('ticks runs in the order they are ticked, and offers no ninth', async () => {
    runs.runs.set(finishedRuns(10));
    await render();

    await click(box(optionNamed('run 3'))!);
    await click(box(optionNamed('run 1'))!);
    expect(session.checkedRuns()).toEqual(['run-3', 'run-1']);

    session.checkedRuns.set(finishedRuns(8).map((run) => run.id));
    await settle();
    // The two unticked runs lose their boxes; a ticked one can still be unticked.
    expect(box(optionNamed('run 8'))).toBeNull();
    expect(box(optionNamed('run 9'))).toBeNull();
    await click(box(optionNamed('run 0'))!);
    expect(session.checkedRuns()).toHaveLength(7);
    expect(box(optionNamed('run 9'))).not.toBeNull();
  });

  it('a click on a row selects it and opens the side panel on it', async () => {
    await render();

    await click(optionNamed(TES3.name));
    expect(session.run()).toBe(TES3.id);
    expect(asides.setOpen).toHaveBeenCalledWith('stats', true);
    expect(optionNamed(TES3.name).hasAttribute('data-active')).toBe(true);
  });

  it('the selection bar says how many are ticked; Compare needs two, and Clear unticks them', async () => {
    await renderChecked(TES3.id);

    expect(text(bar()!.querySelector('.count'))).toBe('1 selected');
    expect(barButton('Compare').disabled).toBe(true);
    expect(barButton('Delete')).toBeDefined();

    await click(box(optionNamed(HW_SHORT.name))!);
    expect(text(bar()!.querySelector('.count'))).toBe('2 selected');
    expect(barButton('Compare').disabled).toBe(false);

    await click(barButton('Clear'));
    expect(session.checkedRuns()).toEqual([]);
    expect(bar()).toBeNull();
    // The bar went with the button that had the focus: the list takes it.
    expect(document.activeElement?.getAttribute('role')).toBe('listbox');
  });

  it('Compare opens the comparison of the ticked runs in their order, the first as baseline', async () => {
    await renderChecked(HW_LONG.id, TES3.id);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await click(barButton('Compare'));

    expect(navigate).toHaveBeenCalledWith(['/stats/compare'], {
      queryParams: { runs: `${HW_LONG.id},${TES3.id}`, baseline: HW_LONG.id },
    });
  });

  it('Delete asks, deletes the ticked runs, says so and unticks them', async () => {
    session.run.set(TES3.id);
    await renderChecked(TES3.id, HW_SHORT.id);

    await click(barButton('Delete'));

    expect(confirm.ask).toHaveBeenCalledWith({
      title: 'Delete 2 runs?',
      message: 'This removes them from the board and cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    expect(runs.deleteRuns).toHaveBeenCalledWith([TES3.id, HW_SHORT.id]);
    expect(toasts.status).toHaveBeenCalledWith('Deleted 2 runs from the board.');
    expect(session.checkedRuns()).toEqual([]);
    // The open run was one of them: the panel closes on it.
    expect(session.run()).toBeNull();
    expect(callout()).toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('listbox');
  });

  it('Delete of one run names it, and keeps the open run when it was another', async () => {
    session.run.set(HW_LONG.id);
    await renderChecked(TES3.id);

    await click(barButton('Delete'));

    expect(confirm.ask.mock.calls[0][0].title).toBe('Delete tes3?');
    expect(toasts.status).toHaveBeenCalledWith('Deleted 1 run from the board.');
    expect(session.run()).toBe(HW_LONG.id);
  });

  it('Cancel deletes nothing and keeps the runs ticked', async () => {
    confirm.ask.mockResolvedValue(false);
    await renderChecked(TES3.id);

    await click(barButton('Delete'));

    expect(runs.deleteRuns).not.toHaveBeenCalled();
    expect(session.checkedRuns()).toEqual([TES3.id]);
  });

  it('a stale_snapshot mid-batch says 1 of 2 runs were not deleted and keeps that one ticked', async () => {
    runs.deleteRuns.mockResolvedValue({
      deleted: [TES3.id],
      failed: [{ id: HW_SHORT.id, failure: failure('stale_snapshot', 'Check the board.') }],
      notTried: [],
    });
    await renderChecked(TES3.id, HW_SHORT.id);

    await click(barButton('Delete'));

    expect(text(callout()!.querySelector('[role="heading"]'))).toBe('1 of 2 runs were not deleted');
    expect(text(callout())).toContain('insight-hw-1790177227');
    expect(text(callout())).toContain('Check the board.');
    expect(text(callout())).toContain('Deleted: tes3');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(session.checkedRuns()).toEqual([HW_SHORT.id]);
  });

  it('a failure that stops the batch lists the failure, the runs not tried (still ticked) and the deleted ones', async () => {
    runs.deleteRuns.mockResolvedValue({
      deleted: [TES3.id],
      failed: [{ id: HW_SHORT.id, failure: failure('stale_snapshot', 'Check the board.') }],
      notTried: [HW_LONG.id],
    });
    await renderChecked(TES3.id, HW_SHORT.id, HW_LONG.id);

    await click(barButton('Delete'));

    const report = callout()!;
    expect(text(report.querySelector('[role="heading"]'))).toBe('2 of 3 runs were not deleted');
    expect([...report.querySelectorAll('.failures p')].map(text)).toEqual([
      `insight-hw-1790177227: ${failure('stale_snapshot').title}`,
      'Check the board.',
    ]);
    expect(text(report)).toContain('Not tried, so still selected: insight-hw-1790177178');
    expect(text(report)).toContain('Deleted: tes3');
    expect(session.checkedRuns()).toEqual([HW_SHORT.id, HW_LONG.id]);

    await click(calloutButton('Dismiss'));
    expect(callout()).toBeNull();
  });

  it('one run not deleted is named in the heading, with what the board said', async () => {
    runs.deleteRuns.mockResolvedValue({
      deleted: [],
      failed: [{ id: TES3.id, failure: failure('sentinel_failed', '', 'rm: permission denied') }],
      notTried: [],
    });
    await renderChecked(TES3.id);

    await click(barButton('Delete'));

    expect(text(callout()!.querySelector('[role="heading"]'))).toBe('Run tes3 was not deleted');
    expect(text(callout()!.querySelector('pre'))).toBe('rm: permission denied');
    expect(session.checkedRuns()).toEqual([TES3.id]);
  });

  it('runs that leave the list leave the selection', async () => {
    await renderChecked(TES3.id, HW_SHORT.id);

    runs.runs.set(RUNS_LIST.filter((run) => run.id !== HW_SHORT.id));
    await settle();
    expect(session.checkedRuns()).toEqual([TES3.id]);

    // While the list is being read again (a board switch) nothing is dropped.
    runs.runs.set(null);
    await settle();
    expect(session.checkedRuns()).toEqual([TES3.id]);
  });

  it('says it is reading the runs, then that there are none', async () => {
    runs.runs.set(null);
    await render();
    expect(text(root())).toBe('Reading runs from the board…');

    runs.runs.set([]);
    await settle();
    expect(text(root().querySelector('neat-select-list'))).toContain(
      'No runs yet. Record a trace to create one.',
    );
    expect(options()).toEqual([]);
  });

  it('a failed read shows its title and hint with Retry, over the runs read before', async () => {
    runs.runsFailure.set(
      failureOf(new BoardProblem('Sentinel failed.', 'sentinel_failed', 'Restart it.', {}), 7),
    );
    await render();

    expect(text(callout()!.querySelector('[role="heading"]'))).toBe(runs.runsFailure()!.title);
    expect(text(callout())).toContain('Restart it.');
    expect(options()).toHaveLength(5);
    await click(calloutButton('Retry'));
    expect(runs.rereadRuns).toHaveBeenCalled();
  });
});
