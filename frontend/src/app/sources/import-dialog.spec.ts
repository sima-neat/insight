import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, inject } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { CatalogAsset, CatalogIndex } from './catalog';
import { ImportDialogs } from './import-dialog';
import type { ImportKind } from './import-runner';
import {
  FakeLibrary,
  FakeSlots,
  FakeToasts,
  fileSlot,
  jobFailed,
  preparing,
  refuse,
  saved,
  sent,
  tick,
} from './import.testing';
import { MediaLibraryService } from './media-library.service';
import { SlotsService } from './slots.service';

/** A page that opens the dialog and keeps what it resolved with. */
@Component({ template: '' })
class Opener {
  private readonly dialogs = inject(ImportDialogs);
  result: string | null | undefined;
  async open(tab?: ImportKind): Promise<void> {
    this.result = await this.dialogs.open(tab);
  }
}

@Component({ template: '' })
class Elsewhere {}

@Component({ imports: [RouterOutlet], template: '<router-outlet />' })
class Frame {}

const asset = (overrides: Partial<CatalogAsset>): CatalogAsset => ({
  source_id: 'street',
  source_title: 'Street',
  profile: '720p30',
  preview: false,
  codec: 'h264',
  container: 'mp4',
  fps: 30,
  target_height: 720,
  path: 'street/street_720p30_30fps_h264.mp4',
  bytes: 1_048_576,
  sha256: '',
  width: 1280,
  height: 720,
  // Never fetched: jsdom loads no media.
  url: 'https://artifacts.neat.sima.ai/media-assets/street/street_720p30_30fps_h264.mp4',
  ...overrides,
});

const CATALOG: CatalogIndex = {
  schema: '1',
  index_url: '',
  base_url: '',
  sources: [
    { id: 'alley', title: 'Alley', description: 'A narrow alley', file: '', url: '' },
    { id: 'street', title: 'Street', description: 'Cars at a crossing', file: '', url: '' },
  ],
  assets: [
    asset({ source_id: 'alley', source_title: 'Alley', path: 'alley/720_h264.mp4' }),
    asset({ source_id: 'alley', source_title: 'Alley', path: 'alley/720_hevc.mp4', codec: 'hevc' }),
    asset({
      source_id: 'alley',
      source_title: 'Alley',
      path: 'alley/preview.mp4',
      profile: 'preview_320p30',
      preview: true,
    }),
    asset({ path: 'street/1080_hevc.mp4', profile: '1080p30', codec: 'hevc', target_height: 1080 }),
  ],
};

