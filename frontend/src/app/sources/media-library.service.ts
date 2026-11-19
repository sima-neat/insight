import { HttpClient, HttpEventType, HttpParams } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { NeatFileBrowserMode, NeatFileNode } from '@sima/neat-ui/file-browser';
import { defer, EMPTY, finalize, firstValueFrom, mergeMap, Observable, of, throwError } from 'rxjs';
import type {
  CatalogImportRequest,
  Job,
  MediaDeleted,
  MediaDeleteRequest,
  MediaEntry,
  MediaFileInfo,
  MediaSaved,
  MediaUpload,
} from '../api.generated';
import { LatestOnly } from '../polling';
import { withRequestErrors } from './api-errors';
import type { CatalogIndex } from './catalog';
import { isFinal, JobEvents, JobFailedError } from './jobs';
import { SlotsService } from './slots.service';

const TREE_URL = '/api/media';

/** The tag a file the streamer does not accept carries in `manage` mode. */
const NOT_STREAMABLE = 'NOT STREAMABLE';

/** What an upload's name does when it is taken: `ask` (the default) refuses with the clash. */
export type UploadOnConflict = NonNullable<MediaUpload['on_conflict']>;

/**
 * What bringing a file into the library reports, in order: the upload's bytes sent (an upload
 * only; `total` null when the browser cannot tell the size), the job that prepares it while one
 * does (an upload's re-encode, a catalog download), and what was saved.
 */
export type LibraryEvent =
  | { readonly kind: 'upload'; readonly loaded: number; readonly total: number | null }
  | { readonly kind: 'job'; readonly job: Job }
  | { readonly kind: 'saved'; readonly saved: MediaSaved };

/**
 * Maps the library's tree to what the kit's `neat-file-browser` shows.
 *
 * - `manage` shows every file: one the streamer does not accept is greyed and tagged, but can
 *   still be selected and ticked, since it can be inspected and deleted.
 * - `pick` chooses a file to stream, so such files are left out, and a folder with nothing left
 *   to pick is greyed (the kit counts the files of a folder, it does not decide whether to grey it).
 */
export function toFileNodes(
  tree: readonly MediaEntry[],
  mode: NeatFileBrowserMode,
): readonly NeatFileNode[] {
  const nodes: NeatFileNode[] = [];
  for (const entry of tree) {
    if (!entry.folder) {
      if (entry.streamable) {
        nodes.push({ name: entry.name, path: entry.path, type: 'file' });
      } else if (mode === 'manage') {
        nodes.push({
          name: entry.name,
          path: entry.path,
          type: 'file',
          unavailable: true,
          tag: NOT_STREAMABLE,
        });
      }
      continue;
    }
    const children = toFileNodes(entry.children ?? [], mode);
    const nothingToPick = !children.some((child) => child.type === 'file' || !child.unavailable);
    nodes.push({
      name: entry.name,
      path: entry.path,
      type: 'folder',
      children,
      ...(mode === 'pick' && nothingToPick ? { unavailable: true } : {}),
    });
  }
  return nodes;
}

/**
 * The media library, for every page that shows or changes it: Media, the picker in Streaming and
 * the import dialog. Nothing else fetches `/api/media`.
 *
 * Requests reject with an `ApiRequestError` carrying the server's message. The tree is fetched
 * again after every change this service makes (a delete, an upload, an import), whatever its
 * outcome. A page calls `refresh()` itself when it opens, since the library may have changed
 * meanwhile (another tab, or files put on the device).
 */
@Injectable({ providedIn: 'root' })
export class MediaLibraryService {
  private readonly http = inject(HttpClient);
  private readonly slots = inject(SlotsService);
  private readonly jobEvents = inject(JobEvents);

  private readonly treeState = signal<readonly MediaEntry[] | null>(null);
  /** The newest answer: the entries of the library's root folder; null before the first one. */
  readonly tree = this.treeState.asReadonly();

  private readonly latestTree = new LatestOnly();
  private readonly latestInfo = new LatestOnly();

  /** Fetches the tree. The newest answer wins; a failure keeps the tree there was. */
  async refresh(): Promise<void> {
    const request = this.latestTree.next();
    const root = await firstValueFrom(
      this.http.get<MediaEntry>(TREE_URL).pipe(withRequestErrors()),
    );
    if (this.latestTree.accept(request)) this.treeState.set(root.children ?? []);
  }

