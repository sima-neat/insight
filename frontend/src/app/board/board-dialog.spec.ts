import { Component, getDebugNode, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatButton } from '@sima/neat-ui';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { PeripheralSnapshot } from '../peripherals/api';
import { PeripheralsService } from '../peripherals/peripherals.service';
import type { BoardState, ShellInfo } from './api';
import { openBoardDialog } from './board-dialog';
import { BoardProblem } from './board-error';
import { BoardService } from './board.service';
import {
  boardState,
  deferred,
  DEVKIT,
  FakeBoard,
  FakePeripherals,
  shellInfo,
} from './board.testing';

/** Something to render, so that change detection runs for the dialog in the overlay. */
@Component({ template: '' })
class Host {}

const connected = (overrides: Partial<BoardState> = {}) =>
  boardState({
    target: DEVKIT,
    status: { state: 'connected', checked_at: null, error: null },
    ...overrides,
  });

const failed = (overrides: Partial<BoardState> = {}) =>
  boardState({
    target: DEVKIT,
    status: {
      state: 'error',
      checked_at: '2026-10-25T10:00:00Z',
      error: { error: 'SSH key authentication failed.', code: 'auth_failed', hint: null },
    },
    ...overrides,
  });

function snapshot(generation: number, overrides: Partial<PeripheralSnapshot> = {}) {
  return {
    board: {
      label: DEVKIT.label,
      source: 'sdk-env',
      hostname: null,
      machine: null,
      build_version: null,
      fingerprint: null,
    },
    generation,
    scan_id: `7:${generation}`,
    scanned_at: '2026-10-25T10:00:00Z',
    items: [],
    issues: [],
    changes: null,
    camera_setup: {
      model: 'SiMa.ai Modalix SoM 16Gig Board',
      overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
    },
    ...overrides,
  } satisfies PeripheralSnapshot;
}

