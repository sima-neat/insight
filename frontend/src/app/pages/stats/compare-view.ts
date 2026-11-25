import { NgTemplateOutlet } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NeatButton, NeatIcon, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatSeriesSwatch } from '@sima/neat-ui/charts';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import { NeatSelect, type NeatSelectOption } from '@sima/neat-ui/select';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatSwitch } from '@sima/neat-ui/switch';
import { NeatNumeric, NeatTable } from '@sima/neat-ui/table';
import { NeatTab, NeatTabs } from '@sima/neat-ui/tabs';
import { firstValueFrom, map } from 'rxjs';
import { boardUrl } from '../../board/api';
import { BOARD_GONE_CODES } from '../../board/board-error';
import { BoardService } from '../../board/board.service';
import { formatDuration } from '../../duration';
import { NO_VALUE } from '../../no-value';
import { LatestOnly } from '../../polling';
import { Announcement } from '../../announcement';
import { withRequestErrors } from '../../sources/api-errors';
import type { CompareExport } from '../../stats/api';
import {
  ALL_GROUPS,
  availableSeries,
  changesOnly,
  compareCsv,
  compareCsvFilename,
  compareOverlay,
  compareSummary,
  compareTable,
  ENERGY_LABEL,
  formatChange,
  isCompareExport,
  orderedIds,
  readCompareParams,
  summarisesEveryRun,
  tableGroups,
  tableStatus,
} from '../../stats/compare';
import { downloadCsv } from '../../stats/csv-download';
import { formatEnergy, formatValue } from '../../stats/format';
import { failureOf, type SentinelFailure, unexpectedAnswer } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { StatsSession } from '../../stats/stats-session';
import { SentinelFailureCallout } from './sentinel-failure-callout';
import { StatsChart, type StatsChartInputs } from './stats-chart';

/** What a comparison body without a comparison's parts is said to be. */
const UNKNOWN_COMPARISON = 'This Sentinel build returned a comparison Insight cannot lay out.';

/**
 * What the address and the run list allow, the first that applies: fewer than two runs named,
 * the list not read yet (or not readable), runs no longer on the board, a run still recording,
 * else the runs to ask Sentinel for, the baseline first.
 */
type Gate =
  | { kind: 'too-few' }
  | { kind: 'reading-list' }
  | { kind: 'list-failed'; failure: SentinelFailure }
  | { kind: 'missing'; ids: string[] }
  | { kind: 'recording'; name: string }
  | { kind: 'open'; ids: string[] };

/** The comparison asked for: its answer, why it failed, or null while it is out. */
type Comparison = { answer: CompareExport } | { failure: SentinelFailure } | null;

/**
 * Stats' Compare view (`/stats/runs/compare?runs=<a>,<b>[,…]&baseline=<a>`): the runs
 * of the address, each in its series color with the baseline marked, one series of theirs drawn
 * over the common window with its summary per run, and Sentinel's per-metric comparison folded
 * below. The baseline is chosen in the header, which opens the same runs with it.
 *
 * The run list (`SentinelRuns.runs`, which the page reads while Compare shows) is waited for
 * before Sentinel is asked: only it tells a run that is gone from the board, or still recording,
 * and both are said rather than sent. Once the list allows them, the runs are asked for once per
 * address and board; a list read again every 30 s with the same runs asks nothing. Only the
 * newest request's answer is shown, and only while the page is on the board it was asked of; a
 * failure saying the board was replaced reloads the board, whose new list asks again.
 *
 * Changes are plain text everywhere: whether lower is better depends on the metric.
 */
