import { Component, signal, viewChild } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { MediaNode } from '../../sources/api';
import { MediaLibraryService } from '../../sources/media-library.service';
import { ApiRequestError } from '../../sources/stream-lines';
import { MediaPicker } from './media-picker';

const TREE: MediaNode[] = [
  {
    name: '/people',
    path: 'people',
    type: 'folder',
    streamable_count: 2,
    children: [
      { name: 'walk.mp4', path: 'people/walk.mp4', type: 'file', streamable: true },
      { name: 'run.mp4', path: 'people/run.mp4', type: 'file', streamable: true },
      { name: 'notes.txt', path: 'people/notes.txt', type: 'file', streamable: false },
      { name: 'cover.png', path: 'people/cover.png', type: 'file', streamable: false },
    ],
  },
  { name: 'cars.mp4', path: 'cars.mp4', type: 'file', streamable: true },
];

class FakeLibrary {
  readonly tree = signal<readonly MediaNode[] | null>(TREE);
  readonly refresh = vi.fn(async () => undefined);
}

@Component({
  imports: [MediaPicker],
  template: `<app-media-picker
    [current]="current()"
    [busy]="busy()"
    (assign)="assigned.push($event)"
    (cancelled)="cancels = cancels + 1"
    (importRequested)="imports = imports + 1"
  />`,
})
class Host {
  readonly current = signal('people/walk.mp4');
  readonly busy = signal(false);
  readonly assigned: string[] = [];
  cancels = 0;
  imports = 0;
  readonly picker = viewChild.required(MediaPicker);
}

describe('MediaPicker', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let library: FakeLibrary;
  let toasts: { error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    library = new FakeLibrary();
    toasts = { error: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: MediaLibraryService, useValue: library },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  async function open(current = 'people/walk.mp4'): Promise<void> {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.current.set(current);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const text = () => root().textContent!.replace(/\s+/g, ' ');
  const options = () => [...root().querySelectorAll<HTMLElement>('[role="option"]')];
  const option = (name: string) => options().find((row) => row.textContent?.includes(name))!;
  const crumbs = () =>
    [...root().querySelectorAll('nav li')].map((crumb) => crumb.textContent!.trim());
  const button = (label: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label,
    )!;
  const filterField = () => root().querySelector<HTMLInputElement>('input[type="search"], input')!;

  async function click(element: HTMLElement): Promise<void> {
    element.click();
    await fixture.whenStable();
  }

  it('opens in the folder of the current file with that file selected, and fetches the library', async () => {
    await open();
    expect(library.refresh).toHaveBeenCalledOnce();
    expect(crumbs().join(' ')).toContain('people');
    expect(option('walk.mp4').getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain('Selected: people/walk.mp4');
    expect(filterField().placeholder).toBe('Filter files in people...');
  });

  it('a library that cannot be fetched is reported, and the picker shows what it had', async () => {
    library.refresh.mockRejectedValueOnce(new ApiRequestError(500, 'Media folder missing', null));
    await open();
    expect(toasts.error).toHaveBeenCalledWith('Media folder missing');
    expect(option('walk.mp4')).toBeDefined();
  });

  it('lists only the files Insight can stream, and says how many the folder hides while no filter is typed', async () => {
    await open();
    expect(options().map((row) => row.textContent?.trim())).toEqual([
      expect.stringContaining('run.mp4'),
      expect.stringContaining('walk.mp4'),
    ]);
    expect(text()).toContain('2 files hidden because Insight cannot stream them.');

    filterField().value = 'wal';
    filterField().dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(text()).not.toContain('hidden because');

    await open('cars.mp4');
    expect(text()).not.toContain('hidden because');
  });

  it('Assign sends the picked file once it differs from the current one; Cancel sends nothing', async () => {
    await open();
    // The current file is no change to assign.
    expect(button('Assign').disabled).toBe(true);

    await click(option('run.mp4'));
    expect(text()).toContain('Selected: people/run.mp4');
    expect(button('Assign').disabled).toBe(false);
    await click(button('Assign'));
    expect(host.assigned).toEqual(['people/run.mp4']);

    // While the assignment is in flight, nothing else can be sent.
    host.busy.set(true);
    await fixture.whenStable();
    expect(button('Assign').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Import…').disabled).toBe(true);

    host.busy.set(false);
    await fixture.whenStable();
    await click(button('Cancel'));
    expect(host.cancels).toBe(1);
    expect(host.assigned).toEqual(['people/run.mp4']);
  });

  it('with nothing assigned it opens at the root and waits for a pick', async () => {
    await open('');
    expect(text()).toContain('Selected: Not assigned');
    expect(button('Assign').disabled).toBe(true);
    expect(option('cars.mp4')).toBeDefined();
  });

  it('Import… asks for the import dialog; reveal then shows the imported file in its folder once the library has it (Q1)', async () => {
    await open('cars.mp4');
    await click(button('Import…'));
    expect(host.imports).toBe(1);

    // What Task 13's import does on success: the library gains the file, and the picker reveals it.
    library.refresh.mockImplementationOnce(async () => {
      library.tree.set([
        ...TREE,
        {
          name: '/youtube',
          path: 'youtube',
          type: 'folder',
          streamable_count: 1,
          children: [
            { name: 'clip.mp4', path: 'youtube/clip.mp4', type: 'file', streamable: true },
          ],
        },
      ]);
    });
    await host.picker().reveal('youtube/clip.mp4');
    await fixture.whenStable();
    expect(crumbs().join(' ')).toContain('youtube');
    expect(option('clip.mp4').getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain('Selected: youtube/clip.mp4');
    expect(button('Assign').disabled).toBe(false);
  });
});
