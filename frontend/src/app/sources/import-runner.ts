import { computed, inject, Injectable, signal } from '@angular/core';
import { NeatToasts, type NeatProgressToast } from '@sima/neat-ui/toast';
import type { Observable } from 'rxjs';
import type { CatalogAsset, UploadOnConflict, YoutubeImportRequest } from './api';
import { catalogAssetLabel } from './catalog';
import { MediaLibraryService } from './media-library.service';
import {
  type ClashChoice,
  isArchiveUpload,
  nameClash,
  type NameClash,
  skippedText,
  type UploadConflict,
  uploadConflict,
} from './name-clash';
import {
  catalogProgress,
  failureText,
  isProgressFailure,
  type Progress,
  type ProgressFailure,
  restartWarning,
  savedPath,
  uploadProgress,
  youtubeProgress,
} from './progress-lines';
import { SlotsService } from './slots.service';
import { messageOf, type StreamEvent } from './stream-lines';

/** The import dialog's tabs, and the kind of work each starts. */
export type ImportKind = 'local' | 'catalog' | 'youtube';

/** How a piece of work ended, for the dialog that started it. */
export interface ImportOutcome {
  /** Everything succeeded or was skipped: the dialog closes. */
  readonly ok: boolean;
  /** The library path saved last (an archive's folder), to reveal; null when nothing was. */
  readonly path: string | null;
}

/** What a progress toast is titled by, once the work has left the dialog. */
const TOAST_TITLES: Record<ImportKind, string> = {
  local: 'Uploading media',
  catalog: 'Importing catalog asset',
  youtube: 'Importing YouTube video',
};

/** "Preparing media 2/3": a position in work of several items; none for a single one. */
const scoped = (title: string, position: number, total: number): string =>
  total > 1 ? `${title} ${position}/${total}` : title;

/**
 * A server line's progress about one item: the item ("clip.mp4", an asset's label, a YouTube
 * target), then what the line adds ("clip.mp4 - 0:12 / 0:40"), as #170 showed it.
 */
const about = (subject: string, detail: string): string =>
  detail && detail !== subject ? `${subject} - ${detail}` : subject;

/** How one file of an upload ended. */
type FileOutcome =
  | { readonly kind: 'uploaded'; readonly path: string | null }
  /** The message names the file; a failed file may still have been saved (`path`). */
  | { readonly kind: 'failed'; readonly message: string; readonly path: string | null }
  /** `unasked` is the outcome's note for a clash no one was there to answer; null for a Skip. */
  | { readonly kind: 'skipped'; readonly unasked: string | null };

/** How work ended: a status message on success (or cancel), a failure to report otherwise. */
type Ending =
  | { readonly ok: boolean; readonly path: string | null; readonly message: string }
  | { readonly ok: false; readonly path: string | null; readonly failure: string };

/**
 * Runs the import dialog's work, outside the dialog so that it outlives it: local uploads, catalog
 * imports and YouTube imports, one piece of work at a time (spec, Media import; Review Focus 3).
 *
 * While a dialog holds the runner (`hold`), the dialog shows the progress, the name-clash question
 * and the failure, and the outcome is a toast as #170's was. When the last dialog lets go while
 * work runs (navigation closes a dialog even while it is busy), the progress moves into a progress
 * toast that reports to the end; a clash that can no longer be asked is skipped and the toast says
 * so (ruling Q17), since a 409 saved nothing. A dialog opened again while the work runs takes it
 * back from the toast: the progress, the clashes and the outcome are the dialog's again.
 *
 * The streamed lines are read as `progress-lines.ts` tells a caller to: to the end, never
 * unsubscribing on a failure line, with the failure taken from all of the request's lines. The
 * library refreshes itself after each request; `MediaLibraryService` does that, whatever the outcome.
 */
@Injectable({ providedIn: 'root' })
export class ImportRunner {
  private readonly library = inject(MediaLibraryService);
  private readonly slots = inject(SlotsService);
  private readonly toasts = inject(NeatToasts);

