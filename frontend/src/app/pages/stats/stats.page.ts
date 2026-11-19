import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, PRIMARY_OUTLET, Router, type UrlTree } from '@angular/router';
import {
  NeatAsidePanel,
  NeatAsideToggle,
  NeatButton,
  NeatIcon,
  NeatNote,
  NeatPage,
  NeatPageToolbar,
  type NeatTone,
  NeatTooltip,
} from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatChartCard } from '@sima/neat-ui/charts';
import { NeatCollapsible } from '@sima/neat-ui/collapsible';
import {
  NeatPopover,
  NeatPopoverContent,
  NeatPopoverItem,
  NeatPopoverTrigger,
} from '@sima/neat-ui/popover';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { filter, map } from 'rxjs';
import { Announcement } from '../../announcement';
import { AppDialogs } from '../../app-dialogs';
import { AsidePrefs } from '../../aside-prefs';
import { BoardProblemNotice } from '../../board/board-problem-notice';
import { BoardSettingsAction } from '../../board/board-settings-action';
import { BoardService } from '../../board/board.service';
import { ticking } from '../../clock';
import { CopyCommand } from '../../copy-command';
import { formatRelativeTime } from '../../relative-time';
import { downloadCsv } from '../../stats/csv-download';
import { daemonView, healthProblems, type DaemonView } from '../../stats/daemon-view';
import type { SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelRuns } from '../../stats/sentinel-runs';
import { SentinelTelemetry, type TelemetryUpdate } from '../../stats/sentinel-telemetry';
import { StatsSession } from '../../stats/stats-session';
import { sessionCsv, sessionCsvFilename, type OverviewCardId } from '../../stats/telemetry';
import { CompareView } from './compare-view';
import { MetricsTable } from './metrics-table';
import { overviewCards } from './overview-cards';
import { RecordTrace } from './record-trace';
import { RunPanel } from './run-panel';
import { RunsView } from './runs-view';
import { SentinelFailureCallout } from './sentinel-failure-callout';
import { StatsAreaPanel } from './stats-area-panel';
import { StatsChart } from './stats-chart';

/**
 * What stands in the page, the first that applies: the board could not be read, no board is
 * selected, Sentinel is being checked, the view (Sentinel answers, or answered on this board), or
 * Sentinel is not ready. The same for every view.
 */
type Body = 'read-failed' | 'no-target' | 'checking' | 'ready' | 'not-ready';

/** The page's views, each at its own address under `/stats`. */
type StatsView = 'live' | 'runs' | 'compare';

/** The view an address names: `/stats/runs/compare` is Compare, `/stats/runs` Runs, the rest Live. */
function statsView(url: UrlTree): StatsView {
  const [, view, deeper] = url.root.children[PRIMARY_OUTLET]?.segments ?? [];
  if (view?.path !== 'runs') return 'live';
  return deeper?.path === 'compare' ? 'compare' : 'runs';
}

const UPDATE_CHIPS: Record<TelemetryUpdate, { label: string; tone: NeatTone }> = {
  live: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: 'neutral' },
  stopped: { label: 'Not updating', tone: 'warning' },
};

/** The status line for screen readers. */
const UPDATE_ANNOUNCEMENTS: Record<TelemetryUpdate, string> = {
  live: 'Metrics are updating live.',
  paused: 'Metric updates are paused.',
  stopped: 'Metric updates are stopped.',
};

/** Whether a failure is the board's own, which its settings fix; `no_target` is a page state of its own. */
const boardCoded = (failure: SentinelFailure | null): failure is SentinelFailure =>
  failure !== null && failure.board && failure.code !== 'no_target';

/**
 * Why Sentinel is not ready, as the empty state's heading and tone. Missing asks the user to
 * install it on the board, stopped needs a hand on the board, and anything else (a daemon that
 * does not answer, or answers nothing Insight reads) is the failure's own title, a fault.
 */
function notReadyHeading(
  failure: SentinelFailure | null,
  daemon: DaemonView,
  label: string,
): { heading: string; tone: NeatTone } {
  if (daemon.state === 'missing') {
    return { heading: `Sentinel is not installed on ${label}`, tone: 'info' };
  }
  if (daemon.state === 'stopped') {
    return { heading: 'Sentinel is installed but stopped', tone: 'warning' };
  }
  return { heading: failure?.title ?? 'Sentinel is not answering', tone: 'danger' };
}

/**
 * Stats, in three views at their own addresses: Live (`/stats`), the selected board's live
 * Sentinel telemetry as overview cards, the chosen card's area in the side panel and every metric
 * under All metrics; Runs (`/stats/runs`), the runs saved on the board; and Compare
 * (`/stats/runs/compare`). The views are child routes without components, so the page stays one
 * instance across them. `SentinelTelemetry` and `SentinelRuns` are provided here, so leaving the
 * page stops every request to the board; while Live is not shown the metrics are not polled, and
 * the run list is read only while Runs or Compare is. Where the user left the page belongs to
 * `StatsSession`. A trace can be recorded and stopped from the toolbar on every view.
 *
 * Insight installs and starts nothing on the board: where Sentinel is missing or stopped, the
 * page shows the command the server's hint names, with Copy, and Check again asks once more.
 *
 * Telemetry once read stays on the page under whatever failure follows: a board that stops
 * answering keeps its last values. The top bar's update state and its Pause, Resume or Retry are
 * about those values, so they show only with them.
 */
