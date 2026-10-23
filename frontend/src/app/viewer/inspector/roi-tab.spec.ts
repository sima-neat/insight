import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatConfirm } from '@sima/neat-ui';
import type { NeatRoiDrawMode, NeatRoiPolygon } from '@sima/neat-ui/video';
import { FakeLocalStorage } from '../settings/fake-storage.testing';
import { RoiStore } from '../settings/roi-store';
import { type SettingsScope, ViewerSettingsStore } from '../settings/viewer-settings.store';
import { RoiTab } from './roi-tab';

const SQUARE: NeatRoiPolygon = {
  type: 'inclusion',
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 },
  ],
};
const TRIANGLE: NeatRoiPolygon = {
  type: 'exclusion',
  points: [
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.2 },
    { x: 0.3, y: 0.4 },
  ],
};
const WEDGE: NeatRoiPolygon = {
  type: 'inclusion',
  points: [
    { x: 0.5, y: 0.5 },
    { x: 0.7, y: 0.5 },
    { x: 0.6, y: 0.8 },
  ],
};

/** The stored form of a list, as the store writes it. */
const stored = (regions: readonly NeatRoiPolygon[]) => ({ version: 1, regions });

@Component({
  imports: [RoiTab],
  template: `
    <app-roi-tab
      [scope]="scope()"
      [channels]="channels()"
      [(drawMode)]="drawMode"
      [(backdrop)]="backdrop"
    />
  `,
})
class Host {
  readonly roi = inject(RoiStore);
  readonly scope = signal<SettingsScope>('global');
  readonly channels = signal<readonly number[]>([0, 1, 2, 3]);
  readonly drawMode = signal<NeatRoiDrawMode>('off');
  readonly backdrop = signal<number | null>(0);
}

