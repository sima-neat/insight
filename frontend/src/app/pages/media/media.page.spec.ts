import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet } from '@angular/router';
import { NeatShell } from '@sima/neat-ui';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaInfo, MediaNode, Slot } from '../../sources/api';
import { ImportDialogs } from '../../sources/import-dialog';
import { MediaLibraryService } from '../../sources/media-library.service';
import type { Progress } from '../../sources/progress-lines';
import { SlotsService } from '../../sources/slots.service';
import { ApiRequestError } from '../../sources/stream-lines';
import { FakeLocalStorage } from '../../viewer/settings/fake-storage.testing';
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
  let imports: { open: ReturnType<typeof vi.fn<(tab?: string) => Promise<string | null>>> };
  let fixture: ComponentFixture<Shell>;

  let storage: FakeLocalStorage;

  beforeEach(() => {
    // The side panel's open state is remembered in storage: a fresh one for every test.
    storage = new FakeLocalStorage();
    vi.stubGlobal('localStorage', storage);
    slots = new FakeSlots();
    library = new FakeLibrary();
    toasts = { error: vi.fn(), status: vi.fn() };
    imports = { open: vi.fn<(tab?: string) => Promise<string | null>>() };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'media', component: MediaPage },
          { path: 'elsewhere', component: Elsewhere },
        ]),
        { provide: SlotsService, useValue: slots },
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
        { provide: ImportDialogs, useValue: imports },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    row.querySelector('neat-status-chip')?.textContent?.trim() ?? '';
  const rowOf = (name: string): HTMLElement => rows().find((row) => nameOf(row) === name)!;
  /** Ticks a file's box, as a click on the box (and nothing else on the row) does. */
  const tick = (name: string) =>
    rowOf(name).querySelector<HTMLElement>('[data-slot="select-list-check"]')!.click();
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

    // The first column holds the tick boxes and has no heading.
    expect(header()).toEqual(['', 'Name', 'In use']);
    // The name, the tag a file Insight cannot stream carries (greyed, still listed), In use.
    expect(rows().map((row) => [nameOf(row), tagOf(row), cells(row)[2]])).toEqual([
      ['people', '', ''],
      ['cars.mp4', '', 'src3 · Live, src9 · Idle'],
      ['idle.mp4', '', 'src1 · Encoding, src5 · Live, src10 · External'],
      ['notes.txt', 'NOT STREAMABLE', ''],
    ]);
    // Files are ticked for deletion: the listbox is multi-selectable and a ticked file is selected.
    expect(root().querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe(
      'true',
    );
    expect(rowOf('cars.mp4').getAttribute('aria-selected')).toBe('false');
    expect(rowOf('people').hasAttribute('aria-selected')).toBe(false);
  });

  it('fetches the library as it opens and polls the slots while it is shown', async () => {
    await open();
    expect(library.refresh).toHaveBeenCalledTimes(1);
    expect(slots.watchers).toBe(1);

    await TestBed.inject(Router).navigateByUrl('/elsewhere');
    await settle();
    expect(slots.watchers).toBe(0);
  });

  it('says it is loading until the library first answers', async () => {
    library.tree.set(null);
    let answer!: () => void;
    library.refresh.mockReturnValueOnce(
      new Promise<undefined>((resolve) => (answer = () => resolve(undefined))),
    );
    await open();
    expect(root().querySelector('app-slots-column')!.textContent).toContain('Loading media…');
    expect(root().querySelector('neat-file-browser')).toBeNull();

    library.tree.set(TREE);
    answer();
    await settle();
    expect(root().querySelector('app-slots-column')!.textContent).not.toContain('Loading media…');
    expect(rows().map(nameOf)).toEqual(['people', 'cars.mp4', 'idle.mp4', 'notes.txt']);
  });

  it('a first fetch that fails stops loading and shows the empty library', async () => {
    library.tree.set(null);
    library.refresh.mockRejectedValueOnce(
      new ApiRequestError(500, 'Media folder unreadable', null),
    );
    await open();
    // The failure reaches the page a few promise turns after the navigation settled.
    await new Promise((resolve) => setTimeout(resolve));
    await settle();
    expect(toasts.error).toHaveBeenCalledWith('Media folder unreadable');
    expect(root().querySelector('app-slots-column')!.textContent).not.toContain('Loading media…');
    expect(root().querySelector('neat-file-browser')).not.toBeNull();
  });

  it('shows a library fetched before at once, while it is fetched again', async () => {
    library.refresh.mockReturnValueOnce(new Promise<undefined>(() => undefined));
    await open();
    expect(root().querySelector('app-slots-column')!.textContent).not.toContain('Loading media…');
    expect(rows()).toHaveLength(4);
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

    tick('cars.mp4');
    tick('idle.mp4');
    await settle();
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('2 selected');
  });

  it('a file that leaves the library leaves the selection and the ticks', async () => {
    await open();
    rowOf('cars.mp4').click();
    tick('idle.mp4');
    await settle();
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('1 selected');

    // Another tab deleted both; the next fetch of the library no longer lists them.
    library.tree.set(TREE.filter((node) => node.path !== 'cars.mp4' && node.path !== 'idle.mp4'));
    await settle();
    expect(aside()!.textContent!.trim()).toBe('Select a file.');
  });

  it('Import… opens the import dialog on Local files, then shows what it imported, selected', async () => {
    await open();
    imports.open.mockResolvedValueOnce('people/walk.mp4');
    toolbarButton('Import…').click();
    await settle();

    expect(imports.open).toHaveBeenCalledExactlyOnceWith('local');
    // Fetched again, so the tree holds the new file.
    expect(library.refresh).toHaveBeenCalledTimes(2);
    expect(root().querySelector('nav[aria-label="Current folder"]')!.textContent).toContain(
      'people',
    );
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
  });

  it('an archive’s import opens its folder; a dialog closed without an import changes nothing', async () => {
    await open();
    imports.open.mockResolvedValueOnce(null);
    toolbarButton('Import…').click();
    await settle();
    expect(library.refresh).toHaveBeenCalledTimes(1);
    expect(rows().map(nameOf)).toEqual(['people', 'cars.mp4', 'idle.mp4', 'notes.txt']);

    imports.open.mockResolvedValueOnce('people');
    toolbarButton('Import…').click();
    await settle();
    expect(rows().map(nameOf)).toEqual(['walk.mp4']);
    expect(aside()!.textContent!.trim()).toBe('Select a file.');
  });

  it('the top bar’s side-panel toggle hides and shows the panel, remembered in storage', async () => {
    await open();
    toolbarButton('Side panel').click();
    await settle();
    expect(aside()).toBeNull();
    expect(storage.values.get('neat-insight:media:aside')).toBe('closed');
    toolbarButton('Side panel').click();
    await settle();
    expect(aside()).not.toBeNull();
    expect(storage.values.get('neat-insight:media:aside')).toBe('open');
  });

  it('keeps the folder, the selected file and the ticks across visits', async () => {
    await open();
    rowOf('people').click();
    await settle();
    rowOf('walk.mp4').click();
    await settle();
    await TestBed.inject(Router).navigateByUrl('/elsewhere');
    await settle();

    await TestBed.inject(Router).navigateByUrl('/media');
    await settle();
    expect(root().querySelector('nav[aria-label="Current folder"]')!.textContent).toContain(
      'people',
    );
    expect(aside()!.querySelector('h2')!.textContent!.trim()).toBe('people/walk.mp4');
  });
});
