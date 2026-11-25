import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { PanelTitle, type PanelChip } from './panel-title';

@Component({
  imports: [PanelTitle],
  template: `<app-panel-title [chip]="chip()"
    >src3<button panelTitleEnd type="button">Extra</button></app-panel-title
  >`,
})
class Host {
  readonly chip = signal<PanelChip | null>({ label: 'Live', tone: 'success' });
}

describe('PanelTitle', () => {
  it("names the panel's subject in its heading, with its state as a chip beside it", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const title: HTMLElement = fixture.nativeElement.querySelector('app-panel-title');
    const heading = title.querySelector('h2')!;
    expect(heading.textContent!.trim()).toBe('src3');
    expect(heading.hasAttribute('neatAsideTitle')).toBe(true);
    // The chip is beside the heading, not in it: the heading names the subject only.
    expect(heading.querySelector('neat-status-chip')).toBeNull();
    const chip = fixture.debugElement.query(By.directive(NeatStatusChip));
    expect(chip.nativeElement.textContent.trim()).toBe('Live');
    expect(chip.componentInstance.tone()).toBe('success');

    fixture.componentInstance.chip.set({ label: 'Idle', tone: 'neutral' });
    await fixture.whenStable();
    expect(chip.nativeElement.textContent.trim()).toBe('Idle');
    expect(chip.componentInstance.tone()).toBe('neutral');
  });

  it('puts an element marked panelTitleEnd after the chip, outside the heading', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const title: HTMLElement = fixture.nativeElement.querySelector('app-panel-title');
    const extra = title.querySelector('button[panelTitleEnd]')!;
    expect(title.querySelector('h2')!.contains(extra)).toBe(false);
    expect(
      title.querySelector('neat-status-chip')!.compareDocumentPosition(extra) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(title.querySelector('h2')!.textContent!.trim()).toBe('src3');
  });

  it('shows no chip while there is none, and shows it again when one comes', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.chip.set(null);
    await fixture.whenStable();
    const title: HTMLElement = fixture.nativeElement.querySelector('app-panel-title');
    expect(title.querySelector('h2')!.textContent!.trim()).toBe('src3');
    expect(title.querySelector('neat-status-chip')).toBeNull();

    fixture.componentInstance.chip.set({ label: '2 warnings', tone: 'warning' });
    await fixture.whenStable();
    expect(title.querySelector('neat-status-chip')!.textContent!.trim()).toBe('2 warnings');
  });
});
