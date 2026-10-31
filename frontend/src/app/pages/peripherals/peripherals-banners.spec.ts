import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { NeatTone } from '@sima/neat-ui';
import { NeatCallout } from '@sima/neat-ui/callout';
import { AppDialogs } from '../../app-dialogs';
import { BoardProblem } from '../../board/board-error';
import { BoardService } from '../../board/board.service';
import { boardState, DEVKIT, FakeBoard } from '../../board/board.testing';
import type { PeripheralSnapshot } from '../../peripherals/api';
import { imx477, usb } from '../../peripherals/cameras.testing';
import { PeripheralsService } from '../../peripherals/peripherals.service';
import { peripheralSnapshot } from '../../peripherals/snapshots.testing';
import { PeripheralsBanners } from './peripherals-banners';

/** `PeripheralsService` as the banners read it. */
class FakePeripherals {
  readonly snapshot = signal<PeripheralSnapshot | null>(null);
  readonly scanning = signal<number | null>(null);
  readonly scanError = signal<BoardProblem | null>(null);
}

@Component({
  imports: [PeripheralsBanners],
  template: `<app-peripherals-banners
    [loadError]="loadError()"
    (refresh)="refreshes = refreshes + 1"
  />`,
})
class Host {
  readonly loadError = signal<BoardProblem | null>(null);
  refreshes = 0;
}

const unreachable = new BoardProblem(
  'Could not connect to sima@192.168.1.20.',
  'unreachable',
  '',
  {},
);