describe('BoardDialog', () => {
  let board: FakeBoard;
  let peripherals: FakePeripherals;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let confirm: { ask: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    board = new FakeBoard();
    peripherals = new FakePeripherals();
    toasts = { status: vi.fn(), error: vi.fn() };
    confirm = { ask: vi.fn(async () => true) };
    TestBed.configureTestingModule({
      providers: [
        { provide: BoardService, useValue: board },
        { provide: PeripheralsService, useValue: peripherals },
        { provide: NeatToasts, useValue: toasts },
        { provide: NeatConfirm, useValue: confirm },
      ],
    });
    fixture = TestBed.createComponent(Host);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  /** Lets the promise chains run, then change detection. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  async function open(): Promise<void> {
    openBoardDialog(TestBed.inject(Injector));
    await settle();
  }

  const dialog = (): HTMLElement => document.querySelector('[role="dialog"]')!;
  const text = (element: Element | null = dialog()) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** An element's words as they read: its text pieces joined by spaces, as the chip and the text beside it do. */
  const words = (element: Element | null) => {
    if (!element) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? '');
    return pieces
      .map((piece) => piece.trim())
      .filter(Boolean)
      .join(' ');
  };
  const statusLine = () => words(dialog().querySelector('.status-line'));
  /** The action buttons, in order, by their text. */
  const actions = () =>
    [...dialog().querySelectorAll<HTMLButtonElement>('.actions button')].map(text);
  const button = (name: string) =>
    [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((one) => text(one) === name)!;
  /** The collapsible section whose trigger starts with `label`. */
  const section = (label: string) =>
    [...dialog().querySelectorAll('neat-collapsible')].find((one) =>
      text(one.querySelector('button')).startsWith(label),
    ) ?? null;
  const notice = () => dialog().querySelector('app-board-problem-notice');
  const variant = (element: HTMLElement) =>
    getDebugNode(element)!.injector.get(NeatButton).variant();

  it('opens titled Board', async () => {
    board.state.set(connected());
    await open();
    expect(text(dialog().querySelector('h2'))).toBe('Board');
  });

  it('the dialog leads with Open shell when connected and supported, otherwise with Check again; Open shell hides without launch_supported', async () => {
    board.state.set(connected());
    board.shellInfo.mockResolvedValue(shellInfo());
    await open();
    expect(actions()).toEqual(['Open shell', 'Check again']);
    expect(variant(button('Open shell'))).toBe('primary');
    expect(variant(button('Check again'))).toBe('outlined');

    // Not connected: Check again leads; Open shell stays, since webssh signs in with a password and
    // helps exactly when Insight's key is refused.
    board.state.set(failed());
    await settle();
    expect(actions()).toEqual(['Check again', 'Open shell']);
    expect(variant(button('Check again'))).toBe('primary');
    expect(variant(button('Open shell'))).toBe('outlined');

    // A shell that cannot sign in by itself is not offered (the next board's read says so).
    board.shellInfo.mockResolvedValue(shellInfo({ launch_supported: false }));
    board.state.set(connected({ generation: 2 }));
    await settle();
    expect(actions()).toEqual(['Check again']);
    expect(variant(button('Check again'))).toBe('primary');
  });

  it('Open shell without webssh is dimmed with #170’s reason and does nothing', async () => {
    board.state.set(connected());
    board.shellInfo.mockResolvedValue(shellInfo({ available: false }));
    const opened = vi.spyOn(window, 'open');
    await open();
    const shell = button('Open shell');
    expect(shell.getAttribute('aria-disabled')).toBe('true');

    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1366);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    shell.getBoundingClientRect = () => new DOMRect(400, 300, 120, 32);
    shell.dispatchEvent(new FocusEvent('focus'));
    await settle();
    expect(text(document.querySelector('[role="tooltip"]'))).toBe(
      'webssh is not installed in this Insight environment',
    );

    shell.click();
    await settle();
    expect(opened).not.toHaveBeenCalled();
    expect(board.startShell).not.toHaveBeenCalled();
  });

  it('Open shell opens the window synchronously, then starts webssh and navigates it; a failure closes it and toasts', async () => {
    board.state.set(connected());
    board.shellInfo.mockResolvedValue(shellInfo());
    const blank = { location: { href: '' }, close: vi.fn() };
    const opened = vi.spyOn(window, 'open').mockReturnValue(blank as unknown as Window);
    const start = deferred<ShellInfo>();
    board.startShell.mockReturnValue(start.promise);
    await open();

    button('Open shell').click();
    // Inside the click, so that popup blockers allow it: the address follows once webssh runs.
    expect(opened).toHaveBeenCalledWith('', '_blank');
    expect(board.startShell).toHaveBeenCalledTimes(1);
    await settle();
    expect(actions()).toEqual(['Opening shell…', 'Check again']);
    expect(button('Opening shell…').getAttribute('aria-disabled')).toBe('true');
    // One action at a time, as #170: Check again waits too.
    expect(button('Check again').getAttribute('aria-disabled')).toBe('true');

    start.resolve(shellInfo({ running: true, launch_url: 'https://localhost:8022/?go' }));
    await settle();
    expect(blank.location.href).toBe('https://localhost:8022/?go');
    expect(blank.close).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(actions()).toEqual(['Open shell', 'Check again']);

    // A blocked popup: the shell opens in a window of its own once the address is known.
    opened.mockReturnValue(null);
    board.startShell.mockResolvedValue(shellInfo({ launch_url: 'https://localhost:8022/?again' }));
    button('Open shell').click();
    await settle();
    expect(opened).toHaveBeenLastCalledWith('https://localhost:8022/?again', '_blank');

    // A failure closes the blank window and says why.
    opened.mockReturnValue(blank as unknown as Window);
    board.startShell.mockRejectedValue(
      new Error('webssh failed to start. Check bin/logs/webssh.log'),
    );
    button('Open shell').click();
    await settle();
    expect(blank.close).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenCalledWith('webssh failed to start. Check bin/logs/webssh.log');

    // Started without an address: #170's message.
    blank.close.mockClear();
    board.startShell.mockResolvedValue(shellInfo({ launch_url: null }));
    button('Open shell').click();
    await settle();
    expect(blank.close).toHaveBeenCalledTimes(1);
    expect(toasts.error).toHaveBeenLastCalledWith('DevKit shell launch URL is unavailable.');
  });

  it('shows the actions once the shell details are in, so that they do not reorder under the pointer', async () => {
    board.state.set(connected());
    const read = deferred<ShellInfo | null>();
    board.shellInfo.mockReturnValue(read.promise);
    await open();
    // Check again alone first, with Open shell put before it a moment later, would take a quick
    // click meant for the leading action.
    expect(dialog().querySelector('.actions')).toBeNull();

    read.resolve(shellInfo());
    await settle();
    expect(actions()).toEqual(['Open shell', 'Check again']);

    // A later board's read keeps the row shown meanwhile.
    board.shellInfo.mockReturnValue(new Promise(() => undefined));
    board.state.set(connected({ generation: 2 }));
    await settle();
    expect(actions()).toEqual(['Open shell', 'Check again']);
  });

  it('shell details read for an earlier board cannot overwrite the newer board', async () => {
    // #170's Codex finding (5878ec6), Inv-PB §6.17: the board changes while the dialog is open.
    board.state.set(connected());
    const reads = [deferred<ShellInfo | null>(), deferred<ShellInfo | null>()];
    board.shellInfo.mockReturnValueOnce(reads[0].promise).mockReturnValueOnce(reads[1].promise);
    await open();
    expect(board.shellInfo).toHaveBeenCalledTimes(1);

    board.state.set(failed({ generation: 2 }));
    await settle();
    expect(board.shellInfo).toHaveBeenCalledTimes(2);

    reads[1].resolve(shellInfo({ launch_supported: false }));
    await settle();
    reads[0].resolve(shellInfo());
    await settle();
    // The newer board has no browser shell; the earlier answer does not bring Open shell back.
    expect(actions()).toEqual(['Check again']);

    // A failed read hides the shell.
    board.shellInfo.mockResolvedValue(null);
    board.state.set(connected({ generation: 3 }));
    await settle();
    expect(actions()).toEqual(['Check again']);
  });

  it('Check again tests the connection, says Checking… meanwhile and toasts the board it reached', async () => {
    board.state.set(failed());
    const test = deferred<BoardState>();
    board.test.mockReturnValue(test.promise);
    await open();

    button('Check again').click();
    await settle();
    expect(board.test).toHaveBeenCalledTimes(1);
    expect(button('Checking…').getAttribute('aria-disabled')).toBe('true');
    // A press while it runs is ignored.
    button('Checking…').click();
    expect(board.test).toHaveBeenCalledTimes(1);

    const answer = connected({
      board: { hostname: 'devkit', machine: null, build_version: null, fingerprint: 'f' },
    });
    board.state.set(answer);
    test.resolve(answer);
    await settle();
    expect(toasts.status).toHaveBeenCalledWith('Connected to devkit.');
    expect(statusLine()).toBe('Connected devkit · sima@192.168.1.20 · SDK DevKit');

    // Without a hostname the toast names the target.
    board.test.mockResolvedValue(connected());
    button('Check again').click();
    await settle();
    expect(toasts.status).toHaveBeenLastCalledWith('Connected to sima@192.168.1.20.');
  });

  it('a failed Check again shows its own problem in the notice; the next success clears it (F21)', async () => {
    board.state.set(connected());
    board.test.mockImplementation(async () => {
      // The service reloads the state before it rejects; the reload recorded an older failure.
      board.state.set(
        failed({
          status: {
            state: 'error',
            checked_at: '2026-10-25T10:00:00Z',
            error: { error: 'The board did not answer.', code: 'unreachable', hint: null },
          },
        }),
      );
      throw new BoardProblem('SSH key authentication failed.', 'auth_failed', '', {});
    });
    await open();
    expect(notice()).toBeNull();

    button('Check again').click();
    await settle();
    expect(statusLine()).toMatch(/^Connection failed /);
    // The action's own problem wins over the one the state repeats.
    expect(text(notice())).toBe('SSH key authentication failed.');
    // Said as it appears, as #170's role="alert": the failure has no toast.
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBe('alert');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(button('Check again').getAttribute('aria-disabled')).toBeNull();

    board.test.mockImplementation(async () => {
      board.state.set(connected());
      return connected();
    });
    button('Check again').click();
    await settle();
    expect(notice()).toBeNull();
  });

  it('shows the connection error the board state repeats, while a target exists', async () => {
    board.state.set(failed());
    await open();
    expect(text(notice())).toBe('SSH key authentication failed.');
    // A problem already there when the dialog opens is not shouted.
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBeNull();

    board.state.set(boardState());
    await settle();
    expect(notice()).toBeNull();
  });

  it('Trust new key trusts the presented key and toasts; a refused trust shows why', async () => {
    const changed = failed({
      status: {
        state: 'error',
        checked_at: '2026-10-25T10:00:00Z',
        error: {
          error: '192.168.1.20 presented a different SSH host key than the one Insight trusted.',
          code: 'host_key_changed',
          hint: null,
          host: '192.168.1.20',
          expected_fingerprint: 'SHA256:old',
          presented_fingerprint: 'SHA256:new',
        },
      },
    });
    board.state.set(changed);
    await open();
    const trust = () => button('Trust new key…');

    const trusted = boardState({ target: DEVKIT, generation: 2 });
    board.trustHostKey.mockImplementation(async () => {
      board.state.set(trusted);
      return trusted;
    });
    trust().click();
    await settle();
    expect(board.trustHostKey).toHaveBeenCalledWith('SHA256:new');
    expect(toasts.status).toHaveBeenCalledWith('Host key updated. Check again to connect.');
    expect(notice()).toBeNull();
    // The Trust button went with the notice; the focus goes on to the next step.
    expect(document.activeElement).toBe(button('Check again'));

    // The board presents a new key again, and this time the server refuses the trust: its words
    // replace the notice (its hint says to check again, which reads the key afresh).
    board.state.set({ ...changed, generation: 3 });
    await settle();
    board.trustHostKey.mockRejectedValueOnce(
      new BoardProblem(
        'That host key is not the one the board presented.',
        'bad_fingerprint',
        'Test the connection again and confirm the fingerprint it reports.',
        {},
      ),
    );
    trust().click();
    await settle();
    expect(words(notice())).toBe(
      'That host key is not the one the board presented. Test the connection again and confirm the fingerprint it reports.',
    );
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBe('alert');
    // Trust new key… went with the warning; the server asks to check again, so the focus goes there.
    expect(document.activeElement).toBe(button('Check again'));
    expect(toasts.status).toHaveBeenCalledTimes(1);
  });

  it('Change board sits under Details; without a board it is open under the guide', async () => {
    board.state.set(
      connected({
        board: { hostname: 'devkit', machine: null, build_version: null, fingerprint: 'f' },
      }),
    );
    await open();
    const sections = () =>
      [...dialog().querySelectorAll('neat-collapsible')].map(
        (one) => words(one.querySelector('button')).split(' ')[0],
      );
    expect(sections()).toEqual(['Details', 'Change']);
    expect(section('Change board')!.querySelector('button')!.getAttribute('aria-expanded')).toBe(
      'false',
    );

    board.state.set(boardState());
    await settle();
    const guide = dialog().querySelector('neat-callout')!;
    const form = section('Change board')!;
    expect(guide.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Checked ticks; Details lists only reported facts and the camera setup of the current generation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:05Z'));
    board.state.set(
      failed({
        generation: 4,
        board: { hostname: 'devkit', machine: null, build_version: '2.0.0', fingerprint: 'f' },
      }),
    );
    peripherals.snapshot.set(snapshot(4));
    await open();
    expect(peripherals.load).toHaveBeenCalledTimes(1);

    const checked = () => text(dialog().querySelector('.checked'));
    expect(checked()).toBe('Checked just now');
    vi.advanceTimersByTime(25_000);
    await settle();
    expect(checked()).toBe('Checked 30 s ago');
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(checked()).toBe('Checked 1 min ago');

    const details = section('Details')!;
    const trigger = details.querySelector('button')!;
    // The hint names what the section holds: here no Machine, which the board did not report.
    expect(words(trigger)).toBe('Details Hostname, Build, Model, Camera setup');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const facts = () =>
      [...details.querySelectorAll('dl dt')].map((term) => [
        text(term),
        text(term.nextElementSibling),
      ]);
    expect(facts()).toEqual([
      ['Hostname', 'devkit'],
      ['Build', '2.0.0'],
      ['Model', 'SiMa.ai Modalix SoM 16Gig Board'],
      ['Camera setup', 'modalix-som-waveshare-ARDU-IMX477-1CAM'],
    ]);

    // A scan of another board generation says nothing about this one's camera setup.
    peripherals.snapshot.set(snapshot(3));
    await settle();
    expect(facts()).toEqual([
      ['Hostname', 'devkit'],
      ['Build', '2.0.0'],
    ]);
    expect(words(trigger)).toBe('Details Hostname, Build');
  });

  it('never checked: no Checked line and no Details', async () => {
    board.state.set(boardState({ target: DEVKIT }));
    await open();
    expect(statusLine()).toBe('Not checked sima@192.168.1.20 · SDK DevKit');
    expect(dialog().querySelector('.checked')).toBeNull();
    expect(section('Details')).toBeNull();
  });

  it('ignores a failed peripherals read', async () => {
    board.state.set(connected());
    peripherals.load.mockRejectedValue(new BoardProblem('Sentinel is down.', '', '', {}));
    await open();
    expect(statusLine()).toMatch(/^Connected /);
  });

  it('a failed board read shows the message with Retry', async () => {
    board.error.set(
      new BoardProblem(
        'Could not reach the Insight server.',
        'network',
        'Check that Insight is still running, then retry.',
        {},
      ),
    );
    await open();
    const callout = dialog().querySelector('neat-callout')!;
    expect(text(callout)).toContain('Could not reach the Insight server.');
    expect(text(callout)).toContain('Check that Insight is still running, then retry.');
    // Retry is the callout's own action, in its action row.
    expect(text(callout.querySelector('[data-slot="callout-actions"] button'))).toBe('Retry');
    expect(dialog().querySelector('.status-line')).toBeNull();

    button('Retry').click();
    expect(board.reload).toHaveBeenCalledTimes(1);

    // The read went through: the board shows, the callout goes.
    board.error.set(null);
    board.state.set(connected());
    await settle();
    expect(dialog().querySelector('neat-callout')).toBeNull();
    expect(statusLine()).toMatch(/^Connected /);
  });

  it('says Loading board… before the first answer', async () => {
    await open();
    expect(text(dialog().querySelector('[role="status"]'))).toBe('Loading board…');
  });

  it('without a board, says so and gives #170’s three ways to get one', async () => {
    board.state.set(boardState());
    await open();
    expect(statusLine()).toBe('No board');
    expect(dialog().querySelector('.actions')).toBeNull();
    const callout = dialog().querySelector('neat-callout')!;
    expect(text(callout.querySelector('[role="heading"]'))).toBe('No board selected');
    expect(text(callout)).toContain(
      'Insight needs a board to discover peripherals. Any of these gives it one:',
    );
    expect([...callout.querySelectorAll('ol li')].map((item) => text(item))).toEqual([
      'Run Insight on the board itself; it then uses that board automatically.',
      'Pair the SDK with a DevKit: run sima-cli sdk setup --devkit <ip>, then reload this page.',
      'Enter a board below. Insight connects with your SSH key; it never asks for a password.',
    ]);
  });
});
