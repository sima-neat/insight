import { inject, Injectable, InjectionToken, Injector } from '@angular/core';
import type { NeatDialogRef } from '@sima/neat-ui/dialog';

/** What a top-bar dialog's module exports to open it: the dialog's ref, from the kit's `NeatDialog`. */
type OpenDialog = (injector: Injector) => NeatDialogRef<unknown>;

/** Each top-bar dialog's module, loaded by a dynamic import. */
export interface TopBarDialogModules {
  board(): Promise<{ openBoardDialog: OpenDialog }>;
}

/**
 * Where the top-bar dialogs' code comes from. The top bar is on every page, so whatever it imports
 * statically is in the initial bundle; the dialogs, and the kit entries only they use (the dialog,
 * the collapsible, the callout), are imported on their first open instead. A token so that a test
 * can see when a module loads.
 */
export const TOP_BAR_DIALOG_MODULES = new InjectionToken<TopBarDialogModules>(
  'TOP_BAR_DIALOG_MODULES',
  {
    providedIn: 'root',
    factory: () => ({ board: () => import('./board/board-dialog') }),
  },
);

type DialogName = keyof TopBarDialogModules;

/**
 * Opens the dialogs of the top bar's end items, from there and from any page that links to them
 * (Peripherals' and Stats' "Open board settings"). Each opens once at a time: a second call while
 * its dialog is loading or open (a double click on the pill) does nothing but wait for the same
 * close.
 */
@Injectable({ providedIn: 'root' })
export class TopBarDialogs {
  private readonly modules = inject(TOP_BAR_DIALOG_MODULES);
  private readonly injector = inject(Injector);

  /** The dialogs loading or open, each settling when it has closed. */
  private readonly showing = new Map<DialogName, Promise<void>>();
  /** The modules loaded or loading, so that each loads on its first open only. */
  private readonly loaded = new Map<DialogName, Promise<OpenDialog>>();

  /** The board dialog. Settles once it has closed. */
  openBoard(): Promise<void> {
    return this.show('board', async () => (await this.modules.board()).openBoardDialog);
  }

  private show(name: DialogName, load: () => Promise<OpenDialog>): Promise<void> {
    const open = this.showing.get(name);
    if (open) return open;
    const shown = (async () => {
      const openDialog = await this.load(name, load);
      await openDialog(this.injector).closed;
    })().finally(() => this.showing.delete(name));
    this.showing.set(name, shown);
    return shown;
  }

  private load(name: DialogName, load: () => Promise<OpenDialog>): Promise<OpenDialog> {
    let module = this.loaded.get(name);
    if (!module) {
      // A failed load (the server gone, a chunk replaced by a newer build) is not kept: the next
      // open asks for the module again rather than failing at once.
      module = load().catch((failure: unknown) => {
        this.loaded.delete(name);
        throw failure;
      });
      this.loaded.set(name, module);
    }
    return module;
  }
}
