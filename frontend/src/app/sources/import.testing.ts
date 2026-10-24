import { computed, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type {
  CatalogIndex,
  Slot,
  UploadOnConflict,
  YoutubeImportRequest,
  YoutubePreview,
} from './api';
import { ApiRequestError, type StreamEvent } from './stream-lines';

/** Fakes for the import runner's and the import dialog's specs. */

/** One streamed request the fake library was asked for, answered by the test. */
export interface Call {
  readonly url: string;
  readonly body: unknown;
  readonly events: Subject<StreamEvent>;
  unsubscribed: boolean;
}

/** The streamed requests and import calls of `MediaLibraryService`, answered by the test. */
export class FakeLibrary {
  readonly calls: Call[] = [];

  readonly catalog = vi.fn<() => Promise<CatalogIndex>>();
  readonly validateYoutube = vi.fn<(url: string) => Promise<YoutubePreview>>();

  /** Like the real service: cold, and unsubscribing before the end aborts the request. */
  private stream(url: string, body: unknown): Observable<StreamEvent> {
    return new Observable<StreamEvent>((subscriber) => {
      const call: Call = { url, body, events: new Subject(), unsubscribed: false };
      this.calls.push(call);
      let ended = false;
      const subscription = call.events.subscribe({
        next: (event) => subscriber.next(event),
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

  upload(file: File, onConflict?: UploadOnConflict): Observable<StreamEvent> {
    return this.stream('upload', { name: file.name, onConflict });
  }
  importCatalog(path: string): Observable<StreamEvent> {
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
  private readonly all = computed(() => this.slots() ?? []);
  assignedTo(path: string): readonly Slot[] {
    return this.all().filter((slot) => slot.file === path);
  }
  assignedUnder(folder: string): readonly Slot[] {
    return this.all().filter((slot) => slot.file.startsWith(`${folder}/`));
  }
}

export interface FakeProgressToast {
  readonly title: string;
  readonly update: ReturnType<typeof vi.fn>;
  readonly done: ReturnType<typeof vi.fn>;
  readonly fail: ReturnType<typeof vi.fn>;
}

export class FakeToasts {
  readonly error = vi.fn();
  readonly status = vi.fn();
  readonly progressToasts: FakeProgressToast[] = [];
  readonly progress = vi.fn((title: string) => {
    const toast = { title, update: vi.fn(), done: vi.fn(), fail: vi.fn() };
    this.progressToasts.push(toast);
    return toast;
  });
}

export const fileSlot = (index: number, file: string): Slot => ({
  index,
  file,
  state: 'stopped',
  transport: '',
  codec: '',
  type: 'file',
  allowed_transports: [],
  urls: {},
});

export const lines = (call: Call, ...texts: string[]) => {
  for (const text of texts) call.events.next({ kind: 'line', text });
};
export const done = (call: Call) => {
  call.events.next({ kind: 'done' });
  call.events.complete();
};
export const refuse = (call: Call, existing: string, suggested: string) =>
  call.events.error(
    new ApiRequestError(409, 'A file with this name exists.', {
      error: 'A file with this name exists.',
      conflict: { existing, suggested },
    }),
  );

/** Lets the promise chains behind an event run. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve));