  private readonly jobState = signal<ImportKind | null>(null);
  /** The kind of work running; null while none is. */
  readonly job = this.jobState.asReadonly();
  readonly busy = computed(() => this.job() !== null);

  private readonly progressState = signal<Progress | null>(null);
  /** How far the work is: a title ("Uploading media 1/2"), a detail and a percent. */
  readonly progress = this.progressState.asReadonly();

  private readonly clashState = signal<NameClash | null>(null);
  /** The name clash waiting for `answer`; null while none is. */
  readonly clash = this.clashState.asReadonly();

  private readonly failureState = signal<string | null>(null);
  /** Why the last work failed, for the dialog to show; cleared when work starts or a dialog opens. */
  readonly failure = this.failureState.asReadonly();

  private holders = 0;
  /** The toast the work reports to once no dialog shows it. */
  private toast: NeatProgressToast | null = null;
  private answerClash: ((choice: ClashChoice) => void) | null = null;
  private abortRequest: (() => void) | null = null;
  private current: Promise<ImportOutcome> | null = null;

  /**
   * Shows the work in the caller (the dialog) until the returned function is called. Letting go
   * while work runs moves its progress into a toast for the rest of it; holding again takes it
   * back from the toast.
   */
  hold(): () => void {
    this.holders++;
    this.failureState.set(null);
    this.takeFromToast();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holders === 0 && this.busy()) this.moveToToast();
    };
  }

  /** The work running, to its outcome; null while none runs. A dialog opened meanwhile awaits it. */
  running(): Promise<ImportOutcome> | null {
    return this.current;
  }

  /** Answers the name clash waiting for one. */
  answer(choice: ClashChoice): void {
    this.answerClash?.(choice);
  }

  /** Aborts a YouTube import; the server stops yt-dlp and FFmpeg when the request goes. */
  cancel(): void {
    if (this.job() === 'youtube') this.abortRequest?.();
  }

  /**
   * Uploads files one after the other, each with byte progress and then the server's processing
   * lines. A name that exists is asked about per file and sent again with the answer. A failure
   * fails its file and the next one still uploads; the outcome is ok when every file was
   * uploaded or skipped.
   */
  upload(files: readonly File[]): Promise<ImportOutcome> {
    return this.run('local', async () => {
      let uploaded = 0;
      let skippedByChoice = 0;
      let path: string | null = null;
      const failures: string[] = [];
      const unasked: string[] = [];

      for (const [index, file] of files.entries()) {
        const outcome = await this.uploadFile(file, index + 1, files.length);
        if (outcome.kind === 'skipped') {
          if (outcome.unasked) unasked.push(outcome.unasked);
          else skippedByChoice++;
          continue;
        }
        if (outcome.kind === 'failed') failures.push(outcome.message);
        else uploaded++;
        path = outcome.path ?? path;
      }

      const attempted = files.length - skippedByChoice - unasked.length;
      const skipped = unasked.map((text) => ` ${text}`).join('');
      if (failures.length === 0) {
        return { ok: true, path, message: `Uploaded and prepared ${uploaded} file(s).${skipped}` };
      }
      return {
        ok: false,
        path,
        failure: `Uploaded and prepared ${uploaded}/${attempted} file(s).${skipped} ${failures[0]}`,
      };
    });
  }

  /** Imports catalog assets one after the other, stopping at the first that fails, as #170 did. */
  importCatalog(assets: readonly CatalogAsset[]): Promise<ImportOutcome> {
    return this.run('catalog', async () => {
      let path: string | null = null;
      for (const [index, asset] of assets.entries()) {
        const position = index + 1;
        const label = catalogAssetLabel(asset);
        this.show({
          title: scoped('Importing catalog asset', position, assets.length),
          detail: label,
          percent: null,
        });
        // Only a YouTube import is ever aborted, so the lines are always there.
        const lines =
          (await this.read(this.library.importCatalog(asset.path), (line) =>
            this.showLine(catalogProgress(line), position, assets.length, label),
          )) ?? [];
        const failure = failureText(lines);
        if (failure) return { ok: false, path, failure };
        path = lastSaved(lines) ?? path;
      }
      return { ok: true, path, message: `Imported ${assets.length} catalog asset(s).` };
    });
  }

  /** Imports a YouTube clip; `cancel` aborts it. */
  importYoutube(request: YoutubeImportRequest): Promise<ImportOutcome> {
    return this.run('youtube', async () => {
      this.show({ title: 'Importing YouTube video', detail: request.target, percent: null });
      const lines = await this.read(this.library.importYoutube(request), (line) =>
        this.showLine(youtubeProgress(line), 1, 1, request.target),
      );
      if (lines === null) return { ok: false, path: null, message: 'YouTube import canceled.' };
      const failure = failureText(lines);
      if (failure) return { ok: false, path: null, failure };
      return { ok: true, path: lastSaved(lines), message: 'Imported YouTube video.' };
    });
  }

  /**
   * Runs one piece of work from start to outcome. Whatever happens in it, a failure included that
   * no request reported, the outcome is reported and the runner is free again.
   */
  private run(kind: ImportKind, work: () => Promise<Ending>): Promise<ImportOutcome> {
    if (this.busy()) return Promise.reject(new Error('An import is running already.'));
    this.jobState.set(kind);
    this.failureState.set(null);
    if (this.holders === 0) this.moveToToast();
    const outcome = work()
      .catch((failure: unknown): Ending => ({ ok: false, path: null, failure: messageOf(failure) }))
      .then((ending) => this.finish(ending));
    this.current = outcome;
    return outcome;
  }

  /** Reports the outcome where the work is shown, and frees the runner for the next. */
  private finish(ending: Ending): ImportOutcome {
    const toast = this.toast;
    if ('failure' in ending) {
      if (toast) toast.fail(ending.failure);
      else {
        this.failureState.set(ending.failure);
        this.toasts.error(ending.failure);
      }
    } else if (toast) {
      toast.done(ending.message);
    } else {
      this.toasts.status(ending.message);
    }
    this.toast = null;
    this.abortRequest = null;
    this.current = null;
    this.progressState.set(null);
    this.jobState.set(null);
    return { ok: ending.ok, path: ending.path };
  }

  private moveToToast(): void {
    const job = this.job();
    if (!job || this.toast) return;
    this.toast = this.toasts.progress(TOAST_TITLES[job]);
    const progress = this.progress();
    if (progress) this.show(progress);
    // No one is left to answer; `upload` records it as skipped.
    this.answerClash?.('skip');
  }

  /**
   * Shows the work in a dialog again. The kit's progress toast cannot be removed, only settled,
   * so it settles with a status that says where the work went.
   */
  private takeFromToast(): void {
    const job = this.job();
    if (!job || !this.toast) return;
    this.toast.done(`${TOAST_TITLES[job]} continues in the import dialog.`);
    this.toast = null;
  }

  private show(progress: Progress): void {
    this.progressState.set(progress);
    this.toast?.update(
      [progress.title, progress.detail].filter(Boolean).join(' · '),
      progress.percent,
    );
  }

  /** Shows a parsed line about one item; a failure line shows nothing, `failureText` reports it. */
  private showLine(
    parsed: Progress | ProgressFailure | null,
    position: number,
    total: number,
    subject: string,
  ): void {
    if (parsed === null || isProgressFailure(parsed)) return;
    this.show({
      title: scoped(parsed.title, position, total),
      detail: about(subject, parsed.detail),
      percent: parsed.percent,
    });
  }

  /**
   * Uploads one file: sent as it is, then, if its name exists, again with the answer to the
   * clash. A failure is reported with the file's name, as #170 did.
   */
  private async uploadFile(file: File, position: number, total: number): Promise<FileOutcome> {
    this.show({
      title: scoped('Uploading media', position, total),
      detail: file.name,
      percent: null,
    });
    let onConflict: UploadOnConflict | undefined;
    for (;;) {
      let lines: string[];
      try {
        lines = await this.sendUpload(file, onConflict, position, total);
      } catch (refusal) {
        const conflict = uploadConflict(refusal);
        if (!conflict) {
          return { kind: 'failed', message: `${file.name}: ${messageOf(refusal)}`, path: null };
        }
        const choice = await this.ask(conflict, isArchiveUpload(file.name));
        if (choice === 'skip') {
          return { kind: 'skipped', unasked: this.toast ? skippedText(conflict) : null };
        }
        onConflict = choice;
        continue;
      }
      const failure = failureText(lines);
      return failure
        ? { kind: 'failed', message: `${file.name}: ${failure}`, path: lastSaved(lines) }
        : { kind: 'uploaded', path: lastSaved(lines) };
    }
  }

  /**
   * Sends one upload and resolves with its lines once the server has finished; rejects with the
   * refusal (a 409 names a clash). The bytes show as the upload's percent until the server's
   * lines take over; a slot a Replace could not restart is reported as it comes (ruling Q6).
   */
  private async sendUpload(
    file: File,
    onConflict: UploadOnConflict | undefined,
    position: number,
    total: number,
  ): Promise<string[]> {
    const lines = await this.read(
      this.library.upload(file, onConflict),
      (line) => {
        const warning = restartWarning(line);
        if (warning) this.toasts.error(warning);
        this.showLine(uploadProgress(line), position, total, file.name);
      },
      (loaded, size) =>
        this.show({
          title: scoped('Uploading media', position, total),
          detail: file.name,
          percent: size ? Math.round((loaded / size) * 100) : null,
        }),
    );
    // Only a YouTube import is ever aborted, so the lines are always there.
    return lines ?? [];
  }

  /**
   * Reads a streamed request to its end and resolves with its lines, or with null when
   * `abortRequest` aborted it; rejects when the request failed or a handler threw.
   */
  private read(
    stream: Observable<StreamEvent>,
    onLine: (line: string) => void,
    onUpload?: (loaded: number, total: number | null) => void,
  ): Promise<string[] | null> {
    return new Promise((resolve, reject) => {
      const lines: string[] = [];
      const subscription = stream.subscribe({
        next: (event) => {
          try {
            if (event.kind === 'upload') onUpload?.(event.loaded, event.total);
            else if (event.kind === 'line') {
              lines.push(event.text);
              onLine(event.text);
            } else resolve(lines);
          } catch (failure) {
            // A failure of ours, not the server's: RxJS would only log it, and the request would
            // read on with nothing to show it. It fails the request instead.
            subscription.unsubscribe();
            reject(failure);
          }
        },
        error: reject,
      });
      this.abortRequest = () => {
        subscription.unsubscribe();
        resolve(null);
      };
    });
  }

  /**
   * Asks what to do about a clash, naming the slots a Replace would restart: fetched again first,
   * as before any replace (spec, "In use"), or the last known ones, said to be so, when that
   * fetch fails (Q16). Skipped without asking once no dialog shows the work.
   */
  private async ask(conflict: UploadConflict, archive: boolean): Promise<ClashChoice> {
    if (this.toast) return 'skip';
    const checked = await this.slots.refresh().then(
      () => true,
      () => false,
    );
    if (this.toast) return 'skip';
    const using = archive
      ? this.slots.assignedUnder(conflict.existing)
      : this.slots.assignedTo(conflict.existing);
    try {
      return await new Promise<ClashChoice>((resolve) => {
        this.answerClash = resolve;
        this.clashState.set(nameClash(conflict, using, checked));
      });
    } finally {
      this.answerClash = null;
      this.clashState.set(null);
    }
  }
}

/** The last path a request's lines say was saved. */
function lastSaved(lines: readonly string[]): string | null {
  return (
    lines
      .map(savedPath)
      .filter((path) => path !== null)
      .pop() ?? null
  );
}
