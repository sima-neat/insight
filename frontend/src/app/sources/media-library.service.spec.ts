import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { MediaEntry, MediaSaved } from '../api.generated';
import type { CatalogIndex } from './catalog';
import { JobFailedError } from './jobs';
import { FakeEventSources } from './jobs.testing';
import { type LibraryEvent, MediaLibraryService, toFileNodes } from './media-library.service';
import { mediaFile as file, mediaFolder as folder, mediaRoot, videoInfo } from './media.testing';
import { SlotsService } from './slots.service';
import { fileSlot, job, slotList } from './slots.testing';

const TREE_URL = '/api/media';
const INFO_URL = '/api/media/info';
const SLOTS_URL = '/api/slots';
const RENDITIONS_URL = '/api/renditions';

/** The library's error shape, with what it adds beside `error`. */
const refusal = (code: string, message: string, extra: object = {}) => ({
  error: { code, message },
  ...extra,
});

/** Lets the promise chains behind a flushed request run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('toFileNodes', () => {
  const tree: MediaEntry[] = [
    folder('catalog', [
      folder('catalog/street', [
        file('catalog/street/day.mp4'),
        file('catalog/street/notes.txt', false),
      ]),
      folder('catalog/docs', [file('catalog/docs/readme.txt', false)]),
    ]),
    file('clip.mp4'),
    file('readme.txt', false),
  ];

  it('tags unstreamable files and greys them in manage mode', () => {
    expect(toFileNodes(tree, 'manage')).toEqual([
      {
        name: 'catalog',
        path: 'catalog',
        type: 'folder',
        children: [
          {
            name: 'street',
            path: 'catalog/street',
            type: 'folder',
            children: [
              { name: 'day.mp4', path: 'catalog/street/day.mp4', type: 'file' },
              {
                name: 'notes.txt',
                path: 'catalog/street/notes.txt',
                type: 'file',
                unavailable: true,
                tag: 'NOT STREAMABLE',
              },
            ],
          },
          {
            name: 'docs',
            path: 'catalog/docs',
            type: 'folder',
            children: [
              {
                name: 'readme.txt',
                path: 'catalog/docs/readme.txt',
                type: 'file',
                unavailable: true,
                tag: 'NOT STREAMABLE',
              },
            ],
          },
        ],
      },
      { name: 'clip.mp4', path: 'clip.mp4', type: 'file' },
      {
        name: 'readme.txt',
        path: 'readme.txt',
        type: 'file',
        unavailable: true,
        tag: 'NOT STREAMABLE',
      },
    ]);
  });

  it('hides unstreamable files in pick mode and greys the folders left with nothing to pick', () => {
    expect(toFileNodes(tree, 'pick')).toEqual([
      {
        name: 'catalog',
        path: 'catalog',
        type: 'folder',
        children: [
          {
            name: 'street',
            path: 'catalog/street',
            type: 'folder',
            children: [{ name: 'day.mp4', path: 'catalog/street/day.mp4', type: 'file' }],
          },
          { name: 'docs', path: 'catalog/docs', type: 'folder', children: [], unavailable: true },
        ],
      },
      { name: 'clip.mp4', path: 'clip.mp4', type: 'file' },
    ]);
  });

  it('greys a pick-mode folder whose files are all deeper and all unstreamable, and keeps one with a streamable file only deeper', () => {
    const nested: MediaEntry[] = [
      folder('a', [folder('a/b', [file('a/b/x.txt', false)])]),
      folder('c', [folder('c/d', [file('c/d/y.mp4')])]),
    ];
    const [a, c] = toFileNodes(nested, 'pick');
    expect(a.unavailable).toBe(true);
    expect(a.children?.[0].unavailable).toBe(true);
    expect(c.unavailable).toBeUndefined();
  });

  it('maps an empty library to an empty tree, and an empty folder (no children) is greyed only in pick mode', () => {
    expect(toFileNodes([], 'pick')).toEqual([]);

    const empty = [folder('empty', [])];
    expect(empty[0].children).toBeUndefined();
    expect(toFileNodes(empty, 'manage')[0].unavailable).toBeUndefined();
    expect(toFileNodes(empty, 'pick')[0].unavailable).toBe(true);
  });
});

describe('MediaLibraryService', () => {
  let http: HttpTestingController;
  let library: MediaLibraryService;
  let sources: FakeEventSources;

  beforeEach(() => {
    sources = new FakeEventSources();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), sources.provider()],
    });
    http = TestBed.inject(HttpTestingController);
    library = TestBed.inject(MediaLibraryService);
  });

  afterEach(() => http.verify());

  /** Answers what a change fetches again once it has settled: the tree, the slots and the renditions. */
  function answerRefreshes(tree: MediaEntry[] = []): void {
    http.expectOne(TREE_URL).flush(mediaRoot(tree));
    http.expectOne(SLOTS_URL).flush(slotList([]));
    http.expectOne(RENDITIONS_URL).flush({ count: 0, bytes: 0, in_use: 0 });
  }

  describe('refresh', () => {
    it("loads the root folder's entries, and the newest answer wins", async () => {
      expect(library.tree()).toBeNull();
      const older = library.refresh();
      const first = http.expectOne(TREE_URL);
      const newer = library.refresh();
      const second = http.expectOne(TREE_URL);

      second.flush(mediaRoot([file('new.mp4')]));
      first.flush(mediaRoot([file('old.mp4')]));
      await Promise.all([older, newer]);

      expect(library.tree()).toEqual([file('new.mp4')]);
    });

    it('takes an empty library, whose root has no children, as no entries', async () => {
      const loaded = library.refresh();
      http.expectOne(TREE_URL).flush(mediaRoot([]));
      await loaded;
      expect(library.tree()).toEqual([]);
    });

    it("rejects with the server's message and keeps the tree it had", async () => {
      const loaded = library.refresh();
      http.expectOne(TREE_URL).flush(mediaRoot([file('a.mp4')]));
      await loaded;

      const failed = library.refresh();
      http
        .expectOne(TREE_URL)
        .flush(refusal('internal', 'disk gone'), { status: 500, statusText: 'Server Error' });

      await expect(failed).rejects.toMatchObject({ status: 500, message: 'disk gone' });
      expect(library.tree()).toEqual([file('a.mp4')]);
    });
  });

  describe('info', () => {
    const infoOf = (path: string) =>
      http.expectOne((r) => r.url === INFO_URL && r.params.get('path') === path);

    it('asks for the path and resolves with the probe', async () => {
      const info = library.info('people/a b.mp4');
      const request = infoOf('people/a b.mp4');
      expect(request.request.method).toBe('GET');
      request.flush(videoInfo('people/a b.mp4'));

      await expect(info).resolves.toEqual(videoInfo('people/a b.mp4'));
    });

    it('ignores a late answer for an earlier path', async () => {
      const earlier = library.info('a.mp4');
      const first = infoOf('a.mp4');
      const later = library.info('b.mp4');
      const second = infoOf('b.mp4');

      second.flush(videoInfo('b.mp4'));
      first.flush(videoInfo('a.mp4'));

      await expect(later).resolves.toEqual(videoInfo('b.mp4'));
      await expect(earlier).resolves.toBeNull();
    });

    it('also ignores an earlier answer that arrives first, and an earlier failure', async () => {
      const earlier = library.info('a.mp4');
      const first = infoOf('a.mp4');
      const later = library.info('b.mp4');
      const second = infoOf('b.mp4');

      first.flush(refusal('not_found', 'gone'), { status: 404, statusText: 'Not Found' });
      second.flush(videoInfo('b.mp4'));

      await expect(earlier).resolves.toBeNull();
      await expect(later).resolves.toEqual(videoInfo('b.mp4'));
    });

    it("rejects with the server's message when the newest request fails", async () => {
      const info = library.info('a.mp4');
      infoOf('a.mp4').flush(refusal('internal', 'Probe failed'), {
        status: 500,
        statusText: 'Server Error',
      });

      await expect(info).rejects.toMatchObject({ status: 500, message: 'Probe failed' });
    });
  });

  describe('delete', () => {
    const DELETE_URL = '/api/media/delete';
    /** The request a step sends once the one before it has settled. */
    const nextRequest = (url: string) => vi.waitFor(() => http.expectOne(url));

    it('deletes the paths in one request, then refreshes the library, the slots and the renditions', async () => {
      const done = library.delete(['a.mp4', 'b.mp4']);

      const request = http.expectOne(DELETE_URL);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ paths: ['a.mp4', 'b.mp4'] });
      request.flush({ paths: ['a.mp4', 'b.mp4'] });

      await vi.waitFor(() => answerRefreshes());
      await expect(done).resolves.toEqual(['a.mp4', 'b.mp4']);
    });

    it('rejects with the in_use refusal, which names the slots, after refreshing all the same', async () => {
      const done = library.delete(['a.mp4']);
      http
        .expectOne(DELETE_URL)
        .flush(refusal('in_use', 'a.mp4 is used by src3.', { slots: [3] }), {
          status: 409,
          statusText: 'Conflict',
        });

      await vi.waitFor(() => answerRefreshes([file('a.mp4')]));
      await expect(done).rejects.toMatchObject({
        status: 409,
        code: 'in_use',
        message: 'a.mp4 is used by src3.',
        body: { slots: [3] },
      });
    });

    it('drops a slot poll that was already on its way when the delete settled', async () => {
      const slots = TestBed.inject(SlotsService);
      // A poll sent before the delete finished: it may still list the deleted file's slots.
      const poll = slots.refresh();
      const stale = http.expectOne(SLOTS_URL);

      const done = library.delete(['a.mp4']);
      http.expectOne(DELETE_URL).flush({ paths: ['a.mp4'] });
      const tree = await nextRequest(TREE_URL);
      const fresh = await nextRequest(SLOTS_URL);
      const renditions = await nextRequest(RENDITIONS_URL);

      stale.flush(slotList([fileSlot(1, 'a.mp4', { run: true, state: 'live' })]));
      await poll;
      expect(slots.slots()).toBeNull();

      tree.flush(mediaRoot([]));
      fresh.flush(slotList([]));
      renditions.flush({ count: 0, bytes: 0, in_use: 0 });
      await done;
      expect(slots.slots()).toEqual([]);
    });

    it('does not fail for a refresh that fails after the delete', async () => {
      const done = library.delete(['a.mp4']);
      http.expectOne(DELETE_URL).flush({ paths: ['a.mp4'] });

      const down = refusal('x', 'down');
      const badGateway = { status: 502, statusText: 'Bad Gateway' };
      await vi.waitFor(() => {
        http.expectOne(TREE_URL).flush(down, badGateway);
        http.expectOne(SLOTS_URL).flush(down, badGateway);
        http.expectOne(RENDITIONS_URL).flush(down, badGateway);
      });
      await expect(done).resolves.toEqual(['a.mp4']);
    });
  });

  describe('catalog', () => {
    it("catalog fetches the index, and rejects with the server's message", async () => {
      const index: CatalogIndex = {
        schema: '1',
        index_url: 'https://artifacts.neat.sima.ai/media-assets/index.json',
        base_url: 'https://artifacts.neat.sima.ai/media-assets/',
        sources: [],
        assets: [],
      };
      const loaded = library.catalog();
      http.expectOne('/api/catalog').flush(index);
      await expect(loaded).resolves.toEqual(index);

      const failed = library.catalog();
      http
        .expectOne('/api/catalog')
        .flush(
          refusal('catalog_unavailable', 'The media catalog could not be fetched: timed out.'),
          { status: 502, statusText: 'Bad Gateway' },
        );
      await expect(failed).rejects.toMatchObject({
        status: 502,
        message: 'The media catalog could not be fetched: timed out.',
      });
    });
  });

  describe('bringing files in', () => {
    const UPLOAD_URL = '/api/media/uploads';
    const saved: MediaSaved = { path: 'a.mp4' };

    function run(stream: ReturnType<MediaLibraryService['upload']>) {
      const seen: { events: LibraryEvent[]; error: unknown; completed: boolean } = {
        events: [],
        error: undefined,
        completed: false,
      };
      stream.subscribe({
        next: (event) => seen.events.push(event),
        error: (failure: unknown) => (seen.error = failure),
        complete: () => (seen.completed = true),
      });
      return seen;
    }

    it('upload sends the file with the conflict choice, reports its bytes, then what was saved (201)', async () => {
      const upload = new File(['x'], 'a.mp4', { type: 'video/mp4' });
      const seen = run(library.upload(upload, 'replace'));

      const request = http.expectOne(UPLOAD_URL);
      expect(request.request.method).toBe('POST');
      const body = request.request.body as FormData;
      expect(body.get('file')).toBe(upload);
      expect(body.get('on_conflict')).toBe('replace');
      request.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 2 });
      request.event({ type: HttpEventType.UploadProgress, loaded: 2 });
      request.flush({ ...saved, restarted: [3] }, { status: 201, statusText: 'Created' });
      answerRefreshes([file('a.mp4')]);
      await tick();

      expect(seen.events).toEqual([
        { kind: 'upload', loaded: 1, total: 2 },
        { kind: 'upload', loaded: 2, total: null },
        { kind: 'saved', saved: { ...saved, restarted: [3] } },
      ]);
      expect(seen.completed).toBe(true);
      expect(library.tree()).toEqual([file('a.mp4')]);
    });

    it('upload leaves the server to ask when no choice is given', () => {
      run(library.upload(new File(['x'], 'a.mp4')));
      const request = http.expectOne(UPLOAD_URL);
      expect((request.request.body as FormData).has('on_conflict')).toBe(false);
      request.flush(saved, { status: 201, statusText: 'Created' });
      answerRefreshes();
    });

    it("follows a re-encode's job (202) to what it saved", () => {
      const seen = run(library.upload(new File(['x'], 'a.mov')));
      const queued = job({ id: 'up-1', kind: 'upload', title: 'Prepare a.mov', state: 'queued' });
      http.expectOne(UPLOAD_URL).flush(queued, { status: 202, statusText: 'Accepted' });

      const source = sources.of('up-1')!;
      const running = { ...queued, state: 'running' as const };
      source.send({
        ...running,
        progress: { phase: 'encode', detail: '00:05 / 00:10', percent: 50 },
      });
      source.send({ ...queued, state: 'done', result: { path: 'a.mp4', reencoded: ['a.mp4'] } });
      answerRefreshes([file('a.mp4')]);

      expect(seen.events.map((event) => event.kind)).toEqual(['job', 'job', 'saved']);
      expect(seen.events[2]).toEqual({
        kind: 'saved',
        saved: { path: 'a.mp4', reencoded: ['a.mp4'] },
      });
      expect(seen.completed).toBe(true);
      expect(source.closed).toBe(true);
    });

    it('errors with the job when the re-encode fails', () => {
      const seen = run(library.upload(new File(['x'], 'a.mov')));
      const queued = job({ id: 'up-1', kind: 'upload', title: 'Prepare a.mov', state: 'queued' });
      http.expectOne(UPLOAD_URL).flush(queued, { status: 202, statusText: 'Accepted' });
      sources.of('up-1')!.send({ ...queued, state: 'failed', error: 'FFmpeg failed: moov atom.' });
      answerRefreshes();

      expect(seen.error).toBeInstanceOf(JobFailedError);
      expect((seen.error as Error).message).toBe('FFmpeg failed: moov atom.');
    });

    it('refreshes after a refused upload too, and aborts it when the subscriber cancels', () => {
      const seen = run(library.upload(new File(['x'], 'a.mp4')));
      http.expectOne(UPLOAD_URL).flush(
        refusal('name_taken', 'a.mp4 exists.', {
          conflict: { existing: 'a.mp4', suggested: 'a_2.mp4' },
        }),
        { status: 409, statusText: 'Conflict' },
      );
      answerRefreshes();
      expect(seen.error).toMatchObject({
        status: 409,
        code: 'name_taken',
        body: { conflict: { suggested: 'a_2.mp4' } },
      });

      const subscription = library.upload(new File(['x'], 'b.mp4')).subscribe();
      const cancelled = http.expectOne(UPLOAD_URL);
      subscription.unsubscribe();
      expect(cancelled.cancelled).toBe(true);
      answerRefreshes();
    });

    it('importCatalog posts the path and follows its job to what it saved, then refreshes the tree', () => {
      const seen = run(library.importCatalog('street/day_720p30.mp4'));
      const request = http.expectOne('/api/catalog/imports');
      expect(request.request.body).toEqual({ path: 'street/day_720p30.mp4' });
      const download = job({ id: 'cat-1', kind: 'catalog_import', title: 'Import Street' });
      request.flush(download, { status: 202, statusText: 'Accepted' });

      sources.of('cat-1')!.send({
        ...download,
        state: 'done',
        result: { path: 'catalog/street/day_720p30.mp4' },
      });
      http.expectOne(TREE_URL).flush(mediaRoot([]));

      expect(seen.events).toEqual([
        { kind: 'job', job: download },
        { kind: 'saved', saved: { path: 'catalog/street/day_720p30.mp4' } },
      ]);
    });
  });
});
