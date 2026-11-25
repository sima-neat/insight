import { Component, getDebugNode, signal } from '@angular/core';
import { deferred } from './board.testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatCallout } from '@sima/neat-ui/callout';
import { NeatConfirm } from '@sima/neat-ui/confirm';
import type { HostKeyChange } from './api';
import { BoardProblem } from './board-error';
import { BoardProblemNotice } from './board-problem-notice';

@Component({
  imports: [BoardProblemNotice],
  template: `
    <app-board-problem-notice
      [problem]="problem()"
      [busy]="busy()"
      [announce]="announce()"
      (trust)="trusted.push($event)"
    />
  `,
})
class Host {
  readonly problem = signal<BoardProblem>(new BoardProblem('', '', ''));
  readonly busy = signal(false);
  readonly announce = signal(false);
  readonly trusted: string[] = [];
}

/** A caller with an action of its own, as Peripherals passes Open board settings. */
@Component({
  imports: [BoardProblemNotice],
  template: `
    <app-board-problem-notice [problem]="problem()">
      <button neatCalloutActions type="button">Open board settings</button>
    </app-board-problem-notice>
  `,
})
class HostWithAction {
  readonly problem = signal<BoardProblem>(new BoardProblem('', '', ''));
}

const COMMAND = 'ssh-copy-id -p 22 sima@192.168.1.20';
const authFailed = new BoardProblem(
  'SSH key authentication as sima on 192.168.1.20 failed.',
  'auth_failed',
  "Insight signs in with the SSH keys of the 'root' account on this machine. Authorize one on the board, then retry.",
  null,
  COMMAND,
);
const keyChanged = (hostKey: HostKeyChange | null) =>
  new BoardProblem(
    '192.168.1.20 presented a different SSH host key than the one Insight trusted.',
    'host_key_changed',
    'This is expected after the board is reflashed.',
    hostKey,
  );
const EXPECTED = 'SHA256:oldoldoldoldoldoldoldoldoldoldoldoldoldold';
const PRESENTED = 'SHA256:newnewnewnewnewnewnewnewnewnewnewnewnewnew';
const HOST_KEY: HostKeyChange = { host: '192.168.1.20', expected: EXPECTED, presented: PRESENTED };

describe('BoardProblemNotice', () => {
  let fixture: ComponentFixture<Host>;
  let confirm: { ask: ReturnType<typeof vi.fn> };
  let writeText: ReturnType<typeof vi.fn>;
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    confirm = { ask: vi.fn(async () => false) };
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    TestBed.configureTestingModule({
      providers: [{ provide: NeatConfirm, useValue: confirm }],
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

  it('auth_failed shows the command that authorizes the key, with Copy', async () => {
    const callout = await show(authFailed);
    expect(tone(callout)).toBe('danger');
    expect(text(callout)).toContain('SSH key authentication as sima on 192.168.1.20 failed.');
    expect(text(callout)).toContain("Insight signs in with the SSH keys of the 'root' account");
    expect(text(callout.querySelector('neat-code-block code'))).toBe(COMMAND);

    const copy = button(callout, 'Copy');
    expect(copy.getAttribute('aria-label')).toBe('Copy command that authorizes the key');
    copy.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(COMMAND);

    // Without the command there is nothing to copy.
    const plain = await show(new BoardProblem(authFailed.message, 'auth_failed', ''));
    expect(plain.querySelector('code')).toBeNull();
    expect(plain.querySelector('button')).toBeNull();
  });

  it('host_key_changed shows both fingerprints; Trust asks first and trusts the presented key; Cancel changes nothing', async () => {
    const callout = await show(keyChanged(HOST_KEY));
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

  it('host_key_changed without the host key cannot be trusted, and says what is unknown', async () => {
    const callout = await show(keyChanged(null));
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
    await show(keyChanged({ ...HOST_KEY, host: '' }));
    button(fixture.nativeElement.querySelector('neat-callout'), 'Trust new key…').click();
    await settle();
    expect(confirm.ask.mock.calls[0][0].message).toMatch(
      /^Trust the new key only if this board was/,
    );
  });

  it('a key that changed again while the confirmation was open is not trusted', async () => {
    const callout = await show(keyChanged(HOST_KEY));
    const answer = deferred<boolean>();
    confirm.ask.mockReturnValue(answer.promise);
    button(callout, 'Trust new key…').click();
    await settle();

    // A re-read while the user compared fingerprints: the board now presents another key.
    await show(keyChanged({ ...HOST_KEY, presented: 'SHA256:other' }));
    answer.resolve(true);
    await settle();
    expect(fixture.componentInstance.trusted).toEqual([]);
  });

  it('says a problem as an alert only when asked to, for an action that just failed', async () => {
    const callout = await show(authFailed);
    expect(callout.getAttribute('role')).toBeNull();
    fixture.componentInstance.announce.set(true);
    await settle();
    expect(fixture.nativeElement.querySelector('neat-callout').getAttribute('role')).toBe('alert');
  });

  it("shows the caller's own actions with every problem, after its own", async () => {
    const withAction = TestBed.createComponent(HostWithAction);
    const actions = async (problem: BoardProblem) => {
      withAction.componentInstance.problem.set(problem);
      await new Promise((resolve) => setTimeout(resolve));
      await withAction.whenStable();
      const callout: HTMLElement = withAction.nativeElement.querySelector('neat-callout');
      return [...callout.querySelectorAll('[data-slot="callout-actions"] button')].map(text);
    };
    expect(await actions(keyChanged(HOST_KEY))).toEqual(['Trust new key…', 'Open board settings']);
    // The command's Copy sits beside the command, not among the actions.
    expect(await actions(authFailed)).toEqual(['Open board settings']);
    expect(await actions(new BoardProblem('Timed out.', 'timeout', ''))).toEqual([
      'Open board settings',
    ]);
  });

  it('other problems are a danger callout with the message and hint', async () => {
    const callout = await show(
      new BoardProblem(
        'Could not connect to 192.168.1.20:22: timed out',
        'unreachable',
        'Check that the board is powered on and on the network.',
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
