import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaInfo, MediaNode, Slot } from '../../sources/api';
import { MediaLibraryService } from '../../sources/media-library.service';
import type { Progress } from '../../sources/progress-lines';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError } from '../../sources/stream-lines';
import { MediaPage } from './media.page';

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

const TREE: MediaNode[] = [
  {
    name: '/people',
    path: 'people',
    type: 'folder',
    streamable_count: 1,
    children: [{ name: 'walk.mp4', path: 'people/walk.mp4', type: 'file', streamable: true }],
  },
  { name: 'cars.mp4', path: 'cars.mp4', type: 'file', streamable: true },
  { name: 'idle.mp4', path: 'idle.mp4', type: 'file', streamable: true },
  { name: 'notes.txt', path: 'notes.txt', type: 'file', streamable: false },
];

const INFO: MediaInfo = { filename: 'cars.mp4', size_bytes: 2048, type: 'unknown' };

class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>(null);
  readonly unavailable = signal(false);
  readonly encodes = signal<ReadonlyMap<number, Progress>>(new Map());
  watchers = 0;
  readonly watch = vi.fn(() => {
    this.watchers++;
    let released = false;
    return () => {
      if (!released) this.watchers--;
      released = true;
    };
  });
  readonly refresh = vi.fn(async () => undefined);
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
  readonly tree = signal<readonly MediaNode[] | null>(TREE);
  readonly refresh = vi.fn(async () => undefined);
  readonly info = vi.fn(async () => INFO);
  readonly delete = vi.fn();
}

/** The app frame, so the page's toolbar has a top bar to render into. */
@Component({
  imports: [NeatShell, RouterOutlet],
  template: `<neat-shell appName="Neat Insight" [navItems]="[]"><router-outlet /></neat-shell>`,
})
class Shell {}

@Component({ template: '' })
class Elsewhere {}

describe('MediaPage', () => {
  let slots: FakeSlots;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
  let fixture: ComponentFixture<Shell>;

  beforeEach(() => {
    slots = new FakeSlots();
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'media', component: MediaPage },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        { provide: SlotsService, useValue: slots },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const settle = () => fixture.whenStable();

  async function open(): Promise<void> {
    fixture = TestBed.createComponent(Shell);
    await TestBed.inject(Router).navigateByUrl('/media');
    await settle();
  }

  const toolbarButton = (name: string): HTMLButtonElement =>
    [...root().querySelectorAll<HTMLButtonElement>('.page-toolbar button')].find(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
    )!;
  const rows = (): HTMLElement[] => [...root().querySelectorAll<HTMLElement>('[role="option"]')];
  /** A row's cells as their text, in column order. */
  const cells = (row: HTMLElement): string[] =>
    [...row.querySelectorAll(':scope > div')].map((cell) =>
      cell.textContent!.replace(/\s+/g, ' ').trim(),
    );
  const nameOf = (row: HTMLElement) =>
    row.querySelector('[data-slot="file-name"] .truncate')!.textContent!.trim();
  const tagOf = (row: HTMLElement) =>
    row.querySelector('[data-slot="file-tag"]')?.textContent?.trim() ?? '';
  const rowOf = (name: string): HTMLElement => rows().find((row) => nameOf(row) === name)!;
  const header = (): string[] =>
    [...root().querySelectorAll('[data-slot="select-list-header"] span')].map((cell) =>
      cell.textContent!.trim(),
    );
  const aside = (): HTMLElement | null =>
    root().querySelector('section[aria-label="Selected media"]');
  const notice = () => root().querySelector('p[role="status"]')?.textContent?.trim() ?? '';

  it('lists folders and files with the slots each file is assigned to', async () => {
    slots.slots.set([
      slot(1, { file: 'idle.mp4' }),
      slot(3, { file: 'cars.mp4', state: 'playing' }),
      slot(5, { file: 'idle.mp4', state: 'playing' }),
      slot(9, { file: 'cars.mp4' }),
      slot(10, { file: 'idle.mp4', state: 'external' }),
    ]);
    slots.encodes.set(new Map([[1, { title: 'Encoding', detail: '', percent: 10 }]]));
    await open();

    expect(header()).toEqual(['Name', 'In use']);
    // The name, the tag a file Insight cannot stream carries (greyed, still listed), In use.
    expect(rows().map((row) => [nameOf(row), tagOf(row), cells(row)[1]])).toEqual([
      ['people', '', ''],
      ['cars.mp4', '', 'src3 · Live, src9 · Idle'],
      ['idle.mp4', '', 'src1 · Encoding, src5 · Live, src10 · External'],
      ['notes.txt', 'NOT STREAMABLE', ''],
    ]);
    expect(
      rowOf('cars.mp4').querySelector('input[type="checkbox"]')!.getAttribute('aria-label'),
    ).toBe('Select cars.mp4 for deletion');
  });

  it('fetches the library as it opens and polls the slots while it is shown', async () => {
    await open();
    expect(library.refresh).toHaveBeenCalledTimes(1);
    expect(slots.watchers).toBe(1);

    await TestBed.inject(Router).navigateByUrl('/elsewhere');
    await settle();
    expect(slots.watchers).toBe(0);
  });

  it('a library that cannot be fetched is reported', async () => {
    library.refresh.mockRejectedValueOnce(
      new ApiRequestError(500, 'Media folder unreadable', null),
    );
    await open();
    expect(toasts.error).toHaveBeenCalledWith('Media folder unreadable');
  });

  it('says so when the slot status could not be refreshed (Q8)', async () => {
    await open();
    expect(notice()).toBe('');
    slots.unavailable.set(true);
    await settle();
    expect(notice()).toBe('Slot status could not be refreshed. Showing the last known state.');
  });

  it('a click on a file shows it in the side panel; ticking files shows them there instead', async () => {
    await open();
    expect(aside()!.textContent!.trim()).toBe('Select a file.');

    rowOf('cars.mp4').click();
    await settle();
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('cars.mp4');
    expect(library.info).toHaveBeenCalledWith('cars.mp4');

    rowOf('cars.mp4').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    rowOf('idle.mp4').querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await settle();
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('2 selected');
  });

  it('the top bar has Import… and the side-panel toggle, which hides and shows the panel', async () => {
    await open();
    expect(toolbarButton('Import…').disabled).toBe(false);

    toolbarButton('Side panel').click();
    await settle();
    expect(aside()).toBeNull();
    toolbarButton('Side panel').click();
    await settle();
    expect(aside()).not.toBeNull();
  });
});
