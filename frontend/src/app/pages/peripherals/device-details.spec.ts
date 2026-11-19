import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { OtherItem, PeripheralItem } from '../../peripherals/api';
import { imx568, usb } from '../../peripherals/cameras.testing';
import { onboardMic } from '../../peripherals/microphones.testing';
import { DeviceDetails } from './device-details';

@Component({
  imports: [DeviceDetails],
  template: `<app-device-details [item]="item()" />`,
})
class Host {
  readonly item = signal<PeripheralItem>(usb);
}

/** A device of a kind Insight has no view for, with nothing to say about it. */
const bare: OtherItem = {
  id: 'future:1',
  kind: 'future_sensor',
  connection: 'future',
  name: 'Future sensor',
  notes: [],
  errors: [],
};

describe('DeviceDetails', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    fixture = TestBed.createComponent(Host);
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const trigger = (): HTMLButtonElement | null =>
    root().querySelector<HTMLButtonElement>('neat-collapsible button[aria-expanded]');
  const facts = (): [string, string][] =>
    [...root().querySelectorAll('dl > dt')].map((term) => [
      term.textContent!.trim(),
      term.nextElementSibling!.textContent!.trim(),
    ]);
  const notes = (): string[] =>
    [...root().querySelectorAll('ul.notes > li')].map((note) => note.textContent!.trim());

  async function show(item: PeripheralItem): Promise<void> {
    fixture.componentInstance.item.set(item);
    await fixture.whenStable();
  }

  it('Details is collapsed and lists the device facts and notes the backend sends', async () => {
    await show(usb);
    expect(trigger()?.textContent?.trim()).toBe('Details');
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    // Not a heading: the panel's Details is a disclosure, not part of the page's outline.
    expect(
      root().querySelector('[role="heading"] button, h1 button, h2 button, h3 button'),
    ).toBeNull();
    expect(facts()).toEqual([
      ['Video node', '/dev/video0'],
      ['By-id link', '/dev/v4l/by-id/usb-046d_0825_2F6D4A10-video-index0'],
      ['USB ID', '046d:0825'],
      ['Manufacturer', 'Logitech'],
      ['Product', 'HD Webcam C270'],
      ['Bus path', '1-1.2'],
      ['Link speed', '480 Mb/s'],
    ]);
    expect(root().querySelector('dl')?.hasAttribute('neatDetails')).toBe(true);
    expect(notes()).toEqual([]);

    trigger()!.click();
    await fixture.whenStable();
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');

    // A MIPI camera's notes follow its facts, under their own heading.
    await show(imx568);
    expect(facts()).toEqual([
      ['libcamera name', 'econ-imx568-fpga 5-0042'],
      ['Media device', '/dev/media0'],
    ]);
    expect(root().querySelector('h3')?.textContent?.trim()).toBe('Notes');
    expect(notes()).toEqual(['Sensor crop rectangle could not be read; defaults were used.']);
  });

  it('shows the notes of a device without facts, and nothing at all with neither', async () => {
    await show({ ...bare, notes: ['Reported by a newer SiMa Sentinel.'] });
    expect(facts()).toEqual([]);
    expect(root().querySelector('dl')).toBeNull();
    expect(notes()).toEqual(['Reported by a newer SiMa Sentinel.']);

    await show(bare);
    expect(trigger()).toBeNull();
    expect(root().querySelector('app-device-details')?.children).toHaveLength(0);

    await show(onboardMic);
    expect(facts().map(([term]) => term)).toEqual(['ALSA card', 'Driver', 'ALSA name', 'PCM node']);
    expect(notes()).toEqual(['Capture formats cannot be read without opening the device.']);
  });
});
