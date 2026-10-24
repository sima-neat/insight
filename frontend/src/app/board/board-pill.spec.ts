import { getDebugNode } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatIcon } from '@sima/neat-ui';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { TopBarDialogs } from '../top-bar-dialogs';
import { BoardProblem } from './board-error';
import { BoardPill } from './board-pill';
import { BoardService } from './board.service';
import { boardState, DEVKIT, FakeBoard } from './board.testing';

describe('BoardPill', () => {
  let board: FakeBoard;
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<BoardPill>;

  beforeEach(() => {
    board = new FakeBoard();
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        { provide: BoardService, useValue: board },
        { provide: TopBarDialogs, useValue: dialogs },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  async function render(): Promise<HTMLButtonElement> {
    fixture = TestBed.createComponent(BoardPill);
    await fixture.whenStable();
    return fixture.nativeElement.querySelector('button');
  }

  const label = (button: HTMLElement) => button.querySelector('.label')?.textContent?.trim();
  const chip = (button: HTMLElement) => button.querySelector('neat-status-chip')!;
  const tone = (button: HTMLElement) =>
    (getDebugNode(chip(button))!.componentInstance as NeatStatusChip).tone();
  const icon = (button: HTMLElement) =>
    (getDebugNode(button.querySelector('neat-icon'))!.componentInstance as NeatIcon).name();

  /** The tooltip, which the kit shows on focus (with a zero delay). */
  async function tooltip(button: HTMLElement): Promise<string | undefined> {
    // jsdom lays nothing out: give the overlay a viewport and the pill a box inside it.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1366);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    button.getBoundingClientRect = () => new DOMRect(1000, 12, 200, 32);
    button.dispatchEvent(new FocusEvent('focus'));
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    return document.querySelector('[role="tooltip"]')?.textContent?.trim();
  }

  it('the pill shows the indicator label and chip and opens the board dialog', async () => {
    board.state.set(
      boardState({
        target: DEVKIT,
        status: { state: 'connected', checked_at: null, error: null },
      }),
    );
    const button = await render();

    expect(label(button)).toBe('DevKit: 192.168.1.20');
    expect(chip(button).textContent?.trim()).toBe('Connected');
    expect(tone(button)).toBe('success');
    expect(icon(button)).toBe('board');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(await tooltip(button)).toBe('sima@192.168.1.20 — Connected. Open board settings.');

    button.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);
  });

  it('the pill shows Error with the reason when the board read fails', async () => {
    board.state.set(boardState({ target: DEVKIT }));
    board.error.set(new BoardProblem('Could not reach the Insight server.', 'network', '', {}));
    const button = await render();

    // The last board known keeps its name; the chip and the tooltip say the read failed (Q4).
    expect(label(button)).toBe('DevKit: 192.168.1.20');
    expect(chip(button).textContent?.trim()).toBe('Error');
    expect(tone(button)).toBe('danger');
    expect(await tooltip(button)).toBe(
      'sima@192.168.1.20 — Could not read the board: Could not reach the Insight server.',
    );

    // It follows the service: the next good answer clears the error.
    board.error.set(null);
    await fixture.whenStable();
    expect(chip(button).textContent?.trim()).toBe('Not checked');
  });
});
