import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { BoardService } from './board/board.service';
import { FakeBoard, FakePeripherals } from './board/board.testing';
import { PeripheralsService } from './peripherals/peripherals.service';
import { TOP_BAR_DIALOG_MODULES, TopBarDialogs } from './top-bar-dialogs';

/** Something to render, so that change detection runs for the dialogs in the overlay. */
@Component({ template: '' })
class Host {}

describe('TopBarDialogs', () => {
  let fixture: ComponentFixture<Host>;
  let loadBoard: ReturnType<typeof vi.fn>;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // The real module, counted: whether it loads, and how often, is what this spec is about.
    loadBoard = vi.fn(() => import('./board/board-dialog'));
    toasts = { status: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: TOP_BAR_DIALOG_MODULES, useValue: { board: loadBoard } },
        { provide: BoardService, useValue: new FakeBoard() },
        { provide: PeripheralsService, useValue: new FakePeripherals() },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    fixture = TestBed.createComponent(Host);
  });

  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((container) => container.remove());
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const boardDialogs = () => document.querySelectorAll('app-board-dialog');
  /** Waits for the module to load (a dynamic import takes a few turns) and the dialog to show. */
  const shown = () => vi.waitFor(() => expect(boardDialogs()).toHaveLength(1));

  it('TopBarDialogs loads each dialog module on first open only', async () => {
    const dialogs = TestBed.inject(TopBarDialogs);
    await settle();
    expect(loadBoard).not.toHaveBeenCalled();

    // A double click: the second call, while the first is loading or open, does nothing.
    const first = dialogs.openBoard();
    const second = dialogs.openBoard();
    await shown();
    await settle();
    expect(loadBoard).toHaveBeenCalledTimes(1);
    expect(boardDialogs()).toHaveLength(1);
    let closed = false;
    void first.then(() => (closed = true));

    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(closed).toBe(true);
    await second;
    expect(boardDialogs()).toHaveLength(0);

    // Opening again uses the module already loaded.
    void dialogs.openBoard();
    await shown();
    expect(loadBoard).toHaveBeenCalledTimes(1);
  });

  it('a module that failed to load says so, and is loaded again on the next open', async () => {
    const dialogs = TestBed.inject(TopBarDialogs);
    loadBoard.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
    // Settles rather than rejects: every caller (the pill, Peripherals, Stats) gets the toast.
    await expect(dialogs.openBoard()).resolves.toBeUndefined();
    expect(toasts.error).toHaveBeenCalledExactlyOnceWith(
      'Could not open the board dialog. Reload the page to try again.',
    );
    expect(boardDialogs()).toHaveLength(0);

    void dialogs.openBoard();
    await shown();
    expect(loadBoard).toHaveBeenCalledTimes(2);
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });
});
