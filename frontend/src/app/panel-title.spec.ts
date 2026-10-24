import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { NeatTone } from '@sima/neat-ui';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { PanelTitle } from './panel-title';

@Component({
  imports: [PanelTitle],
  template: `<app-panel-title [chip]="chip()">src3</app-panel-title>`,
})
class Host {
  readonly chip = signal<{ label: string; tone: NeatTone }>({ label: 'Live', tone: 'success' });
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
});