@Component({
  selector: 'app-stats-page',
  imports: [
    Announcement,
    BoardProblemNotice,
    BoardSettingsAction,
    CompareView,
    CopyCommand,
    MetricsTable,
    NeatAsidePanel,
    NeatAsideToggle,
    NeatButton,
    NeatCallout,
    NeatChartCard,
    NeatCollapsible,
    NeatIcon,
    NeatNote,
    NeatPage,
    NeatPageToolbar,
    NeatPopover,
    NeatPopoverContent,
    NeatPopoverItem,
    NeatPopoverTrigger,
    NeatStatusChip,
    NeatTooltip,
    NgTemplateOutlet,
    RecordTrace,
    RunPanel,
    RunsView,
    SentinelFailureCallout,
    StatsAreaPanel,
    StatsChart,
  ],
  providers: [SentinelTelemetry, SentinelRuns],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stats.page.html',
  styleUrl: './stats.page.css',
})
export class StatsPage {
  protected readonly board = inject(BoardService);
  protected readonly telemetry = inject(SentinelTelemetry);
  private readonly runs = inject(SentinelRuns);
  private readonly router = inject(Router);
  private readonly session = inject(StatsSession);
  private readonly dialogs = inject(AppDialogs);
  private readonly document = inject(DOCUMENT);
  protected readonly asides = inject(AsidePrefs);
  protected readonly asideOpen = computed(() => this.asides.open('stats'));

  /** For "Session started … ago", which moves in steps of 10 s and more. */
  private readonly now = ticking(10_000);

