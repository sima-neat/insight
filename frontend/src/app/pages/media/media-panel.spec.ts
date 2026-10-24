import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaInfo, Slot } from '../../sources/api';
import { type DeleteOutcome, MediaLibraryService } from '../../sources/media-library.service';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError } from '../../sources/stream-lines';
import { MediaPanel } from './media-panel';

function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: '',
    type: 'file',
    allowed_transports: [],
    urls: {},
    ...overrides,
  };
}

const VIDEO: MediaInfo = {
  filename: 'walk.mp4',
  size_bytes: 5_452_595,
  type: 'video',
  codec: 'H.264',
  normalized_codec: 'h264',
  width: 1280,
  height: 720,
  duration_ms: 134_000,
  frame_rate: '30/1',
};

/** `SlotsService` as the panel uses it: the slots set by the test, `refresh` answering with `next`. */
class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([]);
  readonly encodes = signal(new Map());
  /** What the server holds now, which a refresh brings in. */
  next: readonly Slot[] = [];
  readonly refresh = vi.fn(async () => {
    this.slots.set(this.next);
  });
  private readonly byFile = computed(() => {
    const map = new Map<string, Slot[]>();
    for (const s of this.slots() ?? []) {
      if (s.file) map.set(s.file, [...(map.get(s.file) ?? []), s]);
    }
    return map;
  });
  assignedTo(path: string): readonly Slot[] {
    return this.byFile().get(path) ?? [];
  }
}

class FakeLibrary {
  readonly info = vi.fn<(path: string) => Promise<MediaInfo | null>>(async () => VIDEO);
  readonly delete = vi.fn<(paths: readonly string[]) => Promise<DeleteOutcome>>(async (paths) => ({
    deleted: [...paths],
    failed: [],
  }));
}

@Component({
  imports: [MediaPanel],
  template: `<app-media-panel [(selected)]="selected" [(checked)]="checked" />`,
})
class Host {
  readonly selected = signal<string | null>(null);
  readonly checked = signal<readonly string[]>([]);
}

