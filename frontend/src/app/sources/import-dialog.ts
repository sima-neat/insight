import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injectable,
  signal,
  viewChild,
} from '@angular/core';
import { NeatButton, NeatNote } from '@sima/neat-ui';
import { NeatDialog, NeatDialogBody } from '@sima/neat-ui/dialog';
import { NeatProgress } from '@sima/neat-ui/progress';
import { NeatTab, NeatTabs } from '@sima/neat-ui/tabs';
import { ErrorNote } from '../error-note';
import { CatalogTabState, ImportCatalog } from './import-catalog';
import { ImportLocal } from './import-local';
import { type ImportKind, ImportRunner } from './import-runner';
import { ImportSession } from './import-session';
import { ImportYoutube, YoutubeTabState } from './import-youtube';

/**
 * Opens the import dialog, from Media's Import… and from the picker's Import… in Streaming.
 * Resolves with the library path saved last (an archive's folder), for the caller to reveal, or
 * null when nothing was imported or the dialog was closed meanwhile (also by leaving the page,
 * when the work goes on in a toast).
 */
@Injectable({ providedIn: 'root' })
export class ImportDialogs {
  private readonly dialogs = inject(NeatDialog);
  private openingTab: ImportKind = 'local';

  open(tab: ImportKind = 'local'): Promise<string | null> {
    this.openingTab = tab;
    const dialog = this.dialogs.open<string | null>(ImportDialog, {
      title: 'Import media',
      size: 'large',
    });
    return dialog.closed.then((path) => path ?? null);
  }

  /**
   * The tab the dialog being opened starts on. `NeatDialog` gives its content no inputs, so the
   * dialog reads it from here as it is created.
   */
  tabToOpen(): ImportKind {
    return this.openingTab;
  }
}

/**
 * The import dialog (spec, Media import; Inv-SM §1.1): Local files, Catalog and YouTube, each a
 * tab of its own, and under them the work `ImportRunner` runs: its progress, a name clash waiting
 * for an answer (Replace / Keep both / Skip), and why it failed. The dialog holds the runner while
 * it is open, so the work reports here; when the dialog goes while work runs (leaving the page),
 * the runner moves it into a toast. It closes itself once its work went through, and cannot be
 * dismissed while that work runs.
 */
@Component({
  selector: 'app-import-dialog',
  imports: [
    ErrorNote,
    ImportCatalog,
    ImportLocal,
    ImportYoutube,
    NeatButton,
    NeatDialogBody,
    NeatNote,
    NeatProgress,
    NeatTab,
    NeatTabs,
  ],
  providers: [ImportSession, CatalogTabState, YoutubeTabState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './import-dialog.html',
  styleUrl: './import-dialog.css',
})
export class ImportDialog {
  protected readonly runner = inject(ImportRunner);
  protected readonly tab = signal<string | undefined>(inject(ImportDialogs).tabToOpen());

  private readonly work = viewChild.required<ElementRef<HTMLElement>>('work');
  private readonly keepBoth = viewChild<ElementRef<HTMLButtonElement>>('keepBoth');

  constructor() {
    inject(DestroyRef).onDestroy(this.runner.hold());
    // Opened while earlier work runs (it went on in a toast when its dialog went): holding the
    // runner took it back, and this dialog sees it to the end as if it had started it.
    const running = this.runner.running();
    if (running) void inject(ImportSession).run(() => running);

    // Focus follows the work. A clash puts it on Keep both, the answer that loses nothing. When
    // the control that had it goes (an answered clash, Cancel Import) or is disabled (the drop
    // zone, an Import button), it moves to the work's status: the dialog's focus trap does not
    // take back focus that has fallen to the page.
    let wasBusy = false;
    let hadClash = false;
    afterRenderEffect(() => {
      const busy = this.runner.busy();
      const clash = this.runner.clash() !== null;
      if (clash && !hadClash) this.keepBoth()?.nativeElement.focus();
      else if (busy !== wasBusy || (hadClash && !clash)) this.recoverFocus();
      wasBusy = busy;
      hadClash = clash;
    });
  }

  private recoverFocus(): void {
    const active = document.activeElement as HTMLElement | null;
    const lost =
      !active ||
      active === document.body ||
      !active.isConnected ||
      (active as HTMLButtonElement).disabled === true;
    if (lost) this.work().nativeElement.focus();
  }
}
