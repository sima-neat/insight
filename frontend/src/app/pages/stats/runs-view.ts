import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatConfirm, type NeatConfirmOptions } from '@sima/neat-ui/confirm';
import { NeatColumn, NeatSelectList } from '@sima/neat-ui/select-list';
import { NeatToasts } from '@sima/neat-ui/toast';
import { AsidePrefs } from '../../aside-prefs';
import { CellText } from '../../cell-text';
import { ticking } from '../../clock';
import { holdFocus } from '../../hold-focus';
import { ListColumn } from '../../list-column';
import type { RunSummary } from '../../stats/api';
import {
  canCheckRun,
  capChecked,
  checkBlockReason,
  MAX_CHECKED_RUNS,
  runLine,
  runWhen,
} from '../../stats/runs';
import { type DeleteOutcome, SentinelRuns } from '../../stats/sentinel-runs';
import { StatsSession } from '../../stats/stats-session';
import { SentinelFailureCallout } from './sentinel-failure-callout';

/** A run as its row shows it. */
interface RunRow {
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly when: string;
  readonly run: RunSummary;
}

/** What a delete that did not delete every run says, run by run, by name. */
interface DeleteReport {
  readonly title: string;
  readonly failures: readonly {
    name: string;
    title: string;
    message: string;
    hint: string;
  }[];
  /** The runs after the failure that stopped the batch: still selected. */
  readonly notTried: readonly string[];
  readonly deleted: readonly string[];
}

const plural = (count: number): string => (count === 1 ? 'run' : 'runs');

