import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, inject } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { CatalogAsset, CatalogIndex, YoutubePreview } from './api';
import { ImportDialogs } from './import-dialog';
import type { ImportKind } from './import-runner';
import {
  done,
  FakeLibrary,
  FakeSlots,
  FakeToasts,
  fileSlot,
  lines,
  refuse,
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
  generated_at: null,
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

const PREVIEW: YoutubePreview = {
  video_id: 'abc',
  normalized_url: 'https://www.youtube.com/watch?v=abc',
  embed_url: 'https://www.youtube.com/embed/abc?start=30',
  thumbnail_url: '',
  clip_start: 30,
  title: 'Street walk',
  duration: 600,
  is_live: false,
  live_status: 'not_live',
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
  const field = (label: string): HTMLInputElement =>
    [...dialog()!.querySelectorAll('label')]
      .find((one) => one.querySelector('span')?.textContent?.trim() === label)!
      .querySelector('input')!;
  const list = (label: string) =>
    dialog()!.querySelector<HTMLElement>(`[role="listbox"][aria-label="${label}"]`)!;
  /** A list's rows, each as its cells' text. */
  const rows = (label: string) =>
    [...list(label).querySelectorAll<HTMLElement>('[role="option"]')].map((row) =>
      [...row.querySelectorAll(':scope > div')].map(text).join(' '),
    );

  async function click(element: HTMLElement | undefined): Promise<void> {
    element!.click();
    await settle();
  }

  async function type(input: HTMLInputElement, value: string): Promise<void> {
    input.value = value;
    input.dispatchEvent(new Event('input'));
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

  /** The progress card: its title, percent and detail, and the bar's value. */
  const progress = () => {
    const card = dialog()!.querySelector('.progress');
    return card
      ? {
          title: [...card.querySelectorAll('.title span')].map(text).join(' '),
          detail: text(card.querySelector('.detail')),
          value: card.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow'),
        }
      : null;
  };
  /** The name-clash question, its slots and its answers. */
  const clash = () => [...dialog()!.querySelectorAll('.clash p, .clash button')].map(text);
  const alert = () => text(dialog()!.querySelector('[role="alert"]'));

  it('uploads files in order with byte progress, then processing lines, then closes on success', async () => {
    await open();
    expect(text(dialog()!.querySelector('h2'))).toBe('Import media');
    expect(text()).toContain(
      'MP4, MOV, AVI, MKV or WebM with H.264, H.265 or MJPEG video, or a .zip / .tar.gz of them.',
    );

    await drop('a.mp4', 'b.mp4');
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
    ]);
    library.last.events.next({ kind: 'upload', loaded: 50, total: 200 });
    await settle();
    expect(progress()).toEqual({ title: 'Uploading media 1/2 25%', detail: 'a.mp4', value: '25' });

    lines(library.last, 'Uploaded to /data/media/a.mp4', 'Optimizing a.mp4: 40% (00:04 / 00:10)');
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

    lines(library.last, 'Upload complete.');
    done(library.last);
    await settle();
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
      { name: 'b.mp4', onConflict: undefined },
    ]);
    expect(progress()!.title).toBe('Uploading media 2/2');
    lines(library.last, 'Uploaded to /data/media/b.mp4', 'Upload complete.');
    done(library.last);
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
    lines(library.last, 'Uploaded to /data/media/a_2.mp4', 'Upload complete.');
    done(library.last);
    await settle();

    refuse(library.last, 'b.mp4', 'b_2.mp4');
    await settle();
    expect(clash()).toEqual(['b.mp4 already exists.', 'Replace', 'Keep both', 'Skip']);
    await click(button('Replace'));
    expect(library.last.body).toEqual({ name: 'b.mp4', onConflict: 'replace' });
    lines(library.last, 'Uploaded to /data/media/b.mp4', 'Upload complete.');
    done(library.last);
    await settle();

    refuse(library.last, 'c.mp4', 'c_2.mp4');
    await settle();
    await click(button('Skip'));
    expect(library.calls).toHaveLength(5);
    // Every file was uploaded or skipped.
    expect(dialog()).toBeNull();
    expect(opener.result).toBe('b.mp4');
  });

  it('a failure line keeps the dialog open and reports the file', async () => {
    await open();
    await drop('a.mp4');
    lines(
      library.last,
      'Uploaded to /data/media/a.mp4',
      'FFmpeg conversion failed for a.mp4: moov atom not found',
      'Invalid data found when processing input',
    );
    await settle();
    // Read on to the end: the server is still working.
    expect(library.last.unsubscribed).toBe(false);
    lines(library.last, 'Upload complete.');
    done(library.last);
    await settle();

    const failure =
      'Uploaded and prepared 0/1 file(s). a.mp4: FFmpeg conversion failed for a.mp4: moov atom not found\nInvalid data found when processing input';
    expect(dialog()).not.toBeNull();
    expect(alert()).toBe(failure.replace('\n', ' '));
    expect(toasts.error).toHaveBeenCalledWith(failure);
    expect(progress()).toBeNull();
    // Idle again: it may close, and drops are taken.
    expect(dialog()!.querySelector('neat-drop-zone button')!.hasAttribute('disabled')).toBe(false);
    await escape();
    expect(dialog()).toBeNull();
    expect(opener.result).toBeNull();
  });

  it('leaving the page mid-upload continues it in a progress toast', async () => {
    await open();
    await drop('a.mp4');
    library.last.events.next({ kind: 'upload', loaded: 1, total: 2 });
    await settle();

    // The browser's Back button: navigation closes even a dialog that is busy.
    TestBed.inject(Location).back();
    await settle();
    expect(dialog()).toBeNull();
    expect(opener.result).toBeNull();
    const [toast] = toasts.progressToasts;
    expect(toast.title).toBe('Uploading media');
    expect(toast.update).toHaveBeenLastCalledWith('Uploading media · a.mp4', 50);

    lines(library.last, 'Uploaded to /data/media/a.mp4', 'Optimizing a.mp4: 40% (00:04 / 00:10)');
    expect(toast.update).toHaveBeenLastCalledWith('Preparing media · a.mp4 - 00:04 / 00:10', 40);
    lines(library.last, 'Upload complete.');
    done(library.last);
    await settle();

    expect(library.last.unsubscribed).toBe(false);
    expect(toast.done).toHaveBeenCalledWith('Uploaded and prepared 1 file(s).');
    expect(toasts.status).not.toHaveBeenCalled();
  });

  it('catalog filters are one component used by both modes; Import imports the picked asset', async () => {
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
    expect(rows('Catalog assets')).toEqual([
      'Alley 720p30 / 30 fps / H.264 / 1280x720 / 1.0 MB',
      'Alley 720p30 / 30 fps / H.265 / 1280x720 / 1.0 MB',
      'Street 1080p30 / 30 fps / H.265 / 1280x720 / 1.0 MB',
    ]);
    await pick(filters()[0].querySelectorAll('neat-select')[1], 'H.265');
    expect(rows('Catalog assets')).toHaveLength(2);
    expect(text()).toContain('2 matching assets / 0 selected');

    // By asset name: the same filter component, keeping its value.
    await click(tab('Catalog by asset name'));
    expect(filters()).toHaveLength(1);
    expect(text(filters()[0])).toContain('H.265');
    expect(rows('Catalog sources')).toEqual(['Alley 2 variants', 'Street 1 variants']);
    expect(rows('Catalog variants')).toEqual(['720p30 / 30 fps / H.265 / 1280x720 1.0 MB']);
    expect(text()).toContain('A narrow alley');

    await click(tab('Catalog by asset type'));
    await click(list('Catalog assets').querySelectorAll<HTMLElement>('[role="option"]')[1]);
    expect(text()).toContain('1 asset(s) selected');
    await click(button('Import'));
    expect(library.calls.map((call) => call.body)).toEqual(['street/1080_hevc.mp4']);
    lines(library.last, 'Saved catalog asset to catalog/street/1080_hevc.mp4');
    lines(library.last, 'Catalog import complete.');
    done(library.last);
    await settle();

    expect(dialog()).toBeNull();
    expect(opener.result).toBe('catalog/street/1080_hevc.mp4');
    expect(toasts.status).toHaveBeenCalledWith('Imported 1 catalog asset(s).');
  });

  it('YouTube import needs a validated link and Cancel Import aborts it', async () => {
    library.validateYoutube.mockResolvedValue(PREVIEW);
    await open('youtube');
    expect(button('Import')!.disabled).toBe(true);
    expect(text()).toContain('Validate a YouTube link to show the preview before import.');

    await type(field('YouTube URL'), 'https://youtu.be/abc?t=30');
    await click(button('Validate'));
    expect(library.validateYoutube).toHaveBeenCalledWith('https://youtu.be/abc?t=30');
    expect(field('YouTube URL').value).toBe('https://www.youtube.com/watch?v=abc');
    expect(field('Start Time').value).toBe('30');
    expect(dialog()!.querySelector('iframe')!.getAttribute('src')).toBe(PREVIEW.embed_url);
    expect(text()).toContain(
      'Insight will import up to 5 minute(s) from 30 as 1080p30 H.264 with B-frames disabled.',
    );
    expect(text()).toContain('Ready to import YouTube video');

    // A different link needs validating again.
    await type(field('YouTube URL'), 'https://youtu.be/other');
    expect(button('Import')!.disabled).toBe(true);
    await type(field('YouTube URL'), 'https://youtu.be/abc?t=30');
    await click(button('Validate'));

    await click(button('Import'));
    expect(library.last.body).toEqual({
      url: 'https://www.youtube.com/watch?v=abc',
      target: '1080p30',
      clip_start: '30',
      clip_duration: 300,
    });
    expect(button('Importing...')!.disabled).toBe(true);
    await click(button('Cancel Import'));

    expect(library.last.unsubscribed).toBe(true);
    expect(toasts.status).toHaveBeenCalledWith('YouTube import canceled.');
    expect(dialog()).not.toBeNull();
    expect(button('Cancel Import')).toBeUndefined();
  });

  it('the preview frames YouTube’s embed page only', async () => {
    library.validateYoutube.mockResolvedValue({
      ...PREVIEW,
      embed_url: 'https://example.com/embed/abc',
    });
    await open('youtube');
    await type(field('YouTube URL'), 'https://youtu.be/abc');
    await click(button('Validate'));
    expect(dialog()!.querySelector('iframe')!.src).toBe('about:blank');
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
