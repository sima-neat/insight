import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { BoardProblem } from '../../board/board-error';
import { failureOf, type SentinelFailure } from '../../stats/sentinel-failure';
import { SentinelFailureCallout } from './sentinel-failure-callout';

/** A read failure of `code` as `failureOf` words it. */
function failure(code: string, hint = ''): SentinelFailure {
  return failureOf(new BoardProblem(`Failed with ${code}.`, code, hint), 'local');
}

describe('SentinelFailureCallout', () => {
  let fixture: ComponentFixture<SentinelFailureCallout>;
  let retries: number;

  async function show(inputs: Record<string, unknown>): Promise<void> {
    fixture = TestBed.createComponent(SentinelFailureCallout);
    retries = 0;
    fixture.componentInstance.retry.subscribe(() => retries++);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const text = (element: Element | null | undefined): string =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const heading = () => root().querySelector('neat-callout [role="heading"]');
  const button = () => root().querySelector<HTMLButtonElement>('neat-callout button');

  it('says what failed as a heading, with the backend’s message and the hint', async () => {
    await show({ failure: failure('timeout', 'Check the board is awake.'), headingLevel: 2 });
    expect(text(heading())).toBe('The board took too long to answer');
    expect(heading()!.getAttribute('aria-level')).toBe('2');
    expect([...root().querySelectorAll('neat-callout p')].map(text)).toEqual([
      'Failed with timeout.',
      'Check the board is awake.',
    ]);
    expect(root().querySelector('neat-callout [neatNote]')).not.toBeNull();
  });

  it('is announced as an alert when it appears, labelled by its heading', async () => {
    await show({ failure: failure('timeout') });
    const callout = root().querySelector('neat-callout')!;
    expect(callout.getAttribute('role')).toBe('alert');
    expect(callout.getAttribute('aria-labelledby')).toBe(heading()!.id);
  });

  it('leaves out a hint it has none of, and its heading is level 3 by default', async () => {
    await show({ failure: failure('bad_response') });
    expect(heading()!.getAttribute('aria-level')).toBe('3');
    expect(root().querySelector('neat-callout [neatNote]')).toBeNull();
  });

  it('offers Retry where asking again can help, and none where the fix lies elsewhere', async () => {
    await show({ failure: failure('timeout') });
    expect(text(button())).toBe('Retry');
    button()!.click();
    expect(retries).toBe(1);

    fixture.componentRef.setInput('failure', failure('auth_failed'));
    await fixture.whenStable();
    expect(button()).toBeNull();
  });

  it('while busy, Retry says so and waits with aria-disabled, keeping the focus', async () => {
    await show({ failure: failure('timeout'), busy: true });
    expect(text(button())).toBe('Retrying…');
    expect(button()!.disabled).toBe(false);
    expect(button()!.getAttribute('aria-disabled')).toBe('true');
    expect(root().querySelector('neat-callout')!.getAttribute('aria-busy')).toBe('true');
    button()!.click();
    expect(retries).toBe(0);

    fixture.componentRef.setInput('busy', false);
    await fixture.whenStable();
    expect(text(button())).toBe('Retry');
    expect(button()!.getAttribute('aria-disabled')).toBeNull();
    expect(root().querySelector('neat-callout')!.getAttribute('aria-busy')).toBeNull();
  });
});
