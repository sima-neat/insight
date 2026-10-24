import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type {
  CatalogIndex,
  MediaFile,
  MediaFolder,
  MediaInfo,
  MediaNode,
  YoutubePreview,
} from './api';
import { MediaLibraryService, toFileNodes } from './media-library.service';
import { SlotsService } from './slots.service';
import type { StreamEvent } from './stream-lines';

const TREE_URL = '/api/media-files';
const SLOTS_URL = '/api/mediasrc';
const RENDITIONS_URL = '/api/mediasrc/renditions';

const file = (path: string, streamable = true): MediaFile => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'file',
  streamable,
});

const folder = (path: string, children: MediaNode[]): MediaFolder => ({
  name: `/${path.split('/').pop()}`,
  path,
  type: 'folder',
  streamable_count: countStreamable(children),
  children,
});

function countStreamable(nodes: MediaNode[]): number {
  return nodes.reduce(
    (sum, node) =>
      sum + (node.type === 'file' ? Number(node.streamable) : countStreamable(node.children)),
    0,
  );
}

/** Lets the promise chains behind a flushed request run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

describe('toFileNodes', () => {
  const tree: MediaNode[] = [
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

  it('tags unstreamable files and greys them in manage mode, and drops the leading slash of folder names', () => {
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
    const nested: MediaNode[] = [
      folder('a', [folder('a/b', [file('a/b/x.txt', false)])]),
      folder('c', [folder('c/d', [file('c/d/y.mp4')])]),
    ];
    const [a, c] = toFileNodes(nested, 'pick');
    expect(a.unavailable).toBe(true);
    expect(a.children?.[0].unavailable).toBe(true);
    expect(c.unavailable).toBeUndefined();
  });

  it('maps an empty library to an empty tree, and an empty folder is greyed only in pick mode', () => {
    expect(toFileNodes([], 'pick')).toEqual([]);

    const empty = [folder('empty', [])];
    expect(toFileNodes(empty, 'manage')[0].unavailable).toBeUndefined();
    expect(toFileNodes(empty, 'pick')[0].unavailable).toBe(true);
  });
});

describe('MediaLibraryService', () => {
  let http: HttpTestingController;
  let library: MediaLibraryService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    library = TestBed.inject(MediaLibraryService);
  });

  afterEach(() => http.verify());

  const video = (filename: string): MediaInfo => ({
    type: 'video',
    filename,
    size_bytes: 10,
    codec: 'H.264',
    normalized_codec: 'h264',
    width: 640,
    height: 480,
    duration_ms: 1000,
    frame_rate: '30/1',
  });

  /** Answers what a change fetches again once it has settled: the tree, the slots and the renditions. */
  function answerRefreshes(tree: MediaNode[] = []): void {
    http.expectOne(TREE_URL).flush(tree);
    http.expectOne(SLOTS_URL).flush([]);
    http.expectOne(RENDITIONS_URL).flush({ count: 0, bytes: 0 });
  }

  describe('refresh', () => {
    it('loads the tree, and the newest answer wins', async () => {
      expect(library.tree()).toBeNull();
      const older = library.refresh();
      const first = http.expectOne(TREE_URL);
      const newer = library.refresh();
      const second = http.expectOne(TREE_URL);

      second.flush([file('new.mp4')]);
      first.flush([file('old.mp4')]);
      await Promise.all([older, newer]);

      expect(library.tree()).toEqual([file('new.mp4')]);
    });

    it('rejects with the server message and keeps the tree it had', async () => {
      const loaded = library.refresh();
      http.expectOne(TREE_URL).flush([file('a.mp4')]);
      await loaded;

      const failed = library.refresh();
      http
        .expectOne(TREE_URL)
        .flush({ error: 'disk gone' }, { status: 500, statusText: 'Server Error' });

      await expect(failed).rejects.toMatchObject({ status: 500, message: 'disk gone' });
      expect(library.tree()).toEqual([file('a.mp4')]);
    });
  });

  describe('info', () => {
    it('posts the path and resolves with the probe', async () => {
      const info = library.info('a.mp4');
      const request = http.expectOne('/api/media-info');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ path: 'a.mp4' });
      request.flush(video('a.mp4'));

      await expect(info).resolves.toEqual(video('a.mp4'));
    });

    it('ignores a late answer for an earlier path', async () => {
      const earlier = library.info('a.mp4');
      const first = http.expectOne('/api/media-info');
      const later = library.info('b.mp4');
      const second = http.expectOne('/api/media-info');

      second.flush(video('b.mp4'));
      first.flush(video('a.mp4'));

      await expect(later).resolves.toEqual(video('b.mp4'));
      await expect(earlier).resolves.toBeNull();
    });

    it('also ignores an earlier answer that arrives first, and an earlier failure', async () => {
      const earlier = library.info('a.mp4');
      const first = http.expectOne('/api/media-info');
      const later = library.info('b.mp4');
      const second = http.expectOne('/api/media-info');

      first.flush({ error: 'not a file' }, { status: 400, statusText: 'Bad Request' });
      second.flush(video('b.mp4'));

      await expect(earlier).resolves.toBeNull();
      await expect(later).resolves.toEqual(video('b.mp4'));
    });

    it('rejects with the server message when the newest request fails', async () => {
      const info = library.info('a.mp4');
      http
        .expectOne('/api/media-info')
        .flush({ error: 'Probe failed' }, { status: 500, statusText: 'Server Error' });

      await expect(info).rejects.toMatchObject({ status: 500, message: 'Probe failed' });
    });
  });

  describe('delete', () => {
    const DELETE_URL = '/api/delete-media';
    /** The request a sequential step sends once the one before it has settled. */
    const nextRequest = (url: string) => vi.waitFor(() => http.expectOne(url));

    it('deletes one path after the other, then refreshes the library, the slots and the renditions', async () => {
      const done = library.delete(['a.mp4', 'b.mp4']);

      const first = http.expectOne(DELETE_URL);
      expect(first.request.method).toBe('POST');
      expect(first.request.body).toEqual({ path: 'a.mp4' });
      // The second waits for the first.
      http.expectNone(DELETE_URL);
      first.flush({ message: 'Deleted successfully' });

      const second = await nextRequest(DELETE_URL);
      expect(second.request.body).toEqual({ path: 'b.mp4' });
      http.expectNone(TREE_URL);
      second.flush({ message: 'Deleted successfully' });

      await vi.waitFor(() => answerRefreshes());
      await expect(done).resolves.toEqual({ deleted: ['a.mp4', 'b.mp4'], failed: [] });
    });

    it('goes on after a failure and reports each, the first failure first', async () => {
      const done = library.delete(['a.mp4', 'b.mp4', 'c.mp4']);

      http
        .expectOne(DELETE_URL)
        .flush({ error: 'Media file not found' }, { status: 404, statusText: 'Not Found' });
      (await nextRequest(DELETE_URL)).flush({ message: 'Deleted successfully' });
      (await nextRequest(DELETE_URL)).flush(
        { error: 'Invalid path' },
        { status: 403, statusText: 'Forbidden' },
      );

      await vi.waitFor(() => answerRefreshes());
      await expect(done).resolves.toEqual({
        deleted: ['b.mp4'],
        failed: [
          { path: 'a.mp4', message: 'Media file not found' },
          { path: 'c.mp4', message: 'Invalid path' },
        ],
      });
    });

    it('drops a slot poll that was already on its way when the delete settled', async () => {
      const slots = TestBed.inject(SlotsService);
      // A poll sent before the delete finished: it may still list the deleted file's slots.
      const poll = slots.refresh();
      const stale = http.expectOne(SLOTS_URL);

      const done = library.delete(['a.mp4']);
      http.expectOne(DELETE_URL).flush({ message: 'Deleted successfully' });
      const tree = await nextRequest(TREE_URL);
      const fresh = await nextRequest(SLOTS_URL);
      const renditions = await nextRequest(RENDITIONS_URL);

      stale.flush([{ index: 1, file: 'a.mp4', state: 'playing' }]);
      await poll;
      expect(slots.slots()).toBeNull();

      tree.flush([]);
      fresh.flush([]);
      renditions.flush({ count: 0, bytes: 0 });
      await done;
      expect(slots.slots()).toEqual([]);
    });

    it('refreshes even when nothing could be deleted, and does not fail when a refresh does', async () => {
      const done = library.delete(['a.mp4']);
      http
        .expectOne(DELETE_URL)
        .flush({ error: 'Media file not found' }, { status: 404, statusText: 'Not Found' });

      await vi.waitFor(() => {
        http
          .expectOne(TREE_URL)
          .flush({ error: 'down' }, { status: 502, statusText: 'Bad Gateway' });
        http
          .expectOne(SLOTS_URL)
          .flush({ error: 'down' }, { status: 502, statusText: 'Bad Gateway' });
        http
          .expectOne(RENDITIONS_URL)
          .flush({ error: 'down' }, { status: 502, statusText: 'Bad Gateway' });
      });
      await expect(done).resolves.toMatchObject({ deleted: [] });
    });
  });

  describe('catalog and YouTube validation', () => {
    it('catalog fetches the index, and rejects with the server message', async () => {
      const index: CatalogIndex = {
        schema: '1',
        generated_at: null,
        index_url: 'https://artifacts.neat.sima.ai/media-assets/index.json',
        base_url: 'https://artifacts.neat.sima.ai/media-assets/',
        sources: [],
        assets: [],
      };
      const loaded = library.catalog();
      http.expectOne('/api/media-catalog').flush(index);
      await expect(loaded).resolves.toEqual(index);

      const failed = library.catalog();
      http
        .expectOne('/api/media-catalog')
        .flush(
          { error: 'Failed to load media catalog: timed out' },
          { status: 502, statusText: 'Bad Gateway' },
        );
      await expect(failed).rejects.toMatchObject({
        status: 502,
        message: 'Failed to load media catalog: timed out',
      });
    });

    it('validateYoutube posts the link and gives the preview, or the refusal', async () => {
      const preview: YoutubePreview = {
        video_id: 'abc',
        normalized_url: 'https://www.youtube.com/watch?v=abc',
        embed_url: 'https://www.youtube.com/embed/abc',
        thumbnail_url: '',
        title: 'Street',
        duration: 120,
        is_live: false,
        live_status: 'not_live',
      };
      const validated = library.validateYoutube('https://youtu.be/abc');
      const request = http.expectOne('/api/import/youtube/validate');
      expect(request.request.body).toEqual({ url: 'https://youtu.be/abc' });
      request.flush(preview);
      await expect(validated).resolves.toEqual(preview);

      const refused = library.validateYoutube('https://example.com');
      http
        .expectOne('/api/import/youtube/validate')
        .flush({ error: 'Not a YouTube URL.' }, { status: 400, statusText: 'Bad Request' });
      await expect(refused).rejects.toMatchObject({ message: 'Not a YouTube URL.' });
    });
  });

  describe('streamed requests', () => {
    function run(stream: ReturnType<MediaLibraryService['upload']>): StreamEvent[] {
      const events: StreamEvent[] = [];
      stream.subscribe({ next: (event) => events.push(event) });
      return events;
    }

    it('upload sends the file, with the conflict choice when there is one, and reports progress', async () => {
      const upload = new File(['x'], 'a.mp4', { type: 'video/mp4' });
      const events = run(library.upload(upload, 'replace'));

      const request = http.expectOne('/api/upload/media');
      const body = request.request.body as FormData;
      expect(body.get('file')).toBe(upload);
      expect(body.get('on_conflict')).toBe('replace');
      request.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 1 });
      request.flush('Upload complete.\n');
      answerRefreshes([file('a.mp4')]);
      await tick();

      expect(events).toEqual([
        { kind: 'upload', loaded: 1, total: 1 },
        { kind: 'line', text: 'Upload complete.' },
        { kind: 'done' },
      ]);
      expect(library.tree()).toEqual([file('a.mp4')]);
    });

    it('upload leaves the server to ask when no choice is given', () => {
      run(library.upload(new File(['x'], 'a.mp4')));
      const request = http.expectOne('/api/upload/media');
      expect((request.request.body as FormData).has('on_conflict')).toBe(false);
      request.flush('');
      answerRefreshes();
    });

    it('refreshes the library after a refused upload too, and when the subscriber cancels', () => {
      let failure: unknown;
      library.upload(new File(['x'], 'a.mp4')).subscribe({ error: (e: unknown) => (failure = e) });
      http
        .expectOne('/api/upload/media')
        .flush(
          { error: 'exists', conflict: { existing: 'a.mp4', suggested: 'a_2.mp4' } },
          { status: 409, statusText: 'Conflict' },
        );
      answerRefreshes();
      expect(failure).toMatchObject({ status: 409, body: { conflict: { suggested: 'a_2.mp4' } } });

      const subscription = library.upload(new File(['x'], 'b.mp4')).subscribe();
      const cancelled = http.expectOne('/api/upload/media');
      subscription.unsubscribe();
      expect(cancelled.cancelled).toBe(true);
      answerRefreshes();
    });

    it('importCatalog and importYoutube post their request and refresh the library', () => {
      run(library.importCatalog('street/day_720p30.mp4'));
      const catalog = http.expectOne('/api/import/media-catalog');
      expect(catalog.request.body).toEqual({ path: 'street/day_720p30.mp4' });
      catalog.flush('Catalog import complete.\n');
      answerRefreshes();

      const youtube = {
        url: 'https://youtu.be/abc',
        target: '720p30' as const,
        clip_start: 0,
        clip_duration: 60,
      };
      run(library.importYoutube(youtube));
      const request = http.expectOne('/api/import/youtube');
      expect(request.request.body).toEqual(youtube);
      request.flush('YouTube import complete.\n');
      answerRefreshes();
    });
  });
});