@Component({
  selector: 'app-stats-compare',
  imports: [
    Announcement,
    NeatButton,
    NeatCallout,
    NeatCollapsible,
    NeatIcon,
    NeatNote,
    NeatNumeric,
    NeatSelect,
    NeatSeriesSwatch,
    NeatStatusChip,
    NeatSwitch,
    NeatTab,
    NeatTable,
    NeatTabs,
    NgTemplateOutlet,
    RouterLink,
    SentinelFailureCallout,
    StatsChart,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './compare-view.html',
  styleUrl: './compare-view.css',
})
export class CompareView {
  private readonly http = inject(HttpClient);
  private readonly board = inject(BoardService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  protected readonly energyLabel = ENERGY_LABEL;
  protected readonly runs = inject(SentinelRuns);
  protected readonly session = inject(StatsSession);

  private readonly params = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map(readCompareParams)),
    { requireSync: true },
  );

  protected readonly gate = computed<Gate>(() => {
    const { ids, baseline } = this.params();
    if (ids.length < 2) return { kind: 'too-few' };
    const listed = this.runs.runs();
    if (listed === null) {
      const failure = this.runs.runsFailure();
      return failure ? { kind: 'list-failed', failure } : { kind: 'reading-list' };
    }
    const byId = new Map(listed.map((run) => [run.id, run]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { kind: 'missing', ids: missing };
    const recording = ids.map((id) => byId.get(id)).find((run) => run?.ended_at === null);
    if (recording) return { kind: 'recording', name: recording.name };
    return { kind: 'open', ids: orderedIds(ids, baseline) };
  });

  /**
   * The `runs` to ask for, or null while the gate is shut: a string, so a list read again with
   * the same runs leaves it, and the request, as it is.
   */
  private readonly requested = computed(() => {
    const gate = this.gate();
    return gate.kind === 'open' ? gate.ids.join(',') : null;
  });

  /**
   * The baseline's choices, from the list rather than the answer, so that the select stays in
   * place (and keeps the focus) while the comparison with another baseline is read.
   */
  protected readonly baselineChoice = computed(() => {
    const gate = this.gate();
    if (gate.kind !== 'open') return null;
    const names = new Map(this.runs.runs()?.map((run) => [run.id, run.name]));
    const options: NeatSelectOption<string>[] = gate.ids.map((id) => ({
      value: id,
      label: names.get(id) ?? id,
    }));
    return { options, baseline: gate.ids[0] };
  });

  /** "2 runs · common window 6 s"; the window once the shown series has one. */
  protected readonly facts = computed(() => {
    const gate = this.gate();
    if (gate.kind !== 'open') return '';
    const window = this.overlay()?.windowMs;
    const runs = `${gate.ids.length} runs`;
    return window === undefined ? runs : `${runs} · common window ${formatDuration(window)}`;
  });

  private readonly reads = new LatestOnly();
  private readonly comparison = signal<Comparison>(null);
  private destroyed = false;

  protected readonly answer = computed(() => {
    const comparison = this.comparison();
    return comparison && 'answer' in comparison ? comparison.answer : null;
  });
  protected readonly failure = computed(() => {
    const comparison = this.comparison();
    return comparison && 'failure' in comparison ? comparison.failure : null;
  });

  /**
   * Each run with its place for the swatch, the baseline first, with its note: the chips, and the
   * headings of the per-metric table's run columns.
   */
  protected readonly chips = computed(
    () =>
      this.answer()?.runs.map((run, index) => ({
        id: run.metadata.id,
        name: run.metadata.name,
        note: run.metadata.note ?? '',
        baseline: index === 0,
        index,
      })) ?? [],
  );

  /** A run Sentinel did not summarise has no values in the per-metric table, which is said. */
  protected readonly partial = computed(() => {
    const answer = this.answer();
    return answer !== null && !summarisesEveryRun(answer);
  });

  /**
   * Said to screen readers when the comparison replaces "Reading the comparison from the board…"
   * (a failure says itself, as an alert). Empty while it is read, so each new one is heard.
   */
  protected readonly announcement = computed(() => (this.answer() ? 'Comparison ready.' : ''));

  protected readonly seriesOptions = computed(() => {
    const answer = this.answer();
    return answer ? availableSeries(answer.runs) : [];
  });

  /** The series chosen before while the runs share it, else the first they share. */
  protected readonly series = computed(() => {
    const options = this.seriesOptions();
    const chosen = this.session.compareSeries();
    return options.find((option) => option.key === chosen) ?? options[0] ?? null;
  });

  private readonly overlay = computed(() => {
    const answer = this.answer();
    const series = this.series();
    return answer && series ? compareOverlay(answer.runs, series.key) : null;
  });

  protected readonly chart = computed(() => {
    const overlay = this.overlay();
    if (!overlay) return null;
    const chart: StatsChartInputs = {
      series: overlay.series,
      unit: overlay.unit,
      domain: overlay.domain,
      thresholds: [],
      tone: 'default',
      headline: '',
    };
    return { chart, times: overlay.times };
  });

  protected readonly summary = computed(() => {
    const answer = this.answer();
    const series = this.series();
    if (!answer || !series) return [];
    const value = (figure: number | null) => formatValue(figure, series.unit);
    return compareSummary(answer.runs, series.key).map((row, index) => ({
      id: row.id,
      name: row.name,
      index,
      empty: row.samples === 0,
      samples: row.samples === 0 ? 'No samples' : String(row.samples),
      minimum: value(row.minimum),
      mean: value(row.mean),
      median: value(row.median),
      p95: value(row.p95),
      maximum: value(row.maximum),
      change: row.baseline ? 'Baseline' : formatChange(row.change) || NO_VALUE,
      energy: formatEnergy(row.energy),
    }));
  });

  /** Per-metric comparison starts closed on every visit; its table is built only while open. */
  protected readonly tableOpen = signal(false);
  protected readonly group = signal(ALL_GROUPS);
  protected readonly changesOnly = signal(false);

  private readonly tableRows = computed(() => {
    const answer = this.answer();
    return answer ? compareTable(answer) : [];
  });
  protected readonly rowCount = computed(() => {
    const count = this.tableRows().length;
    return `${count} ${count === 1 ? 'row' : 'rows'}`;
  });
  protected readonly groups = computed(() =>
    tableGroups(this.tableRows()).map(({ group, count }) => ({
      group,
      label: `${group} (${count})`,
    })),
  );

  /** The group chosen while the table has it, else All, which the tabs then show open. */
  protected readonly shownGroup = computed(() => {
    const group = this.group();
    return this.groups().some((choice) => choice.group === group) ? group : ALL_GROUPS;
  });

  protected readonly table = computed(() => {
    const all = this.tableRows();
    const group = this.shownGroup();
    const grouped = group === ALL_GROUPS ? all : all.filter((row) => row.group === group);
    const shown = this.changesOnly() ? changesOnly(grouped) : grouped;
    return {
      columns: this.chips(),
      rows: shown.map((row) => ({
        key: row.key,
        label: row.label,
        cells: row.cells.map((cell) => ({
          mean: formatValue(cell.mean, row.unit),
          change: formatChange(cell.change),
        })),
      })),
      status: tableStatus(shown.length, all.length, grouped.length - shown.length),
    };
  });

  constructor() {
    effect(() => {
      const runs = this.requested();
      const id = this.board.id();
      untracked(() => void this.load(runs, id));
    });
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  /** Opens the same runs with another baseline; the address then asks for them in its order. */
  protected chooseBaseline(id: string | null): void {
    const { ids, baseline } = this.params();
    if (id === null || id === orderedIds(ids, baseline)[0]) return;
    void this.router.navigate(['/stats/runs/compare'], {
      queryParams: { runs: ids.join(','), baseline: id },
      replaceUrl: true,
    });
  }

  protected chooseGroup(group: string | undefined): void {
    this.group.set(group ?? ALL_GROUPS);
  }

  protected retry(): void {
    void this.load(this.requested(), this.board.id());
  }

  /** Downloads every row of the comparison, whatever the table shows. */
  protected exportCsv(): void {
    const answer = this.answer();
    if (!answer) return;
    const baseline = answer.runs[0]?.metadata.name ?? '';
    downloadCsv(this.document, compareCsv(answer), compareCsvFilename(baseline, new Date()));
  }

  /**
   * Asks Sentinel to compare `runs` on the board of `id`, dropping whatever was shown; null asks
   * nothing. An answer is shown only while it is the newest request's and the page is on that
   * board; one without a comparison's parts (`isCompareExport`) is shown as a failure.
   */
  private async load(runs: string | null, id: string | null): Promise<void> {
    const request = this.reads.next();
    this.comparison.set(null);
    if (runs === null || id === null) return;
    const current = () => !this.destroyed && this.reads.isNewest(request) && this.board.id() === id;
    try {
      const answer = await firstValueFrom(
        this.http
          .get<unknown>(boardUrl(id, 'sentinel/compare'), { params: { runs } })
          .pipe(withRequestErrors()),
      );
      if (!current()) return;
      this.comparison.set(
        isCompareExport(answer)
          ? { answer }
          : { failure: unexpectedAnswer(UNKNOWN_COMPARISON, id) },
      );
    } catch (error) {
      if (!current()) return;
      const failure = failureOf(error, id);
      if (BOARD_GONE_CODES.has(failure.code)) void this.board.reload();
      this.comparison.set({ failure });
    }
  }
}
