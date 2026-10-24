import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SlotsNotice } from './slots-notice';
import { SlotsService } from './slots.service';

describe('SlotsNotice', () => {
  it('says the slot status is stale while it could not be refreshed, in a live region that stays', async () => {
    const unavailable = signal(false);
    TestBed.configureTestingModule({
      providers: [{ provide: SlotsService, useValue: { unavailable } }],
    });
    const fixture = TestBed.createComponent(SlotsNotice);
    await fixture.whenStable();
    const status = (): HTMLElement => fixture.nativeElement.querySelector('[role="status"]');
    expect(status().textContent!.trim()).toBe('');

    unavailable.set(true);
    await fixture.whenStable();
    expect(status().textContent!.trim()).toBe(
      'Slot status could not be refreshed. Showing the last known state.',
    );

    const region = status();
    unavailable.set(false);
    await fixture.whenStable();
    expect(status()).toBe(region);
    expect(region.textContent!.trim()).toBe('');
  });
});
