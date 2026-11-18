import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatDetails } from '@sima/neat-ui/details';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaFileInfo, Slot } from '../../api.generated';
import { MediaLibraryService } from '../../sources/media-library.service';
import { videoInfo } from '../../sources/media.testing';
import { SlotsService } from '../../sources/slots.service';
import { fileSlot } from '../../sources/slots.testing';
import { ApiRequestError } from '../../sources/stream-lines';
import { MediaPanel } from './media-panel';

const VIDEO = videoInfo('people/walk.mp4', { size: 5_452_595 });

/** `SlotsService` as the panel uses it: the slots set by the test, `refresh` answering with `next`. */
class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([]);
  readonly encodes = signal(new Map());
  /** What the server holds now, which a refresh brings in. */
  next: readonly Slot[] = [];
  readonly refresh = vi.fn(async () => {
    this.slots.set(this.next);
  });
  /** As the service's: a refresh, resolved as whether it worked. */
  recheck(): Promise<boolean> {
    return this.refresh().then(
      () => true,
      () => false,
    );
  }
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
  readonly info = vi.fn<(path: string) => Promise<MediaFileInfo | null>>(async () => VIDEO);
  readonly delete = vi.fn<(paths: readonly string[]) => Promise<readonly string[]>>(
    async (paths) => [...paths],
  );
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
    expect(panel().querySelector('video')!.getAttribute('src')).toBe(
      '/api/media/file?path=people%2Fwalk.mp4',
    );
    expect(button('Delete…')).toBeDefined();
  });

  it('previews a file the probe finds MJPEG through the MJPEG route', async () => {
    library.info.mockResolvedValue(
      videoInfo('clips/cam.avi', { codec: 'mjpeg', codec_name: 'MJPEG' }),
    );
    await show('clips/cam.avi');
    expect(panel().querySelector('video')).toBeNull();
    expect(panel().querySelector('img')!.getAttribute('src')).toBe(
      '/api/media/preview.mjpg?path=clips%2Fcam.avi',
    );
  });

  it('shows the info of the file selected last, and a failed probe as an Error row', async () => {
    let resolveFirst!: (info: MediaFileInfo | null) => void;
    library.info.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));
    library.info.mockRejectedValueOnce(new ApiRequestError(503, 'FFmpeg is not installed.', null));
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.selected.set('a.mp4');
    fixture.detectChanges();
    await Promise.resolve();
    host.selected.set('b.mp4');
    fixture.detectChanges();
    // The answer for the file selected before arrives late; it is not shown for this one.
    resolveFirst(videoInfo('a.mp4'));
    await settle();

    expect(library.info.mock.calls).toEqual([['a.mp4'], ['b.mp4']]);
    expect(infoRows()).toEqual([['Error', 'FFmpeg is not installed.']]);
  });

  it('Delete asks naming the file; Cancel changes nothing, Delete removes it', async () => {
    await show('people/walk.mp4');

    button('Delete…').click();
    await settleOverlay();

    expect(slots.refresh).toHaveBeenCalled();
    // It stays enabled while asking, so Cancel can give the focus back to it.
    expect(button('Delete…').disabled).toBe(false);
    expect(confirmText()).toBe('Delete File | Delete this media file people/walk.mp4?');
    await answer('Cancel');
    expect(confirmDialog()).toBeNull();
    expect(library.delete).not.toHaveBeenCalled();
    expect(host.selected()).toBe('people/walk.mp4');

    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');
    expect(library.delete).toHaveBeenCalledWith(['people/walk.mp4']);
    expect(toasts.status).toHaveBeenCalledWith('Removed 1 media file(s).');
    expect(host.selected()).toBeNull();
    expect(text()).toBe('Select a file.');
    // The button that had the focus is gone: the note takes it, rather than the page's body.
    expect(document.activeElement).toBe(panel().querySelector('p'));
  });

  it('a file the slots use, as they are now, is not asked about: the panel names the slots to clear', async () => {
    // The slots as last polled, and what the server holds by the time Delete is pressed.
    slots.slots.set([fileSlot(3, 'people/walk.mp4', { run: true, state: 'live' })]);
    slots.next = [
      fileSlot(3, 'people/walk.mp4', { run: true, state: 'live' }),
      fileSlot(9, 'people/walk.mp4'),
    ];
    await show('people/walk.mp4');

    button('Delete…').click();
    await settleOverlay();

    expect(confirmDialog()).toBeNull();
    expect(library.delete).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      'people/walk.mp4 is in use on src3, src9. Clear those slots, then delete again.',
    );
    expect(host.selected()).toBe('people/walk.mp4');
  });

  it('checking several files shows N selected and deletes them in one request', async () => {
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
    expect(confirmText()).toBe('Delete Files | Delete 3 media files: b.mp4, c.mp4, a.mp4?');
    await answer('Delete');

    expect(library.delete).toHaveBeenCalledWith(['b.mp4', 'c.mp4', 'a.mp4']);
    expect(toasts.status).toHaveBeenCalledWith('Removed 3 media file(s).');
    expect(host.checked()).toEqual([]);
    // The previewed file was not among them: it shows again.
    expect(host.selected()).toBe('people/walk.mp4');
    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
    expect(document.activeElement).toBe(panel().querySelector('h2'));
  });

  it('several files of which the slots use some are not asked about either', async () => {
    slots.next = [fileSlot(2, 'b.mp4'), fileSlot(5, 'a.mp4', { run: true, state: 'live' })];
    await show(null, ['b.mp4', 'c.mp4', 'a.mp4']);

    button('Delete…').click();
    await settleOverlay();

    expect(confirmDialog()).toBeNull();
    expect(toasts.error).toHaveBeenCalledWith(
      'These files are in use on src2, src5. Clear those slots, then delete again.',
    );
    expect(host.checked()).toEqual(['b.mp4', 'c.mp4', 'a.mp4']);
  });

  it('a delete the server refuses says why with its message and keeps the files ticked', async () => {
    library.delete.mockRejectedValueOnce(
      new ApiRequestError(409, 'a.mp4 is used by src12.', {
        error: {
          code: 'in_use',
          message: 'a.mp4 is used by src12.',
          hint: 'Clear those slots, then delete again.',
        },
        slots: [12],
      }),
    );
    await show(null, ['a.mp4', 'b.mp4']);

    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');

    expect(toasts.error).toHaveBeenCalledWith(
      'a.mp4 is used by src12. Clear those slots, then delete again.',
    );
    expect(toasts.status).not.toHaveBeenCalled();
    expect(host.checked()).toEqual(['a.mp4', 'b.mp4']);
    expect(button('Delete…').disabled).toBe(false);
  });

  it('Clear N unticks the files and shows the selected file again', async () => {
    await show('people/walk.mp4', ['a.mp4', 'b.mp4']);
    button('Clear 2').click();
    await settle();
    expect(host.checked()).toEqual([]);
    expect(panel().querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
  });

  it('holds Delete while a delete is under way', async () => {
    let finish!: (deleted: readonly string[]) => void;
    library.delete.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');
    expect(button('Delete…').disabled).toBe(true);

    finish(['a.mp4']);
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

  it('asks when the slots cannot be fetched again, and says so (Q16): the server has the last word', async () => {
    slots.slots.set([fileSlot(4, 'a.mp4')]);
    slots.refresh.mockRejectedValueOnce(
      new ApiRequestError(500, 'MediaMTX is not answering', null),
    );
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();

    expect(confirmText()).toBe(
      'Delete File | Delete this media file a.mp4? Could not check which slots use these files.',
    );
    await answer('Delete');
    expect(library.delete).toHaveBeenCalledWith(['a.mp4']);
  });

  it('leaves the focus where the user moved it while the delete ran', async () => {
    let finish!: (deleted: readonly string[]) => void;
    library.delete.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const elsewhere = document.body.appendChild(document.createElement('button'));
    await show('a.mp4');
    button('Delete…').click();
    await settleOverlay();
    await answer('Delete');
    elsewhere.focus();

    finish(['a.mp4']);
    await settleOverlay();
    expect(text()).toBe('Select a file.');
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