describe('RoiTab', () => {
  let storage: FakeLocalStorage;
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    TestBed.configureTestingModule({ providers: [RoiStore, ViewerSettingsStore] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(scope: SettingsScope, seed: Record<string, unknown> = {}): Promise<void> {
    storage.seed(seed);
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.scope.set(scope);
    await fixture.whenStable();
  }

  const settle = () => fixture.whenStable();
  const host = () => fixture.componentInstance;
  const root = (): HTMLElement => fixture.nativeElement;
  const flat = (element: Element | null | undefined) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (name: string): HTMLButtonElement | null =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => (element.getAttribute('aria-label') ?? flat(element)) === name,
    ) ?? null;
  const radios = () => [...root().querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const radio = (label: string) => radios().find((element) => flat(element) === label)!;
  const hint = () => flat(root().querySelector('.hint'));
  /** The region list's lines, as they read. */
  const lines = () => [...root().querySelectorAll('.regions li')].map((line) => flat(line));
  const backdropField = (): HTMLInputElement | null =>
    root().querySelector('input[aria-label="Draw on channel"]');
  const switchNamed = (name: string) =>
    root().querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`);

  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

  /** Lets a dialog open or close: it moves focus after rendering and closes a frame later. */
  async function settleDialog(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await settle();
    }
  }

  /** Presses the open dialog's button and waits for it to close. */
  async function answer(label: string): Promise<void> {
    await settleDialog();
    [...dialog()!.querySelectorAll('button')]
      .find((element) => element.textContent?.trim() === label)!
      .click();
    await settleDialog();
  }

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await settle();
  }

  async function enter(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  }

  it('the hint and list copy match the spec, and No regions. shows for an empty list', async () => {
    await render('global');

    expect(flat(root().querySelector('[role="radiogroup"]'))).toBe('Off Inclusion Exclusion');
    expect(root().querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Draw');
    expect(radio('Off').getAttribute('aria-checked')).toBe('true');
    expect(hint()).toBe(
      'Regions filter what the viewer shows; the pipeline still detects everything.',
    );
    expect(flat(root().querySelector('.empty'))).toBe('No regions.');
    expect(root().querySelector('.regions')).toBeNull();
    expect(button('Delete all…')).toBeNull();

    await click(radio('Inclusion'));
    expect(host().drawMode()).toBe('inclusion');
    expect(hint()).toBe(
      'Click to add points; click the first point or double-click to close. Escape cancels.',
    );
    await click(radio('Exclusion'));
    expect(host().drawMode()).toBe('exclusion');
    expect(hint()).toBe(
      'Click to add points; click the first point or double-click to close. Escape cancels.',
    );

    // Numbered per type, in list order.
    host().roi.set('global', [SQUARE, TRIANGLE, WEDGE]);
    await settle();
    expect(lines()).toEqual([
      'Inclusion 1 Delete',
      'Exclusion 1 Delete',
      'Inclusion 2 Delete',
      'Delete all…',
    ]);
    expect(root().querySelector('.empty')).toBeNull();
    expect(button('Delete Inclusion 1')).not.toBeNull();
    expect(button('Delete Exclusion 1')).not.toBeNull();
    expect(button('Delete Inclusion 2')).not.toBeNull();

    // The Show and Filter switches, which follow the list.
    expect(switchNamed('Show regions')).not.toBeNull();
    expect(switchNamed('Filter by regions')).not.toBeNull();
  });

  it('the parts come in the spec’s order: field, Draw, hint, list, notes, switches', async () => {
    await render('global', {
      'roi:global': stored([SQUARE]),
      'roi:channel:3': stored([]),
    });

    const parts = [
      backdropField()!,
      root().querySelector('[role="radiogroup"]')!,
      root().querySelector('.hint')!,
      root().querySelector('.regions')!,
      root().querySelector('.owners')!,
      switchNamed('Show regions')!,
      switchNamed('Filter by regions')!,
    ];
    for (let index = 1; index < parts.length; index++) {
      expect(
        parts[index - 1].compareDocumentPosition(parts[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('Delete removes that region and moves focus to the next Delete', async () => {
    await render(1, { 'roi:channel:1': stored([SQUARE, TRIANGLE, WEDGE]) });

    const first = button('Delete Inclusion 1')!;
    first.focus();
    await click(first);

    expect(storage.readStored('roi:channel:1')).toStrictEqual(stored([TRIANGLE, WEDGE]));
    expect(lines()).toEqual(['Exclusion 1 Delete', 'Inclusion 1 Delete', 'Delete all…']);
    // The next row's Delete, which now names the region after the deleted one.
    expect(document.activeElement).toBe(button('Delete Exclusion 1'));

    // The last row's: the previous one's.
    await click(button('Delete Inclusion 1')!);
    expect(storage.readStored('roi:channel:1')).toStrictEqual(stored([TRIANGLE]));
    expect(document.activeElement).toBe(button('Delete Exclusion 1'));

    // The only row's: the list goes, so focus goes to Draw.
    await click(button('Delete Exclusion 1')!);
    expect(storage.readStored('roi:channel:1')).toStrictEqual(stored([]));
    expect(flat(root().querySelector('.empty'))).toBe('No regions.');
    expect(document.activeElement).toBe(radio('Off'));
  });

  it('every region can be deleted from the keyboard, through the list alone', async () => {
    await render('global', { 'roi:global': stored([SQUARE, TRIANGLE, WEDGE]) });

    // Each Delete is a button in the Tab order; Enter or Space on a focused one activates it,
    // which a click stands in for here. Focus stays in the list until it is empty.
    button('Delete Inclusion 2')!.focus();
    for (let left = 3; left > 0; left--) {
      const focused = document.activeElement as HTMLButtonElement;
      expect(focused.tabIndex).toBe(0);
      expect(focused.getAttribute('aria-label')).toMatch(/^Delete (Inclusion|Exclusion) \d$/);
      await click(focused);
    }

    expect(storage.readStored('roi:global')).toStrictEqual(stored([]));
    expect(document.activeElement).toBe(radio('Off'));
  });

  it('a Delete on a channel that inherits keeps the other global regions as its own', async () => {
    await render(2, { 'roi:global': stored([SQUARE, TRIANGLE]) });
    expect(lines()).toEqual(['Inclusion 1 Delete', 'Exclusion 1 Delete', 'Delete all…']);

    await click(button('Delete Exclusion 1')!);

    expect(storage.readStored('roi:channel:2')).toStrictEqual(stored([SQUARE]));
    expect(storage.readStored('roi:global')).toStrictEqual(stored([SQUARE, TRIANGLE]));
  });

  it('Delete all on a channel stores [] after confirmation; Cancel changes nothing', async () => {
    await render(4, { 'roi:global': stored([SQUARE]), 'roi:channel:4': stored([TRIANGLE]) });
    const ask = vi.spyOn(TestBed.inject(NeatConfirm), 'ask');
    const writes = storage.writes.length;

    const opener = button('Delete all…')!;
    opener.focus();
    opener.click();
    await answer('Cancel');

    expect(ask).toHaveBeenCalledExactlyOnceWith({
      title: 'Delete all regions?',
      message: "Channel 4's regions are deleted; it will show none, not the global ones.",
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    expect(storage.writes).toHaveLength(writes);
    expect(lines()).toEqual(['Exclusion 1 Delete', 'Delete all…']);
    expect(document.activeElement).toBe(opener);

    opener.click();
    await answer('Delete');

    // An explicit empty list: still the channel's own, not the global regions.
    expect(storage.readStored('roi:channel:4')).toStrictEqual(stored([]));
    expect(storage.readStored('roi:global')).toStrictEqual(stored([SQUARE]));
    expect(flat(root().querySelector('.empty'))).toBe('No regions.');
    expect(document.activeElement).toBe(radio('Off'));
  });

  it('Delete all on All channels says it deletes the regions for all channels', async () => {
    await render('global', { 'roi:global': stored([SQUARE, TRIANGLE]) });
    const ask = vi.spyOn(TestBed.inject(NeatConfirm), 'ask');

    button('Delete all…')!.click();
    await answer('Delete');

    expect(ask).toHaveBeenCalledExactlyOnceWith({
      title: 'Delete all regions?',
      message: 'The regions for all channels are deleted.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    expect(storage.readStored('roi:global')).toStrictEqual(stored([]));
  });

  it('Use global removes the channel list and moves focus to Draw', async () => {
    await render(3, { 'roi:global': stored([SQUARE]), 'roi:channel:3': stored([TRIANGLE]) });
    host().drawMode.set('exclusion');
    await settle();
    expect(flat(root().querySelector('.own'))).toBe('Own regions · Use global');

    const useGlobal = button('Use the global regions on channel 3')!;
    expect(flat(useGlobal)).toBe('Use global');
    useGlobal.focus();
    await click(useGlobal);

    expect(storage.readStored('roi:channel:3')).toBeNull();
    expect(host().roi.own(3)()).toBeNull();
    expect(lines()).toEqual(['Inclusion 1 Delete', 'Delete all…']);
    expect(root().querySelector('.own')).toBeNull();
    expect(document.activeElement).toBe(radio('Exclusion'));
  });

  it('a channel that inherits has no Own regions line; one with an empty list of its own has', async () => {
    await render(5, { 'roi:global': stored([SQUARE]) });
    expect(root().querySelector('.own')).toBeNull();

    host().roi.set(5, []);
    await settle();
    expect(flat(root().querySelector('.own'))).toBe('Own regions · Use global');
    expect(flat(root().querySelector('.empty'))).toBe('No regions.');
  });

  it('the global tab names the channels with their own regions', async () => {
    await render('global', { 'roi:channel:6': stored([SQUARE]), 'roi:channel:2': stored([]) });

    expect(flat(root().querySelector('.owners'))).toBe('Channels 2 and 6 use their own regions.');
    // Text only: the lists are reset from their channels.
    expect(root().querySelector('.owners button')).toBeNull();

    host().roi.set(9, [TRIANGLE]);
    await settle();
    expect(flat(root().querySelector('.owners'))).toBe(
      'Channels 2, 6 and 9 use their own regions.',
    );

    host().roi.useGlobal(2);
    host().roi.useGlobal(9);
    await settle();
    expect(flat(root().querySelector('.owners'))).toBe('Channel 6 uses its own regions.');

    host().roi.useGlobal(6);
    await settle();
    expect(root().querySelector('.owners')).toBeNull();
  });

  it('a channel has no Draw on channel field and no list of channels', async () => {
    await render(1, { 'roi:channel:2': stored([SQUARE]) });

    expect(backdropField()).toBeNull();
    expect(root().querySelector('.owners')).toBeNull();
  });

  it('Draw on channel applies a displayed channel on Enter or blur and shows the current one back otherwise', async () => {
    await render('global');
    const field = backdropField()!;
    expect(field.value).toBe('0');

    await enter(field, '2');
    expect(host().backdrop()).toBe(2);
    expect(field.value).toBe('2');

    // Not displayed, or not a channel number: refused, and the field shows the backdrop again.
    for (const typed of ['7', '-1', 'two', '']) {
      await enter(field, typed);
      expect(host().backdrop()).toBe(2);
      expect(field.value).toBe('2');
    }

    field.value = '3';
    field.dispatchEvent(new FocusEvent('blur'));
    await settle();
    expect(host().backdrop()).toBe(3);
    expect(field.value).toBe('3');
  });

  it('the Show and Filter switches write the scope’s settings', async () => {
    await render(2);

    await click(switchNamed('Show regions')!);
    await click(switchNamed('Filter by regions')!);

    expect(storage.readStored('settings:channel:2')).toMatchObject({
      general: { showRoi: false, applyRoiFiltering: false },
    });
  });
});
