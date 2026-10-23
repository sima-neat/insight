import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatConfirm } from '@sima/neat-ui';
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

  /** The disclosure that folds the channels overriding this setting open. */
  const overrideNote = (): HTMLButtonElement | null =>
    root().querySelector<HTMLButtonElement>('button[aria-expanded]');
  /** The open list's lines, each as the text it shows. */
  const overrideLines = () =>
    [...root().querySelectorAll('.overrides li')].map((line) =>
      [...line.children].map((part) => part.textContent?.trim()).join(' '),
    );
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  /** The dialog's title, message and buttons, in order. */
  const dialogText = () =>
    [...(dialog()?.querySelectorAll('h2, p, button') ?? [])]
      .map((part) => part.textContent?.trim())
      .join(' ');
  const dialogButton = (label: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (element) => element.textContent?.trim() === label,
    );

  /** Lets the dialog open or close: it moves focus after rendering and closes a frame later. */
  async function settleDialog(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

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

  it('the override note is collapsed by default and expands to list channels with their values', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8, videoSyncBufferMs: 900 } },
      'settings:channel:6': { version: 10, general: { videoSyncBufferMs: 900 } },
    });
    await render(LINE_WIDTH);
    expect(readout()).toBe('3 px');

    const note = overrideNote()!;
    expect(note.textContent?.trim()).toBe('Overridden on 2 channels');
    expect(note.getAttribute('aria-expanded')).toBe('false');
    expect(note.hasAttribute('aria-controls')).toBe(false);
    expect(overrideLines()).toEqual([]);
    expect(text()).not.toContain('Channel 1');
    expect(button('Reset on 2 channels…')).toBeUndefined();

    await click(note);

    expect(note.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(note.getAttribute('aria-controls')!)).not.toBeNull();
    expect(overrideLines()).toEqual([
      'Channel 1 6 px Use global',
      'Channel 4 8 px Use global',
      'Reset on 2 channels…',
    ]);

    await click(note);
    expect(note.getAttribute('aria-expanded')).toBe('false');
    expect(overrideLines()).toEqual([]);
  });

  it('lists a number with its unit and a switch as On or Off', async () => {
    storage.seed({
      'settings:channel:2': { version: 10, general: { videoSyncBufferMs: 900 } },
      'settings:channel:5': { version: 10, types: { 'object-detection': { visible: false } } },
      'settings:channel:8': { version: 10, types: { 'object-detection': { visible: true } } },
    });

    await render(SYNC_BUFFER);
    await click(overrideNote()!);
    expect(overrideLines()[0]).toBe('Channel 2 900 ms Use global');

    await render(SHOW_DETECTIONS);
    await click(overrideNote()!);
    expect(overrideLines()).toEqual([
      'Channel 5 Off Use global',
      'Channel 8 On Use global',
      'Reset on 2 channels…',
    ]);
  });

  it('a note does not remember being open: it is collapsed again when overrides come back', async () => {
    storage.seed({ 'settings:channel:3': { version: 10, general: { lineWidth: 6 } } });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    expect(overrideLines()).toHaveLength(2);

    store().resetOverride(3, 'general.lineWidth');
    await fixture.whenStable();
    expect(overrideNote()).toBeNull();

    store().set(3, 'general.lineWidth', 6);
    await fixture.whenStable();
    expect(overrideNote()!.getAttribute('aria-expanded')).toBe('false');
    expect(overrideLines()).toEqual([]);
  });

  it('Use global on a channel resets only that channel at once; the list updates and the note hides at zero', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, general: { lineWidth: 6, videoSyncBufferMs: 900 } },
      'settings:channel:5': { version: 10, general: { lineWidth: 8 } },
      'settings:channel:7': { version: 10, general: { lineWidth: 9 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    const useGlobal = (channel: number) =>
      root().querySelector<HTMLButtonElement>(
        `button[aria-label="Use global value on channel ${channel}: Line width"]`,
      )!;
    // The visible text starts the accessible name (WCAG 2.5.3, label in name).
    expect(useGlobal(3).textContent?.trim()).toBe('Use global');

    await click(useGlobal(3));

    expect(dialog()).toBeNull();
    expect(store().overridesOf('general.lineWidth')).toEqual([5, 7]);
    // Channel 3's other value is not touched.
    expect(storage.readStored('settings:channel:3')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 900 },
      types: {},
      auxiliary: {},
    });
    expect(overrideNote()!.textContent?.trim()).toBe('Overridden on 2 channels');
    expect(overrideLines()).toEqual([
      'Channel 5 8 px Use global',
      'Channel 7 9 px Use global',
      'Reset on 2 channels…',
    ]);

    await click(useGlobal(5));
    await click(useGlobal(7));

    expect(overrideNote()).toBeNull();
    expect(overrideLines()).toEqual([]);
    expect(storage.readStored('settings:channel:5')).toBeNull();
  });

  it('keeps focus in the list after Use global: on the next channel, else on the control', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:5': { version: 10, general: { lineWidth: 8 } },
      'settings:channel:7': { version: 10, general: { lineWidth: 9 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    const useGlobalButtons = () => [
      ...root().querySelectorAll<HTMLButtonElement>('button[aria-label^="Use global value"]'),
    ];

    await click(useGlobalButtons()[1]);
    expect(document.activeElement).toBe(useGlobalButtons()[1]);
    expect(document.activeElement!.getAttribute('aria-label')).toBe(
      'Use global value on channel 7: Line width',
    );

    // The last line has no next one: focus goes to the one before.
    await click(useGlobalButtons()[1]);
    expect(document.activeElement!.getAttribute('aria-label')).toBe(
      'Use global value on channel 3: Line width',
    );

    await click(useGlobalButtons()[0]);
    expect(overrideNote()).toBeNull();
    expect(document.activeElement).toBe(slider());
  });

  it('Reset on 2 channels… asks with the exact copy; Cancel changes nothing', async () => {
    storage.seed({
      'settings:global': { version: 10, general: { lineWidth: 4 } },
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    const bulk = button('Reset on 2 channels…')!;
    // The visible text starts the accessible name (WCAG 2.5.3, label in name).
    expect(bulk.getAttribute('aria-label')).toBe(
      'Reset on 2 channels to the global value: Line width',
    );
    const writes = storage.writes.length;
    const ask = vi.spyOn(TestBed.inject(NeatConfirm), 'ask');

    bulk.focus();
    bulk.click();
    await settleDialog();

    expect(ask).toHaveBeenCalledExactlyOnceWith({
      title: 'Reset Line width on 2 channels?',
      message: "They go back to the global value (4 px). This can't be undone.",
      confirmLabel: 'Reset',
      tone: 'danger',
    });

    expect(dialogText()).toBe(
      "Reset Line width on 2 channels? They go back to the global value (4 px). This can't be undone. Cancel Reset",
    );

    dialogButton('Cancel')!.click();
    await settleDialog();

    expect(dialog()).toBeNull();
    expect(store().overridesOf('general.lineWidth')).toEqual([1, 4]);
    expect(storage.writes).toHaveLength(writes);
    expect(document.activeElement).toBe(bulk);
  });

  it('Reset resets the channels overriding at that moment, not when the dialog opened', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    button('Reset on 2 channels…')!.click();
    await settleDialog();
    expect(dialogText()).toContain('Reset Line width on 2 channels?');

    // While the dialog is open, channel 1 gives its value back and channel 9 takes one.
    store().resetOverride(1, 'general.lineWidth');
    store().set(9, 'general.lineWidth', 3);
    dialogButton('Reset')!.click();
    await settleDialog();

    expect(store().overridesOf('general.lineWidth')).toEqual([]);
    expect(storage.readStored('settings:channel:4')).toBeNull();
    expect(storage.readStored('settings:channel:9')).toBeNull();
    expect(overrideNote()).toBeNull();
  });

  it('a confirmed reset keeps other settings of the channels, and the global value', async () => {
    storage.seed({
      'settings:global': { version: 10, general: { lineWidth: 4 } },
      'settings:channel:1': { version: 10, general: { lineWidth: 6, videoSyncBufferMs: 900 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    button('Reset on 1 channel…')!.click();
    await settleDialog();

    dialogButton('Reset')!.click();
    await settleDialog();

    expect(storage.readStored('settings:channel:1')).toEqual({
      version: 10,
      general: { videoSyncBufferMs: 900 },
      types: {},
      auxiliary: {},
    });
    expect(store().value('global', 'general.lineWidth')).toBe(4);
  });

  it('asks about one channel in the singular, and names a switch’s global value', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, types: { 'object-detection': { visible: false } } },
    });
    await render(SHOW_DETECTIONS, 'global', 'Object detection: Show overlay');
    await click(overrideNote()!);
    expect(button('Reset on 1 channel…')!.getAttribute('aria-label')).toBe(
      'Reset on 1 channel to the global value: Object detection: Show overlay',
    );

    button('Reset on 1 channel…')!.click();
    await settleDialog();

    expect(dialogText()).toBe(
      "Reset Object detection: Show overlay on 1 channel? It goes back to the global value (on). This can't be undone. Cancel Reset",
    );
  });

  it('keeps focus on the control after a confirmed reset, when the list that opened the dialog is gone', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8 } },
    });
    await render(LINE_WIDTH);
    await click(overrideNote()!);
    const bulk = button('Reset on 2 channels…')!;
    bulk.focus();
    bulk.click();
    await settleDialog();

    dialogButton('Reset')!.click();
    await settleDialog();

    expect(bulk.isConnected).toBe(false);
    expect(document.activeElement).toBe(slider());
  });

  it('puts focus on the field of a number setting and on the switch of a switch setting', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { videoSyncBufferMs: 900 } },
      'settings:channel:2': { version: 10, types: { 'object-detection': { visible: false } } },
    });
    await render(SYNC_BUFFER);
    await click(overrideNote()!);
    button('Reset on 1 channel…')!.click();
    await settleDialog();
    dialogButton('Reset')!.click();
    await settleDialog();
    expect(document.activeElement).toBe(field());

    await render(SHOW_DETECTIONS);
    await click(overrideNote()!);
    await click(button('Use global')!);
    expect(document.activeElement).toBe(toggle());
  });

  it('a slider is described by the override note, like the other controls, so focus announces it', async () => {
    storage.seed({
      'settings:channel:1': { version: 10, general: { lineWidth: 6 } },
      'settings:channel:4': { version: 10, general: { lineWidth: 8 } },
    });
    await render(LINE_WIDTH);
    expect(description(slider())).toBe('Overridden on 2 channels');

    await render(LINE_WIDTH, 1);
    expect(description(slider())).toBe('overrides global · Global: 3 px');

    await render(LINE_WIDTH, 2);
    expect(slider().hasAttribute('aria-describedby')).toBe(false);
  });

  it('a slider that depends on another is disabled on its thumb, which is what gets focus', async () => {
    await render(TRAIL_LENGTH, 3);
    expect(slider().hasAttribute('aria-disabled')).toBe(false);

    store().set('global', 'types.tracking.history.enabled', false);
    await fixture.whenStable();
    expect(slider().getAttribute('aria-disabled')).toBe('true');
  });

  it('a switch announces what overrides it, globally and on a channel', async () => {
    storage.seed({
      'settings:channel:3': { version: 10, types: { 'object-detection': { visible: false } } },
    });
    await render(SHOW_DETECTIONS, 'global', 'Object detection: Show overlay');
    expect(description(toggle())).toBe('Overridden on 1 channel');

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
