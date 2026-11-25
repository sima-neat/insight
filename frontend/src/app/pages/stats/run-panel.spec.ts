import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { BoardProblem } from '../../board/board-error';
import type { RunMetadata, RunSummary, SavedRun } from '../../stats/api';
import {
  ACTIVE_TRACE,
  RECORDING_RUN,
  RUNS_LIST,
  SAVED_RUN,
  savedRun,
} from '../../stats/runs.testing';
import { failureOf } from '../../stats/sentinel-failure';
import { type RunRead, SentinelRuns } from '../../stats/sentinel-runs';
import { RunPanel } from './run-panel';

/** The part of `SentinelRuns` the panel uses: the run reads as a spy, and the trace. */
class FakeRuns {
  readonly trace = signal<RunMetadata | null>(null);
  readonly traceSummary = signal<RunSummary | null>(null);
  readonly readRun = vi.fn<(id: string) => Promise<RunRead>>(async () => ({ run: SAVED_RUN }));
}

/** The list's entry for the run of `SAVED_RUN`. */
const SAVED_SUMMARY = RUNS_LIST.find((run) => run.id === SAVED_RUN.metadata.id)!;

@Component({
  imports: [RunPanel],
  template: '<app-run-panel [run]="run()" />',
})
class Host {
  readonly run = signal<RunSummary>(SAVED_SUMMARY);
}

