import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FakeLocalStorage } from '../settings/fake-storage.testing';
import { type SettingsScope, ViewerSettingsStore } from '../settings/viewer-settings.store';
import { type SettingControl, SettingRow } from './setting-row';

const SHOW_DETECTIONS: SettingControl = {
  control: 'switch',
  id: 'types.object-detection.visible',
  label: 'Show overlay',
};
const CONFIDENCE: SettingControl = {
  control: 'slider',
  id: 'types.object-detection.confidenceThreshold',
  label: 'Confidence threshold',
  min: 0,
  max: 1,
  step: 0.01,
  describe: (value) => value.toFixed(2),
};
const SYNC_BUFFER: SettingControl = {
  control: 'number',
  id: 'general.videoSyncBufferMs',
  label: 'Video sync buffer',
  min: 0,
  max: 4000,
  step: 50,
  unit: 'ms',
  describe: (value) => `${value} ms`,
};
const LINE_WIDTH: SettingControl = {
  control: 'slider',
  id: 'general.lineWidth',
  label: 'Line width',
  min: 1,
  max: 10,
  step: 1,
  describe: (value) => `${value} px`,
};
const TRAIL_LENGTH: SettingControl = {
  control: 'slider',
  id: 'types.tracking.history.trailLength',
  label: 'Trail length',
  min: 1,
  max: 60,
  step: 1,
  describe: (value) => `${value} positions`,
  requires: 'types.tracking.history.enabled',
};

@Component({
  imports: [SettingRow],
  template: `<app-setting-row [scope]="scope()" [setting]="setting()" [name]="name()" />`,
})
class Host {
  readonly store = inject(ViewerSettingsStore);
  readonly scope = signal<SettingsScope>('global');
  readonly setting = signal<SettingControl>(SHOW_DETECTIONS);
  readonly name = signal<string | undefined>(undefined);
}

