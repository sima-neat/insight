import { Component, Injector } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatToasts } from '@sima/neat-ui/toast';
import { PeripheralsService } from '../peripherals/peripherals.service';
import { peripheralSnapshot } from '../peripherals/snapshots.testing';
import type { BoardList, SelectedBoard } from './api';
import { openBoardDialog } from './board-dialog';
import { BoardProblem } from './board-error';
import { BoardService } from './board.service';
import {
  boardList,
  boardWith,
  deferred,
  DEVKIT,
  FakeBoard,
  FakePeripherals,
  LOCAL,
} from './board.testing';

/** Something to render, so that change detection runs for the dialog in the overlay. */
@Component({ template: '' })
class Host {}

const connected = (overrides: Partial<SelectedBoard> = {}) =>
  boardWith(DEVKIT, { status: { state: 'connected' }, ...overrides });

const failed = (overrides: Partial<SelectedBoard> = {}) =>
  boardWith(DEVKIT, {
    status: {
      state: 'error',
      checked_at: '2026-10-25T10:00:00Z',
      error: { code: 'auth_failed', message: 'SSH key authentication failed.' },
    },
    ...overrides,
  });

const IDENTITY = { hostname: 'devkit', machine: '', build: '2.0.0', host_key: '' };

/** A scan of the board `boardId` that read the board's camera setup, as Details show it. */
const scanOf = (boardId: string) =>
  peripheralSnapshot([], {
    board: { id: boardId },
    camera_setup: {
      model: 'SiMa.ai Modalix SoM 16Gig Board',
      overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
    },
  });

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
  const shell = () => dialog().querySelector('.shell');

  it('opens titled Board', async () => {
    board.state.set(connected());
    await open();
    expect(text(dialog().querySelector('h2'))).toBe('Board');
  });

  it('offers Check again for a selected board, whatever its state', async () => {
    board.state.set(connected());
    await open();
    expect(actions()).toEqual(['Check again']);

    board.state.set(failed());
    await settle();
    expect(actions()).toEqual(['Check again']);
  });

  it('an SSH board shows the ssh command that opens a shell, with Copy; the local board has none', async () => {
    const writeText = vi.fn(async () => undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      board.state.set(connected());
      await open();
      expect(text(shell()!.querySelector('p'))).toBe('Open a shell on the board from a terminal:');
      expect(text(shell()!.querySelector('code'))).toBe('ssh sima@192.168.1.20');
      const copy = shell()!.querySelector('button')!;
      expect(copy.getAttribute('aria-label')).toBe('Copy the ssh command');
      copy.click();
      await settle();
      expect(writeText).toHaveBeenCalledWith('ssh sima@192.168.1.20');
      expect(toasts.status).toHaveBeenCalledWith('Copied: ssh sima@192.168.1.20');

      // No Open shell any more: Insight runs no shell of its own.
      expect(button('Open shell')).toBeUndefined();

      board.state.set(boardWith(LOCAL, { status: { state: 'connected' } }));
      await settle();
      expect(shell()).toBeNull();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('Check again checks the connection, says Checking… meanwhile and toasts the board it reached', async () => {
    board.state.set(failed());
    const check = deferred<BoardList>();
    board.check.mockReturnValue(check.promise);
    await open();

    button('Check again').click();
    await settle();
    expect(board.check).toHaveBeenCalledTimes(1);
    expect(button('Checking…').getAttribute('aria-disabled')).toBe('true');
    // A press while it runs is ignored.
    button('Checking…').click();
    expect(board.check).toHaveBeenCalledTimes(1);

    const answer = connected({ identity: { ...IDENTITY, machine: 'modalix' } });
    board.state.set(answer);
    check.resolve(answer);
    await settle();
    expect(toasts.status).toHaveBeenCalledWith('Connected to devkit.');
    expect(statusLine()).toBe('Connected devkit · sima@192.168.1.20 · SDK DevKit');

    // Without a hostname the toast names the board.
    board.check.mockResolvedValue(connected());
    button('Check again').click();
    await settle();
    expect(toasts.status).toHaveBeenLastCalledWith('Connected to sima@192.168.1.20.');
  });

  it('a failed Check again shows its own problem in the notice; the next success clears it', async () => {
    board.state.set(connected());
    board.check.mockImplementation(async () => {
      // The service reloads the state before it rejects; the reload recorded an older failure.
      board.state.set(
        failed({
          status: {
            state: 'error',
            checked_at: '2026-10-25T10:00:00Z',
            error: { code: 'unreachable', message: 'The board did not answer.' },
          },
        }),
      );
      throw new BoardProblem('SSH key authentication failed.', 'auth_failed', '');
    });
    await open();
    expect(notice()).toBeNull();

    button('Check again').click();
    await settle();
    expect(statusLine()).toMatch(/^Connection failed /);
    // The action's own problem wins over the one the status records.
    expect(text(notice())).toBe('SSH key authentication failed.');
    // Said as it appears: the failure has no toast.
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBe('alert');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(button('Check again').getAttribute('aria-disabled')).toBeNull();

    board.check.mockImplementation(async () => {
      board.state.set(connected());
      return connected();
    });
    button('Check again').click();
    await settle();
    expect(notice()).toBeNull();
  });

  it('shows the connection error the board’s status records, with its command, while a board is selected', async () => {
    board.state.set(
      failed({
        status: {
          state: 'error',
          error: { code: 'auth_failed', message: 'SSH key authentication failed.' },
          command: 'ssh-copy-id sima@192.168.1.20',
        },
      }),
    );
    await open();
    expect(words(notice())).toBe(
      'SSH key authentication failed. ssh-copy-id sima@192.168.1.20 Copy',
    );
    // A problem already there when the dialog opens is not shouted.
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBeNull();

    board.state.set(boardList());
    await settle();
    expect(notice()).toBeNull();
  });

  it('a board change drops the problem of an action on the board before', async () => {
    board.state.set(connected());
    board.check.mockRejectedValue(new BoardProblem('Timed out.', 'timeout', ''));
    await open();
    button('Check again').click();
    await settle();
    expect(text(notice())).toBe('Timed out.');

    board.state.set(boardWith(LOCAL, { status: { state: 'connected' } }));
    await settle();
    expect(notice()).toBeNull();
  });

  it('Trust new key trusts the presented key and toasts; a refused trust shows why', async () => {
    const changed = failed({
      status: {
        state: 'error',
        checked_at: '2026-10-25T10:00:00Z',
        error: {
          code: 'host_key_changed',
          message: '192.168.1.20 presented a different SSH host key than the one Insight trusted.',
        },
        host_key: { host: '192.168.1.20', expected: 'SHA256:old', presented: 'SHA256:new' },
      },
    });
    board.state.set(changed);
    await open();
    const trust = () => button('Trust new key…');

    const trusted = boardWith(DEVKIT);
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
    board.state.set({ ...changed });
    await settle();
    board.trustHostKey.mockRejectedValueOnce(
      new BoardProblem(
        'That host key is not the one the board presented.',
        'invalid_request',
        'Check the connection again and confirm the fingerprint it reports.',
      ),
    );
    trust().click();
    await settle();
    expect(words(notice())).toBe(
      'That host key is not the one the board presented. Check the connection again and confirm the fingerprint it reports.',
    );
    expect(notice()!.querySelector('neat-callout')!.getAttribute('role')).toBe('alert');
    // Trust new key… went with the warning; the server asks to check again, so the focus goes there.
    expect(document.activeElement).toBe(button('Check again'));
    expect(toasts.status).toHaveBeenCalledTimes(1);
  });

  it('Change board sits under Details; without a board it is open under the guide', async () => {
    board.state.set(connected({ identity: IDENTITY }));
    await open();
    const sections = () =>
      [...dialog().querySelectorAll('neat-collapsible')].map(
        (one) => words(one.querySelector('button')).split(' ')[0],
      );
    expect(sections()).toEqual(['Details', 'Change']);
    expect(section('Change board')!.querySelector('button')!.getAttribute('aria-expanded')).toBe(
      'false',
    );

    board.state.set(boardList());
    await settle();
    const guide = dialog().querySelector('neat-callout')!;
    const form = section('Change board')!;
    expect(guide.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('Checked ticks; Details lists only reported facts and the camera setup of the selected board', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-10-25T10:00:05Z'));
    board.state.set(failed({ identity: IDENTITY }));
    peripherals.snapshot.set(scanOf(DEVKIT.id));
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

    // A scan of another board says nothing about this one's camera setup.
    peripherals.snapshot.set(scanOf(LOCAL.id));
    await settle();
    expect(facts()).toEqual([
      ['Hostname', 'devkit'],
      ['Build', '2.0.0'],
    ]);
    expect(words(trigger)).toBe('Details Hostname, Build');
  });

  it('never checked: no Checked line and no Details', async () => {
    board.state.set(boardWith(DEVKIT));
    await open();
    expect(statusLine()).toBe('Not checked sima@192.168.1.20 · SDK DevKit');
    expect(dialog().querySelector('.checked')).toBeNull();
    expect(section('Details')).toBeNull();
  });

  it('ignores a failed peripherals read', async () => {
    board.state.set(connected());
    peripherals.load.mockRejectedValue(new BoardProblem('Sentinel is down.', '', ''));
    await open();
    expect(statusLine()).toMatch(/^Connected /);
  });

  it('a failed board read shows the message with Retry', async () => {
    board.error.set(
      new BoardProblem(
        'Could not reach the Insight server.',
        'network',
        'Check that Insight is still running, then retry.',
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

  it('without a board, says so and gives the three ways to get one', async () => {
    board.state.set(boardList());
    await open();
    expect(statusLine()).toBe('No board');
    expect(dialog().querySelector('.actions')).toBeNull();
    expect(shell()).toBeNull();
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