  /**
   * What ffprobe says about a media file. Resolves with null when a newer call was made
   * meanwhile, success or failure: only the file asked about last is on screen, and an answer
   * about an earlier one must not be shown for it.
   */
  async info(path: string): Promise<MediaFileInfo | null> {
    const request = this.latestInfo.next();
    try {
      const info = await firstValueFrom(
        this.http
          .get<MediaFileInfo>(`${TREE_URL}/info`, { params: new HttpParams().set('path', path) })
          .pipe(withRequestErrors()),
      );
      return this.latestInfo.isNewest(request) ? info : null;
    } catch (failure) {
      if (this.latestInfo.isNewest(request)) throw failure;
      return null;
    }
  }

  /**
   * Deletes the files in one request and resolves with the paths removed. The server refuses the
   * whole request, removing nothing, when a slot uses one of the files (409 `in_use`, naming the
   * slots). It removes the deleted files' renditions, so the slots and the rendition usage are
   * fetched again with the tree, whatever the outcome.
   */
  async delete(paths: readonly string[]): Promise<readonly string[]> {
    const body: MediaDeleteRequest = { paths };
    try {
      const deleted = await firstValueFrom(
        this.http.post<MediaDeleted>(`${TREE_URL}/delete`, body).pipe(withRequestErrors()),
      );
      return deleted.paths;
    } finally {
      await Promise.allSettled([this.refresh(), this.slots.settleChange({ renditions: true })]);
    }
  }

  /**
   * Uploads a file or an archive (unpacked into a folder named after it). A file the board
   * streams well is saved at once; one it would stream badly is re-encoded by a job first, whose
   * progress follows the upload's. Without `onConflict`, a name that exists already is refused
   * with a 409 `name_taken` whose `conflict` names it and the name `keep_both` would use; the
   * caller asks and sends the file again with the answer.
   *
   * Cold: the request is sent on subscribe, and unsubscribing aborts it (or, once the server
   * re-encodes, stops following the job, which goes on). A re-encode that fails errors with a
   * `JobFailedError`. A Replace restarts the slots that streamed what it replaced, so the slots
   * are fetched again with the tree however it ends.
   */
  upload(file: File, onConflict?: UploadOnConflict): Observable<LibraryEvent> {
    return defer(() => {
      const body = new FormData();
      body.append('file', file);
      if (onConflict) body.append('on_conflict', onConflict);
      return this.http
        .post<MediaSaved | Job>(`${TREE_URL}/uploads`, body, {
          observe: 'events',
          reportProgress: true,
        })
        .pipe(
          withRequestErrors(),
          mergeMap((event): Observable<LibraryEvent> => {
            if (event.type === HttpEventType.UploadProgress) {
              return of({ kind: 'upload', loaded: event.loaded, total: event.total ?? null });
            }
            if (event.type !== HttpEventType.Response || event.body === null) return EMPTY;
            // 202 is a re-encode's job; 201 what was saved.
            return event.status === 202
              ? this.savedBy(event.body as Job)
              : of({ kind: 'saved', saved: event.body as MediaSaved });
          }),
          finalize(() => {
            void this.refresh().catch(() => undefined);
            void this.slots.settleChange({ renditions: true });
          }),
        );
    });
  }

  /**
   * The published media catalog. The server fetches its index again when the last fetch is a few
   * minutes old; the fields of its sources and assets beyond `path` and `url` are the index's own.
   */
  catalog(): Promise<CatalogIndex> {
    return firstValueFrom(this.http.get<CatalogIndex>('/api/catalog').pipe(withRequestErrors()));
  }

  /**
   * Downloads a catalog asset into the library, as a job: its progress, then what was saved (a
   * taken name is saved as `name_2`). Cold, as `upload` is; a download that fails errors with a
   * `JobFailedError`. The tree is fetched again however it ends.
   */
  importCatalog(path: string): Observable<LibraryEvent> {
    return defer(() => {
      const body: CatalogImportRequest = { path };
      return this.http.post<Job>('/api/catalog/imports', body).pipe(
        withRequestErrors(),
        mergeMap((job) => this.savedBy(job)),
        finalize(() => void this.refresh().catch(() => undefined)),
      );
    });
  }

  /**
   * A job that saves into the library, as events: each change, then what it saved once done; a
   * job that failed or was cancelled errors with it. A done job's `result` is what was saved.
   */
  private savedBy(job: Job): Observable<LibraryEvent> {
    return this.jobEvents.updates(job).pipe(
      mergeMap((update): Observable<LibraryEvent> => {
        if (!isFinal(update)) return of({ kind: 'job', job: update });
        if (update.state !== 'done') return throwError(() => new JobFailedError(update));
        return of({ kind: 'saved', saved: update.result as MediaSaved });
      }),
    );
  }
}
