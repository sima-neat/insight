import { computed, inject, Injectable, signal } from '@angular/core';
import { NeatToasts, type NeatProgressToast } from '@sima/neat-ui/toast';
import { type Observable, Subscription } from 'rxjs';
import type { Job, MediaSaved } from '../api.generated';
import { messageOf } from './api-errors';
import { type CatalogAsset, catalogAssetLabel } from './catalog';
import { jobProgress, type Progress } from './jobs';
import {
  type LibraryEvent,
  MediaLibraryService,
  type UploadOnConflict,
} from './media-library.service';
import {
  type ClashChoice,
  isArchiveUpload,
  nameClash,
  type NameClash,
  skippedText,
  type UploadConflict,
  uploadConflict,
} from './name-clash';
import { SlotsService } from './slots.service';

/** The import dialog's tabs, and the kind of work each starts. */
export type ImportKind = 'local' | 'catalog';

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
};

/** "Preparing media 2/3": a position in work of several items; none for a single one. */
const scoped = (title: string, position: number, total: number): string =>
  total > 1 ? `${title} ${position}/${total}` : title;

/**
 * Progress about one item: the item ("clip.mp4", an asset's label), then what the server adds
 * ("clip.mp4 - 0:12 / 0:40").
 */
const about = (subject: string, detail: string): string =>
  detail && detail !== subject ? `${subject} - ${detail}` : subject;

/** How one file of an upload ended. */
type FileOutcome =
  | { readonly kind: 'uploaded'; readonly path: string }
  /** The message names the file. */
  | { readonly kind: 'failed'; readonly message: string }
  /** `unasked` is the outcome's note for a clash no one was there to answer; null for a Skip. */
  | { readonly kind: 'skipped'; readonly unasked: string | null };

/** How work ended: a status message on success, a failure to report otherwise. */
type Ending =
  | { readonly ok: true; readonly path: string | null; readonly message: string }
  | { readonly ok: false; readonly path: string | null; readonly failure: string };

/** What a request that saves into the library said it saved; it must have said so. */
function savedOf(saved: MediaSaved | null): MediaSaved {
  if (!saved) throw new Error('The server did not say what it saved.');
  return saved;
}

