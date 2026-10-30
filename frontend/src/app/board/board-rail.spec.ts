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
import { boardState, DEVKIT, FakeBoard, railItem } from './board.testing';

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

  /** What the block gave the kit's rail item: the app's mapping, whatever the kit draws from it. */
  const mapped = (button: HTMLElement) => {
    const item = railItem(button);
    return { text: item.text(), detail: item.detail(), tone: item.tone(), label: item.label() };
  };
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

  it('a connected board is quiet: name and address, a success tone, the state in its label', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();

    // The state is in the label (the item's name and tooltip), not only in the tone's colour.
    expect(mapped(button)).toEqual({
      text: 'DevKit',
      detail: '192.168.1.20',
      tone: 'success',
      label: 'DevKit — 192.168.1.20 — Connected',
    });
    expect(icon(button)).toBe('board');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('a board that is not connected says its state in words, in the state’s tone', async () => {
    board.state.set(
      boardState({ target: DEVKIT, status: { state: 'error', checked_at: null, error: null } }),
    );
    const button = await render();

    expect(mapped(button)).toEqual({
      text: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      label: 'DevKit — 192.168.1.20 — Connection failed',
    });

    board.state.set(boardState({ target: DEVKIT }));
    await fixture.whenStable();
    expect(mapped(button)).toMatchObject({
      text: 'DevKit',
      detail: 'Not checked',
      tone: 'neutral',
    });

    board.state.set(boardState({ target: null }));
    await fixture.whenStable();
    expect(mapped(button)).toMatchObject({
      text: 'No board',
      detail: 'Not selected',
      tone: 'neutral',
    });
  });

  it('says Checking… in the warning tone while the connection check is out, then its result', async () => {
    board.state.set(boardState({ target: DEVKIT }));
    board.checking.set(true);
    const button = await render();

    expect(mapped(button)).toEqual({
      text: 'DevKit',
      detail: 'Checking…',
      tone: 'warning',
      label: 'DevKit — 192.168.1.20 — Checking the connection',
    });

    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    board.checking.set(false);
    await fixture.whenStable();
    expect(mapped(button)).toMatchObject({ detail: '192.168.1.20', tone: 'success' });
  });

  it('keeps naming the last known board when the board read fails, and says so', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    board.error.set(new BoardProblem('Could not reach the Insight server.', 'network', '', {}));
    const button = await render();

    expect(mapped(button)).toEqual({
      text: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      label:
        'DevKit — 192.168.1.20 — Could not read the board: Could not reach the Insight server.',
    });
  });

  it('the tooltip of the collapsed rail says it all', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();

    expect(await tooltip(button)).toBe('DevKit — 192.168.1.20 — Connected');
  });

  it('a click opens the board dialog', async () => {
    board.state.set(boardState({ target: DEVKIT, status: CONNECTED }));
    const button = await render();

    button.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
  });
});