describe('RunPanel', () => {
  let runs: FakeRuns;
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    runs = new FakeRuns();
    TestBed.configureTestingModule({ providers: [{ provide: SentinelRuns, useValue: runs }] });
  });

  afterEach(() => fixture.destroy());

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const title = (): string => text(root().querySelector('app-panel-title h2'));
  const rows = (): string[][] =>
    [...root().querySelectorAll('table tbody tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map(text),
    );
  const collapsible = (label: string): HTMLElement | undefined =>
    [...root().querySelectorAll<HTMLElement>('neat-collapsible')].find((element) =>
      text(element.querySelector('button')).startsWith(label),
    );
  const details = (scope: Element): string[][] =>
    [...scope.querySelectorAll('dt')].map((term) => [text(term), text(term.nextElementSibling)]);

  /**
   * Lets the reads' promises run, then renders. Not by waiting for the fixture to be stable: a
   * read still out keeps it unstable, which one spec holds on purpose.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      TestBed.tick();
    }
  }

  async function render(run: RunSummary = SAVED_SUMMARY): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.run.set(run);
    await settle();
  }

  async function renderSaved(saved: SavedRun): Promise<void> {
    runs.readRun.mockResolvedValue({ run: saved });
    await render();
  }

  it('reads a finished run and shows its name, facts and note', async () => {
    await render();

    expect(runs.readRun).toHaveBeenCalledWith(SAVED_RUN.metadata.id);
    expect(title()).toBe('insight-hw-1790177227');
    expect(text(root().querySelector('.facts'))).toMatch(/^4 samples · 6 metrics · Sep 23, /);
    expect(text(root().querySelector('.note'))).toBe('Insight hardware validation');
    // The run has no tags.
    expect(root().querySelector('.tags')).toBeNull();
  });

  it('lists each metric’s mean, minimum and maximum under its group', async () => {
    await render();

    expect([...root().querySelectorAll('thead th')].map(text)).toEqual([
      'Metric',
      'Mean',
      'Min',
      'Max',
    ]);
    expect(rows()).toEqual([
      ['CPU'],
      ['CPU core 0 usage', '0.37%', '0%', '0.99%'],
      ['CPU core 11 usage', '0%', '0%', '0%'],
      ['Disk'],
      ['eMMC disk used MB', '21114 MB', '21114 MB', '21114 MB'],
      ['Memory'],
      ['Linux memory used', '8.7%', '8.55%', '8.81%'],
      ['Power'],
      ['Current board power', '8.62 W', '8.53 W', '8.88 W'],
      ['TOP'],
      ['TOP RTSN-6', '39.8 °C', '39.5 °C', '40.3 °C'],
    ]);
    expect(root().querySelector('table neat-status-chip')).toBeNull();
  });

  it('marks a maximum past the metric’s warn level with a Warning chip', async () => {
    await renderSaved(
      savedRun({
        metrics: SAVED_RUN.metrics.map((metric) =>
          metric.key === 'rtsn_6' ? { ...metric, warn: 40 } : metric,
        ),
      }),
    );

    const chips = [...root().querySelectorAll('table neat-status-chip')];
    expect(chips.map(text)).toEqual(['Warning']);
    // The chip is on the maximum, after its figure.
    const maximum = root().querySelector('table tbody:last-child tr:last-child td:last-child')!;
    expect(text(maximum)).toBe('40.3 °C Warning');
    expect(text(root().querySelector('.facts'))).toMatch(/· 1 past a threshold$/);
  });

  it('says which readings the run carries no definition for', async () => {
    await renderSaved(
      savedRun({
        samples: SAVED_RUN.samples.map((sample) => ({
          ...sample,
          values: { ...sample.values, npu_util: 1, fan_rpm: 2 },
        })),
      }),
    );

    expect(text(root().querySelector('.undefined'))).toBe(
      'This run also recorded 2 values it carries no definition for: fan_rpm, npu_util.',
    );
  });

  it('folds the run’s metadata, and other fields only when Sentinel sent some', async () => {
    await render();

    const metadata = collapsible('Run metadata')!;
    expect(details(metadata)).toContainEqual(['Id', SAVED_RUN.metadata.id]);
    expect(details(metadata)).toContainEqual(['Sentinel version', 'main:80ab7de4da31']);
    expect(details(metadata)).toContainEqual(['OS release', 'eLxr 12 (aria)']);
    expect(collapsible('Other fields')).toBeUndefined();

    fixture.destroy();
    await renderSaved({ ...SAVED_RUN, origin: 'cli' } as SavedRun);
    expect(details(collapsible('Other fields')!)).toEqual([['origin', 'cli']]);
  });

  it('shows the tags a run was saved with', async () => {
    await renderSaved(
      savedRun({ metadata: { ...SAVED_RUN.metadata, tags: ['yolo26', 'nms'], note: null } }),
    );

    expect([...root().querySelectorAll('.tags neat-status-chip')].map(text)).toEqual([
      'yolo26',
      'nms',
    ]);
    expect(root().querySelector('.note')).toBeNull();
  });

  it('says it is reading until the run is read, and a failed read with Retry', async () => {
    let answer!: (read: RunRead) => void;
    runs.readRun.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await render();
    expect(text(root().querySelector('p[role="status"]'))).toBe('Reading the run from the board…');

    const failure = failureOf(new BoardProblem('Gone.', 'sentinel_failed', 'Restart it.'), 'local');
    answer({ failure });
    await settle();
    const callout = root().querySelector('neat-callout')!;
    expect(text(callout.querySelector('[role="heading"]'))).toBe(failure.title);
    expect(text(callout)).toContain('Restart it.');

    runs.readRun.mockResolvedValue({ run: SAVED_RUN });
    [...callout.querySelectorAll('button')].find((b) => text(b) === 'Retry')!.click();
    await settle();
    expect(runs.readRun).toHaveBeenCalledTimes(2);
    expect(root().querySelector('neat-callout')).toBeNull();
    expect(rows()).toHaveLength(11);
  });

  it('Retry waits, and says so, while the run is read again', async () => {
    const failure = failureOf(new BoardProblem('Gone.', 'sentinel_failed', ''), 'local');
    runs.readRun.mockResolvedValue({ failure });
    await render();
    const retry = () =>
      [...root().querySelectorAll<HTMLButtonElement>('neat-callout button')].find((b) =>
        text(b).startsWith('Retr'),
      )!;
    expect(retry().getAttribute('aria-disabled')).toBeNull();

    let answer!: (read: RunRead) => void;
    runs.readRun.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    retry().click();
    await settle();
    expect(text(retry())).toBe('Retrying…');
    expect(retry().getAttribute('aria-disabled')).toBe('true');
    // A second press meanwhile asks nothing more.
    retry().click();
    await settle();
    expect(runs.readRun).toHaveBeenCalledTimes(2);

    answer({ failure });
    await settle();
    expect(text(retry())).toBe('Retry');
    expect(retry().getAttribute('aria-disabled')).toBeNull();
  });

  it('a stale read shows nothing of it', async () => {
    runs.readRun.mockResolvedValue({ stale: true });
    await render();

    expect(text(root().querySelector('p[role="status"]'))).toBe('Reading the run from the board…');
    expect(root().querySelector('table')).toBeNull();
  });

  it('the recording run shows the trace summary, note and tags, and is not read', async () => {
    runs.trace.set(ACTIVE_TRACE);
    runs.traceSummary.set({
      ...RECORDING_RUN,
      duration_ms: 20_400,
      samples: 11,
      energy_joules: 150,
    });
    await render(RECORDING_RUN);

    expect(runs.readRun).not.toHaveBeenCalled();
    expect(title()).toBe('compiler-v2-bench');
    expect(text(root().querySelector('app-panel-title neat-status-chip'))).toBe('Recording');
    expect(details(root()).slice(1)).toEqual([
      ['Duration', '20 s'],
      ['Samples', '11'],
      ['Energy (Estimated)', '150 J'],
    ]);
    expect(details(root())[0][0]).toBe('Started');
    expect(text(root().querySelector('.note'))).toBe('Compiler v2 on the YOLO pipeline');
    expect([...root().querySelectorAll('.tags neat-status-chip')].map(text)).toEqual([
      'compiler-v2',
      'yolo',
    ]);
  });

  it('before the first trace read after a start, the recording run’s figures come from the list', async () => {
    await render(RECORDING_RUN);

    expect(details(root()).slice(1)).toEqual([
      ['Duration', '12 s'],
      ['Samples', '7'],
      ['Energy (Estimated)', '96 J'],
    ]);
    expect(root().querySelector('.note')).toBeNull();
  });

  it('reads the run once its trace has stopped', async () => {
    await render(RECORDING_RUN);
    expect(runs.readRun).not.toHaveBeenCalled();

    fixture.componentInstance.run.set({ ...RECORDING_RUN, ended_at: '2026-09-25T09:16:00Z' });
    await settle();
    expect(runs.readRun).toHaveBeenCalledWith(RECORDING_RUN.id);

    // The list read again every 30 s gives the same run anew: it is not read again.
    fixture.componentInstance.run.set({ ...RECORDING_RUN, ended_at: '2026-09-25T09:16:00Z' });
    await settle();
    expect(runs.readRun).toHaveBeenCalledTimes(1);
  });
});
