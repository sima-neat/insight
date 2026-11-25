import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { BoardList } from './api';
import { BoardProblem } from './board-error';
import { type BoardAction, BoardForm } from './board-form';
import { BoardService } from './board.service';
import { boardList, boardWith, deferred, DEVKIT, FakeBoard, MANUAL } from './board.testing';

/** The dialog's side of the form: the one action running, and whether a selection went through. */
@Component({
  imports: [BoardForm],
  template: `<app-board-form [(busy)]="busy" (selected)="selections = selections + 1" />`,
})
class Host {
  readonly busy = signal<BoardAction | null>(null);
  selections = 0;
}

/** The board entered by hand, selected, with the paired DevKit to fall back to. */
const ENTERED = boardList([MANUAL, DEVKIT]);

describe('BoardForm', () => {
  let board: FakeBoard;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    board = new FakeBoard();
    toasts = { status: vi.fn(), error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: BoardService, useValue: board },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  async function render(state: BoardList): Promise<HTMLElement> {
    board.state.set(state);
    fixture = TestBed.createComponent(Host);
    await settle();
    return fixture.nativeElement;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** Text pieces joined by spaces, as a label and the summary beside it read. */
  const words = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const pieces: string[] = [];
    while (walker.nextNode()) pieces.push(walker.currentNode.textContent ?? '');
    return pieces
      .map((piece) => piece.trim())
      .filter(Boolean)
      .join(' ');
  };
  const trigger = () => root().querySelector<HTMLButtonElement>('neat-collapsible button')!;
  const isOpen = () => trigger().getAttribute('aria-expanded') === 'true';
  const field = (name: string) =>
    [...root().querySelectorAll('label')]
      .find((label) => text(label).startsWith(name))!
      .querySelector('input')!;
  const button = (name: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('form button')].find(
      (one) => text(one) === name,
    );
  const errorNote = () => text(root().querySelector('neat-error-note'));
  const hint = () => text(root().querySelector('form p[neatNote]'));

  async function type(name: string, value: string): Promise<void> {
    const input = field(name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function press(name: string): Promise<void> {
    const target = button(name)!;
    target.focus();
    target.click();
    await settle();
  }

  it('Change board is open without a board and shows the default hint', async () => {
    await render(boardList());
    // Open, so the summary is hidden.
    expect(words(trigger())).toBe('Change board');
    expect(isOpen()).toBe(true);
    expect(hint()).toBe(
      'Default: none (Insight is not on a board and the SDK is not paired with a DevKit).',
    );
    expect(field('Host or IP address').placeholder).toBe('192.168.2.2');
    expect(field('SSH port').getAttribute('inputmode')).toBe('numeric');
    expect([
      field('Host or IP address').value,
      field('SSH port').value,
      field('User').value,
    ]).toEqual(['', '22', 'sima']);
    // Nothing to go back to: no Cancel.
    expect(button('Cancel')).toBeUndefined();
  });

  it('with a board it starts closed, from the board in use, with the default it falls back to', async () => {
    await render(boardWith(DEVKIT));
    expect(isOpen()).toBe(false);
    expect(words(trigger())).toBe('Change board Host, port, user');

    trigger().click();
    await settle();
    expect(hint()).toBe('Default: sima@192.168.1.20:22 (paired SDK DevKit).');
    expect([
      field('Host or IP address').value,
      field('SSH port').value,
      field('User').value,
    ]).toEqual(['192.168.1.20', '22', 'sima']);

    // Cancel closes and forgets what was typed.
    await type('Host or IP address', '10.9.9.9');
    await press('Cancel');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
    trigger().click();
    await settle();
    expect(field('Host or IP address').value).toBe('192.168.1.20');
  });

  it('Save validates, selects, toasts, closes and returns focus to the trigger', async () => {
    await render(boardWith(DEVKIT));
    trigger().click();
    await settle();

    const refusals: [string, string, string][] = [
      ['Host or IP address', ' ', 'Enter the board host name or IP address.'],
      ['Host or IP address', 'dev kit', 'The host cannot contain spaces.'],
      ['SSH port', '70000', 'The SSH port must be a whole number from 1 to 65535.'],
      ['User', '', 'Enter the SSH user, usually "sima".'],
    ];
    for (const [name, value, message] of refusals) {
      await type(name, value);
      await press('Save');
      expect(errorNote()).toBe(message);
      if (name === 'Host or IP address') await type(name, '10.0.0.5');
      if (name === 'SSH port') await type(name, '2222');
    }
    expect(board.select).not.toHaveBeenCalled();

    await type('User', 'sima');
    const answer = deferred<BoardList>();
    board.select.mockReturnValue(answer.promise);
    await press('Save');
    expect(board.select).toHaveBeenCalledWith({ host: '10.0.0.5', port: 2222, user: 'sima' });
    expect(errorNote()).toBe('');
    // One action at a time: the dialog sees the save, and the form says it runs.
    expect(fixture.componentInstance.busy()).toBe('select');
    expect(button('Saving…')).toBeDefined();
    // Cancel waits too: closing now would hide a refusal that arrives later.
    expect(button('Cancel')!.getAttribute('aria-disabled')).toBe('true');
    button('Cancel')!.click();
    await settle();
    expect(isOpen()).toBe(true);

    board.state.set(ENTERED);
    answer.resolve(ENTERED);
    await settle();
    expect(toasts.status).toHaveBeenCalledWith(
      'Board set to sima@10.0.0.5:2222. Check again to test the connection.',
    );
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
    expect(fixture.componentInstance.busy()).toBeNull();
    expect(fixture.componentInstance.selections).toBe(1);
  });

  it('waits while another board action runs', async () => {
    await render(boardList());
    fixture.componentInstance.busy.set('check');
    await settle();
    expect(button('Save')!.getAttribute('aria-disabled')).toBe('true');
    board.select.mockResolvedValue(boardList());
    await press('Save');
    expect(board.select).not.toHaveBeenCalled();
  });

  it('Use default shows only with a board entered by hand, and forgets it', async () => {
    await render(boardWith(DEVKIT));
    trigger().click();
    await settle();
    expect(button('Use default')).toBeUndefined();

    // The board read again with one entered by hand: the section stays as the user left it.
    board.state.set(ENTERED);
    await settle();
    expect(isOpen()).toBe(true);
    trigger().click();
    await settle();
    // The summary shows while closed.
    expect(words(trigger())).toBe('Change board Host, port, user · Use default');
    trigger().click();
    await settle();

    const paired = boardWith(DEVKIT);
    board.forget.mockImplementation(async () => {
      board.state.set(paired);
      return paired;
    });
    await press('Use default');
    expect(board.forget).toHaveBeenCalled();
    expect(toasts.status).toHaveBeenCalledWith('Using sima@192.168.1.20.');
    expect(isOpen()).toBe(false);
    expect(fixture.componentInstance.selections).toBe(1);

    // Without a default to fall back to, no board is left: the form stays open to enter one.
    board.state.set(boardList([MANUAL]));
    await settle();
    trigger().click();
    await settle();
    const none = boardList();
    board.forget.mockImplementation(async () => {
      board.state.set(none);
      return none;
    });
    await press('Use default');
    expect(toasts.status).toHaveBeenLastCalledWith('Manual board cleared.');
    expect(isOpen()).toBe(true);
    // Use default and Cancel went with the entered board; the next step is to enter a board.
    expect(document.activeElement).toBe(field('Host or IP address'));
  });

  it('a server refusal stays under the form', async () => {
    await render(boardList());
    await type('Host or IP address', 'board_7');
    board.select.mockRejectedValue(
      new BoardProblem(
        "Enter the board's IP address or host name.",
        'invalid_request',
        'For example 192.168.2.2',
      ),
    );
    await press('Save');
    expect(errorNote()).toBe("Enter the board's IP address or host name. For example 192.168.2.2");
    expect(isOpen()).toBe(true);
    expect(field('Host or IP address').value).toBe('board_7');
    expect(toasts.status).not.toHaveBeenCalled();
    expect(fixture.componentInstance.selections).toBe(0);
    expect(fixture.componentInstance.busy()).toBeNull();

    // The next attempt starts clean.
    board.select.mockResolvedValue(ENTERED);
    await press('Save');
    expect(errorNote()).toBe('');
  });

  it('a refusal goes when the board changes otherwise', async () => {
    await render(boardList());
    board.select.mockRejectedValue(new BoardProblem('Enter a valid SSH user name.', '', ''));
    await type('Host or IP address', '10.0.0.4');
    await press('Save');
    expect(errorNote()).toBe('Enter a valid SSH user name.');

    // Another tab or a terminal selected a board meanwhile; the refusal was about the old one.
    board.state.set(boardWith(DEVKIT));
    await settle();
    expect(errorNote()).toBe('');
  });
});