/** The confirmation before deleting the runs named, in the app's dialog (spec, "Delete"). */
function deleteQuestion(names: readonly string[]): NeatConfirmOptions {
  return {
    title: names.length === 1 ? `Delete ${names[0]}?` : `Delete ${names.length} runs?`,
    message: `This removes ${names.length === 1 ? 'it' : 'them'} from the board and cannot be undone.`,
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

/**
 * What a delete of `ids` did, by name, when it did not delete them all; null when it did. One run
 * asked for is named in the title; several are counted (#170's wording).
 */
function deleteReport(
  ids: readonly string[],
  outcome: DeleteOutcome,
  nameOf: (id: string) => string,
): DeleteReport | null {
  const kept = outcome.failed.length + outcome.notTried.length;
  if (kept === 0) return null;
  return {
    title:
      ids.length === 1
        ? `Run ${nameOf(ids[0])} was not deleted`
        : `${kept} of ${ids.length} runs were not deleted`,
    failures: outcome.failed.map(({ id, failure }) => ({
      name: nameOf(id),
      title: failure.title,
      message: failure.problem.message,
      hint: failure.hint,
    })),
    notTried: outcome.notTried.map(nameOf),
    deleted: outcome.deleted.map(nameOf),
  };
}

/**
 * Stats' Runs view: the runs saved on the board, the one recording first as Sentinel lists it,
 * one row each with its recorded line and when it started (spec, "Run list"). A click on a row
 * selects the run, whose detail the side panel shows (the page builds the panel). Ticking runs
 * (at most 8, never the recording one) brings up the selection bar: Compare opens their
 * comparison, the first ticked as baseline; Delete asks, then deletes them one at a time.
 *
 * What is ticked and selected lives in `StatsSession`, by run id. A run that leaves the list (a
 * delete here, the Sentinel CLI, retention) leaves the ticks too; the selected run stays selected,
 * and the panel says it is gone.
 *
 * When Clear, Dismiss or a delete removed the button that had the focus, the list takes it, so the
 * keyboard stays in the view rather than falling to the page's body. A focus moved elsewhere
 * meanwhile (a delete takes a request per run) is left where it is.
 */
@Component({
  selector: 'app-stats-runs',
  imports: [
    CellText,
    ListColumn,
    NeatButton,
    NeatCallout,
    NeatColumn,
    NeatNote,
    NeatSelectList,
    SentinelFailureCallout,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './runs-view.html',
  styleUrl: './runs-view.css',
})
export class RunsView {
  protected readonly runs = inject(SentinelRuns);
  protected readonly session = inject(StatsSession);
  private readonly asides = inject(AsidePrefs);
  private readonly confirm = inject(NeatConfirm);
  private readonly toasts = inject(NeatToasts);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly list = viewChild(NeatSelectList);

  /** "5 min ago" moves in steps of 10 s and more. */
  private readonly now = ticking(10_000);

  protected readonly rows = computed<RunRow[] | null>(() => {
    const now = this.now();
    return (
      this.runs.runs()?.map((run) => ({
        id: run.id,
        name: run.name,
        line: runLine(run),
        when: runWhen(run.started_at, now),
        run,
      })) ?? null
    );
  });

  protected readonly selectedRow = computed(
    () => this.rows()?.find((row) => row.id === this.session.run()) ?? null,
  );

  protected readonly rowId = (row: RunRow): string => row.id;

  /** Which rows have a box. */
  protected readonly canCheck = (row: RunRow): boolean => canCheckRun(row.run);

  /** Why a row's box is blocked: a new function when the ticks change, so the list asks again. */
  protected readonly checkBlocked = computed(() => {
    const checked = this.session.checkedRuns();
    return (row: RunRow) => checkBlockReason(row.run, checked);
  });

  protected readonly checkedCount = computed(() => this.session.checkedRuns().length);
  /**
   * The count says why no more can be ticked at the cap: the greyed boxes give the reason only
   * to a pointer, so on touch the bar is the one place it shows.
   */
  protected readonly countText = computed(() =>
    this.checkedCount() >= MAX_CHECKED_RUNS
      ? `${MAX_CHECKED_RUNS} selected, the most that can be compared`
      : `${this.checkedCount()} selected`,
  );
  protected readonly canCompare = computed(
    () => this.checkedCount() >= 2 && this.checkedCount() <= MAX_CHECKED_RUNS,
  );

  /**
   * A delete is under way: Delete and Compare wait until it has finished, Delete with
   * `aria-disabled` so the focus stays on it.
   */
  protected readonly deleting = signal(false);
  /** Delete is asking; it stays enabled so the dialog can give the focus back on Cancel. */
  private asking = false;
  /** What the last delete could not do, until the next delete or Dismiss. */
  protected readonly report = signal<DeleteReport | null>(null);

  constructor() {
    // Ticks of runs no longer listed go. Not while the list is being read (null): a board switch
    // reads the new board's list, which drops the previous board's runs then.
    effect(() => {
      const listed = this.runs.runs();
      if (listed === null) return;
      untracked(() => {
        const ids = new Set(listed.map((run) => run.id));
        const checked = this.session.checkedRuns();
        const kept = checked.filter((id) => ids.has(id));
        if (kept.length !== checked.length) this.session.checkedRuns.set(kept);
      });
    });
  }

  /** The list's ticks, held to the cap: a bulk tick can go past it (`capChecked`). */
  protected check(ids: readonly string[]): void {
    this.session.checkedRuns.set(capChecked(ids, this.rows()?.map((row) => row.id) ?? []));
  }

  protected select(row: RunRow | null): void {
    this.session.run.set(row?.id ?? null);
  }

  protected open(row: RunRow): void {
    this.session.run.set(row.id);
    this.asides.setOpen('stats', true);
  }

  protected compare(): void {
    const ids = this.session.checkedRuns();
    if (!this.canCompare() || this.deleting()) return;
    void this.router.navigate(['/stats/runs/compare'], {
      queryParams: { runs: ids.join(','), baseline: ids[0] },
    });
  }

  protected clear(): void {
    this.session.checkedRuns.set([]);
    this.holdFocus();
  }

  protected dismiss(): void {
    this.report.set(null);
    this.holdFocus();
  }

  protected async delete(): Promise<void> {
    const ids = this.session.checkedRuns();
    if (ids.length === 0 || this.asking || this.deleting()) return;
    // The names as listed now: a run deleted is no longer listed by the time the report names it.
    const names = new Map(this.runs.runs()?.map((run) => [run.id, run.name]));
    const nameOf = (id: string) => names.get(id) ?? id;
    this.asking = true;
    let confirmed: boolean;
    try {
      confirmed = await this.confirm.ask(deleteQuestion(ids.map(nameOf)));
    } finally {
      this.asking = false;
    }
    if (!confirmed) return;

    this.report.set(null);
    this.deleting.set(true);
    try {
      const outcome = await this.runs.deleteRuns(ids);
      const gone = new Set(outcome.deleted);
      this.session.checkedRuns.update((checked) => checked.filter((id) => !gone.has(id)));
      const selected = this.session.run();
      if (selected !== null && gone.has(selected)) this.session.run.set(null);
      const report = deleteReport(ids, outcome, nameOf);
      if (report) this.report.set(report);
      else this.toasts.status(`Deleted ${ids.length} ${plural(ids.length)} from the board.`);
      this.holdFocus();
    } finally {
      this.deleting.set(false);
    }
  }

  /**
   * Once the view shows what changed: the button that had the focus may be gone by then, which
   * leaves the focus on the body, and the list takes it. A button still there keeps it.
   */
  private holdFocus(): void {
    holdFocus(this.injector, () => this.list());
  }
}
