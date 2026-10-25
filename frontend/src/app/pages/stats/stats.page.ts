import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
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
import { Announcement } from '../../announcement';
import { AsidePrefs } from '../../aside-prefs';
import { BoardProblemNotice } from '../../board/board-problem-notice';
import { BoardSettingsAction } from '../../board/board-settings-action';
import { BoardService } from '../../board/board.service';
import { ticking } from '../../clock';
import { formatRelativeTime } from '../../relative-time';
import { downloadCsv } from '../../stats/csv-download';
import { daemonView, healthProblems, type DaemonView } from '../../stats/daemon-view';
import { failureOf, type SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelInstall } from '../../stats/sentinel-install';
import { SentinelTelemetry, type TelemetryUpdate } from '../../stats/sentinel-telemetry';
import { StatsSession } from '../../stats/stats-session';
import { sessionCsv, sessionCsvFilename, type OverviewCardId } from '../../stats/telemetry';
import { TopBarDialogs } from '../../top-bar-dialogs';
import { MetricsTable } from './metrics-table';
import { overviewCards } from './overview-cards';
import { StatsAreaPanel } from './stats-area-panel';
import { StatsChart } from './stats-chart';

/**
 * What stands in the page, the first that applies: the board could not be read, no board is
 * selected, Sentinel is being checked, the telemetry, or Sentinel is not ready.
 */
type Body = 'read-failed' | 'no-target' | 'checking' | 'telemetry' | 'not-ready';

const UPDATE_CHIPS: Record<TelemetryUpdate, { label: string; tone: NeatTone }> = {
  live: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: 'neutral' },
  stopped: { label: 'Not updating', tone: 'warning' },
};

/** #170's status line for screen readers (Inv-S §2.4). */
const UPDATE_ANNOUNCEMENTS: Record<TelemetryUpdate, string> = {
  live: 'Metrics are updating live.',
  paused: 'Metric updates are paused.',
  stopped: 'Metric updates are stopped.',
};

/** #170's line while the installer runs (Inv-S §2.3). */
const INSTALLING =
  'Running `sima-cli neat install sentinel` on the board. This downloads and unpacks an artifact and can take several minutes.';

/** Whether a failure is the board's own, which its settings fix; `no_target` is a page state of its own. */
const boardCoded = (failure: SentinelFailure | null): failure is SentinelFailure =>
  failure !== null && failure.board && failure.code !== 'no_target';

/**
 * Why Sentinel is not ready, as the empty state's heading and tone. A failed state read says what
 * failed; otherwise the daemon's state does. Missing is an invitation to install, stopped needs a
 * hand on the board, and a daemon that does not answer (or answers nothing Insight reads) is a
 * fault.
 */
function notReadyHeading(
  failure: SentinelFailure | null,
  daemon: DaemonView,
  label: string,
): { heading: string; tone: NeatTone } {
  if (failure) return { heading: failure.title, tone: 'danger' };
  if (daemon.state === 'missing') {
    return { heading: `Sentinel is not installed on ${label}`, tone: 'info' };
  }
  if (daemon.state === 'stopped') {
    return { heading: 'Sentinel is installed but stopped', tone: 'warning' };
  }
  return { heading: 'Sentinel is not answering', tone: 'danger' };
}

/**
 * Stats: the selected board's live Sentinel telemetry as overview cards, the chosen card's area in
 * the side panel and every metric under All metrics (spec, "Stats, live telemetry").
 * `SentinelTelemetry` is provided here, so leaving the page stops every request to the board; the
 * install belongs to `SentinelInstall`, which outlives the page, and where the user left the panel
 * to `StatsSession`.
 *
 * Telemetry once read stays on the page under whatever failure follows (#170): a board that stops
 * answering keeps its last values. The top bar's update state and its Pause, Resume or Retry are
 * about those values, so they show only with them (ruling F15).
 */
@Component({
  selector: 'app-stats-page',
  imports: [
    Announcement,
    BoardProblemNotice,
    BoardSettingsAction,
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
    StatsAreaPanel,
    StatsChart,
  ],
  providers: [SentinelTelemetry],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stats.page.html',
  styleUrl: './stats.page.css',
})
export class StatsPage {
  protected readonly board = inject(BoardService);
  protected readonly telemetry = inject(SentinelTelemetry);
  protected readonly install = inject(SentinelInstall);
  private readonly session = inject(StatsSession);
  private readonly dialogs = inject(TopBarDialogs);
  private readonly document = inject(DOCUMENT);
  protected readonly asides = inject(AsidePrefs);
  protected readonly asideOpen = computed(() => this.asides.open('stats'));

  /** For "Session started … ago", which moves in steps of 10 s and more. */
  private readonly now = ticking(10_000);

  protected readonly moreOpen = signal(false);
  /** All metrics starts closed on every visit; its table is built only while it is open. */
  protected readonly allMetricsOpen = signal(false);

  private readonly target = computed(() => this.board.state()?.target ?? null);
  private readonly daemon = computed(() => daemonView(this.telemetry.state()));