/**
 * Runs the import dialog's work, outside the dialog so that it outlives it: local uploads and
 * catalog imports, one piece of work at a time.
 *
 * While a dialog holds the runner (`hold`), the dialog shows the progress, the name-clash question
 * and the failure, and the outcome is a toast. When the last dialog lets go while
 * work runs (navigation closes a dialog even while it is busy), the progress moves into a progress
 * toast that reports to the end; a clash that can no longer be asked is skipped and the toast says
 * so, since a 409 saved nothing. A dialog opened again while the work runs takes it
 * back from the toast: the progress, the clashes and the outcome are the dialog's again.
 *
 * An upload shows its bytes, then the job that re-encodes it when the server needs one; a catalog
 * import shows its download's job. The library refreshes itself after each request;
 * `MediaLibraryService` does that, whatever the outcome.
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

  /**
   * Uploads files one after the other, each with byte progress and then the progress of its
   * re-encode, when the server needs one. A name that exists is asked about per file and sent
   * again with the answer. A failure fails its file and the next one still uploads; the outcome
   * is ok when every file was uploaded or skipped.
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
        if (outcome.kind === 'failed') {
          failures.push(outcome.message);
          continue;
        }
        uploaded++;
        path = outcome.path;
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

  /** Imports catalog assets one after the other, stopping at the first that fails. */
  importCatalog(assets: readonly CatalogAsset[]): Promise<ImportOutcome> {
    return this.run('catalog', async () => {
      let path: string | null = null;
      for (const [index, asset] of assets.entries()) {
        const position = index + 1;
        const title = scoped('Importing catalog asset', position, assets.length);
        const label = catalogAssetLabel(asset);
        this.show({ title, detail: label, percent: null });
        let saved: MediaSaved | null = null;
        try {
          await this.read(this.library.importCatalog(asset.path), (event) => {
            if (event.kind === 'job') this.showJob(event.job, title, label);
            else if (event.kind === 'saved') saved = this.reportSaved(event.saved);
          });
        } catch (failure) {
          return { ok: false, path, failure: messageOf(failure) };
        }
        path = savedOf(saved).path;
      }
      return { ok: true, path, message: `Imported ${assets.length} catalog asset(s).` };
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
   * Shows the work in a dialog again. The toast goes without an outcome: the dialog that took the
   * work back shows it, and reports how it ended.
   */
  private takeFromToast(): void {
    if (!this.toast) return;
    this.toast.dismiss();
    this.toast = null;
  }

  private show(progress: Progress): void {
    this.progressState.set(progress);
    this.toast?.update(
      [progress.title, progress.detail].filter(Boolean).join(' · '),
      progress.percent,
    );
  }

  /** Shows a job's progress about one item, under `title`. */
  private showJob(job: Job, title: string, subject: string): void {
    const progress = jobProgress(job, title);
    this.show({ ...progress, detail: about(subject, progress.detail) });
  }

  /**
   * Says what saving changed beyond the library: a slot a Replace could not restart,
   * and the slots a replaced folder cleared because it no longer has their file. Returns what was
   * saved.
   */
  private reportSaved(saved: MediaSaved): MediaSaved {
    for (const warning of saved.warnings ?? []) this.toasts.warning(warning);
    const cleared = saved.unassigned ?? [];
    if (cleared.length > 0) {
      const names = cleared.map((n) => `src${n}`).join(', ');
      this.toasts.warning(`Cleared ${names}: the replaced folder no longer has their files.`);
    }
    return saved;
  }

  /**
   * Uploads one file: sent as it is, then, if its name exists, again with the answer to the
   * clash. A failure is reported with the file's name.
   */
  private async uploadFile(file: File, position: number, total: number): Promise<FileOutcome> {
    const title = scoped('Uploading media', position, total);
    this.show({ title, detail: file.name, percent: null });
    let onConflict: UploadOnConflict | undefined;
    for (;;) {
      let saved: MediaSaved;
      try {
        saved = await this.sendUpload(
          file,
          onConflict,
          title,
          scoped('Preparing media', position, total),
        );
      } catch (refusal) {
        const conflict = uploadConflict(refusal);
        if (!conflict) return { kind: 'failed', message: `${file.name}: ${messageOf(refusal)}` };
        const choice = await this.ask(conflict, isArchiveUpload(file.name));
        if (choice === 'skip') {
          return { kind: 'skipped', unasked: this.toast ? skippedText(conflict) : null };
        }
        onConflict = choice;
        continue;
      }
      return { kind: 'uploaded', path: saved.path };
    }
  }

  /**
   * Sends one upload and resolves with what was saved; rejects with the refusal (a 409 names a
   * clash) or the failure of its re-encode. The bytes show as the upload's percent until the
   * server's re-encode, if any, takes over; what saving changed is reported as it arrives.
   */
  private async sendUpload(
    file: File,
    onConflict: UploadOnConflict | undefined,
    uploading: string,
    preparing: string,
  ): Promise<MediaSaved> {
    let saved: MediaSaved | null = null;
    await this.read(this.library.upload(file, onConflict), (event: LibraryEvent) => {
      if (event.kind === 'upload') {
        const percent = event.total ? Math.round((event.loaded / event.total) * 100) : null;
        this.show({ title: uploading, detail: file.name, percent });
      } else if (event.kind === 'job') {
        this.showJob(event.job, preparing, file.name);
      } else {
        saved = this.reportSaved(event.saved);
      }
    });
    return savedOf(saved);
  }

  /** Reads a request to its end; rejects when the request failed or a handler threw. */
  private read<E>(stream: Observable<E>, onEvent: (event: E) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // Made first and the request added to it: a source that emits while `subscribe` runs can
      // fail a handler before `subscribe` returns, and the request added to a subscription that is
      // already closed is ended at once.
      const subscription = new Subscription();
      subscription.add(
        stream.subscribe({
          next: (event) => {
            try {
              onEvent(event);
            } catch (failure) {
              // A failure of ours, not the server's: RxJS would only log it, and the request would
              // read on with nothing to show it. It fails the request instead.
              subscription.unsubscribe();
              reject(failure);
            }
          },
          error: reject,
          complete: () => resolve(),
        }),
      );
    });
  }

  /**
   * Asks what to do about a clash, naming the slots a Replace would restart: fetched again first,
   * as before any replace, or the last known ones, said to be so, when that
   * fetch fails. Skipped without asking once no dialog shows the work.
   */
  private async ask(conflict: UploadConflict, archive: boolean): Promise<ClashChoice> {
    if (this.toast) return 'skip';
    const checked = await this.slots.recheck();
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
