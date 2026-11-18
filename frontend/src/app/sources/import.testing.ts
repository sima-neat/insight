import { computed, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { Job, MediaSaved, Slot } from '../api.generated';
import type { YoutubeImportRequest, YoutubePreview } from './api';
import type { CatalogIndex } from './catalog';
import { JobFailedError } from './jobs';
import type { LibraryEvent, UploadOnConflict } from './media-library.service';
import { job } from './slots.testing';
import { ApiRequestError, type StreamEvent } from './stream-lines';

export { fileSlot } from './slots.testing';

/** Fakes for the import runner's and the import dialog's specs. */

/** One request the fake library was asked for, answered by the test. */
export interface Call<E = LibraryEvent | StreamEvent> {
  readonly url: string;
  readonly body: unknown;
  readonly events: Subject<E>;
  unsubscribed: boolean;
}

/** The import requests of `MediaLibraryService`, answered by the test. */
export class FakeLibrary {
  readonly calls: Call[] = [];

  readonly catalog = vi.fn<() => Promise<CatalogIndex>>();
  readonly validateYoutube = vi.fn<(url: string) => Promise<YoutubePreview>>();

  /** Like the real service: cold, and unsubscribing before the end aborts the request. */
  private stream<E extends LibraryEvent | StreamEvent>(url: string, body: unknown): Observable<E> {
    return new Observable<E>((subscriber) => {
      const call: Call = { url, body, events: new Subject(), unsubscribed: false };
      this.calls.push(call);
      let ended = false;
      const subscription = call.events.subscribe({
        next: (event) => subscriber.next(event as E),
        error: (failure: unknown) => {
          ended = true;
          subscriber.error(failure);
        },
        complete: () => {
          ended = true;
          subscriber.complete();
        },
      });
      return () => {
        if (!ended) call.unsubscribed = true;
        subscription.unsubscribe();
      };
    });
  }

  upload(file: File, onConflict?: UploadOnConflict): Observable<LibraryEvent> {
    return this.stream('upload', { name: file.name, onConflict });
  }
  importCatalog(path: string): Observable<LibraryEvent> {
    return this.stream('catalog', path);
  }
  importYoutube(request: YoutubeImportRequest): Observable<StreamEvent> {
    return this.stream('youtube', request);
  }

  /** The newest request. */
  get last(): Call {
    return this.calls[this.calls.length - 1];
  }
}

export class FakeSlots {
  readonly slots = signal<readonly Slot[] | null>([]);
  readonly refresh = vi.fn(async () => undefined);
  /** As the service's: a refresh, resolved as whether it worked. */
  recheck(): Promise<boolean> {
    return this.refresh().then(
      () => true,
      () => false,
    );
  }
  private readonly all = computed(() => this.slots() ?? []);
  assignedTo(path: string): readonly Slot[] {
    return this.all().filter((slot) => slot.file === path);
  }
  assignedUnder(folder: string): readonly Slot[] {
    return this.all().filter((slot) => slot.file?.startsWith(`${folder}/`));
  }
}

export interface FakeProgressToast {
  readonly title: string;
  readonly update: ReturnType<typeof vi.fn>;
  readonly done: ReturnType<typeof vi.fn>;
  readonly fail: ReturnType<typeof vi.fn>;
  readonly dismiss: ReturnType<typeof vi.fn>;
}

export class FakeToasts {
  readonly error = vi.fn();
  readonly warning = vi.fn();
  readonly status = vi.fn();
  readonly progressToasts: FakeProgressToast[] = [];
  readonly progress = vi.fn((title: string) => {
    const toast = { title, update: vi.fn(), done: vi.fn(), fail: vi.fn(), dismiss: vi.fn() };
    this.progressToasts.push(toast);
    return toast;
  });
}

/** An upload's bytes sent so far. */
export const sent = (call: Call, loaded: number, total: number | null) =>
  call.events.next({ kind: 'upload', loaded, total });

/** The job that prepares the file (an upload's re-encode, a catalog download) as it runs. */
export const preparing = (call: Call, overrides: Partial<Job> = {}) =>
  call.events.next({ kind: 'job', job: job({ kind: 'upload', ...overrides }) });

/** The request saved what it brought in, and ended. */
export const saved = (call: Call, path: string, extra: Omit<MediaSaved, 'path'> = {}) => {
  call.events.next({ kind: 'saved', saved: { path, ...extra } });
  call.events.complete();
};

/** The job that prepared the file failed, with the server's sentence. */
export const jobFailed = (call: Call, error: string) =>
  call.events.error(new JobFailedError(job({ state: 'failed', error })));

/** Lines of the YouTube import's streamed response. */
export const lines = (call: Call, ...texts: string[]) => {
  for (const text of texts) call.events.next({ kind: 'line', text });
};
/** The end of the YouTube import's streamed response. */
export const done = (call: Call) => {
  call.events.next({ kind: 'done' });
  call.events.complete();
};
/** The upload's name is taken: 409 `name_taken` with the clash, before anything was saved. */
export const refuse = (call: Call, existing: string, suggested: string) =>
  call.events.error(
    new ApiRequestError(409, `${existing} already exists.`, {
      error: { code: 'name_taken', message: `${existing} already exists.` },
      conflict: { existing, suggested },
    }),
  );

/** Lets the promise chains behind an event run. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve));