  /** The view the address names, followed as the router moves between the views. */
  protected readonly view = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => statsView(this.router.parseUrl(this.router.url))),
    ),
    { initialValue: statsView(this.router.parseUrl(this.router.url)) },
  );

  protected readonly moreOpen = signal(false);
  /** All metrics starts closed on every visit; its table is built only while it is open. */
  protected readonly allMetricsOpen = signal(false);

  private readonly daemon = computed(() =>
    daemonView(this.telemetry.state(), this.telemetry.stateFailure()),
  );

  /**
   * Telemetry is shown while Sentinel answers, or once a window of this board was read: a daemon
   * that stops answering then leaves its last values on screen under the failure.
   */
  private readonly telemetryShown = computed(
    () => this.telemetry.ready() || this.telemetry.window()?.board === this.board.id(),
  );

  protected readonly body = computed<Body>(() => {
    const board = this.board.state();
    // Until the board is first read, Insight is still finding out what there is to check.
    if (board === null) return this.board.error() ? 'read-failed' : 'checking';
    if (board.selected === null) return 'no-target';
    if (this.telemetryShown()) return 'ready';
    // Before the first state read has answered (a hidden tab sends it when it shows), it checks.
    const read = this.telemetry.state() !== null || this.telemetry.stateFailure() !== null;
    return this.telemetry.checking() || !read ? 'checking' : 'not-ready';
  });

  /** What the state says is wrong: why the newest health read failed. */
  private readonly stateProblem = computed(() => this.telemetry.stateFailure());

  /**
   * The board's own failure over the telemetry, the state's or the metrics'. The state's counts
   * only while the metrics are not updating: a poll answered since says the board answers.
   */
  protected readonly boardFailure = computed(() => {
    const state = this.telemetry.update() === 'live' ? null : this.stateProblem();
    return [state, this.telemetry.failure()].find(boardCoded) ?? null;
  });

  /**
   * The callout over the telemetry when the board's notice does not stand there: why the last poll
   * failed, else why the state says Sentinel cannot be used. A state read can stop the polling with
   * no poll failing (after Resume, on focus, or on the 30 s check), and the values on screen must
   * not stop changing without a reason.
   */
  protected readonly telemetryProblem = computed(() => {
    const failure = this.telemetry.failure();
    if (failure) return failure;
    return this.telemetry.ready() ? null : this.stateProblem();
  });

  protected readonly collectorErrors = computed(() =>
    healthProblems(this.telemetry.state()?.health ?? null),
  );

  protected readonly cards = computed(() => {
    const window = this.telemetry.window();
    return window ? overviewCards(window) : [];
  });

  /** The chosen card, while the panel shows its area. */
  protected readonly selectedCard = computed(() => (this.asideOpen() ? this.session.card() : null));
  /**
   * The panel's area: the chosen card's while this board shows that card, Thermal before any is
   * chosen and after a switch to a board without it (a board with no power metrics has no Power
   * area to show).
   */
  protected readonly area = computed(
    () => this.cards().find((view) => view.card.id === this.session.card())?.card.area ?? 'thermal',
  );
  /**
   * The panel is about what the view shows (the chosen card's area on Live, the selected run on
   * Runs), so it is shown only with it; Compare takes the full width.
   */
  protected readonly asideShown = computed(
    () => this.asideOpen() && this.body() === 'ready' && this.view() !== 'compare',
  );

  /** Runs is a list page: the list scrolls its rows, the page nothing (a body state scrolls). */
  protected readonly listShown = computed(() => this.body() === 'ready' && this.view() === 'runs');

  /**
   * The run the panel shows on Runs, as a list of none or one, so that the panel is built afresh
   * for each run: its listed summary, or null while the list is being read (`listed` false, and
   * `failed` once its read failed: the view says why) or once the run is no longer on the board.
   */
  protected readonly selectedRuns = computed(() => {
    const id = this.session.run();
    if (id === null) return [];
    const listed = this.runs.runs();
    return [
      {
        id,
        run: listed?.find((run) => run.id === id) ?? null,
        listed: listed !== null,
        failed: listed === null && this.runs.runsFailure() !== null,
      },
    ];
  });

  protected readonly updateChip = computed(() => UPDATE_CHIPS[this.telemetry.update()]);

  /**
   * The top bar's button: Pause while live, Resume while paused, Retry where the values stopped on
   * a failure that asking again can help, and none where neither helps: Pause beside Not updating
   * would pause nothing. The chip and the callout say why.
   */
  protected readonly updateAction = computed<'pause' | 'resume' | 'retry' | null>(() => {
    const update = this.telemetry.update();
    if (update === 'live') return 'pause';
    if (update === 'paused') return 'resume';
    return this.telemetry.failure()?.retryable ? 'retry' : null;
  });

  /**
   * The update state as it is said, while the telemetry is shown (on Live, where the metrics are
   * polled: the other views stop them, which is no news either). A hidden tab reads `stopped`
   * (nothing polls) and reads `live` again when it shows: neither is news to anyone. So a change
   * made while the tab is hidden keeps what was said, and the tab coming back says only what
   * differs from it. Computed when the update changes, under the visibility it changed under.
   */
  protected readonly announcement = linkedSignal<string, string>({
    source: () =>
      this.body() === 'ready' && this.view() === 'live'
        ? UPDATE_ANNOUNCEMENTS[this.telemetry.update()]
        : '',
    computation: (said, previous) =>
      previous && this.document.visibilityState !== 'visible' ? previous.value : said,
  });

  protected readonly version = computed(() => this.daemon().version);
  protected readonly sessionStarted = computed(() => {
    const ago = formatRelativeTime(this.daemon().startedAt, this.now());
    return ago ? `Session started ${ago}` : '';
  });

  private readonly sampleCount = computed(() => this.telemetry.window()?.timestamps.length ?? 0);
  protected readonly canExport = computed(() => this.sampleCount() > 0);
  protected readonly exportTooltip = computed(
    () => `Every metric at each of the ${this.sampleCount()} samples Insight read from Sentinel`,
  );

  /** A board-coded state problem while Sentinel is not ready: the board's notice says it. */
  protected readonly notReadyBoardFailure = computed(() => {
    const problem = this.stateProblem();
    return boardCoded(problem) ? problem : null;
  });

  /**
   * The empty state while Sentinel is not ready: its heading and tone, the server's message where
   * the heading does not already say it (a missing or stopped daemon's heading does), its hint, and
   * the command the hint names (installing Sentinel, starting its service), which the user copies
   * and runs on the board; '' when there is none.
   */
  protected readonly notReady = computed(() => {
    const daemon = this.daemon();
    const failure = this.stateProblem();
    return {
      ...notReadyHeading(failure, daemon, this.board.selected()?.label ?? 'this board'),
      message: daemon.state === 'error' ? (failure?.problem.message ?? '') : '',
      hint: failure?.hint ?? '',
      command: daemon.command,
    };
  });

  constructor() {
    // The metrics are polled only while Live shows them; Compare reads the run list too, for its
    // callouts about runs that are gone or still recording.
    effect(() => {
      const view = this.view();
      this.telemetry.setWatching(view === 'live');
      this.runs.setRunsShown(view === 'runs' || view === 'compare');
    });
    // The trace and the runs are read only while the state says Sentinel answers: a missing or
    // stopped daemon would answer each with the failure the page shows already.
    effect(() => this.runs.setSentinelReady(this.telemetry.ready()));
    // The runs selected and ticked are the board's they were chosen on.
    effect(() => {
      const id = this.board.id();
      if (id !== null) untracked(() => this.session.followBoard(id));
    });
  }

  protected openBoard(): void {
    void this.dialogs.openBoard();
  }

  protected openCard(id: OverviewCardId): void {
    this.session.card.set(id);
    this.asides.setOpen('stats', true);
  }

  protected recheck(): void {
    if (!this.telemetry.rechecking()) void this.telemetry.recheck();
  }

  /** Downloads the window as CSV. */
  protected exportCsv(): void {
    const window = this.telemetry.window();
    if (!window || !this.canExport()) return;
    this.moreOpen.set(false);
    downloadCsv(this.document, sessionCsv(window), sessionCsvFilename(new Date()));
  }
}