describe('ImportDialog', () => {
  let library: FakeLibrary;
  let slots: FakeSlots;
  let toasts: FakeToasts;
  let fixture: ComponentFixture<Frame>;
  let opener: Opener;

  beforeEach(async () => {
    // jsdom has no ResizeObserver; brain's tabs observe their list's size.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        readonly observe = vi.fn();
        readonly unobserve = vi.fn();
        readonly disconnect = vi.fn();
      },
    );
    // Nor scrollIntoView, which the kit's select calls on its active option.
    Element.prototype.scrollIntoView = vi.fn();
    library = new FakeLibrary();
    slots = new FakeSlots();
    toasts = new FakeToasts();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'elsewhere', component: Elsewhere },
          { path: 'media', component: Opener },
        ]),
        provideLocationMocks(),
        { provide: MediaLibraryService, useValue: library },
        { provide: SlotsService, useValue: slots },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    fixture = TestBed.createComponent(Frame);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/elsewhere');
    await router.navigateByUrl('/media');
    await settle();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  async function settle(): Promise<void> {
    await tick();
    await fixture.whenStable();
  }

  async function open(tab?: ImportKind): Promise<void> {
    opener = fixture.debugElement.query((node) => node.componentInstance instanceof Opener)
      .componentInstance as Opener;
    void opener.open(tab);
    await settle();
  }

  const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"]');
  const text = (element: Element | null = dialog()) =>
    element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const buttons = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')];
  const button = (name: string) =>
    buttons().find((one) => (one.getAttribute('aria-label') ?? one.textContent?.trim()) === name);
  const tab = (name: string) =>
    [...dialog()!.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (one) => one.textContent?.trim() === name,
    )!;
  const list = (label: string) =>
    dialog()!.querySelector<HTMLElement>(`[role="listbox"][aria-label="${label}"]`)!;
  const options = (label: string) => [
    ...list(label).querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  /** A list's column headings and its rows as their cells' text (a checked list's boxes have none). */
  const table = (label: string) => ({
    headings: [
      ...list(label)
        .closest('neat-select-list')!
        .querySelectorAll('[data-slot="select-list-header"] span'),
    ]
      .map(text)
      .filter(Boolean),
    rows: options(label).map((row) =>
      [...row.querySelectorAll(':scope > div')].map(text).filter(Boolean),
    ),
  });
  /** A list's rows, each as its cells' text (a checked list's boxes have none). */
  const rows = (label: string) =>
    options(label).map((row) =>
      [...row.querySelectorAll(':scope > div')].map(text).filter(Boolean).join(' '),
    );

  async function click(element: HTMLElement | undefined): Promise<void> {
    element!.click();
    await settle();
  }

  async function pick(select: Element, option: string): Promise<void> {
    await click(select.querySelector<HTMLElement>('[role="combobox"]')!);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (one) => one.textContent?.trim() === option,
      ),
    );
  }

  async function drop(...names: string[]): Promise<File[]> {
    const files = names.map((name) => new File(['x'], name));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
    dialog()!.querySelector('neat-drop-zone')!.dispatchEvent(event);
    await settle();
    return files;
  }

  async function escape(): Promise<void> {
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
  }

  /** The work's readout (the kit's titled progress): title and percent, detail, the bar's value. */
  const progress = () => {
    const readout = dialog()!.querySelector('.work [data-slot="progress-readout"]');
    return readout
      ? {
          title: [...readout.querySelector('[data-slot="progress-title"]')!.children]
            .map(text)
            .join(' '),
          detail: text(readout.querySelector('[data-slot="progress-detail"]')),
          value: readout.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'),
        }
      : null;
  };
  /** The name-clash question, its slots and its answers. */
  const clash = () => [...dialog()!.querySelectorAll('.clash p, .clash button')].map(text);
  const alert = () => text(dialog()!.querySelector('neat-error-note[role="alert"]'));

  it('uploads files in order with byte progress, then their re-encode, then closes on success', async () => {
    await open();
    expect(text(dialog()!.querySelector('h2'))).toBe('Import media');
    expect(text()).toContain(
      'MP4, MOV, AVI, MKV or WebM with H.264, H.265 or MJPEG video, or a .zip / .tar.gz of them.',
    );

    await drop('a.mp4', 'b.mp4');
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
    ]);
    sent(library.last, 50, 200);
    await settle();
    expect(progress()).toEqual({ title: 'Uploading media 1/2 25%', detail: 'a.mp4', value: '25' });

    preparing(library.last, {
      progress: { phase: 'encode', detail: '00:04 / 00:10', percent: 40 },
    });
    await settle();
    expect(progress()).toEqual({
      title: 'Preparing media 1/2 40%',
      detail: 'a.mp4 - 00:04 / 00:10',
      value: '40',
    });
    // Busy: Escape does not close it, and nothing else can be dropped.
    await escape();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('neat-drop-zone button')!.hasAttribute('disabled')).toBe(true);

    saved(library.last, 'a.mp4', { reencoded: ['a.mp4'] });
    await settle();
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
      { name: 'b.mp4', onConflict: undefined },
    ]);
    expect(progress()!.title).toBe('Uploading media 2/2');
    saved(library.last, 'b.mp4');
    await settle();

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('b.mp4');
    expect(toasts.status).toHaveBeenCalledWith('Uploaded and prepared 2 file(s).');
  });

  it('a 409 asks Replace / Keep both / Skip per file, names the slots using it, and re-sends with on_conflict', async () => {
    slots.slots.set([fileSlot(3, 'a.mp4'), fileSlot(9, 'a.mp4')]);
    await open();
    await drop('a.mp4', 'b.mp4', 'c.mp4');

    refuse(library.last, 'a.mp4', 'a_2.mp4');
    await settle();
    expect(clash()).toEqual([
      'a.mp4 already exists.',
      'In use on src3, src9',
      'Replace',
      'Keep both',
      'Skip',
    ]);
    // The safe answer has the focus, so Enter keeps both.
    expect(document.activeElement).toBe(button('Keep both'));
    await click(button('Keep both'));
    expect(library.last.body).toEqual({ name: 'a.mp4', onConflict: 'keep_both' });
    saved(library.last, 'a_2.mp4');
    await settle();

    refuse(library.last, 'b.mp4', 'b_2.mp4');
    await settle();
    expect(clash()).toEqual(['b.mp4 already exists.', 'Replace', 'Keep both', 'Skip']);
    await click(button('Replace'));
    expect(library.last.body).toEqual({ name: 'b.mp4', onConflict: 'replace' });
    saved(library.last, 'b.mp4');
    await settle();

    refuse(library.last, 'c.mp4', 'c_2.mp4');
    await settle();
    await click(button('Skip'));
    expect(library.calls).toHaveLength(5);
    // Every file was uploaded or skipped.
    expect(dialog()).toBeNull();
    expect(opener.result).toBe('b.mp4');
  });

  it('a failed re-encode keeps the dialog open and reports the file', async () => {
    await open();
    await drop('a.mp4');
    preparing(library.last);
    jobFailed(library.last, 'Preparing a.mp4 for streaming failed: moov atom not found.');
    await settle();

    const failure =
      'Uploaded and prepared 0/1 file(s). a.mp4: Preparing a.mp4 for streaming failed: moov atom not found.';
    expect(dialog()).not.toBeNull();
    expect(alert()).toBe(failure);
    expect(toasts.error).toHaveBeenCalledWith(failure);
    expect(progress()).toBeNull();
    // Idle again: it may close, and drops are taken.
    expect(dialog()!.querySelector('neat-drop-zone button')!.hasAttribute('disabled')).toBe(false);
    await escape();
    expect(dialog()).toBeNull();
    expect(opener.result).toBeNull();
  });

  it('leaving the page mid-upload lets it go on, and a toast says how it ended', async () => {
    await open();
    await drop('a.mp4');
    sent(library.last, 1, 2);
    await settle();

    // The browser's Back button: navigation closes even a dialog that is busy.
    TestBed.inject(Location).back();
    await settle();
    expect(dialog()).toBeNull();
    expect(opener.result).toBeNull();

    preparing(library.last, {
      progress: { phase: 'encode', detail: '00:04 / 00:10', percent: 40 },
    });
    saved(library.last, 'a.mp4');
    await settle();

    expect(library.last.unsubscribed).toBe(false);
    expect(toasts.status).toHaveBeenCalledWith('Uploaded and prepared 1 file(s).');
  });

  it('opened again while earlier work runs, the dialog sees it to the end', async () => {
    await open();
    await drop('a.mp4', 'b.mp4');
    TestBed.inject(Location).back();
    await settle();

    await TestBed.inject(Router).navigateByUrl('/media');
    await settle();
    await open();
    expect(progress()!.title).toBe('Uploading media 1/2');
    // It is this dialog's work now: not dismissed by Escape, and it closes when the work is done.
    await escape();
    expect(dialog()).not.toBeNull();

    saved(library.last, 'a.mp4');
    await settle();
    refuse(library.last, 'b.mp4', 'b_2.mp4');
    await settle();
    expect(clash()).toEqual(['b.mp4 already exists.', 'Replace', 'Keep both', 'Skip']);
    await click(button('Skip'));

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('a.mp4');
    expect(toasts.status).toHaveBeenCalledWith('Uploaded and prepared 1 file(s).');
  });

  it('an archive clashes on its folder and names the slots streaming files in it', async () => {
    slots.slots.set([fileSlot(2, 'clips/a.mp4'), fileSlot(6, 'clips/deep/b.mp4')]);
    await open();
    await drop('clips.zip');
    refuse(library.last, 'clips', 'clips_2');
    await settle();
    expect(clash()).toEqual([
      'clips already exists.',
      'In use on src2, src6',
      'Replace',
      'Keep both',
      'Skip',
    ]);
    await click(button('Replace'));
    expect(library.last.body).toEqual({ name: 'clips.zip', onConflict: 'replace' });
    saved(library.last, 'clips', { folder: true, restarted: [2, 6] });
    await settle();

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('clips');
  });

  it('a clash whose slots could not be checked says so', async () => {
    slots.refresh.mockRejectedValueOnce(new Error('MediaMTX is down'));
    await open();
    await drop('a.mp4');
    refuse(library.last, 'a.mp4', 'a_2.mp4');
    await settle();
    expect(clash()).toEqual([
      'a.mp4 already exists.',
      'Could not check which slots use these files.',
      'Replace',
      'Keep both',
      'Skip',
    ]);
  });

  it('catalog filters are one component used by both modes; Import Selected imports the checked asset', async () => {
    library.catalog.mockResolvedValue(CATALOG);
    await open();
    // Loaded only once the Catalog tab opens.
    expect(library.catalog).not.toHaveBeenCalled();
    await click(tab('Catalog'));
    expect(library.catalog).toHaveBeenCalledTimes(1);

    const filters = () => [...dialog()!.querySelectorAll('app-catalog-filters')];
    expect(filters()).toHaveLength(1);
    expect(
      [...filters()[0].querySelectorAll('label')].map((label) => label.textContent?.trim()),
    ).toEqual(['Resolution & FPS', 'Codec']);
    // By asset type, every importable asset; the preview clip is not one.
    // In columns, as a table reads.
    expect(table('Catalog assets')).toEqual({
      headings: ['Name', 'Resolution & FPS', 'Codec', 'Dimensions', 'Size'],
      rows: [
        ['Alley', '720p30', 'H.264', '1280x720', '1.0 MB'],
        ['Alley', '720p30', 'H.265', '1280x720', '1.0 MB'],
        ['Street', '1080p30', 'H.265', '1280x720', '1.0 MB'],
      ],
    });
    await pick(filters()[0].querySelectorAll('neat-select')[1], 'H.265');
    expect(rows('Catalog assets')).toHaveLength(2);
    expect(text()).toContain('2 matching assets / 0 selected');

    // By asset name: the same filter component, keeping its value.
    await click(tab('Catalog by asset name'));
    expect(filters()).toHaveLength(1);
    expect(text(filters()[0])).toContain('H.265');
    expect(rows('Catalog sources')).toEqual(['Alley 2 variants', 'Street 1 variants']);
    expect(table('Catalog variants')).toEqual({
      headings: ['Resolution & FPS', 'Codec', 'Dimensions', 'Size'],
      rows: [['720p30', 'H.265', '1280x720', '1.0 MB']],
    });
    expect(text()).toContain('A narrow alley');
    // The summary beside the preview has no actions, so no box for them; the footer's has.
    expect(dialog()!.querySelector('app-import-preview .actions')).toBeNull();
    expect(
      dialog()!.querySelector('app-import-preview ~ app-import-summary .actions'),
    ).not.toBeNull();

    await click(tab('Catalog by asset type'));
    await click(options('Catalog assets')[1]);
    expect(text()).toContain('1 asset(s) selected');
    await click(button('Import Selected'));
    expect(library.calls.map((call) => call.body)).toEqual(['street/1080_hevc.mp4']);
    preparing(library.last, { kind: 'catalog_import' });
    saved(library.last, 'catalog/street/1080_hevc.mp4');
    await settle();

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('catalog/street/1080_hevc.mp4');
    expect(toasts.status).toHaveBeenCalledWith('Imported 1 catalog asset(s).');
  });

  it('narrower catalog lists give up Dimensions first, then Codec', async () => {
    library.catalog.mockResolvedValue(CATALOG);
    // The lists measure their width as they first render.
    let listWidth = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { width: this.tagName === 'NEAT-SELECT-LIST' ? listWidth : 0 } as DOMRect;
    });
    const headingsAt = async (width: number, mode: string, label: string) => {
      listWidth = width;
      await click(tab(mode === 'type' ? 'Catalog by asset name' : 'Catalog by asset type'));
      await click(tab(mode === 'type' ? 'Catalog by asset type' : 'Catalog by asset name'));
      return table(label).headings;
    };
    await open('catalog');

    expect(await headingsAt(600, 'type', 'Catalog assets')).toEqual([
      'Name',
      'Resolution & FPS',
      'Codec',
      'Dimensions',
      'Size',
    ]);
    expect(await headingsAt(500, 'type', 'Catalog assets')).toEqual([
      'Name',
      'Resolution & FPS',
      'Codec',
      'Size',
    ]);
    expect(await headingsAt(400, 'type', 'Catalog assets')).toEqual([
      'Name',
      'Resolution & FPS',
      'Size',
    ]);
    expect(await headingsAt(420, 'name', 'Catalog variants')).toEqual([
      'Resolution & FPS',
      'Codec',
      'Dimensions',
      'Size',
    ]);
    expect(await headingsAt(360, 'name', 'Catalog variants')).toEqual([
      'Resolution & FPS',
      'Codec',
      'Size',
    ]);
    expect(await headingsAt(300, 'name', 'Catalog variants')).toEqual(['Resolution & FPS', 'Size']);
  });

  it('by asset type, assets are checked and imported one after the other', async () => {
    library.catalog.mockResolvedValue(CATALOG);
    await open('catalog');
    const assets = list('Catalog assets');
    const box = (row: number) =>
      options('Catalog assets')[row].querySelector<HTMLElement>('[data-slot="select-list-check"]')!;
    const checked = () =>
      options('Catalog assets').map((row) => row.getAttribute('aria-selected') === 'true');
    const filters = dialog()!.querySelector('app-catalog-filters')!;

    expect(assets.getAttribute('aria-multiselectable')).toBe('true');
    expect(button('Select All')!.disabled).toBe(false);
    expect(button('Clear')!.disabled).toBe(true);
    expect(button('Import Selected')!.disabled).toBe(true);

    // A click on a box, or anywhere on the row, checks the asset.
    await click(box(0));
    await click(options('Catalog assets')[2]);
    expect(checked()).toEqual([true, false, true]);
    expect(text()).toContain('3 matching assets / 2 selected');
    expect(text()).toContain('2 asset(s) selected');
    expect(text()).toContain('Total selected: 2.0 MB');
    await click(options('Catalog assets')[2]);
    expect(checked()).toEqual([true, false, false]);

    // A check the filter hides is dropped, and widening the filter does not restore it.
    const codec = filters.querySelectorAll('neat-select')[1];
    await pick(codec, 'H.265');
    expect(text()).toContain('2 matching assets / 0 selected');
    await pick(codec, 'Any');
    expect(checked()).toEqual([false, false, false]);
    expect(text()).toContain('3 matching assets / 0 selected');
    expect(button('Clear')!.disabled).toBe(true);

    // Select All checks exactly the assets the filter shows.
    await pick(codec, 'H.265');
    await click(button('Select All'));
    expect(checked()).toEqual([true, true]);
    expect(text()).toContain('2 matching assets / 2 selected');

    await click(button('Clear'));
    expect(checked()).toEqual([false, false]);
    expect(button('Clear')!.disabled).toBe(true);

    await click(button('Select All'));
    await click(button('Import Selected'));
    expect(library.calls.map((call) => call.body)).toEqual(['alley/720_hevc.mp4']);
    expect(progress()!.title).toBe('Importing catalog asset 1/2');
    saved(library.last, 'catalog/alley/720_hevc.mp4');
    await settle();
    expect(library.calls.map((call) => call.body)).toEqual([
      'alley/720_hevc.mp4',
      'street/1080_hevc.mp4',
    ]);
    saved(library.last, 'catalog/street/1080_hevc.mp4');
    await settle();

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('catalog/street/1080_hevc.mp4');
    expect(toasts.status).toHaveBeenCalledWith('Imported 2 catalog asset(s).');
  });

  it('a drop holding files Insight cannot import uploads the rest and names those', async () => {
    await open();
    await drop('notes.txt', 'a.mp4', 'cover.png');
    expect(toasts.error).toHaveBeenCalledWith(
      'Not uploaded: notes.txt, cover.png (not a supported video or archive).',
    );
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
    ]);
  });
});