describe('MediaPanel', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let slots: FakeSlots;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    slots = new FakeSlots();
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: SlotsService, useValue: slots },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const panel = (): HTMLElement => root().querySelector('app-media-panel')!;
  const text = () => panel().textContent!.replace(/\s+/g, ' ').trim();
  const settle = () => fixture.whenStable();
  async function settleOverlay(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve));
      await settle();
    }
  }
  const button = (label: string): HTMLButtonElement =>
    [...panel().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  /** The info table's rows, a kit details list. */
  const infoRows = () =>
    [
      ...(
        fixture.debugElement.query(By.directive(NeatDetails)).nativeElement as HTMLElement
      ).querySelectorAll('dt'),
    ].map((dt) => [dt.textContent!.trim(), dt.nextElementSibling!.textContent!.trim()]);
  const confirmDialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const confirmText = () =>
    [...(confirmDialog()?.querySelectorAll('h2, p') ?? [])]
      .map((part) => part.textContent?.trim())
      .join(' | ');
  async function answer(label: string): Promise<void> {
    [...confirmDialog()!.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === label)!
      .click();
    await settleOverlay();
  }

  async function show(selected: string | null, checked: readonly string[] = []): Promise<void> {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.selected.set(selected);
    host.checked.set(checked);
    await settle();
  }

  it('says what to do when nothing is selected', async () => {
    await show(null);
    expect(text()).toBe('Select a file.');
    expect(library.info).not.toHaveBeenCalled();
  });

  it('the panel shows readable info for the selected file', async () => {
    await show('people/walk.mp4');

    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
    expect(library.info).toHaveBeenCalledWith('people/walk.mp4');
    expect(infoRows()).toEqual([
      ['Filename', 'walk.mp4'],
      ['Size', '5.2 MB'],
      ['Type', 'Video'],
      ['Codec', 'H.264'],
      ['Width', '1280'],
      ['Height', '720'],
      ['Duration', '2:14'],
      ['Frame rate', '30 fps'],
    ]);
    expect(panel().querySelector('video')!.getAttribute('src')).toBe('/media/people/walk.mp4');
    expect(button('Delete…')).toBeDefined();
  });

  it('previews a file the probe finds MJPEG through the MJPEG route', async () => {
    library.info.mockResolvedValue({ ...VIDEO, codec: 'MJPEG', normalized_codec: 'mjpeg' });
    await show('clips/cam.avi');
    expect(panel().querySelector('video')).toBeNull();
    expect(panel().querySelector('img')!.getAttribute('src')).toBe(
      '/api/media-preview/mjpeg?path=clips%2Fcam.avi',
    );
  });

  it('shows the info of the file selected last, and a failed probe as an Error row', async () => {
    let resolveFirst!: (info: MediaInfo | null) => void;
    library.info.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    library.info.mockRejectedValueOnce(new ApiRequestError(500, 'ffprobe is not installed', null));
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.selected.set('a.mp4');
    fixture.detectChanges();
    await Promise.resolve();
    host.selected.set('b.mp4');
    fixture.detectChanges();
    // The answer for the file selected before arrives late; it is not shown for this one.
    resolveFirst({ ...VIDEO, filename: 'a.mp4' });
    await settle();

    expect(library.info.mock.calls).toEqual([['a.mp4'], ['b.mp4']]);
    expect(infoRows()).toEqual([['Error', 'ffprobe is not installed']]);
  });

  it('Delete names the files and the slots that will be cleared; Cancel changes nothing', async () => {
    // The slots as last polled, and what the server holds by the time Delete is pressed.
    slots.slots.set([slot(3, { file: 'people/walk.mp4', state: 'playing' })]);
    slots.next = [
      slot(3, { file: 'people/walk.mp4', state: 'playing' }),
      slot(9, { file: 'people/walk.mp4' }),
    ];
    await show('people/walk.mp4');

    button('Delete…').click();
    await settleOverlay();

    expect(slots.refresh).toHaveBeenCalled();
    // It stays enabled while asking, so Cancel can give the focus back to it.
    expect(button('Delete…').disabled).toBe(false);
    expect(confirmText()).toBe(
      'Delete File | Delete this media file people/walk.mp4? In use on src3, src9; those slots are cleared.',
    );
    await answer('Cancel');
    expect(confirmDialog()).toBeNull();
    expect(library.delete).not.toHaveBeenCalled();
    expect(host.selected()).toBe('people/walk.mp4');

    // A file no slot uses says nothing about slots.
    slots.next = [];
    button('Delete…').click();
    await settleOverlay();
    expect(confirmText()).toBe('Delete File | Delete this media file people/walk.mp4?');
    await answer('Delete');
    expect(library.delete).toHaveBeenCalledWith(['people/walk.mp4']);
    expect(toasts.status).toHaveBeenCalledWith('Removed 1 media file(s).');
    expect(host.selected()).toBeNull();
    expect(text()).toBe('Select a file.');
    // The button that had the focus is gone: the note takes it, rather than the page's body.
    expect(document.activeElement).toBe(panel().querySelector('p'));
  });

  it('checking several files shows N selected and deletes them in order, reporting the first failure', async () => {
    slots.next = [slot(2, { file: 'b.mp4' }), slot(5, { file: 'a.mp4', state: 'playing' })];
    library.delete.mockResolvedValue({
      deleted: ['c.mp4'],
      failed: [
        { path: 'b.mp4', message: 'Invalid path' },
        { path: 'a.mp4', message: 'Not found' },
      ],
    });
    await show('people/walk.mp4', ['b.mp4', 'c.mp4', 'a.mp4']);

    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('3 selected');
    expect([...panel().querySelectorAll('li')].map((li) => li.textContent!.trim())).toEqual([
      'b.mp4',
      'c.mp4',
      'a.mp4',
    ]);
    expect(panel().querySelector('video, img')).toBeNull();

    button('Delete…').click();
    await settleOverlay();
    expect(confirmText()).toBe(
      'Delete Files | Delete 3 media files: b.mp4, c.mp4, a.mp4? In use on src2, src5; those slots are cleared.',
    );
    await answer('Delete');

    expect(library.delete).toHaveBeenCalledWith(['b.mp4', 'c.mp4', 'a.mp4']);
    expect(toasts.error).toHaveBeenCalledWith('b.mp4: Invalid path');
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.status).toHaveBeenCalledWith('Removed 1/3 media file(s).');
    expect(host.checked()).toEqual([]);
    // The previewed file was not among them: it shows again.
    expect(host.selected()).toBe('people/walk.mp4');
    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
    expect(document.activeElement).toBe(panel().querySelector('h2'));
  });

  it('Clear N unticks the files and shows the selected file again', async () => {
    await show('people/walk.mp4', ['a.mp4', 'b.mp4']);
    button('Clear 2').click();
    await settle();
    expect(host.checked()).toEqual([]);
    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
  });

  it('holds Delete while a delete is under way', async () => {
    let finish!: (outcome: DeleteOutcome) => void;
    library.delete.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');
    expect(button('Delete…').disabled).toBe(true);

    finish({ deleted: ['a.mp4'], failed: [] });
    await settleOverlay();
    expect(text()).toBe('Select a file.');
  });

  it('a second press while it asks does nothing; one question, one fetch of the slots', async () => {
    let answerSlots!: () => void;
    slots.refresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => (answerSlots = resolve)),
    );
    await show('a.mp4');
    button('Delete…').click();
    button('Delete…').click();
    answerSlots();
    await settleOverlay();

    expect(slots.refresh).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await answer('Cancel');
    expect(library.delete).not.toHaveBeenCalled();
  });

  it('asks with the last known slots when they cannot be fetched again, and says so (Q16)', async () => {
    slots.slots.set([slot(4, { file: 'a.mp4' })]);
    slots.refresh.mockRejectedValueOnce(
      new ApiRequestError(500, 'MediaMTX is not answering', null),
    );
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();

    expect(confirmText()).toBe(
      'Delete File | Delete this media file a.mp4? In use on src4; those slots are cleared. Could not check which slots use these files.',
    );
    await answer('Delete');
    expect(library.delete).toHaveBeenCalledWith(['a.mp4']);
  });

  it('leaves the focus where the user moved it while the delete ran', async () => {
    let finish!: (outcome: DeleteOutcome) => void;
    library.delete.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const elsewhere = document.body.appendChild(document.createElement('button'));
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');
    elsewhere.focus();

    finish({ deleted: ['a.mp4'], failed: [] });
    await settleOverlay();
    expect(text()).toBe('Select a file.');
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
