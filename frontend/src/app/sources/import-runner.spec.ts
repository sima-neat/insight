import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import { of } from 'rxjs';
import { ApiRequestError } from './api-errors';
import type { CatalogAsset } from './catalog';
import { ImportRunner } from './import-runner';
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
import { type LibraryEvent, MediaLibraryService } from './media-library.service';
import { SlotsService } from './slots.service';

const asset = (path: string): CatalogAsset => ({
  source_id: 'street',
  source_title: 'Street',
  profile: '720p30',
  preview: false,
  codec: 'h264',
  container: 'mp4',
  fps: 30,
  target_height: 720,
  path,
  bytes: 10,
  sha256: '',
  width: 1280,
  height: 720,
  url: '',
});

describe('ImportRunner', () => {
  let library: FakeLibrary;
  let slots: FakeSlots;
  let toasts: FakeToasts;
  let runner: ImportRunner;
  let release: () => void;

  beforeEach(() => {
    library = new FakeLibrary();
    slots = new FakeSlots();
    toasts = new FakeToasts();
    TestBed.configureTestingModule({
      providers: [
        { provide: MediaLibraryService, useValue: library },
        { provide: SlotsService, useValue: slots },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
    runner = TestBed.inject(ImportRunner);
    // A dialog shows the work, as in the app.
    release = runner.hold();
  });

  it('shows the bytes of an upload, then its re-encode, then reports what it saved', async () => {
    const outcome = runner.upload([new File(['x'], 'a.mov')]);
    sent(library.last, 50, 200);
    expect(runner.progress()).toEqual({ title: 'Uploading media', detail: 'a.mov', percent: 25 });
    sent(library.last, 50, null);
    expect(runner.progress()?.percent).toBeNull();

    preparing(library.last, {
      progress: { phase: 'encode', detail: '00:04 / 00:10', percent: 40.2 },
    });
    expect(runner.progress()).toEqual({
      title: 'Preparing media',
      detail: 'a.mov - 00:04 / 00:10',
      percent: 40,
    });
    saved(library.last, 'a.mp4', { reencoded: ['a.mp4'] });

    await expect(outcome).resolves.toEqual({ ok: true, path: 'a.mp4' });
    expect(toasts.status).toHaveBeenCalledWith('Uploaded and prepared 1 file(s).');
  });

  it('an archive clashes on its folder and names the slots streaming files in it', async () => {
    slots.slots.set([
      fileSlot(2, 'clips/a.mp4'),
      fileSlot(5, 'clips/deep/b.mp4'),
      fileSlot(7, 'x.mp4'),
    ]);
    const outcome = runner.upload([new File(['x'], 'clips.zip')]);
    refuse(library.last, 'clips', 'clips_2');
    await tick();

    expect(slots.refresh).toHaveBeenCalled();
    expect(runner.clash()).toEqual({
      question: 'clips already exists.',
      notes: ['In use on src2, src5'],
    });
    runner.answer('replace');
    await tick();
    expect(library.last.body).toEqual({ name: 'clips.zip', onConflict: 'replace' });
    saved(library.last, 'clips', { folder: true, restarted: [2] });

    await expect(outcome).resolves.toEqual({ ok: true, path: 'clips' });
  });

  it('warns of what saving changed beyond the library: a slot it could not restart, the slots a replaced folder cleared', async () => {
    const outcome = runner.upload([new File(['x'], 'clips.zip')]);
    saved(library.last, 'clips', {
      folder: true,
      warnings: ['Could not restart src4: MediaMTX is down'],
      unassigned: [6, 8],
    });

    await expect(outcome).resolves.toEqual({ ok: true, path: 'clips' });
    expect(toasts.warning.mock.calls).toEqual([
      ['Could not restart src4: MediaMTX is down'],
      ['Cleared src6, src8: the replaced folder no longer has their files.'],
    ]);
    expect(toasts.error).not.toHaveBeenCalled();
    expect(runner.failure()).toBeNull();
  });

  it('a refused request fails its file only, and the next file still uploads', async () => {
    const outcome = runner.upload([new File(['x'], 'a.mp4'), new File(['y'], 'b.mp4')]);
    library.last.events.error(new ApiRequestError(0, 'Could not reach the server.', null));
    await tick();
    saved(library.last, 'b.mp4');

    await expect(outcome).resolves.toEqual({ ok: false, path: 'b.mp4' });
    const failure = 'Uploaded and prepared 1/2 file(s). a.mp4: Could not reach the server.';
    expect(runner.failure()).toBe(failure);
    expect(toasts.error).toHaveBeenCalledWith(failure);
  });

  it("a re-encode that fails fails its file with the server's sentence", async () => {
    const outcome = runner.upload([new File(['x'], 'a.mov')]);
    preparing(library.last);
    jobFailed(library.last, 'FFmpeg failed: moov atom not found.');

    await expect(outcome).resolves.toEqual({ ok: false, path: null });
    expect(runner.failure()).toBe(
      'Uploaded and prepared 0/1 file(s). a.mov: FFmpeg failed: moov atom not found.',
    );
  });

  it('a clash still open when the dialog goes is skipped, and the outcome toast says so', async () => {
    const outcome = runner.upload([new File(['x'], 'a.mp4'), new File(['y'], 'b.mp4')]);
    refuse(library.last, 'a.mp4', 'a_2.mp4');
    await tick();
    expect(runner.clash()).not.toBeNull();

    release();
    await tick();
    expect(runner.clash()).toBeNull();
    expect(library.calls.map((call) => call.body)).toEqual([
      { name: 'a.mp4', onConflict: undefined },
      { name: 'b.mp4', onConflict: undefined },
    ]);
    // A clash after leaving cannot be asked either.
    refuse(library.last, 'b.mp4', 'b_2.mp4');
    await tick();

    await expect(outcome).resolves.toEqual({ ok: true, path: null });
    expect(toasts.status).toHaveBeenCalledWith(
      'Uploaded and prepared 0 file(s). Skipped a.mp4: it already exists. Skipped b.mp4: it already exists.',
    );
  });

  it('work goes on after its dialog went, and its failure is a toast', async () => {
    const outcome = runner.upload([new File(['x'], 'a.mov')]);
    release();
    preparing(library.last);
    jobFailed(library.last, 'FFmpeg failed: moov atom not found.');

    await expect(outcome).resolves.toEqual({ ok: false, path: null });
    expect(toasts.error).toHaveBeenCalledWith(
      'Uploaded and prepared 0/1 file(s). a.mov: FFmpeg failed: moov atom not found.',
    );
  });

  it('catalog imports run one after the other, showing their download, and stop at a failure', async () => {
    const outcome = runner.importCatalog([asset('a.mp4'), asset('b.mp4'), asset('c.mp4')]);
    expect(runner.progress()).toEqual({
      title: 'Importing catalog asset 1/3',
      detail: '720p30 / 30 fps / H.264 / 1280x720',
      percent: null,
    });
    preparing(library.last, {
      kind: 'catalog_import',
      progress: { phase: 'download', detail: '0.5 / 1.0 MB', percent: 50 },
    });
    expect(runner.progress()).toEqual({
      title: 'Importing catalog asset 1/3',
      detail: '720p30 / 30 fps / H.264 / 1280x720 - 0.5 / 1.0 MB',
      percent: 50,
    });
    saved(library.last, 'catalog/street/a.mp4');
    await tick();

    expect(library.calls.map((call) => call.body)).toEqual(['a.mp4', 'b.mp4']);
    jobFailed(library.last, 'Size mismatch for street/b.mp4: expected 10 bytes, got 9.');

    await expect(outcome).resolves.toEqual({ ok: false, path: 'catalog/street/a.mp4' });
    expect(library.calls).toHaveLength(2);
    expect(runner.failure()).toBe('Size mismatch for street/b.mp4: expected 10 bytes, got 9.');
    expect(runner.busy()).toBe(false);
  });

  it('a new dialog starts without the failure of the work before', async () => {
    const outcome = runner.importCatalog([asset('a.mp4')]);
    library.last.events.error(new ApiRequestError(404, 'No such asset.', null));
    await outcome;
    expect(runner.failure()).not.toBeNull();

    release();
    runner.hold();
    expect(runner.failure()).toBeNull();
  });

  it('a clash whose slots could not be fetched again names the last known ones and says so', async () => {
    slots.slots.set([fileSlot(3, 'a.mp4')]);
    slots.refresh.mockRejectedValueOnce(new ApiRequestError(500, 'MediaMTX is down', null));
    void runner.upload([new File(['x'], 'a.mp4')]);
    refuse(library.last, 'a.mp4', 'a_2.mp4');
    await tick();

    expect(runner.clash()).toEqual({
      question: 'a.mp4 already exists.',
      notes: ['In use on src3', 'Could not check which slots use these files.'],
    });
  });

  it('a dialog opened while earlier work runs shows its progress and asks its clashes', async () => {
    const outcome = runner.upload([new File(['x'], 'a.mp4'), new File(['y'], 'b.mp4')]);
    release();

    runner.hold();
    preparing(library.last, {
      progress: { phase: 'encode', detail: '00:04 / 00:10', percent: 40 },
    });
    expect(runner.progress()?.percent).toBe(40);
    saved(library.last, 'a.mp4');
    await tick();

    refuse(library.last, 'b.mp4', 'b_2.mp4');
    await tick();
    expect(runner.clash()?.question).toBe('b.mp4 already exists.');
    runner.answer('skip');

    await expect(outcome).resolves.toEqual({ ok: true, path: 'a.mp4' });
    expect(toasts.status).toHaveBeenCalledWith('Uploaded and prepared 1 file(s).');
  });

  it('a failure of its own while reading frees the runner and is reported', async () => {
    toasts.warning.mockImplementationOnce(() => {
      throw new Error('toast host gone');
    });
    const outcome = runner.upload([new File(['x'], 'a.mp4')]);
    saved(library.last, 'a.mp4', { warnings: ['Could not restart src4: MediaMTX is down'] });

    await expect(outcome).resolves.toEqual({ ok: false, path: null });
    expect(runner.busy()).toBe(false);
    expect(runner.failure()).toBe('Uploaded and prepared 0/1 file(s). a.mp4: toast host gone');
  });

  it('fails a request that ended without saying what it saved, also one that ends while being sent', async () => {
    vi.spyOn(library, 'upload').mockReturnValueOnce(of<LibraryEvent>());

    await expect(runner.upload([new File(['x'], 'a.mp4')])).resolves.toEqual({
      ok: false,
      path: null,
    });
    expect(runner.failure()).toBe(
      'Uploaded and prepared 0/1 file(s). a.mp4: The server did not say what it saved.',
    );
    expect(runner.busy()).toBe(false);
  });

  it('refuses to start while work runs', async () => {
    void runner.importCatalog([asset('a.mp4')]);
    await expect(runner.upload([new File(['x'], 'a.mp4')])).rejects.toThrow(
      'An import is running already.',
    );
  });
});
