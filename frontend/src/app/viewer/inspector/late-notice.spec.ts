import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatDetails } from '@sima/neat-ui/details';
import type { NeatLateNoticeDetails } from '@sima/neat-ui/video';
import { LateNotice, type RaiseTarget } from './late-notice';

const RAISE: NeatLateNoticeDetails = {
  latenessMs: 120,
  latePercent: 64,
  bufferMs: 300,
  suggestedBufferMs: 450,
  blockedBy: null,
  globalAction: { kind: 'raise', valueMs: 450 },
};

@Component({
  imports: [LateNotice],
  template: `<app-late-notice [details]="details()" (raise)="raised.push($event)" />`,
})
class Host {
  readonly details = signal<NeatLateNoticeDetails>(RAISE);
  readonly raised: RaiseTarget[] = [];
}

describe('LateNotice', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ').trim() ?? '';
  /** The term → description pairs of the values list, a kit details list. */
  const values = () =>
    [
      ...(
        fixture.debugElement.query(By.directive(NeatDetails)).nativeElement as HTMLElement
      ).querySelectorAll('dt'),
    ].map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()]);
  const flat = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
  /** The text an element's `aria-describedby` points at. */
  const description = (element: Element) =>
    flat(root().querySelector(`#${element.getAttribute('aria-describedby')}`));
  const actions = () => [...root().querySelectorAll<HTMLButtonElement>('button')];
  const action = (label: string) =>
    actions().find((button) => button.textContent?.includes(label))!;

  async function show(details: Partial<NeatLateNoticeDetails>): Promise<void> {
    fixture.componentInstance.details.set({ ...RAISE, ...details });
    await fixture.whenStable();
  }

  it('says what is wrong and shows the measured values', () => {
    expect(root().querySelector('[role="heading"][aria-level="3"]')?.textContent?.trim()).toBe(
      'Overlays are being dropped',
    );
    expect(text()).toContain('Metadata arrives after its video frame was already shown.');
    expect(values()).toEqual([
      ['Arrives after its frame', '~120 ms'],
      ['Video sync buffer', '300 ms'],
      ['Late messages', '64 %'],
    ]);
  });

  it('is a region named by its heading, so it can be jumped to', () => {
    const region = root().querySelector('[role="region"]')!;
    const heading = root().querySelector('[role="heading"]')!;

    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(flat(heading)).toBe('Overlays are being dropped');
  });

  it('shows unmeasured values as such', async () => {
    await show({ latenessMs: null, latePercent: null });

    expect(values()).toEqual([
      ['Arrives after its frame', 'not measured'],
      ['Video sync buffer', '300 ms'],
      ['Late messages', '—'],
    ]);
  });

  it('offers to raise for this channel or globally, each saying what it changes', async () => {
    expect(actions().map((button) => [flat(button), description(button)])).toEqual([
      ['Raise for this channel to 450 ms', 'Other channels keep their setting.'],
      ['Raise globally to 450 ms', 'Applies to every channel without its own value.'],
    ]);

    action('Raise for this channel').click();
    action('Raise globally').click();
    expect(fixture.componentInstance.raised).toEqual(['channel', 'global']);
  });

  it('offers the global value instead when it already covers the suggestion', async () => {
    await show({ globalAction: { kind: 'follow', valueMs: 500 } });

    const follow = action('Use global value');
    expect(flat(follow)).toBe('Use global value (500 ms)');
    expect(description(follow)).toBe("Removes this channel's own value.");
    follow.click();
    expect(fixture.componentInstance.raised).toEqual(['global']);
  });

  it.each([
    [
      'maximum',
      'The buffer needed exceeds the 4000 ms maximum. The application must send metadata sooner.',
    ],
    ['unsupported', 'This browser cannot delay video; overlays cannot be synchronized.'],
    [
      'unmeasured',
      'Lateness could not be measured. The metadata does not belong to the frames that were shown.',
    ],
  ] as const)('blocked by %s, says why and offers nothing', async (blockedBy, reason) => {
    await show({ blockedBy, suggestedBufferMs: null, globalAction: null });

    expect(text()).toContain(reason);
    expect(actions()).toEqual([]);
  });
});
