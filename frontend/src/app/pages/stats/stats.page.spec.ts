import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatIcon, NeatPage, NeatShell, type NeatTone } from '@sima/neat-ui';
import { NeatTimeChart } from '@sima/neat-ui/charts';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { NeatToasts } from '@sima/neat-ui/toast';
import { AppDialogs } from '../../app-dialogs';
import type { BoardTarget } from '../../board/api';
import { problemOf } from '../../board/board-error';
import { BoardService } from '../../board/board.service';
import { boardState, DEVKIT, FakeBoard, FakePeripherals } from '../../board/board.testing';
import { FakeLocalStorage } from '../../fake-storage.testing';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import type { SentinelMetric, SentinelMetrics, SentinelState } from '../../stats/api';
import {
  ACTIVE_TRACE,
  COMPARE_RAW,
  RUNS_LIST,
  runsAnswer,
  SAVED_RUN,
  traceAnswer,
} from '../../stats/runs.testing';
import { SentinelTelemetry } from '../../stats/sentinel-telemetry';
import { StatsSession } from '../../stats/stats-session';
import { METRICS_LIVE, sentinelState, withHistory } from '../../stats/stats.testing';
import {
  boardPowerChart,
  mergeTelemetry,
  metricChart,
  metricsQuery,
  sessionCsv,
  sessionCsvFilename,
  thermalMaxChart,
} from '../../stats/telemetry';
import { StatsPage } from './stats.page';

const STATE_URL = '/api/sentinel';
const METRICS_URL = '/api/sentinel/metrics';
const INSTALL_URL = '/api/sentinel/install';
const TRACES_URL = '/api/sentinel/traces';
const RUNS_URL = '/api/sentinel/runs';
const badGateway = { status: 502, statusText: 'Bad Gateway' };
const GENERATION = METRICS_LIVE.generation;
const OTHER_BOARD: BoardTarget = { ...DEVKIT, host: '192.168.1.30', label: 'sima@192.168.1.30' };

/** The live board's answer with `samples` samples of history, each metric flat at its reading. */
const live = (metrics: SentinelMetrics = METRICS_LIVE, samples = 20): SentinelMetrics =>
  withHistory(metrics, samples);

/** `metrics` without the metrics `drop` names, as a board that does not report them. */
function dropping(metrics: SentinelMetrics, drop: (key: string) => boolean): SentinelMetrics {
  return {
    ...metrics,
    groups: metrics.groups
      .map((group) => ({ ...group, metrics: group.metrics.filter((m) => !drop(m.key)) }))
      .filter((group) => group.metrics.length),
    order: metrics.order.filter((key) => !drop(key)),
  };
}

/** `metrics` with each metric `change` returns something for replaced by that. */
function changing(
  metrics: SentinelMetrics,
  change: (metric: SentinelMetric) => Partial<SentinelMetric> | undefined,
): SentinelMetrics {
  return {
    ...metrics,
    groups: metrics.groups.map((group) => ({
      ...group,
      metrics: group.metrics.map((metric) => ({ ...metric, ...change(metric) })),
    })),
  };
}

/** Sentinel not installed on board `generation`, as `GET /api/sentinel` says it. */
function missingState(generation = GENERATION, simaCli: string | null = '/usr/bin/sima-cli') {
  const running = sentinelState();
  return sentinelState({
    generation,
    available: false,
    version: null,
    status: {
      state: 'missing',
      error: {
        error: 'Sentinel is not installed on this board.',
        code: 'sentinel_missing',
        hint: 'Install it from this page, or run `sima-cli neat install sentinel` on the board.',
      },
    },
    daemon: {
      ...running.daemon,
      installed: false,
      healthy: false,
      service: 'inactive',
      socket: false,
      sima_cli: simaCli,
      instance_id: null,
      started_at: null,
    },
    health: null,
  });
}

/** Sentinel installed but stopped, as `GET /api/sentinel` says it. */
function stoppedState(): SentinelState {
  const missing = missingState();
  return {
    ...missing,
    status: {
      state: 'stopped',
      error: {
        error: 'The simaai-sentinel service is installed but inactive.',
        code: 'sentinel_stopped',
        hint: 'Start it on the board with `sudo systemctl start simaai-sentinel`.',
      },
    },
    daemon: { ...missing.daemon, installed: true },
  };
}

/** A failure body as the backend answers it. */
function failed(code: string, extra: Record<string, unknown> = {}) {
  return { error: `Failed with ${code}.`, code, hint: '', generation: GENERATION, ...extra };
}

/** The app frame, so the page's toolbar has a top bar to render into. */
@Component({
  imports: [NeatShell, RouterOutlet],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"><router-outlet /></neat-shell>`,
})
class Shell {}

@Component({ template: '' })
class Elsewhere {}

