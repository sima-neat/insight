import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { NeatFileBrowserMode, NeatFileNode } from '@sima/neat-ui/file-browser';
import { finalize, firstValueFrom, Observable } from 'rxjs';
import { LatestOnly } from '../polling';
import type {
  CatalogImportRequest,
  CatalogIndex,
  MediaDeleteResponse,
  MediaInfo,
  MediaNode,
  MediaPathRequest,
  UploadOnConflict,
  YoutubeImportRequest,
  YoutubePreview,
  YoutubeValidateRequest,
} from './api';
import { SlotsService } from './slots.service';
import { postStreamedText, withRequestErrors, type StreamEvent } from './stream-lines';

const TREE_URL = '/api/media-files';

/** The tag a file the streamer does not accept carries in `manage` mode. */
const NOT_STREAMABLE = 'NOT STREAMABLE';

/**
 * Maps the library's tree to what the kit's `neat-file-browser` shows.
 *
 * - `manage` shows every file: one the streamer does not accept is greyed and tagged, but can
 *   still be selected and ticked, since it can be inspected and deleted.
 * - `pick` chooses a file to stream, so such files are left out, and a folder with nothing left
 *   to pick is greyed (the kit counts the files of a folder, it does not decide whether to grey it).
 *
 * The server names a folder with a leading slash (`/catalog`); the kit's names have none.
 */
export function toFileNodes(
  tree: readonly MediaNode[],
  mode: NeatFileBrowserMode,
): readonly NeatFileNode[] {
  const nodes: NeatFileNode[] = [];
  for (const node of tree) {
    if (node.type === 'file') {
      if (node.streamable) {
        nodes.push({ name: node.name, path: node.path, type: 'file' });
      } else if (mode === 'manage') {
        nodes.push({
          name: node.name,
          path: node.path,
          type: 'file',
          unavailable: true,
          tag: NOT_STREAMABLE,
        });
      }
      continue;
    }
    const children = toFileNodes(node.children, mode);
    const nothingToPick = !children.some((child) => child.type === 'file' || !child.unavailable);
    nodes.push({
      name: node.name.replace(/^\//, ''),
      path: node.path,
      type: 'folder',
      children,
      ...(mode === 'pick' && nothingToPick ? { unavailable: true } : {}),
    });
  }
  return nodes;
}

/** What `delete` did: the paths it removed, and each failure with the server's message. */
export interface DeleteOutcome {
  deleted: readonly string[];
  failed: readonly { path: string; message: string }[];
}

/**
 * The media library, for every page that shows or changes it: Media, the picker in Streaming and
 * the import dialog. Nothing else fetches `/api/media-files`.
 *
 * Requests reject with a `ApiRequestError` carrying the server's message. The tree is fetched
 * again after every change this service makes (a delete, an upload, an import), whatever its
 * outcome: a failed upload may still have saved the file. A page calls `refresh()` itself when it
 * opens, since the library may have changed meanwhile (another tab, or files put on the device).
 */
@Injectable({ providedIn: 'root' })
export class MediaLibraryService {
  private readonly http = inject(HttpClient);
  private readonly slots = inject(SlotsService);

  private readonly treeState = signal<readonly MediaNode[] | null>(null);
  /** The newest answer; null before the first one. */
  readonly tree = this.treeState.asReadonly();

  private readonly latestTree = new LatestOnly();
  private readonly latestInfo = new LatestOnly();

  /** Fetches the tree. The newest answer wins; a failure keeps the tree there was. */
  async refresh(): Promise<void> {
    const request = this.latestTree.next();
    const tree = await firstValueFrom(
      this.http.get<MediaNode[]>(TREE_URL).pipe(withRequestErrors()),
    );
    if (this.latestTree.accept(request)) this.treeState.set(tree);
  }

  /**
   * What the server knows about a media file. Resolves with null when a newer call was made
   * meanwhile, success or failure: only the file asked about last is on screen, and an answer
   * about an earlier one must not be shown for it.
   */
  async info(path: string): Promise<MediaInfo | null> {
    const request = this.latestInfo.next();
    const body: MediaPathRequest = { path };
    try {
      const info = await firstValueFrom(
        this.http.post<MediaInfo>('/api/media-info', body).pipe(withRequestErrors()),
      );
      return this.latestInfo.isNewest(request) ? info : null;
    } catch (failure) {
      if (this.latestInfo.isNewest(request)) throw failure;
      return null;
    }
  }

  /**
   * Deletes the files one after the other and goes on after a failure, so one that cannot be
   * deleted does not keep the rest. The server clears and stops the slots that were assigned to a
   * deleted file and removes its renditions, so the slots and the rendition usage are fetched
   * again with the tree.
   */
  async delete(paths: readonly string[]): Promise<DeleteOutcome> {
    const deleted: string[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const path of paths) {
      const body: MediaPathRequest = { path };
      try {
        await firstValueFrom(
          this.http.post<MediaDeleteResponse>('/api/delete-media', body).pipe(withRequestErrors()),
        );
        deleted.push(path);
      } catch (failure) {
        failed.push({
          path,
          message: failure instanceof Error ? failure.message : 'Could not delete the file.',
        });
      }
    }
    await Promise.allSettled([this.refresh(), this.slots.settleChange({ renditions: true })]);
    return { deleted, failed };
  }

  /**
   * Uploads a file or an archive. Without `onConflict`, a name that exists already is refused
   * with a 409 whose body names it (`conflict.existing`) and the name `keep_both` would use
   * (`conflict.suggested`); the caller asks and sends the file again with the answer.
   *
   * Cold, like the other streamed requests below: the request is sent on subscribe and
   * unsubscribing aborts it. Read the lines with `uploadProgress` and `failureText` from
   * `progress-lines.ts`, and see that file's header for how a caller must read them.
   */
  upload(file: File, onConflict?: UploadOnConflict): Observable<StreamEvent> {
    const body = new FormData();
    body.append('file', file);
    if (onConflict) body.append('on_conflict', onConflict);
    return this.streamed('/api/upload/media', body);
  }

  /** The published media catalog, which the server fetches from its index on every call. */
  catalog(): Promise<CatalogIndex> {
    return firstValueFrom(
      this.http.get<CatalogIndex>('/api/media-catalog').pipe(withRequestErrors()),
    );
  }

  /** What a YouTube link would import; rejects with the server's reason when it cannot. */
  validateYoutube(url: string): Promise<YoutubePreview> {
    const body: YoutubeValidateRequest = { url };
    return firstValueFrom(
      this.http
        .post<YoutubePreview>('/api/import/youtube/validate', body)
        .pipe(withRequestErrors()),
    );
  }

  /** Reads its lines with `catalogProgress`. */
  importCatalog(path: string): Observable<StreamEvent> {
    const body: CatalogImportRequest = { path };
    return this.streamed('/api/import/media-catalog', body);
  }

  /** Reads its lines with `youtubeProgress`. */
  importYoutube(request: YoutubeImportRequest): Observable<StreamEvent> {
    return this.streamed('/api/import/youtube', request);
  }

  private streamed(url: string, body: FormData | object): Observable<StreamEvent> {
    return postStreamedText(this.http, url, body).pipe(
      // However it ends, including by the caller's unsubscribe. A Replace restarts the slots of
      // the file it swaps and drops its renditions, so those are fetched again too. A refresh that
      // fails leaves the old tree, and the next page that opens the library fetches it again.
      finalize(() => {
        void this.refresh().catch(() => undefined);
        void this.slots.settleChange({ renditions: true });
      }),
    );
  }
}
