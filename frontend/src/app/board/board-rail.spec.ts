import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { getDebugNode } from '@angular/core';
import { provideRouter } from '@angular/router';
import { NeatIcon, NeatShell } from '@sima/neat-ui';
import { FakeLocalStorage } from '../fake-storage.testing';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardProblem } from './board-error';
import { BoardRail } from './board-rail';
import { BoardService } from './board.service';
import { boardState, DEVKIT, FakeBoard } from './board.testing';

/** The app frame: a rail item belongs in the shell's rail end, which gives it the rail's state. */
@Component({
  imports: [BoardRail, NeatShell],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"
    ><app-board-rail neatRailEnd
  /></neat-shell>`,
})
class Shell {}

const CONNECTED = { state: 'connected', checked_at: null, error: null } as const;

describe('BoardRail', () => {
  let board: FakeBoard;
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    // The rail's expanded state is remembered in storage: a fresh, collapsed one for every test.
    vi.stubGlobal('localStorage', new FakeLocalStorage());
    board = new FakeBoard();
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: BoardService, useValue: board },
        { provide: TopBarDialogs, useValue: dialogs },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  async function render(): Promise<HTMLButtonElement> {
    fixture = TestBed.createComponent(Shell);
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('app-board-rail button');
  }

  /** The rail's own control, which shows the labels. */
  async function expand(): Promise<void> {
    const control = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button: HTMLElement) => button.textContent?.trim() === 'Show labels',
    ) as HTMLButtonElement;
    control.click();
    await fixture.whenStable();
  }

  const lines = (button: HTMLElement) =>
    [...button.querySelectorAll('.lines > span')].map((line) => line.textContent?.trim());
  const dot = (button: HTMLElement) => button.querySelector('.dot');
  const icon = (button: HTMLElement) =>
    (getDebugNode(button.querySelector('neat-icon'))!.componentInstance as NeatIcon).name();

  /** The tooltip, which the kit shows on focus (with a zero delay), to the right of the item. */
  async function tooltip(button: HTMLElement): Promise<string | undefined> {
    // jsdom lays nothing out: give the overlay a viewport and the item a box inside it.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1366);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    button.getBoundingClientRect = () => new DOMRect(0, 600, 48, 40);
    button.dispatchEvent(new FocusEvent('focus'));
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    return document.querySelector('[role="tooltip"]')?.textContent?.trim();
  }

  it('a connected board is quiet: name and address, a success dot, the state in its name', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();
    await expand();

    expect(lines(button)).toEqual(['DevKit', '192.168.1.20']);
    expect(button.getAttribute('data-tone')).toBe('success');
    expect(dot(button)).not.toBeNull();
    expect(icon(button)).toBe('board');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    // The state is in the name, not only in the dot's colour.
    expect(button.getAttribute('aria-label')).toBe('DevKit — 192.168.1.20 — Connected');
  });

  it('a board that is not connected says its state in words, in the state’s tone', async () => {
    board.state.set(
      boardState({ target: DEVKIT, status: { state: 'error', checked_at: null, error: null } }),
    );
    const button = await render();
    await expand();

    expect(lines(button)).toEqual(['DevKit', 'Error']);
    expect(button.getAttribute('data-tone')).toBe('danger');
    expect(button.getAttribute('aria-label')).toBe('DevKit — 192.168.1.20 — Connection failed');

    board.state.set(boardState({ target: DEVKIT }));
    await fixture.whenStable();
    expect(lines(button)).toEqual(['DevKit', 'Not checked']);
    expect(button.getAttribute('data-tone')).toBe('neutral');

    board.state.set(boardState({ target: null }));
    await fixture.whenStable();
    expect(lines(button)).toEqual(['No board', 'Not selected']);
    expect(button.getAttribute('data-tone')).toBe('neutral');
  });

  it('says Checking… in the warning tone while the connection check is out, then its result', async () => {
    board.state.set(boardState({ target: DEVKIT }));
    board.checking.set(true);
    const button = await render();
    await expand();

    expect(lines(button)).toEqual(['DevKit', 'Checking…']);
    expect(button.getAttribute('data-tone')).toBe('warning');
    expect(button.getAttribute('aria-label')).toBe(
      'DevKit — 192.168.1.20 — Checking the connection',
    );

    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    board.checking.set(false);
    await fixture.whenStable();
    expect(lines(button)).toEqual(['DevKit', '192.168.1.20']);
  });

  it('keeps naming the last known board when the board read fails, and says so', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    board.error.set(new BoardProblem('Could not reach the Insight server.', 'network', '', {}));
    const button = await render();
    await expand();

    expect(lines(button)).toEqual(['DevKit', 'Error']);
    expect(button.getAttribute('data-tone')).toBe('danger');
    expect(button.getAttribute('aria-label')).toBe(
      'DevKit — 192.168.1.20 — Could not read the board: Could not reach the Insight server.',
    );
  });

  it('collapsed, the lines are for screen readers only and the tooltip says it all', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();

    expect(button.querySelector('.label.sr-only')).not.toBeNull();
    expect(await tooltip(button)).toBe('DevKit — 192.168.1.20 — Connected');
  });

  it('a click opens the board dialog', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();

    button.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
  });
});