  /**
   * Telemetry is shown while Sentinel is available, or once a window of this board was read: a
   * daemon that stops answering then leaves its last values on screen under the failure.
   */
  private readonly telemetryShown = computed(
    () =>
      this.telemetry.state()?.available === true ||
      this.telemetry.window()?.generation === this.board.generation(),
  );

  protected readonly body = computed<Body>(() => {
    const board = this.board.state();
    // Until the board is first read, Insight is still finding out what there is to check.
    if (board === null) return this.board.error() ? 'read-failed' : 'checking';
    if (board.target === null) return 'no-target';
    if (this.telemetryShown()) return 'telemetry';
    // Before the first state read has answered (a hidden tab sends it when it shows), it checks.
    const read = this.telemetry.state() !== null || this.telemetry.stateFailure() !== null;
    return this.telemetry.checking() || !read ? 'checking' : 'not-ready';
  });

  /**
   * What the state says is wrong: why the newest read failed, else why the daemon cannot be used
   * (its `status.error`, with the backend's hint or `failureOf`'s fallback for the code).
   */
  private readonly stateProblem = computed(() => {
    const failure = this.telemetry.stateFailure();
    if (failure) return failure;
    const state = this.telemetry.state();
    return state?.status.error ? failureOf(state.status.error, state.generation) : null;
  });

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
   * not stop changing without a reason. An unavailable state always carries its `status.error`.
   */
  protected readonly telemetryProblem = computed(() => {
    const failure = this.telemetry.failure();
    if (failure) return failure;
    return this.telemetry.state()?.available === false ? this.stateProblem() : null;
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
  /** The panel is about the telemetry, so it is shown only with it. */
  protected readonly asideShown = computed(() => this.asideOpen() && this.body() === 'telemetry');

  protected readonly updateChip = computed(() => UPDATE_CHIPS[this.telemetry.update()]);

  /**
   * The top bar's button: Pause while live, Resume while paused, Retry where the values stopped on
   * a failure that asking again can help, and none where neither helps: Pause beside Not updating
   * would pause nothing (Inv-S §13.22). The chip and the callout say why.
   */
  protected readonly updateAction = computed<'pause' | 'resume' | 'retry' | null>(() => {
    const update = this.telemetry.update();
    if (update === 'live') return 'pause';
    if (update === 'paused') return 'resume';
    return this.telemetry.failure()?.retryable ? 'retry' : null;
  });

  /**
   * The update state as it is said, while the telemetry is shown. A hidden tab reads `stopped`
   * (nothing polls) and reads `live` again when it shows: neither is news to anyone. So a change
   * made while the tab is hidden keeps what was said, and the tab coming back says only what
   * differs from it. Computed when the update changes, under the visibility it changed under.
   */
  protected readonly announcement = linkedSignal<string, string>({
    source: () =>
      this.body() === 'telemetry' ? UPDATE_ANNOUNCEMENTS[this.telemetry.update()] : '',
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

  /** The install running, and whether it runs on this board: the backend runs one at a time. */
  protected readonly installing = computed(() => {
    const running = this.install.running();
    if (!running) return null;
    return { here: running.generation === this.board.generation(), label: running.label };
  });

  /**
   * Install waits: an install runs, or the state is read again (after an install, or Check again),
   * so the state held may already be out of date.
   */
  protected readonly installWaits = computed(
    () => this.installing() !== null || this.telemetry.rechecking(),
  );

  /** Another board's install: a press would do nothing, so the button says why (ruling F18). */
  protected readonly installTooltip = computed(() => {
    const installing = this.installing();
    return installing && !installing.here
      ? `Sentinel is being installed on ${installing.label}.`
      : null;
  });

  /** Install is offered for a missing daemon on a board with `sima-cli` (`DaemonView.canInstall`). */
  protected readonly canInstall = computed(() => this.daemon().canInstall);

  /** A board-coded state problem while Sentinel is not ready: the board's notice says it. */
  protected readonly notReadyBoardFailure = computed(() => {
    const problem = this.stateProblem();
    return boardCoded(problem) ? problem : null;
  });

  protected readonly notReady = computed(() => {
    const daemon = this.daemon();
    // Missing and not installable from here: the reason, where the hint would offer the install.
    const blocked = daemon.state === 'missing' && !daemon.canInstall ? daemon.installBlocked : '';
    return {
      ...notReadyHeading(
        this.telemetry.stateFailure(),
        daemon,
        this.target()?.label ?? 'this board',
      ),
      body: this.installing()?.here ? INSTALLING : blocked || this.stateProblem()?.hint || '',
    };
  });

  /** The output of this board's last install: the installer's log, or what its failure attached. */
  protected readonly installerOutput = computed(() => {
    const outcome = this.install.outcome();
    if (!outcome || outcome.generation !== this.board.generation()) return '';
    return outcome.ok ? outcome.log : outcome.failure.detail;
  });

  protected openBoard(): void {
    void this.dialogs.openBoard();
  }

  protected openCard(id: OverviewCardId): void {
    this.session.card.set(id);
    this.asides.setOpen('stats', true);
  }

  protected installSentinel(): void {
    const generation = this.board.generation();
    const label = this.target()?.label;
    if (this.installWaits() || generation === null || !label) return;
    void this.install.install(generation, label);
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
