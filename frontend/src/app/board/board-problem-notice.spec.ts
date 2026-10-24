import { Component, getDebugNode, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import { NeatToasts } from '@sima/neat-ui/toast';
import { BoardProblem } from './board-error';
import { BoardProblemNotice } from './board-problem-notice';

@Component({
  imports: [BoardProblemNotice],
  template: `
    <app-board-problem-notice
      [problem]="problem()"
      [busy]="busy()"
      (trust)="trusted.push($event)"
    />
  `,
})
class Host {
  readonly problem = signal<BoardProblem>(new BoardProblem('', '', '', {}));
  readonly busy = signal(false);
  readonly trusted: string[] = [];
}

const COMMAND = 'ssh-copy-id -p 22 sima@192.168.1.20';
const authFailed = new BoardProblem(
  'SSH key authentication as sima on 192.168.1.20 failed.',
  'auth_failed',
  `Insight signs in with the SSH keys of the 'root' account on this machine. Authorize one on the board, then retry: ${COMMAND}`,
  { command: COMMAND },
);
const keyChanged = (details: Record<string, unknown>) =>
  new BoardProblem(
    '192.168.1.20 presented a different SSH host key than the one Insight trusted.',
    'host_key_changed',
    'This is expected after the board is reflashed.',
    details,
  );
const EXPECTED = 'SHA256:oldoldoldoldoldoldoldoldoldoldoldoldoldold';
const PRESENTED = 'SHA256:newnewnewnewnewnewnewnewnewnewnewnewnewnew';

describe('BoardProblemNotice', () => {
  let fixture: ComponentFixture<Host>;
  let toasts: { status: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let confirm: { ask: ReturnType<typeof vi.fn> };
  let writeText: ReturnType<typeof vi.fn>;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    toasts = { status: vi.fn(), error: vi.fn() };
    confirm = { ask: vi.fn(async () => false) };
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    TestBed.configureTestingModule({
      providers: [
        { provide: NeatToasts, useValue: toasts },
        { provide: NeatConfirm, useValue: confirm },
      ],
    });
    fixture = TestBed.createComponent(Host);
  });

  afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  async function show(problem: BoardProblem): Promise<HTMLElement> {
    fixture.componentInstance.problem.set(problem);
    await settle();
    return fixture.nativeElement.querySelector('neat-callout');
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  }

  const text = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const tone = (callout: HTMLElement) =>
    (getDebugNode(callout)!.componentInstance as NeatCallout).tone();
  const button = (callout: HTMLElement, name: string) =>
    [...callout.querySelectorAll<HTMLButtonElement>('button')].find((one) => text(one) === name)!;
  const facts = (callout: HTMLElement) =>
    [...callout.querySelectorAll('dl dt')].map((term) => [
      text(term),
      text(term.nextElementSibling),
    ]);

  it('auth_failed shows the ssh-copy-id command with Copy; a refused clipboard says so', async () => {
    const callout = await show(authFailed);
    expect(tone(callout)).toBe('danger');
    expect(text(callout)).toContain('SSH key authentication as sima on 192.168.1.20 failed.');
    expect(text(callout)).toContain("Insight signs in with the SSH keys of the 'root' account");
    expect(text(callout.querySelector('code[neatCode]'))).toBe(COMMAND);

    button(callout, 'Copy command').click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(toasts.status).toHaveBeenCalledWith(`Copied: ${COMMAND}`);

    writeText.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
    button(callout, 'Copy command').click();
    await settle();
    expect(toasts.error).toHaveBeenCalledWith(
      'Could not copy: the browser only allows clipboard access over HTTPS or localhost. Select the text and copy it instead.',
    );

    // Without the command (an older Insight) there is nothing to copy.
    const plain = await show(new BoardProblem(authFailed.message, 'auth_failed', '', {}));
    expect(plain.querySelector('code')).toBeNull();
    expect(text(plain)).not.toContain('Copy command');
  });

  it('host_key_changed shows both fingerprints; Trust asks first and trusts the presented key; Cancel changes nothing', async () => {
    const callout = await show(
      keyChanged({
        host: '192.168.1.20',
        expected_fingerprint: EXPECTED,
        presented_fingerprint: PRESENTED,
      }),
    );
    expect(tone(callout)).toBe('warning');
    expect(text(callout)).toContain('presented a different SSH host key');
    expect(facts(callout)).toEqual([
      ['Expected', EXPECTED],
      ['Presented', PRESENTED],
    ]);

    // Cancel: nothing is trusted.
    button(callout, 'Trust new key…').click();
    await settle();
    expect(confirm.ask).toHaveBeenCalledWith({
      title: 'Trust the new host key?',
      message:
        'Trust the new key only if 192.168.1.20 was reflashed or replaced. Otherwise a different device may be answering at this address.',
      confirmLabel: 'Trust new key',
      tone: 'danger',
    });
    expect(fixture.componentInstance.trusted).toEqual([]);

    confirm.ask.mockResolvedValueOnce(true);
    button(callout, 'Trust new key…').click();
    await settle();
    expect(fixture.componentInstance.trusted).toEqual([PRESENTED]);

    // While a board action runs, Trust waits.
    fixture.componentInstance.busy.set(true);
    await settle();
    expect(button(callout, 'Trust new key…').getAttribute('aria-disabled')).toBe('true');
    button(callout, 'Trust new key…').click();
    await settle();
    expect(confirm.ask).toHaveBeenCalledTimes(2);
  });

  it('host_key_changed without a presented key cannot be trusted, and says what is unknown', async () => {
    const callout = await show(keyChanged({}));
    expect(facts(callout)).toEqual([
      ['Expected', 'unknown'],
      ['Presented', 'unknown'],
    ]);
    expect(button(callout, 'Trust new key…').disabled).toBe(true);
    confirm.ask.mockResolvedValue(true);
    button(callout, 'Trust new key…').click();
    await settle();
    expect(confirm.ask).not.toHaveBeenCalled();

    // The confirmation names the board as "this board" when the host is unknown.
    await show(keyChanged({ presented_fingerprint: PRESENTED }));
    button(fixture.nativeElement.querySelector('neat-callout'), 'Trust new key…').click();
    await settle();
    expect(confirm.ask.mock.calls[0][0].message).toMatch(
      /^Trust the new key only if this board was/,
    );
  });

  it('other problems are a danger callout with the message and hint', async () => {
    const callout = await show(
      new BoardProblem(
        'Could not connect to 192.168.1.20:22: timed out',
        'unreachable',
        'Check that the board is powered on and on the network.',
        {},
      ),
    );
    expect(tone(callout)).toBe('danger');
    expect([...callout.querySelectorAll('p')].map((line) => text(line))).toEqual([
      'Could not connect to 192.168.1.20:22: timed out',
      'Check that the board is powered on and on the network.',
    ]);
    expect(callout.querySelector('button')).toBeNull();
  });
});