describe('PeripheralsBanners', () => {
  let board: FakeBoard;
  let peripherals: FakePeripherals;
  let dialogs: { openBoard: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    board = new FakeBoard();
    board.state.set(boardState({ target: DEVKIT, generation: 3 }));
    peripherals = new FakePeripherals();
    dialogs = { openBoard: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        { provide: BoardService, useValue: board },
        { provide: PeripheralsService, useValue: peripherals },
        { provide: AppDialogs, useValue: dialogs },
      ],
    });
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  const settle = () => fixture.whenStable();
  const callouts = () => fixture.debugElement.queryAll(By.directive(NeatCallout));
  const headingOf = (callout: HTMLElement) =>
    callout.querySelector('[role="heading"]')?.textContent?.trim() ?? '';
  /** Each callout as its tone, heading, body text and live role, in the order shown. */
  const shown = () =>
    callouts().map((debug) => {
      const host = debug.nativeElement as HTMLElement;
      const instance = debug.componentInstance as NeatCallout;
      const body = host.querySelector('[data-slot="callout-body"]');
      return {
        tone: instance.tone() as NeatTone,
        heading: headingOf(host),
        body: [...(body?.children ?? [])].map((line) => line.textContent?.trim()),
        role: host.getAttribute('role'),
      };
    });
  const button = (label: string): HTMLButtonElement | undefined =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  it('shows nothing for a scan of the selected board that went well', async () => {
    peripherals.snapshot.set(peripheralSnapshot([imx477]));
    await settle();
    expect(callouts()).toHaveLength(0);
  });

  it('board changed: a warning naming both boards, with Refresh now while a board is selected', async () => {
    peripherals.snapshot.set(peripheralSnapshot([imx477]));
    board.state.set(
      boardState({
        target: { ...DEVKIT, host: '10.0.0.9', label: 'sima@10.0.0.9' },
        generation: 4,
      }),
    );
    await settle();
    expect(shown()).toEqual([
      {
        tone: 'warning',
        heading: 'Board changed — refresh',
        body: [
          'These results are from sima@192.168.1.20; the selected board is now sima@10.0.0.9. Preview is disabled until you refresh.',
        ],
        role: null,
      },
    ]);
    button('Refresh now')!.click();
    expect(fixture.componentInstance.refreshes).toBe(1);

    // While a scan runs, Refresh now waits with it.
    peripherals.scanning.set(Date.now());
    await settle();
    expect(button('Refresh now')!.getAttribute('aria-disabled')).toBe('true');

    board.state.set(boardState({ target: null, generation: 5 }));
    await settle();
    expect(shown()[0].body).toEqual([
      'These results are from sima@192.168.1.20; the selected board is now not set. Preview is disabled until you refresh.',
    ]);
    expect(button('Refresh now')).toBeUndefined();
  });

  it('a scan failure is an alert; a connection failure adds the fallback hint and Open board settings', async () => {
    peripherals.scanError.set(unreachable);
    await settle();
    expect(shown()).toEqual([
      {
        tone: 'danger',
        heading: 'Scan failed: Could not connect to sima@192.168.1.20.',
        body: ['Insight could not reach the board.'],
        role: 'alert',
      },
    ]);
    button('Open board settings')!.click();
    expect(dialogs.openBoard).toHaveBeenCalledTimes(1);

    // The backend's own hint wins over the fallback.
    peripherals.scanError.set(
      new BoardProblem('Host key changed.', 'host_key_changed', 'Trust the new key.', {}),
    );
    await settle();
    expect(shown()[0].body).toEqual(['Trust the new key.']);

    // Any other failure has its hint and no board settings: they would not help.
    peripherals.scanError.set(
      new BoardProblem('SiMa Sentinel is not installed.', 'peripheral_tool_missing', '', {}),
    );
    await settle();
    expect(shown()).toEqual([
      {
        tone: 'danger',
        heading: 'Scan failed: SiMa Sentinel is not installed.',
        body: [],
        role: 'alert',
      },
    ]);
    expect(button('Open board settings')).toBeUndefined();
  });

  // Ruling Q9: Peripherals says what failed (Review Focus 4).
  it('a failed read of the peripherals says what failed, with its hint', async () => {
    fixture.componentInstance.loadError.set(
      new BoardProblem('Internal Server Error', '', 'Check the Insight log.', {}),
    );
    await settle();
    expect(shown()).toEqual([
      {
        tone: 'danger',
        heading: 'Could not load peripherals: Internal Server Error',
        body: ['Check the Insight log.'],
        role: 'alert',
      },
    ]);
  });

  it('the change summary is one status line per change; each issue is a callout, errors first, toned by severity', async () => {
    peripherals.snapshot.set(
      peripheralSnapshot([imx477], {
        changes: {
          added: [{ id: imx477.id, name: 'imx477' }],
          removed: [{ id: usb.id, name: usb.name }],
        },
        issues: [
          { severity: 'info', code: 'a', message: 'USB hub reports low power.', hint: null },
          {
            severity: 'error',
            code: 'b',
            message: 'v4l2-ctl is missing.',
            hint: 'Install v4l-utils.',
          },
          { severity: 'warning', code: 'c', message: 'Camera overlays unknown.', hint: null },
        ],
      }),
    );
    await settle();
    expect(shown()).toEqual([
      {
        tone: 'info',
        heading: '',
        body: ['Disconnected since last refresh: HD Webcam C270', 'New: imx477'],
        role: 'status',
      },
      {
        tone: 'danger',
        heading: 'Error',
        body: ['v4l2-ctl is missing.', 'Install v4l-utils.'],
        role: null,
      },
      { tone: 'warning', heading: 'Warning', body: ['Camera overlays unknown.'], role: null },
      { tone: 'info', heading: 'Info', body: ['USB hub reports low power.'], role: null },
    ]);
  });

  it('shows the banners in the order board changed, load failure, scan failure, changes, issues', async () => {
    peripherals.snapshot.set(
      peripheralSnapshot([imx477], {
        changes: { added: [{ id: imx477.id, name: 'imx477' }], removed: [] },
        issues: [
          { severity: 'warning', code: 'c', message: 'Camera overlays unknown.', hint: null },
        ],
      }),
    );
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    peripherals.scanError.set(unreachable);
    fixture.componentInstance.loadError.set(new BoardProblem('Bad Gateway', '', '', {}));
    await settle();
    expect(shown().map((callout) => callout.heading)).toEqual([
      'Board changed — refresh',
      'Could not load peripherals: Bad Gateway',
      'Scan failed: Could not connect to sima@192.168.1.20.',
      '',
      'Warning',
    ]);
  });
});
