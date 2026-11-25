import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { DeviceError } from '../../peripherals/api';
import { DeviceErrors } from './device-errors';

@Component({
  imports: [DeviceErrors],
  template: `<app-device-errors [errors]="errors()" />`,
})
class Host {
  readonly errors = signal<DeviceError[]>([]);
}

describe('DeviceErrors', () => {
  it('shows each problem the backend reports with a device as a danger callout, its hint the body', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const callouts = () =>
      [...fixture.nativeElement.querySelectorAll('neat-callout')].map((callout: Element) => ({
        heading: callout.querySelector('[role="heading"]')?.textContent?.trim(),
        body: callout.querySelector('p')?.textContent?.trim() ?? null,
        level: callout.querySelector('[role="heading"]')?.getAttribute('aria-level'),
      }));
    expect(callouts()).toEqual([]);

    fixture.componentInstance.errors.set([
      {
        code: 'no_modes',
        message: 'SiMa Sentinel reported no modes for this camera.',
        hint: 'Run sima-sentinel status on the board.',
      },
      {
        code: 'capture_unreadable',
        message: 'The capture formats could not be read.',
        hint: 'Refresh once the device has started.',
      },
    ]);
    await fixture.whenStable();
    // Callouts in a side panel, under its level 2 title.
    expect(callouts()).toEqual([
      {
        heading: 'SiMa Sentinel reported no modes for this camera.',
        body: 'Run sima-sentinel status on the board.',
        level: '3',
      },
      {
        heading: 'The capture formats could not be read.',
        body: 'Refresh once the device has started.',
        level: '3',
      },
    ]);
  });
});