describe('SettingRow', () => {
  let storage: FakeLocalStorage;
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          // The kit slider measures its track; these specs only press keys.
        }
        unobserve(): void {
          // Nothing observed.
        }
        disconnect(): void {
          // Nothing observed.
        }
      },
    );
    TestBed.configureTestingModule({ providers: [ViewerSettingsStore] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function render(setting: SettingControl, scope: SettingsScope = 'global', name?: string) {
    // One row at a time: two would put the same element ids in the document.
    fixture?.destroy();
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.setting.set(setting);
    fixture.componentInstance.scope.set(scope);
    fixture.componentInstance.name.set(name);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const store = () => fixture.componentInstance.store;
  const text = () => root().textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (label: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent?.trim() === label,
    );
  const toggle = (): HTMLButtonElement => root().querySelector('button[role="switch"]')!;
  const slider = (): HTMLElement => root().querySelector('[role="slider"]')!;
  const field = (): HTMLInputElement => root().querySelector('input')!;
  const readout = () => root().querySelector('.readout')?.textContent?.trim();
  /** The text of what the element's `aria-describedby` points at, or null without one. */
  const description = (element: Element) => {
    const ids = element.getAttribute('aria-describedby');
    if (ids === null) return null;
    return ids
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim())
      .join(' ');
  };
  const sliderDisabled = () => root().querySelector('neat-slider')!.getAttribute('aria-disabled');

  async function press(key: string, target: HTMLElement): Promise<void> {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await fixture.whenStable();
  }

  async function type(value: string): Promise<void> {
    field().value = value;
    field().dispatchEvent(new Event('change'));
    await fixture.whenStable();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await fixture.whenStable();
  }

  it('a switch shows the value in effect and stores the change for its scope', async () => {
    await render(SHOW_DETECTIONS, 'global', 'Object detection: Show overlay');
    expect(toggle().textContent?.trim()).toBe('Show overlay');
    // The section is part of the name: the Metadata tab has a "Show overlay" per type.
    expect(toggle().getAttribute('aria-label')).toBe('Object detection: Show overlay');
    expect(root().querySelector('app-setting-row')!.hasAttribute('role')).toBe(false);
    expect(description(toggle())).toBeNull();
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    await click(toggle());

    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(storage.readStored('settings:global')).toEqual({
      version: 10,
      general: {},
      types: { 'object-detection': { visible: false } },
      auxiliary: {},
    });
  });

  it('a slider reads out its value and stores each step', async () => {
    await render(CONFIDENCE, 'global', 'Object detection: Confidence threshold');
    expect(slider().getAttribute('aria-label')).toBe('Object detection: Confidence threshold');
    expect(readout()).toBe('0.00');

    for (let step = 0; step < 7; step += 1) await press('ArrowRight', slider());

    expect(store().value('global', 'types.object-detection.confidenceThreshold')).toBe(0.07);
    expect(readout()).toBe('0.07');
  });

  it('a number field clamps to its range, keeps whole milliseconds, and reverts junk', async () => {
    await render(SYNC_BUFFER);
    const label = root().querySelector('label')!;
    expect(label.textContent?.trim()).toBe('Video sync buffer');
    expect(label.htmlFor).toBe(field().id);
    expect(field().getAttribute('aria-label')).toBe('Video sync buffer');
    expect(field().inputMode).toBe('numeric');
    expect(field().value).toBe('300');
    expect(text()).toContain('ms');

    await type('5000');
    expect(store().value('global', 'general.videoSyncBufferMs')).toBe(4000);
    expect(field().value).toBe('4000');

    await type('512.6');
    expect(store().value('global', 'general.videoSyncBufferMs')).toBe(513);
    expect(field().value).toBe('513');

    const writes = storage.writes.length;
    await type('');
    expect(field().value).toBe('513');
    expect(storage.writes).toHaveLength(writes);
  });

  it('on a channel a change is an override marked "overrides global"; Reset follows global again', async () => {
    await render(SYNC_BUFFER, 2);
    expect(text()).not.toContain('overrides global');
    expect(button('Reset')).toBeUndefined();

    await type('800');

    expect(storage.readStored('settings:channel:2')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 800 },
      types: {},
      auxiliary: {},
    });
    expect(storage.readStored('settings:global')).toBeNull();
    expect(text()).toContain('overrides global · Global: 300 ms');
    // The field announces its state on focus.
    expect(description(field())).toBe('overrides global · Global: 300 ms');
    const reset = button('Reset')!;
    expect(reset.getAttribute('aria-label')).toBe(
      'Reset Video sync buffer to the global value (300 ms)',
    );

    await click(reset);

    expect(storage.readStored('settings:channel:2')).toBeNull();
    expect(field().value).toBe('300');
    expect(text()).not.toContain('overrides global');
    expect(description(field())).toBeNull();
  });

  it('globally a row says how many channels override it and resets just those', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8, videoSyncBufferMs: 900 } },
      'settings:channel:6': { version: 10, general: { videoSyncBufferMs: 900 } },
    });
    await render(LINE_WIDTH);
    expect(readout()).toBe('3 px');
    expect(text()).toContain('Overridden on 2 channels: 1, 4');
    expect(button('Reset those to global')!.getAttribute('aria-label')).toBe(
      'Reset Line width on 2 channels to the global value',
    );

    await click(button('Reset those to global')!);

    expect(store().overridesOf('general.lineWidth')).toEqual([]);
    expect(storage.readStored('settings:channel:1')).toBeNull();
    expect(storage.readStored('settings:channel:4')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 900 },
      types: {},
      auxiliary: {},
    });
    // Never written: still as seeded.
    expect(storage.readStored('settings:channel:6')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 900 },
    });
    expect(text()).not.toContain('Overridden on');
    expect(button('Reset those to global')).toBeUndefined();

    store().set(6, 'general.lineWidth', 2);
    await fixture.whenStable();
    expect(text()).toContain('Overridden on 1 channel: 6');
    expect(button('Reset those to global')!.getAttribute('aria-label')).toBe(
      'Reset Line width on 1 channel to the global value',
    );
  });

  it('a switch announces what overrides it, globally and on a channel', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, types: { 'object-detection': { visible: false } } },
    });
    await render(SHOW_DETECTIONS, 'global', 'Object detection: Show overlay');
    expect(description(toggle())).toBe('Overridden on 1 channel: 3');
    expect(button('Reset those to global')!.getAttribute('aria-label')).toBe(
      'Reset Object detection: Show overlay on 1 channel to the global value',
    );

    await render(SHOW_DETECTIONS, 3, 'Object detection: Show overlay');
    expect(description(toggle())).toBe('overrides global · Global: on');
    expect(button('Reset')!.getAttribute('aria-label')).toBe(
      'Reset Object detection: Show overlay to the global value (on)',
    );
  });

  it('a setting that depends on another is disabled while that one is off', async () => {
    await render(TRAIL_LENGTH, 3);
    expect(sliderDisabled()).toBeNull();

    store().set('global', 'types.tracking.history.enabled', false);
    await fixture.whenStable();
    expect(sliderDisabled()).toBe('true');

    // The channel's own value counts, not the global one.
    store().set(3, 'types.tracking.history.enabled', true);
    await fixture.whenStable();
    expect(sliderDisabled()).toBeNull();
  });
});
