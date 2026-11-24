import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { NeatSeriesSwatch, NeatTimeChart } from '@sima/neat-ui/charts';
import { NeatSelect } from '@sima/neat-ui/select';
import { BoardProblem } from '../../board/board-error';
import { BoardService } from '../../board/board.service';
import { boardWith, DEVKIT, FakeBoard, LOCAL } from '../../board/board.testing';
import type { CompareExport, RunSummary } from '../../stats/api';
import { compareCsv, compareCsvFilename, compareSummary, formatChange } from '../../stats/compare';
import { COMPARE_RAW, RECORDING_RUN, RUNS_LIST } from '../../stats/runs.testing';
import { failureOf, type SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { StatsSession } from '../../stats/stats-session';
import { CompareView } from './compare-view';

const COMPARE_URL = `/api/boards/${encodeURIComponent(DEVKIT.id)}/sentinel/compare`;
// The fixture's two runs: tes3, its baseline, and the hardware validation run.
const [BASELINE, OTHER] = COMPARE_RAW.runs.map((run) => run.metadata.id);

/** The part of `SentinelRuns` the view uses: the run list, its failure and a re-read. */
class FakeRuns {
  readonly runs = signal<RunSummary[] | null>(RUNS_LIST);
  readonly runsFailure = signal<SentinelFailure | null>(null);
  readonly rereadRuns = vi.fn();
}

@Component({ template: '' })
class RunsList {}

/** The fixture compared the other way round: the hardware run as the baseline. */
const SWAPPED: CompareExport = {
  ...COMPARE_RAW,
  baseline_id: OTHER,
  runs: [...COMPARE_RAW.runs].reverse(),
};

/** Sentinel's comparison as the route answers it. */
const answer = (comparison: CompareExport = COMPARE_RAW): CompareExport => comparison;

describe('CompareView', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let runs: FakeRuns;
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    // jsdom has no ResizeObserver; the tab strip watches its width to scroll its tabs.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // jsdom lays nothing out, so no width ever changes.
        }
        unobserve(): void {
          // Nothing was observed.
        }
        disconnect(): void {
          // Nothing was observed.
        }
      },
    );
    board = new FakeBoard();
    board.state.set(boardWith(DEVKIT));
    runs = new FakeRuns();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'stats/runs/compare', component: CompareView },
          { path: 'stats/runs', component: RunsList },
        ]),
        { provide: BoardService, useValue: board },
        { provide: SentinelRuns, useValue: runs },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    try {
      harness.fixture.destroy();
      // Every request a test caused was answered and checked.
      http.verify();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  const root = (): HTMLElement => harness.routeNativeElement!;
  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await harness.fixture.whenStable();
    }
  }

  async function open(query: string): Promise<void> {
    await harness.navigateByUrl(`/stats/runs/compare?${query}`);
    await settle();
  }

  /** Opens the comparison of the fixture's two runs, tes3 as its baseline. */
  const openPair = () => open(`runs=${BASELINE},${OTHER}&baseline=${BASELINE}`);

  const compareRequests = (): TestRequest[] => http.match((request) => request.url === COMPARE_URL);
  const compareRequest = (): TestRequest =>
    http.expectOne((request) => request.url === COMPARE_URL);
  const noRequest = () => http.expectNone((request) => request.url === COMPARE_URL);

  async function flush(request: TestRequest, body: object, status?: number): Promise<void> {
    request.flush(body, status ? { status, statusText: 'Bad Gateway' } : undefined);
    await settle();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  const calloutHeadings = (): string[] =>
    [...root().querySelectorAll('neat-callout [role="heading"]')].map(text);
  const callout = (): HTMLElement => root().querySelector('neat-callout')!;
  const buttonNamed = (name: string): HTMLButtonElement =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => text(button) === name,
    )!;
  const chips = (): HTMLElement[] => [
    ...root().querySelectorAll<HTMLElement>('ul[aria-label="Compared runs"] > li'),
  ];
  const tabs = (label: string): string[] =>
    [...root().querySelectorAll(`[role="tablist"][aria-label="${label}"] [role="tab"]`)].map(text);
  const tab = (label: string, name: string): HTMLElement =>
    [
      ...root().querySelectorAll<HTMLElement>(
        `[role="tablist"][aria-label="${label}"] [role="tab"]`,
      ),
    ].find((element) => text(element) === name)!;
  /** A table's rows as they read: each cell's text. */
  const rows = (table: Element | null): string[][] =>
    [...(table?.querySelectorAll('tbody tr') ?? [])].map((row) =>
      [...row.querySelectorAll('th, td')].map(text),
    );
  const headings = (table: Element | null): string[] =>
    [...(table?.querySelectorAll('thead th') ?? [])].map(text);
  const summaryTable = () => root().querySelector('table[aria-label="Summary"]');
  /** Each summary row's Mean cell. */
  const meanCells = (): Element[] =>
    [...(summaryTable()?.querySelectorAll('tbody tr') ?? [])].map(
      (row) => row.querySelectorAll('td')[2],
    );
  const status = (): HTMLElement => root().querySelector<HTMLElement>('.table-status')!;
  const metricTable = () => root().querySelector('table[aria-label="Per-metric comparison"]');
  const chart = (): NeatTimeChart | undefined =>
    harness.fixture.debugElement.query(By.directive(NeatTimeChart))?.componentInstance;
  /** The series index of each kit swatch inside `container`, in document order. */
  const swatchIndexes = (container: Element): number[] =>
    harness.fixture.debugElement
      .queryAll(By.directive(NeatSeriesSwatch))
      .filter((swatch) => container.contains(swatch.nativeElement))
      .map((swatch) => swatch.injector.get(NeatSeriesSwatch).index());
  const baselineSelect = (): NeatSelect<string> =>
    harness.fixture.debugElement.query(By.directive(NeatSelect)).componentInstance;

  it('asks Sentinel for the runs with the baseline first', async () => {
    await open(`runs=${OTHER},${BASELINE}&baseline=${BASELINE}`);
    const request = compareRequest();
    expect(request.request.method).toBe('GET');
    expect(request.request.params.get('runs')).toBe(`${BASELINE},${OTHER}`);
    expect(text(root().querySelector('[role="status"]'))).toBe(
      'Reading the comparison from the board…',
    );
    await flush(request, answer());
  });

  it('heads the comparison with the runs, the common window, the baseline and Export CSV', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    const back = root().querySelector<HTMLAnchorElement>('a[href="/stats/runs"]');
    expect(text(back)).toBe('Runs');
    expect(text(root().querySelector('h2'))).toBe('Comparison');
    expect(text(root().querySelector('.facts'))).toBe('2 runs · common window 6.0 s');
    expect(baselineSelect().label()).toBe('Baseline');
    expect(baselineSelect().labelPosition()).toBe('inline');
    expect(baselineSelect().value()).toBe(BASELINE);
    expect(baselineSelect().options()).toEqual([
      { value: BASELINE, label: 'tes3' },
      { value: OTHER, label: 'insight-hw-1790177227' },
    ]);
    expect(buttonNamed('Export CSV').disabled).toBe(false);
  });

  it('shows a chip per run in its series colour, B on the baseline', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    expect(chips().map((chip) => text(chip.querySelector('.name')))).toEqual([
      'tes3',
      'insight-hw-1790177227',
    ]);
    expect(chips().map((chip) => text(chip.querySelector('neat-status-chip')))).toEqual(['B', '']);
    // B is for the eye; a screen reader hears ", baseline".
    expect(chips().map((chip) => text(chip.querySelector('.visually-hidden')))).toEqual([
      ', baseline',
      '',
    ]);
    expect(chips()[0].querySelector('neat-status-chip')!.getAttribute('aria-hidden')).toBe('true');
    // The kit's swatch, by the run's place: the colour the chart draws its line in.
    expect(chips().map(swatchIndexes)).toEqual([[0], [1]]);
  });

  it('choosing another baseline opens the same runs with it, which asks for them the other way round', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    baselineSelect().value.set(OTHER);
    await settle();
    const router = TestBed.inject(Router);
    expect(router.url).toBe(`/stats/runs/compare?runs=${BASELINE},${OTHER}&baseline=${OTHER}`);
    const request = compareRequest();
    expect(request.request.params.get('runs')).toBe(`${OTHER},${BASELINE}`);
    await flush(request, answer(SWAPPED));
    expect(chips().map((chip) => text(chip.querySelector('neat-status-chip')))).toEqual(['B', '']);
    expect(text(chips()[0].querySelector('.name'))).toBe('insight-hw-1790177227');
  });

  it('offers the series the runs share and draws the chosen one over elapsed time, remembering it', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    expect(tabs('Series to compare')).toEqual(['Total power', 'Thermal max', 'CPU usage']);
    expect(chart()!.axis()).toBe('elapsed');
    expect(chart()!.size()).toBe('large');
    expect(chart()!.label()).toBe('Total power');
    expect(
      chart()!
        .series()
        .map((series) => series.label),
    ).toEqual(['tes3', 'insight-hw-1790177227']);
    expect(chart()!.format()(9.03125)).toBe('9.03 W');

    await click(tab('Series to compare', 'Thermal max'));
    expect(TestBed.inject(StatsSession).compareSeries()).toBe('thermal_max');
    expect(chart()!.label()).toBe('Thermal max');
    expect(chart()!.format()(55)).toBe('55 °C');
  });

  it('opens on the series chosen before, and on the first where the runs do not share it', async () => {
    const session = TestBed.inject(StatsSession);
    session.compareSeries.set('thermal_max');
    await openPair();
    await flush(compareRequest(), answer());
    expect(chart()!.label()).toBe('Thermal max');

    session.compareSeries.set('ev74_cma_used_mb');
    await settle();
    expect(chart()!.label()).toBe('Total power');
  });

  it('summarises the series per run over the common window, with the baseline and a signed change', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    expect(headings(summaryTable())).toEqual([
      'Run',
      'Samples',
      'Min',
      'Mean',
      'Median',
      'P95',
      'Max',
      'vs. baseline',
      'Energy',
    ]);
    // Each summary row names its run by the swatch of its place too.
    const summaryRows = [...summaryTable()!.querySelectorAll('tbody tr')];
    expect(summaryRows.map(swatchIndexes)).toEqual([[0], [1]]);
    const [, other] = compareSummary(COMPARE_RAW.runs, 'power_current_watts');
    expect(formatChange(other.change)).toBe('−4.58%');
    expect(rows(summaryTable())).toEqual([
      ['tes3', '4', '9.03 W', '9.03 W', '9.03 W', '9.03 W', '9.03 W', 'Baseline', '54 J'],
      [
        'insight-hw-1790177227',
        '4',
        '8.53 W',
        '8.62 W',
        '8.53 W',
        '8.88 W',
        '8.88 W',
        '−4.58%',
        '52 J',
      ],
    ]);
    // A run with samples has nothing to say in their place.
    expect(meanCells().map((cell) => cell.querySelector('.narrow'))).toEqual([null, null]);
    // The change is plain text: lower is not always better.
    const change = summaryTable()!.querySelectorAll('tbody tr')[1].querySelectorAll('td')[6];
    expect(change.className).toBe('');
    expect(change.querySelector('neat-status-chip')).toBeNull();
  });

  it('a series no run has readings of draws no chart, and the summary says No samples', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    await click(tab('Series to compare', 'CPU usage'));
    expect(chart()).toBeUndefined();
    expect(text(root().querySelector('.no-chart'))).toBe(
      'No run has two readings of CPU usage to draw.',
    );
    expect(text(root().querySelector('.facts'))).toBe('2 runs');
    expect(rows(summaryTable()).map((row) => row.slice(0, 2))).toEqual([
      ['tes3', 'No samples'],
      ['insight-hw-1790177227', 'No samples'],
    ]);
    // Where Samples gives way to the width (`.wide`), the Mean cell says it instead (`.narrow`).
    const means = meanCells();
    expect(means.map((cell) => text(cell.querySelector('.wide')))).toEqual(['–', '–']);
    expect(means.map((cell) => text(cell.querySelector('.narrow')))).toEqual([
      'No samples',
      'No samples',
    ]);
  });

  it('builds the per-metric table only once opened; Changes only hides the rows where no run differs', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    // The kit's trigger: the label, then the summary while closed.
    const trigger = [...root().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      text(button).startsWith('Per-metric comparison'),
    )!;
    expect(text(trigger)).toMatch(/^Per-metric comparison\s*7 rows$/);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(metricTable()).toBeNull();

    await click(trigger);
    expect(tabs('Metric groups')).toEqual([
      'All (7)',
      'Run totals (3)',
      'Board (1)',
      'CPU (1)',
      'MLA (1)',
      'Power (1)',
    ]);
    // Each run's heading as its chip reads it, B on the baseline, with the run's note under it.
    const columns = [...metricTable()!.querySelectorAll('thead th')].slice(1);
    expect(headings(metricTable())[0]).toBe('Metric');
    expect(columns.map((th) => text(th.querySelector('.name')))).toEqual([
      'tes3',
      'insight-hw-1790177227',
    ]);
    expect(columns.map((th) => text(th.querySelector('neat-status-chip')))).toEqual(['B', '']);
    expect(text(columns[0].querySelector('.visually-hidden'))).toBe(', baseline');
    expect(columns.map(swatchIndexes)).toEqual([[0], [1]]);
    expect(columns.map((th) => text(th.querySelector('.note')))).toEqual([
      '',
      'Insight hardware validation',
    ]);
    expect(root().querySelector('.partial')).toBeNull();
    expect(rows(metricTable())).toEqual([
      ['Duration', '8.13 s', '6.67 s −18%'],
      ['Energy', '54.2 J', '51.5 J −4.9%'],
      ['Samples', '4', '4 ±0%'],
      ['CPU usage', '–', '–'],
      ['Current board power', '9.03 W', '8.62 W −4.58%'],
      ['LM96163 temp2', '54.8 °C', '40.7 °C −25.8%'],
      ['MLA RTSN-0', '52.2 °C', '38.5 °C −26.3%'],
    ]);
    // A live region that says nothing yet: there for screen readers, out of the eye's way.
    expect(text(status())).toBe('');
    expect(status().getAttribute('role')).toBe('status');
    expect(status().classList).toContain('visually-hidden');

    const changesOnly = root().querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(text(changesOnly)).toBe('Changes only');
    await click(changesOnly);
    expect(rows(metricTable()).map((row) => row[0])).toEqual([
      'Duration',
      'Energy',
      'Current board power',
      'LM96163 temp2',
      'MLA RTSN-0',
    ]);
    expect(text(status())).toBe(
      'Showing 5 of 7 rows. Changes only hides 2 rows where no run differs from the baseline. ' +
        'Export CSV still writes all 7.',
    );
    expect(status().classList).not.toContain('visually-hidden');

    await click(tab('Metric groups', 'MLA (1)'));
    expect(rows(metricTable()).map((row) => row[0])).toEqual(['MLA RTSN-0']);
    expect(text(status())).toBe('Showing 1 of 7 rows. Export CSV still writes all 7.');
  });

  it('a group the next baseline’s definitions do not have falls back to All', async () => {
    // The hardware run files MLA RTSN-0 under Thermal: as the baseline, its definition counts.
    const regrouped: CompareExport = {
      ...SWAPPED,
      runs: SWAPPED.runs.map((run) =>
        run.metadata.id !== OTHER
          ? run
          : {
              ...run,
              metrics: run.metrics.map((metric) =>
                metric.key === 'rtsn_0' ? { ...metric, group: 'Thermal' } : metric,
              ),
            },
      ),
    };
    await openPair();
    await flush(compareRequest(), answer());
    await click(
      [...root().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        text(button).startsWith('Per-metric comparison'),
      )!,
    );
    await click(tab('Metric groups', 'MLA (1)'));
    expect(rows(metricTable())).toHaveLength(1);

    baselineSelect().value.set(OTHER);
    await settle();
    await flush(compareRequest(), answer(regrouped));
    expect(tabs('Metric groups')).not.toContain('MLA (1)');
    expect(rows(metricTable())).toHaveLength(7);
  });

  it('Export CSV downloads every row of the comparison, named after the baseline', async () => {
    await openPair();
    await flush(compareRequest(), answer());

    const blobs: Blob[] = [];
    const { createObjectURL: create, revokeObjectURL: revoke } = URL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:compare';
    });
    URL.revokeObjectURL = vi.fn();
    onTestFinished(() => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    await click(buttonNamed('Export CSV'));

    expect(downloads).toEqual([compareCsvFilename('tes3', new Date())]);
    expect(await blobs[0].text()).toBe(compareCsv(COMPARE_RAW));
  });

  it('with fewer than two runs it asks to choose more, links back to Runs and asks nothing', async () => {
    await open(`runs=${BASELINE}`);
    noRequest();
    expect(calloutHeadings()).toEqual(['Choose two or more runs to compare']);
    const back = callout().querySelector<HTMLAnchorElement>('a[href="/stats/runs"]');
    expect(text(back)).toBe('Open Runs');
    expect(root().querySelector('neat-select')).toBeNull();
  });

  it('waits for the run list before asking, and names the runs no longer on the board', async () => {
    runs.runs.set(null);
    await open(`runs=${BASELINE},gone-1,${OTHER},gone-2`);
    noRequest();
    expect(text(root().querySelector('[role="status"]'))).toBe('Reading runs from the board…');

    runs.runs.set(RUNS_LIST);
    await settle();
    noRequest();
    expect(calloutHeadings()).toEqual(['Some runs are no longer on the board']);
    expect(text(callout().querySelector('p'))).toBe(
      'The board’s run list no longer has gone-1, gone-2. Choose the runs to compare again.',
    );
  });

  it('a run list that cannot be read says why, with Retry', async () => {
    runs.runs.set(null);
    runs.runsFailure.set(failureOf(new BoardProblem('Timed out.', 'timeout', ''), DEVKIT.id));
    await openPair();
    noRequest();
    expect(calloutHeadings()).toEqual(['The board took too long to answer']);
    await click(buttonNamed('Retry'));
    expect(runs.rereadRuns).toHaveBeenCalledOnce();
  });

  it('a run still recording is compared once its trace has stopped', async () => {
    await open(`runs=${RECORDING_RUN.id},${BASELINE}`);
    noRequest();
    expect(calloutHeadings()).toEqual([
      'compiler-v2-bench is still recording; compare it once the trace has stopped',
    ]);

    // The next read of the list finds it finished.
    runs.runs.set(
      RUNS_LIST.map((run) =>
        run.id === RECORDING_RUN.id ? { ...run, ended_at: '2026-09-25T09:21:00Z' } : run,
      ),
    );
    await settle();
    const request = compareRequest();
    expect(request.request.params.get('runs')).toBe(`${RECORDING_RUN.id},${BASELINE}`);
    request.flush(answer());
    await settle();
  });

  it('a re-read run list does not ask again', async () => {
    await openPair();
    await flush(compareRequest(), answer());
    runs.runs.set([...RUNS_LIST]);
    await settle();
    noRequest();
  });

  it('a failure shows its title and hint, and Retry asks again', async () => {
    await openPair();
    await flush(
      compareRequest(),
      {
        error: {
          code: 'response_too_large',
          message: 'Sentinel answered with 13 MB; Insight reads at most 12 MiB.',
          hint: 'Compare fewer or shorter runs.',
        },
      },
      502,
    );
    expect(calloutHeadings()).toEqual([
      'Sentinel answered with 13 MB; Insight reads at most 12 MiB.',
    ]);
    expect(text(callout())).toContain('Compare fewer or shorter runs.');
    expect(buttonNamed('Export CSV').disabled).toBe(true);

    await click(buttonNamed('Retry'));
    await flush(compareRequest(), answer());
    expect(calloutHeadings()).toEqual([]);
    expect(chips()).toHaveLength(2);
  });

  it('says once that the comparison is ready, where it said it was reading it', async () => {
    const announcement = () => text(root().querySelector('app-announcement'));
    await openPair();
    expect(announcement()).toBe('');
    await flush(compareRequest(), answer());
    expect(announcement()).toBe('Comparison ready.');

    // Another baseline reads it afresh, and says so again once it is in.
    baselineSelect().value.set(OTHER);
    await settle();
    expect(announcement()).toBe('');
    await flush(compareRequest(), answer(SWAPPED));
    expect(announcement()).toBe('Comparison ready.');
  });

  it.each(['runs', 'summaries', 'baseline_deltas_pct'] as const)(
    'a comparison without its %s is an unexpected answer, with Retry',
    async (missing) => {
      const body: Partial<CompareExport> = { ...COMPARE_RAW };
      delete body[missing];
      await openPair();
      await flush(compareRequest(), answer(body as CompareExport));
      expect(calloutHeadings()).toEqual(['Insight answered something unexpected']);
      expect(text(callout())).toContain(
        'This Sentinel build returned a comparison Insight cannot lay out.',
      );
      expect(chips()).toHaveLength(0);
      expect(text(root().querySelector('app-announcement'))).toBe('');

      await click(buttonNamed('Retry'));
      await flush(compareRequest(), answer());
      expect(chips()).toHaveLength(2);
    },
  );

  it('says when Sentinel summarised only some of the runs, whose cells stay empty', async () => {
    const summaries = { [BASELINE]: COMPARE_RAW.summaries[BASELINE] };
    await openPair();
    await flush(compareRequest(), answer({ ...COMPARE_RAW, summaries }));
    await click(
      [...root().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        text(button).startsWith('Per-metric comparison'),
      )!,
    );
    expect(text(root().querySelector('.partial'))).toBe(
      'Sentinel summarised only some of these runs.',
    );
    expect(rows(metricTable()).every((row) => row[2] === '–')).toBe(true);
  });

  it('drops an answer that lands after the board changed, and asks the new board', async () => {
    await openPair();
    const first = compareRequest();
    board.state.set(boardWith(LOCAL));
    await settle();
    const local = http.expectOne((request) => request.url === '/api/boards/local/sentinel/compare');
    expect(local.request.params.get('runs')).toBe(`${BASELINE},${OTHER}`);
    await flush(first, answer());
    expect(chips()).toHaveLength(0);
    expect(text(root().querySelector('[role="status"]'))).toBe(
      'Reading the comparison from the board…',
    );
    await flush(local, answer());
    expect(chips()).toHaveLength(2);
  });

  it('a board that is no longer selected reloads the boards', async () => {
    await openPair();
    await flush(
      compareRequest(),
      {
        error: {
          code: 'not_found',
          message: `${DEVKIT.id} is not the selected board.`,
          hint: 'Read the boards again and use the selected one.',
        },
      },
      404,
    );
    expect(board.reload).toHaveBeenCalledOnce();
  });

  it('shows only the newest answer: one for the baseline chosen before is dropped', async () => {
    await openPair();
    baselineSelect().value.set(OTHER);
    await settle();
    const [first, second] = compareRequests();
    await flush(second, answer(SWAPPED));
    await flush(first, answer());
    expect(text(chips()[0].querySelector('.name'))).toBe('insight-hw-1790177227');
  });
});