describe('StatsPage', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let visibility: DocumentVisibilityState;
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    // The polls and the backoff are timeouts and the state checks and clocks intervals: the test
    // moves them on itself.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(Date.parse('2026-10-24T10:00:40Z'));
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.stubGlobal('localStorage', new FakeLocalStorage());
    // jsdom has no ResizeObserver; the run list watches its width to give up a column, and
    // Compare's tab strips theirs to scroll their tabs.
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
    board.state.set(boardState({ target: DEVKIT, generation: GENERATION }));
    toasts = { status: vi.fn(), error: vi.fn() };
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          {
            path: 'stats',
            component: StatsPage,
            children: [
              { path: '', children: [] },
              { path: 'runs', children: [] },
              { path: 'runs/compare', children: [] },
            ],
          },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        { provide: BoardService, useValue: board },
        { provide: PeripheralsService, useValue: new FakePeripherals() },
        { provide: NeatToasts, useValue: toasts },
        { provide: AppDialogs, useValue: dialogs },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Shell);
  });

  afterEach(() => {
    try {
      fixture.destroy();
      // The trace is read on every visit to a board; the specs about recording answer it, the
      // rest leave it unanswered, which shows Record.
      http.match((request) => request.url === TRACES_URL);
      // Every other request a test caused was answered and checked: a stray poll fails it.
      http.verify();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  const root = (): HTMLElement => fixture.nativeElement;

  /**
   * Lets the requests and promise chains behind an answer run, then renders. The render is run
   * here rather than waited for: a clock that ticks while time is moved on (Runs' "5 min ago")
   * schedules it a fake millisecond later, which moving on by nothing never reaches.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      await fixture.whenStable();
    }
  }

  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  };

  const stateRead = (): TestRequest => http.expectOne((request) => request.url === STATE_URL);
  const metricsPoll = (): TestRequest => http.expectOne((request) => request.url === METRICS_URL);
  const noPoll = () => http.expectNone((request) => request.url === METRICS_URL);

  async function flush(request: TestRequest, body: object, failure = false): Promise<void> {
    request.flush(body, failure ? badGateway : undefined);
    await settle();
  }

  const answerState = (state: SentinelState = sentinelState()) => flush(stateRead(), state);
  const answerMetrics = (answer: SentinelMetrics = live()) => flush(metricsPoll(), answer);

  async function go(url: string): Promise<void> {
    await TestBed.inject(Router).navigateByUrl(url);
    await settle();
  }

  /** Opens Stats on a running Sentinel and answers its first poll with `answer`. */
  async function visit(answer: SentinelMetrics = live()): Promise<void> {
    await go('/stats');
    await answerState();
    await answerMetrics(answer);
  }

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const toolbar = (): HTMLElement => root().querySelector('.page-toolbar')!;
  const toolbarButton = (name: string): HTMLButtonElement | undefined =>
    [...toolbar().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => (button.getAttribute('aria-label') ?? text(button)) === name,
    );
  /** The side-panel toggle: the kit draws it at the top bar's right edge, outside the page tools. */
  const sidePanelToggle = (): HTMLButtonElement | null =>
    root().querySelector<HTMLButtonElement>('header button[aria-label="Side panel"]');
  const chip = (): string => text(toolbar().querySelector('neat-status-chip'));
  /** The page's own status line; Record has its own for the trace it starts. */
  const announcement = (): string =>
    text(
      [...root().querySelectorAll('app-announcement')].find(
        (element) => !element.closest('app-record-trace'),
      ),
    );
  const buttonNamed = (label: string): HTMLButtonElement | undefined =>
    [...root().querySelectorAll<HTMLButtonElement>('neat-page button')].find(
      (button) => text(button) === label,
    );
  const calloutHeadings = (): string[] =>
    [...root().querySelectorAll('neat-page neat-callout [role="heading"]')].map(text);
  const callout = (heading: string): HTMLElement | undefined =>
    [...root().querySelectorAll<HTMLElement>('neat-page neat-callout')].find(
      (element) => text(element.querySelector('[role="heading"]')) === heading,
    );
  const aside = (): HTMLElement | null => root().querySelector('aside');
  const asideTitle = (): string => text(aside()?.querySelector('h2'));
  /** The overview cards; the side panel's Power area has cards of its own. */
  const cards = (): HTMLElement[] => [
    ...root().querySelectorAll<HTMLElement>('.cards > neat-chart-card'),
  ];
  const cardNamed = (heading: string): HTMLElement =>
    cards().find((card) => text(card.querySelector('.heading')) === heading)!;
  /** A card as it reads: heading, value with unit, caption and chip. */
  const cardText = (card: HTMLElement) => ({
    heading: text(card.querySelector('.heading')),
    value: text(card.querySelector('.value')),
    caption: text(card.querySelector('.caption')),
    chip: text(card.querySelector('neat-status-chip')),
  });
  const debugOf = <T>(type: new (...args: never[]) => T, host: Element): T | undefined =>
    fixture.debugElement
      .queryAll(By.directive(type))
      .find((debug) => host.contains(debug.nativeElement))?.componentInstance;
  const chartOf = (card: HTMLElement) => debugOf(NeatTimeChart, card);
  const chipToneOf = (host: Element): NeatTone | undefined => debugOf(NeatStatusChip, host)?.tone();
  const morePanel = () => document.querySelector('[role="dialog"][aria-label="More actions"]');

  /** The tooltip, which the kit shows on focus (with a zero delay). */
  async function tooltip(button: HTMLElement): Promise<string | undefined> {
    // jsdom lays nothing out: give the overlay a viewport and the button a box inside it.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1366);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    button.getBoundingClientRect = () => new DOMRect(1000, 12, 120, 32);
    button.dispatchEvent(new FocusEvent('focus'));
    // Its zero delay is an RxJS timer. Moved on synchronously: moved on asynchronously while a
    // popover is open, the overlays never settle.
    vi.advanceTimersByTime(1);
    await settle();
    return document.querySelector('[role="tooltip"]')?.textContent?.trim();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  it('gives the page its remembered side panel width, and remembers a new one', async () => {
    localStorage.setItem('neat-insight:stats:aside-width', '420');
    await visit();
    const neatPage = fixture.debugElement.query(By.directive(NeatPage))
      .componentInstance as NeatPage;
    expect(neatPage.asideWidth()).toBe(420);

    neatPage.asideWidth.set(380);
    expect(localStorage.getItem('neat-insight:stats:aside-width')).toBe('380');

    neatPage.asideWidth.set(null);
    expect(localStorage.getItem('neat-insight:stats:aside-width')).toBeNull();
  });

  it('shows the six overview cards with their values, units and charts for the live board', async () => {
    await visit();

    expect(cards().map(cardText)).toEqual([
      {
        heading: 'Thermal max',
        value: '66.3 °C',
        caption: 'Hottest sensor: Board LM96-2',
        chip: '',
      },
      { heading: 'Board power', value: '11.6 W', caption: '', chip: '' },
      { heading: 'CPU usage', value: '37.5 %', caption: '', chip: '' },
      { heading: 'Linux memory', value: '21.3 %', caption: '', chip: '' },
      { heading: 'MLA memory', value: '742 MB', caption: '', chip: '' },
      { heading: 'Network', value: '2.82 MB/s', caption: '', chip: '' },
    ]);
    // The unit is the card's own part, after the value.
    expect(text(cardNamed('Board power').querySelector('.unit'))).toBe('W');

    // Each card draws its chart headless and medium, built as the side panel builds it.
    const window = mergeTelemetry(null, live());
    for (const card of cards()) {
      const chart = chartOf(card)!;
      expect(chart.label()).toBe(cardText(card).heading);
      expect(chart.headless()).toBe(true);
      expect(chart.size()).toBe('medium');
      // A card's plot is small: its lines and time axis without the values that would crowd it.
      expect(chart.valueLabels()).toBe(false);
      expect(chart.times()).toEqual(window.times);
    }
    const thermal = chartOf(cardNamed('Thermal max'))!;
    expect(thermal.series()).toEqual(thermalMaxChart(window)!.series);
    expect(thermal.thresholds().map((line) => line.value)).toEqual([70, 85]);
    expect(thermal.domain()).toEqual([40, 90]);
    const power = chartOf(cardNamed('Board power'))!;
    expect(power.domain()).toEqual(boardPowerChart(window)!.domain);
    expect(power.reference()).toEqual(boardPowerChart(window)!.reference);
    const cpu = chartOf(cardNamed('CPU usage'))!;
    expect(cpu.series()).toEqual(metricChart(window, 'cpu_usage_pct')!.series);
    expect(cpu.domain()).toEqual([0, 100]);
    expect(cpu.thresholds().map((line) => line.value)).toEqual([80, 95]);
    expect(
      chartOf(cardNamed('Network'))!
        .series()
        .map((series) => series.label),
    ).toEqual(['Receive', 'Transmit']);

    expect(chip()).toBe('Live');
    expect(chipToneOf(toolbar())).toBe('success');
    expect(announcement()).toBe('Metrics are updating live.');
  });

  it('a card whose metric is not reported says Not reported and still opens its area; a card whose area has no metrics is hidden', async () => {
    const answer = dropping(
      METRICS_LIVE,
      (key) => key === 'mla_mem_allocated_mb' || key.startsWith('power_'),
    );
    await visit(live(answer));

    // Without any power metric there is no Power area to open, so no Board power card.
    expect(cards().map((card) => cardText(card).heading)).toEqual([
      'Thermal max',
      'CPU usage',
      'Linux memory',
      'MLA memory',
      'Network',
    ]);
    const mla = cardNamed('MLA memory');
    expect(cardText(mla).value).toBe('Not reported');
    expect(mla.querySelector('.unit')).toBeNull();
    expect(chartOf(mla)).toBeUndefined();

    await click(mla.querySelector<HTMLButtonElement>('button.activator')!);
    expect(asideTitle()).toBe('System');
  });

  it('cards past a threshold carry Warning or Critical; Thermal max counts its alerts and names the hottest sensor', async () => {
    const answer = changing(METRICS_LIVE, (metric) => {
      switch (metric.key) {
        case 'cpu_usage_pct':
          return { status: 'warn' };
        case 'linux_mem_used_pct':
          return { status: 'critical' };
        case 'net_rx_mbps':
          return { status: 'critical' };
        case 'net_tx_mbps':
          return { status: 'warn' };
        case 'rtsn_0':
          return { value: 74, status: 'warn' };
        case 'rtsn_1':
          return { value: 78, status: 'warn' };
        default:
          return undefined;
      }
    });
    await visit(live(answer));

    const chips = cards().map((card) => [cardText(card).heading, cardText(card).chip]);
    expect(chips).toEqual([
      ['Thermal max', '2 warnings'],
      ['Board power', ''],
      ['CPU usage', 'Warning'],
      ['Linux memory', 'Critical'],
      ['MLA memory', ''],
      // Network takes the worse of its two.
      ['Network', 'Critical'],
    ]);
    expect(chipToneOf(cardNamed('Thermal max'))).toBe('warning');
    expect(chipToneOf(cardNamed('CPU usage'))).toBe('warning');
    expect(chipToneOf(cardNamed('Linux memory'))).toBe('danger');
    expect(chipToneOf(cardNamed('Network'))).toBe('danger');

    const thermal = cardText(cardNamed('Thermal max'));
    expect(thermal.value).toBe('78 °C');
    expect(thermal.caption).toBe('Hottest sensor: MLA MLA-1');
    expect(chartOf(cardNamed('Thermal max'))!.tone()).toBe('warning');
  });

  it('clicking a card opens the panel on its area and marks it; the panel shows Thermal before any card is chosen', async () => {
    await visit();
    const marked = () =>
      cards()
        .filter((card) => card.querySelector('button.activator')!.getAttribute('aria-current'))
        .map((card) => cardText(card).heading);

    // The side panel is open until the user closes it; with no card chosen it shows Thermal.
    expect(aside()?.querySelector('section')?.getAttribute('aria-label')).toBe('Stats area');
    expect(asideTitle()).toBe('Thermal');
    expect(marked()).toEqual([]);

    await click(cardNamed('Board power').querySelector<HTMLButtonElement>('button.activator')!);
    expect(asideTitle()).toBe('Power');
    expect(marked()).toEqual(['Board power']);

    // Closed, the panel marks no card; a click on the card itself opens it on that card's area.
    await click(sidePanelToggle()!);
    expect(aside()).toBeNull();
    expect(marked()).toEqual([]);
    await click(cardNamed('CPU usage'));
    expect(asideTitle()).toBe('System');
    expect(marked()).toEqual(['CPU usage']);
    expect(localStorage.getItem('neat-insight:stats:aside')).toBe('open');
  });

  it('a click on a card’s chart opens its area, and the side panel keeps its charts’ value labels', async () => {
    await visit();
    const plot = cardNamed('Network').querySelector<HTMLElement>('neat-time-chart .plot')!;
    expect(plot.getAttribute('tabindex')).toBe('0');

    await click(plot);
    expect(asideTitle()).toBe('Storage & Network');
    expect(
      cardNamed('Network').querySelector('button.activator')!.getAttribute('aria-current'),
    ).toBe('true');
    const panelCharts = fixture.debugElement
      .queryAll(By.directive(NeatTimeChart))
      .filter((debug) => aside()!.contains(debug.nativeElement))
      .map((debug) => debug.componentInstance as NeatTimeChart);
    expect(panelCharts.length).toBeGreaterThan(0);
    expect(panelCharts.every((chart) => chart.valueLabels())).toBe(true);
  });

  it('without a board, Choose a board opens the board dialog', async () => {
    board.state.set(boardState({ target: null, generation: 2 }));
    await go('/stats');

    expect(calloutHeadings()).toEqual(['Select a board to see its telemetry']);
    expect(text(callout('Select a board to see its telemetry'))).toContain(
      'Stats shows the live telemetry SiMa Sentinel reads on the selected board.',
    );
    await click(buttonNamed('Choose a board')!);
    expect(dialogs.openBoard).toHaveBeenCalledOnce();
    // Nothing is asked of a board that is not there, and the top bar has no update state.
    http.expectNone((request) => request.url.startsWith(STATE_URL));
    expect(toolbar().querySelector('neat-status-chip')).toBeNull();
    expect(toolbarButton('Pause')).toBeUndefined();
    expect(toolbarButton('More actions')).toBeDefined();
    expect(aside()).toBeNull();
  });

  it('a board that cannot be read says why, with Open board settings', async () => {
    board.state.set(null);
    board.error.set(
      problemOf({ error: 'Could not reach the Insight server.', code: 'network', hint: '' }),
    );
    await go('/stats');

    const notice = root().querySelector('app-board-problem-notice');
    expect(text(notice)).toContain('Could not reach the Insight server.');
    expect(notice?.querySelector('app-board-settings-action')).not.toBeNull();
    http.expectNone((request) => request.url.startsWith(STATE_URL));
  });

  it('says it is checking Sentinel until the first state read answers, with no update state', async () => {
    await go('/stats');
    const note = root().querySelector('neat-page p[role="status"]');
    expect(text(note)).toBe('Checking Sentinel on the board…');
    expect(toolbar().querySelector('neat-status-chip')).toBeNull();
    expect(toolbarButton('Pause')).toBeUndefined();
    // The side panel is about the telemetry: no toggle for a panel that is not there.
    expect(sidePanelToggle()).toBeNull();

    await answerState();
    expect(root().querySelector('neat-page p[role="status"]')).toBeNull();
    expect(sidePanelToggle()).not.toBeNull();
    // Telemetry is shown from here; the cards wait for the first reading.
    expect(text(root().querySelector('neat-page'))).toContain(
      'Waiting for the first reading from Sentinel…',
    );
    expect(chip()).toBe('Live');
    await answerMetrics();
    expect(cards()).toHaveLength(6);
  });

  it('Sentinel missing with sima-cli offers Install Sentinel; without it, Check again with the reason', async () => {
    await go('/stats');
    await answerState(missingState());

    const empty = callout('Sentinel is not installed on sima@192.168.1.20')!;
    expect(empty).toBeDefined();
    expect(text(empty)).toContain(
      'Install it from this page, or run `sima-cli neat install sentinel` on the board.',
    );
    expect(buttonNamed('Install Sentinel')).toBeDefined();
    expect(buttonNamed('Check again')).toBeUndefined();
    // Not ready: no update state, no cards, no side panel and no toggle for it.
    expect(toolbar().querySelector('neat-status-chip')).toBeNull();
    expect(toolbarButton('Pause')).toBeUndefined();
    expect(cards()).toHaveLength(0);
    expect(aside()).toBeNull();
    expect(sidePanelToggle()).toBeNull();
    noPoll();

    await go('/elsewhere');
    await go('/stats');
    await answerState(missingState(GENERATION, null));
    const blocked = callout('Sentinel is not installed on sima@192.168.1.20')!;
    expect(text(blocked)).toContain(
      'sima-cli was not found on the board, so Insight cannot install Sentinel from here.',
    );
    expect(text(blocked)).not.toContain('Install it from this page');
    expect(buttonNamed('Install Sentinel')).toBeUndefined();

    // Check again asks the board's service manager again, and says so while it does.
    await click(buttonNamed('Check again')!);
    const recheck = stateRead();
    expect(recheck.request.params.get('refresh')).toBe('1');
    expect(buttonNamed('Checking…')?.getAttribute('aria-disabled')).toBe('true');
    await flush(recheck, missingState(GENERATION, null));
    expect(buttonNamed('Check again')).toBeDefined();
  });

  it('a stopped daemon gets its own heading and hint, and Check again rather than Install', async () => {
    await go('/stats');
    await answerState(stoppedState());

    const empty = callout('Sentinel is installed but stopped')!;
    expect(text(empty)).toContain(
      'Start it on the board with `sudo systemctl start simaai-sentinel`.',
    );
    expect(buttonNamed('Check again')).toBeDefined();
    expect(buttonNamed('Install Sentinel')).toBeUndefined();
  });

  it('installing shows Installing… and #170’s line, and still does after leaving and coming back', async () => {
    const line =
      'Running `sima-cli neat install sentinel` on the board. This downloads and unpacks an artifact and can take several minutes.';
    await go('/stats');
    await answerState(missingState());

    await click(buttonNamed('Install Sentinel')!);
    const post = http.expectOne((request) => request.url === INSTALL_URL);
    expect(post.request.method).toBe('POST');
    expect(post.request.params.get('generation')).toBe(String(GENERATION));
    const installing = () => buttonNamed('Installing…');
    expect(installing()?.getAttribute('aria-disabled')).toBe('true');
    expect(text(root().querySelector('neat-page'))).toContain(line);
    // A second press while it runs sends nothing.
    await click(installing()!);
    http.expectNone((request) => request.url === INSTALL_URL);

    await go('/elsewhere');
    await go('/stats');
    await answerState(missingState());
    expect(installing()?.getAttribute('aria-disabled')).toBe('true');
    expect(text(root().querySelector('neat-page'))).toContain(line);

    // It ends: the toast says so, and the page reads the daemon again and polls.
    await flush(post, {
      board: METRICS_LIVE.board,
      generation: GENERATION,
      daemon: sentinelState().daemon,
      log: 'Sentinel installed.',
    });
    expect(toasts.status).toHaveBeenCalledWith('Sentinel installed on sima@192.168.1.20.');
    const recheck = stateRead();
    expect(recheck.request.params.get('refresh')).toBe('1');
    // Until that read answers, the state held is the one from before the install: Install is not
    // offered again, and the installer's output stays.
    expect(buttonNamed('Install Sentinel')).toBeUndefined();
    const checking = buttonNamed('Checking…')!;
    expect(checking.getAttribute('aria-disabled')).toBe('true');
    expect(root().querySelector('neat-page .empty')?.getAttribute('aria-busy')).toBe('true');
    const output = [...root().querySelectorAll('neat-collapsible')].find((section) =>
      text(section).startsWith('Installer output'),
    );
    expect(output?.querySelector('pre')?.textContent).toBe('Sentinel installed.');
    await click(checking);
    http.expectNone((request) => request.url === INSTALL_URL);
    await flush(recheck, sentinelState());
    await answerMetrics();
    expect(cards()).toHaveLength(6);
  });

  it('a board that stops answering keeps its cards under the failure, never says Sentinel is not installed, and the top bar says Not updating with Retry', async () => {
    await visit();

    await advance(2000);
    await flush(
      metricsPoll(),
      failed('unreachable', { error: 'Could not connect to sima@192.168.1.20.' }),
      true,
    );
    // The poll's failure halts polling and re-reads the state, which fails the same way.
    await flush(
      stateRead(),
      failed('unreachable', { error: 'Could not connect to sima@192.168.1.20.' }),
      true,
    );

    expect(cards()).toHaveLength(6);
    expect(cardText(cardNamed('CPU usage')).value).toBe('37.5 %');
    const notice = root().querySelector('app-board-problem-notice')!;
    expect(text(notice)).toContain('Could not connect to sima@192.168.1.20.');
    expect(notice.querySelector('app-board-settings-action')).not.toBeNull();
    // The failure stands above the cards.
    expect(
      notice.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(text(root().querySelector('neat-page'))).not.toContain('not installed');
    expect(chip()).toBe('Not updating');
    expect(chipToneOf(toolbar())).toBe('warning');
    expect(toolbarButton('Pause')).toBeUndefined();
    expect(announcement()).toBe('Metric updates are stopped.');

    await click(toolbarButton('Retry')!);
    await answerMetrics(
      withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
    );
    expect(chip()).toBe('Live');
    expect(toolbarButton('Pause')).toBeDefined();
    expect(root().querySelector('app-board-problem-notice')).toBeNull();
  });

  it('a failed poll of Sentinel itself shows its title, message and hint, with Retry', async () => {
    await visit();
    await advance(2000);
    await flush(metricsPoll(), failed('sentinel_failed'), true);

    const failure = callout('Sentinel could not answer')!;
    expect(text(failure)).toContain('Failed with sentinel_failed.');
    expect(text(failure)).toContain('Check `systemctl status simaai-sentinel` on the board.');
    expect(chipToneOf(failure)).toBeUndefined();
    expect(cards()).toHaveLength(6);
    expect(toolbarButton('Retry')).toBeDefined();

    // Retry polls at once rather than after the backoff.
    await click(failure.querySelector<HTMLButtonElement>('button')!);
    await answerMetrics(
      withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
    );
    expect(callout('Sentinel could not answer')).toBeUndefined();
  });

  it('the top bar offers no button where neither pausing nor asking again helps (Inv-S §13.22)', async () => {
    await visit();
    await advance(2000);
    // A refused key: only the board's settings fix it, and its state read fails the same way.
    await flush(metricsPoll(), failed('auth_failed'), true);
    await flush(stateRead(), failed('auth_failed'), true);

    expect(chip()).toBe('Not updating');
    expect(cards()).toHaveLength(6);
    expect(toolbarButton('Pause')).toBeUndefined();
    expect(toolbarButton('Resume')).toBeUndefined();
    expect(toolbarButton('Retry')).toBeUndefined();
  });

  it('a state read that stops the polling shows its reason over the cards, and Retry reads the state again', async () => {
    await visit();
    // The window regains focus and the state says the daemon stopped, before any poll failed.
    window.dispatchEvent(new Event('focus'));
    await answerState(stoppedState());

    expect(chip()).toBe('Not updating');
    expect(cards()).toHaveLength(6);
    const stopped = callout('The Sentinel service is stopped')!;
    expect(text(stopped)).toContain('The simaai-sentinel service is installed but inactive.');
    expect(text(stopped)).toContain(
      'Start it on the board with `sudo systemctl start simaai-sentinel`.',
    );
    expect(
      stopped.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // No poll failed, so the top bar has nothing to retry; the callout's Retry asks the board.
    expect(toolbarButton('Pause')).toBeUndefined();
    expect(toolbarButton('Retry')).toBeUndefined();
    noPoll();

    await click(stopped.querySelector<HTMLButtonElement>('button')!);
    const read = stateRead();
    expect(read.request.params.get('refresh')).toBe('1');
    await flush(read, sentinelState());
    await answerMetrics(
      withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
    );
    expect(chip()).toBe('Live');
    expect(callout('The Sentinel service is stopped')).toBeUndefined();
  });

  it('after a board switch the panel shows Thermal when the chosen card is not on the new board', async () => {
    await visit();
    await click(cardNamed('Board power').querySelector<HTMLButtonElement>('button.activator')!);
    expect(asideTitle()).toBe('Power');

    board.state.set(boardState({ target: OTHER_BOARD, generation: GENERATION + 1 }));
    await settle();
    await answerState(sentinelState({ generation: GENERATION + 1 }));
    const unpowered = dropping(METRICS_LIVE, (key) => key.startsWith('power_'));
    await answerMetrics({ ...live(unpowered), generation: GENERATION + 1 });

    expect(cards().map((card) => cardText(card).heading)).not.toContain('Board power');
    expect(asideTitle()).toBe('Thermal');
  });

  it('an install outcome for another board is not shown', async () => {
    await go('/stats');
    await answerState(missingState());
    await click(buttonNamed('Install Sentinel')!);
    const post = http.expectOne((request) => request.url === INSTALL_URL);

    // Another board is selected while the install runs on the first.
    board.state.set(boardState({ target: OTHER_BOARD, generation: GENERATION + 1 }));
    await settle();
    await answerState(missingState(GENERATION + 1));
    expect(callout('Sentinel is not installed on sima@192.168.1.30')).toBeDefined();
    const install = buttonNamed('Install Sentinel')!;
    expect(install.getAttribute('aria-disabled')).toBe('true');
    expect(text(root().querySelector('neat-page'))).not.toContain('Running `sima-cli');
    expect(await tooltip(install)).toBe('Sentinel is being installed on sima@192.168.1.20.');
    await click(install);
    http.expectNone((request) => request.url === INSTALL_URL);

    // The first board's install fails: its output is that board's, not this one's.
    await flush(
      post,
      failed('sentinel_failed', { error: 'The installer failed.', detail: 'E: no artifact' }),
      true,
    );
    expect(toasts.error).toHaveBeenCalledWith('The installer failed.');
    expect(text(root().querySelector('neat-page'))).not.toContain('Installer output');
    expect(buttonNamed('Install Sentinel')?.getAttribute('aria-disabled')).toBeNull();

    // Back on the first board, its outcome shows.
    board.state.set(boardState({ target: DEVKIT, generation: GENERATION }));
    await settle();
    await answerState(missingState());
    const output = [...root().querySelectorAll('neat-collapsible')].find((section) =>
      text(section).startsWith('Installer output'),
    );
    expect(output?.querySelector('pre')?.textContent).toBe('E: no artifact');
  });

  it('collector errors show as a callout above the cards', async () => {
    await go('/stats');
    const state = sentinelState();
    await answerState({
      ...state,
      health: {
        ...state.health!,
        errors: ['power: INA231 not found', { error: 'thermal: read failed' }, null],
      },
    });
    await answerMetrics();

    const errors = callout('Sentinel reported collector errors')!;
    expect([...errors.querySelectorAll('li')].map(text)).toEqual([
      'power: INA231 not found',
      'thermal: read failed',
    ]);
    expect(chipToneOf(errors)).toBeUndefined();
    expect(
      errors.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('Pause and Resume switch the chip and the announcement', async () => {
    await visit();
    const iconOf = (button: HTMLElement) => debugOf(NeatIcon, button)?.name();
    expect(iconOf(toolbarButton('Pause')!)).toBe('pause');

    await click(toolbarButton('Pause')!);
    expect(chip()).toBe('Paused');
    expect(chipToneOf(toolbar())).toBe('neutral');
    expect(announcement()).toBe('Metric updates are paused.');
    expect(iconOf(toolbarButton('Resume')!)).toBe('play');
    await advance(4000);
    noPoll();

    await click(toolbarButton('Resume')!);
    await answerMetrics(
      withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
    );
    expect(chip()).toBe('Live');
    expect(announcement()).toBe('Metrics are updating live.');
    expect(toolbarButton('Pause')).toBeDefined();
  });

  it('a hidden tab’s stop and return are not announced', async () => {
    await visit();
    expect(announcement()).toBe('Metrics are updating live.');

    setVisibility('hidden');
    await settle();
    expect(announcement()).toBe('Metrics are updating live.');

    // Back: the state and the metrics are read at once, and nothing changed that was heard.
    setVisibility('visible');
    await settle();
    await answerState();
    await answerMetrics(
      withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
    );
    expect(announcement()).toBe('Metrics are updating live.');
  });

  it('the ⋯ menu names the Sentinel version and session start, and Export CSV downloads the session', async () => {
    // The first answer holds no samples yet.
    await visit(live(METRICS_LIVE, 0));
    await click(toolbarButton('More actions')!);
    const panel = () => morePanel() as HTMLElement;
    const notes = () => [...panel().querySelectorAll('[neatNote]')].map(text);
    const exportButton = () =>
      [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => text(button) === 'Export CSV',
      )!;
    expect(notes()).toEqual(['Sentinel main:80ab7de4da31', 'Session started 30 min ago']);
    expect(exportButton().disabled).toBe(true);
    // A ⋯ menu's item is the kit's menu row alone: a button's classes would fight the row look.
    expect(exportButton().getAttribute('data-slot')).toBeNull();

    // The facts age (in a hidden tab, so that nothing is read meanwhile).
    await click(toolbarButton('More actions')!);
    setVisibility('hidden');
    await advance(60_000);
    setVisibility('visible');
    await settle();
    await answerState();
    const answer = live();
    await answerMetrics(answer);
    await click(toolbarButton('More actions')!);
    expect(notes()).toEqual(['Sentinel main:80ab7de4da31', 'Session started 31 min ago']);
    expect(exportButton().disabled).toBe(false);
    expect(await tooltip(exportButton())).toBe(
      'Every metric at each of the 20 samples Insight read from Sentinel',
    );

    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:session';
    });
    const revokeObjectURL = vi.fn();
    const { createObjectURL: create, revokeObjectURL: revoke } = URL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    onTestFinished(() => {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    });
    const downloads: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, download: this.download });
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
    await click(exportButton());

    expect(downloads).toEqual([{ href: 'blob:session', download: sessionCsvFilename(new Date()) }]);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:session');
    expect(blobs[0].type).toBe('text/csv');
    // jsdom reads a Blob on a timer.
    vi.useRealTimers();
    expect(await blobs[0].text()).toBe(sessionCsv(mergeTelemetry(null, answer)));
  });

  it('All metrics is closed and, opened, lists every metric in Sentinel order', async () => {
    await visit();
    const section = [...root().querySelectorAll('neat-page neat-collapsible')].find((element) =>
      text(element).startsWith('All metrics'),
    )!;
    const trigger = section.querySelector<HTMLButtonElement>('button')!;
    expect(text(trigger)).toMatch(/^All metrics\s*59 metrics$/);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // Closed, its table is not built: 59 sparklines redrawn on every poll for nobody.
    expect(section.querySelector('app-metrics-table')).toBeNull();

    await click(trigger);
    const table = section.querySelector('app-metrics-table table')!;
    expect(table.getAttribute('aria-label')).toBe('All metrics');
    const names = [...table.querySelectorAll('tbody th')].map(text);
    const shorts = new Map(
      METRICS_LIVE.groups.flatMap((group) => group.metrics).map((m) => [m.key, m.short]),
    );
    expect(names).toEqual(METRICS_LIVE.order.map((key) => shorts.get(key)));
  });

  describe('views', () => {
    /** The view drawn: each has a part of its own, Live its cards. */
    const drawn = (): string[] =>
      [
        cards().length > 0 ? 'live' : null,
        root().querySelector('app-stats-runs') ? 'runs' : null,
        root().querySelector('app-stats-compare') ? 'compare' : null,
      ].filter((view): view is string => view !== null);
    const telemetryOf = (): SentinelTelemetry =>
      fixture.debugElement.query(By.directive(StatsPage)).injector.get(SentinelTelemetry);
    const runsRead = (): TestRequest => http.expectOne((request) => request.url === RUNS_URL);

    it('the view follows the address: /stats is Live, /stats/runs Runs, /stats/runs/compare Compare', async () => {
      await visit();
      expect(drawn()).toEqual(['live']);
      expect(cards()).toHaveLength(6);

      await go('/stats/runs');
      await flush(runsRead(), runsAnswer());
      expect(drawn()).toEqual(['runs']);

      await go('/stats/runs/compare?runs=a,b');
      expect(drawn()).toEqual(['compare']);
    });

    it("the page has no navigation of its own: the views are its rail item's children", async () => {
      await visit();
      expect(root().querySelector('neat-page > nav')).toBeNull();
    });

    it('keeps the page and its telemetry across the views, polls no metrics on Runs and reads only what is new back on Live', async () => {
      await visit();
      const page = fixture.debugElement.query(By.directive(StatsPage)).componentInstance;
      const telemetry = telemetryOf();

      await go('/stats/runs');
      await flush(runsRead(), runsAnswer());
      expect(fixture.debugElement.query(By.directive(StatsPage)).componentInstance).toBe(page);
      expect(telemetryOf()).toBe(telemetry);
      // The state is still checked every 30 s; the metrics are not polled.
      await advance(30_000);
      await answerState();
      noPoll();
      // The list is read again every 30 s while it is shown.
      await flush(runsRead(), runsAnswer());
      expect(announcement()).toBe('');

      await go('/stats');
      // The window held is asked after: only the samples since come back.
      const poll = metricsPoll();
      const held = metricsQuery(telemetry.window(), GENERATION);
      expect(held.after).toBeDefined();
      expect(poll.request.params.get('after')).toBe(held.after);
      await flush(
        poll,
        withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
      );
      expect(chip()).toBe('Live');
      expect(announcement()).toBe('Metrics are updating live.');
      expect(cards()).toHaveLength(6);
    });

    it('Compare shows the comparison of the runs the address names, across the full width', async () => {
      const [baseline, other] = COMPARE_RAW.runs.map((run) => run.metadata.id);
      await visit();
      await go(`/stats/runs/compare?runs=${baseline},${other}&baseline=${baseline}`);
      // The run list first: it says whether the runs are still on the board and finished.
      await flush(runsRead(), runsAnswer());
      const request = http.expectOne((request) => request.url === '/api/sentinel/compare');
      expect(request.request.params.get('runs')).toBe(`${baseline},${other}`);
      await flush(request, {
        board: METRICS_LIVE.board,
        generation: GENERATION,
        sentinel: COMPARE_RAW,
      });

      const chips = [...root().querySelectorAll('neat-page ul[aria-label="Compared runs"] .name')];
      expect(chips.map(text)).toEqual(['tes3', 'insight-hw-1790177227']);
      expect(aside()).toBeNull();
    });

    it('the run list is read on Runs and Compare, and not on Live', async () => {
      await visit();
      http.expectNone((request) => request.url === RUNS_URL);

      await go('/stats/runs/compare?runs=a,b');
      await flush(runsRead(), runsAnswer());

      await go('/stats');
      await answerMetrics(
        withHistory(METRICS_LIVE, 1, { start: '2026-10-24T10:00:40Z', full: false }),
      );
      await advance(30_000);
      await answerState();
      http.expectNone((request) => request.url === RUNS_URL);
      http.match((request) => request.url === METRICS_URL);
    });

    it('Runs lists the runs, opens the selected one in the side panel and says when it is gone', async () => {
      const saved = RUNS_LIST.find((run) => run.id === SAVED_RUN.metadata.id)!;
      const runRead = () =>
        http.expectOne((request) => request.url === `${RUNS_URL}/${encodeURIComponent(saved.id)}`);
      await visit();
      await go('/stats/runs');
      await flush(runsRead(), runsAnswer());

      // A list page: the list scrolls its rows, not the page.
      expect(root().querySelector('neat-page app-stats-runs neat-select-list')).not.toBeNull();
      expect(text(aside()?.querySelector('section'))).toBe('Select a run to see its detail.');

      const row = [...root().querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
        text(option).startsWith(saved.name),
      )!;
      // Rendered without waiting for the page to settle: the run read out keeps it unsettled.
      row.click();
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      await flush(runRead(), {
        board: METRICS_LIVE.board,
        generation: GENERATION,
        sentinel: SAVED_RUN,
      });
      expect(asideTitle()).toBe(saved.name);
      expect(aside()?.querySelector('table')).not.toBeNull();

      // Deleted elsewhere (the Sentinel CLI): the next read of the list no longer has it.
      await advance(30_000);
      await answerState();
      await flush(runsRead(), runsAnswer(RUNS_LIST.filter((run) => run.id !== saved.id)));
      expect(text(aside()?.querySelector('neat-callout [role="heading"]'))).toBe(
        'This run is no longer on the board',
      );
    });

    it('the side panel says when the run list could not be read, rather than reading on', async () => {
      const saved = RUNS_LIST.find((run) => run.id === SAVED_RUN.metadata.id)!;
      TestBed.inject(StatsSession).run.set(saved.id);
      await visit();
      await go('/stats/runs');
      expect(text(aside()?.querySelector('section'))).toBe('Reading runs from the board…');

      await flush(runsRead(), failed('sentinel_failed'), true);
      expect(text(aside()?.querySelector('section'))).toBe('The run list could not be read.');

      // Read on the next try: the run's panel, which reads the run. Rendered without waiting for
      // the page to settle: the run read out keeps it unsettled.
      await advance(30_000);
      await answerState();
      runsRead().flush(runsAnswer());
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
      await flush(
        http.expectOne((request) => request.url === `${RUNS_URL}/${encodeURIComponent(saved.id)}`),
        { board: METRICS_LIVE.board, generation: GENERATION, sentinel: SAVED_RUN },
      );
      expect(asideTitle()).toBe(saved.name);
    });

    it('the runs ticked and selected belong to their board: another board starts with none', async () => {
      const session = TestBed.inject(StatsSession);
      await visit();
      await go('/stats/runs');
      await flush(runsRead(), runsAnswer());
      // The recording run is selected: its panel reads nothing from the board.
      session.run.set(RUNS_LIST[0].id);
      session.checkedRuns.set([RUNS_LIST[1].id, RUNS_LIST[2].id]);
      await settle();

      // Re-read, the same board keeps them.
      board.state.set(boardState({ target: DEVKIT, generation: GENERATION }));
      await settle();
      expect(session.run()).toBe(RUNS_LIST[0].id);
      expect(session.checkedRuns()).toEqual([RUNS_LIST[1].id, RUNS_LIST[2].id]);

      // Away from Stats when the board changes: the next visit finds none.
      await go('/elsewhere');
      board.state.set(boardState({ target: OTHER_BOARD, generation: GENERATION + 1 }));
      await go('/stats/runs');
      expect(session.run()).toBeNull();
      expect(session.checkedRuns()).toEqual([]);
      await answerState(sentinelState({ generation: GENERATION + 1 }));
      await flush(runsRead(), runsAnswer(RUNS_LIST, GENERATION + 1));
      expect(text(aside()?.querySelector('section'))).toBe('Select a run to see its detail.');
    });

    it('each view’s toolbar: Live has its update state, Record, ⋯ and the panel’s toggle after them; Runs Record and the toggle; Compare Record only', async () => {
      await visit();
      expect(chip()).toBe('Live');
      expect(toolbarButton('Pause')).toBeDefined();
      expect(toolbarButton('Record')).toBeDefined();
      expect(toolbarButton('More actions')).toBeDefined();
      expect(sidePanelToggle()).not.toBeNull();
      // Left to right: the view's own state, Record, ⋯, then the panel's toggle, which the kit
      // draws after the tools, not among them. The views are not in the toolbar.
      expect(toolbar().contains(sidePanelToggle())).toBe(false);
      expect(toolbar().querySelector('[role="radiogroup"]')).toBeNull();
      const order = [
        toolbar().querySelector('neat-status-chip')!,
        toolbarButton('Record')!,
        toolbarButton('More actions')!,
        sidePanelToggle()!,
      ];
      for (const [index, element] of order.slice(1).entries()) {
        expect(
          order[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }

      await go('/stats/runs');
      await flush(runsRead(), runsAnswer());
      expect(toolbar().querySelector('neat-status-chip')).toBeNull();
      expect(toolbarButton('Pause')).toBeUndefined();
      expect(toolbarButton('More actions')).toBeUndefined();
      expect(toolbarButton('Record')).toBeDefined();
      expect(sidePanelToggle()).not.toBeNull();

      await go('/stats/runs/compare?runs=a,b');
      expect(toolbarButton('Record')).toBeDefined();
      expect(toolbarButton('More actions')).toBeUndefined();
      expect(sidePanelToggle()).toBeNull();
    });

    it('a trace recording shows in the toolbar on every view', async () => {
      await go('/stats/runs');
      await answerState();
      await flush(
        http.expectOne((request) => request.url === TRACES_URL),
        traceAnswer(ACTIVE_TRACE, null),
      );
      await flush(runsRead(), runsAnswer());

      expect(text(toolbar().querySelector('.recording'))).toMatch(
        /^Recording · compiler-v2-bench · \d+:\d{2}(:\d{2})?$/,
      );
      expect(toolbarButton('Stop the trace')).toBeDefined();
      expect(toolbarButton('Record')).toBeUndefined();
    });

    it('Runs and Compare show the same empty states as Live, and no Record', async () => {
      board.state.set(boardState({ target: null, generation: GENERATION }));
      await go('/stats/runs');
      expect(calloutHeadings()).toEqual(['Select a board to see its telemetry']);
      expect(toolbarButton('Record')).toBeUndefined();

      board.state.set(boardState({ target: DEVKIT, generation: GENERATION }));
      await go('/stats/runs/compare?runs=a,b');
      expect(text(root().querySelector('neat-page p[role="status"]'))).toBe(
        'Checking Sentinel on the board…',
      );
      await answerState(missingState());
      expect(calloutHeadings()).toEqual(['Sentinel is not installed on sima@192.168.1.20']);
      expect(toolbarButton('Record')).toBeUndefined();
    });

    it('reads no trace and no runs while Sentinel is not ready, and reads them once it is', async () => {
      const traceReads = () => http.match((request) => request.url === TRACES_URL);
      await go('/stats/runs');
      // Before the state answers, and with a stopped daemon, nothing is asked of it.
      expect(traceReads()).toHaveLength(0);
      await answerState(stoppedState());
      await advance(30_000);
      expect(traceReads()).toHaveLength(0);
      http.expectNone((request) => request.url === RUNS_URL);

      // Started on the board: the next state check finds it ready, and both are read at once.
      await flush(stateRead(), sentinelState());
      expect(traceReads()).toHaveLength(1);
      await flush(runsRead(), runsAnswer());
    });
  });
});
