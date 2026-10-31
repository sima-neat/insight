import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
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
  let loadSystemInfo: ReturnType<typeof vi.fn>;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // The real module, counted: whether it loads, and how often, is what this spec is about.
    loadBoard = vi.fn(() => import('./board/board-dialog'));
    loadSystemInfo = vi.fn(() => import('./system-info/system-info-dialog'));
    toasts = { status: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: TOP_BAR_DIALOG_MODULES,
          useValue: { board: loadBoard, systemInfo: loadSystemInfo },
        },
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

  const dialogs = (selector: string) => document.querySelectorAll(selector);
  /** Waits for the module to load (a dynamic import takes a few turns) and the dialog to show. */
  const shown = (selector: string) => vi.waitFor(() => expect(dialogs(selector)).toHaveLength(1));

  /** Each dialog: how it is opened, its module's loader, and the element that shows it. */
  const cases = [
    {
      name: 'board',
      selector: 'app-board-dialog',
      open: (top: TopBarDialogs) => top.openBoard(),
      loader: () => loadBoard,
      failure: 'Could not open the board dialog. Reload the page to try again.',
    },
    {
      name: 'System Info',
      selector: 'app-system-info-dialog',
      open: (top: TopBarDialogs) => top.openSystemInfo(),
      loader: () => loadSystemInfo,
      failure: 'Could not open the System information dialog. Reload the page to try again.',
    },
  ];

  it('TopBarDialogs loads each dialog module on first open only', async () => {
    const top = TestBed.inject(TopBarDialogs);
    await settle();
    expect(loadBoard).not.toHaveBeenCalled();
    expect(loadSystemInfo).not.toHaveBeenCalled();

    for (const { selector, open, loader } of cases) {
      // Its module stays unloaded until this dialog is opened, whatever else was.
      expect(loader()).not.toHaveBeenCalled();
      // A double click: the second call, while the first is loading or open, does nothing.
      const first = open(top);
      const second = open(top);
      await shown(selector);
      await settle();
      expect(loader()).toHaveBeenCalledTimes(1);
      expect(dialogs(selector)).toHaveLength(1);
      let closed = false;
      void first.then(() => (closed = true));

      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(closed).toBe(true);
      await second;
      expect(dialogs(selector)).toHaveLength(0);

      // Opening again uses the module already loaded.
      void open(top);
      await shown(selector);
      expect(loader()).toHaveBeenCalledTimes(1);
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
    }
  });

  for (const { name, selector, open, loader, failure } of cases) {
    it(`a ${name} module that failed to load says so, and is loaded again on the next open`, async () => {
      const top = TestBed.inject(TopBarDialogs);
      loader().mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'));
      // Settles rather than rejects: every caller (the board block, System information, Peripherals, Stats) gets the toast.
      await expect(open(top)).resolves.toBeUndefined();
      expect(toasts.error).toHaveBeenCalledExactlyOnceWith(failure);
      expect(dialogs(selector)).toHaveLength(0);

      void open(top);
      await shown(selector);
      expect(loader()).toHaveBeenCalledTimes(2);
      expect(toasts.error).toHaveBeenCalledTimes(1);
    });
  }
});
