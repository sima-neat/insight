import { inject, Injectable, InjectionToken, Injector } from '@angular/core';
import type { NeatDialogRef } from '@sima/neat-ui/dialog';
import { NeatToasts } from '@sima/neat-ui/toast';

/** What a dialog's module exports to open it: the dialog's ref, from the kit's `NeatDialog`. */
type OpenDialog = (injector: Injector) => NeatDialogRef<unknown>;

/** Each of the rail's dialogs' modules, loaded by a dynamic import. */
export interface AppDialogModules {
  board(): Promise<{ openBoardDialog: OpenDialog }>;
  systemInfo(): Promise<{ openSystemInfoDialog: OpenDialog }>;
}

/**
 * Where the dialogs' code comes from. The rail is on every page, so whatever it imports
 * statically is in the initial bundle; the dialogs, and the kit entries only they use (the dialog,
 * the collapsible, the callout), are imported on their first open instead. A token so that a test
 * can see when a module loads.
 */
export const APP_DIALOG_MODULES = new InjectionToken<AppDialogModules>(
  'APP_DIALOG_MODULES',
  {
    providedIn: 'root',
    factory: () => ({
      board: () => import('./board/board-dialog'),
      systemInfo: () => import('./system-info/system-info-dialog'),
    }),
  },
);

type DialogName = keyof AppDialogModules;

/** What the toast says when a dialog's module could not be loaded (ruling Q11). */
const LOAD_FAILED: Record<DialogName, string> = {
  board: 'Could not open the board dialog. Reload the page to try again.',
  systemInfo: 'Could not open the System information dialog. Reload the page to try again.',
};

/**
 * Opens the dialogs of the rail's board and System information items, from there and from any page
 * that links to them (Peripherals' and Stats' "Open board settings"). Each opens once at a time: a
 * second call while its dialog is loading or open (a double click on the board block) does nothing
 * but wait for the same close. A module that cannot be loaded (the server gone, or its chunk
 * replaced by a newer build) is reported here, in a toast, for every caller; the next open tries
 * again.
 */
@Injectable({ providedIn: 'root' })
export class AppDialogs {
  private readonly modules = inject(APP_DIALOG_MODULES);
  private readonly injector = inject(Injector);
  private readonly toasts = inject(NeatToasts);

  /** The dialogs loading or open, each settling when it has closed. */
  private readonly showing = new Map<DialogName, Promise<void>>();
  /** The modules loaded or loading, so that each loads on its first open only. */
  private readonly loaded = new Map<DialogName, Promise<OpenDialog>>();

  /** The board dialog. Settles once it has closed, or could not be opened. */
  openBoard(): Promise<void> {
    return this.show('board', async () => (await this.modules.board()).openBoardDialog);
  }

  /** The System Info dialog. Settles once it has closed, or could not be opened. */
  openSystemInfo(): Promise<void> {
    return this.show(
      'systemInfo',
      async () => (await this.modules.systemInfo()).openSystemInfoDialog,
    );
  }

  private show(name: DialogName, load: () => Promise<OpenDialog>): Promise<void> {
    const open = this.showing.get(name);
    if (open) return open;
    const shown = (async () => {
      let openDialog: OpenDialog;
      try {
        openDialog = await this.load(name, load);
      } catch {
        this.toasts.error(LOAD_FAILED[name]);
        return;
      }
      await openDialog(this.injector).closed;
    })().finally(() => this.showing.delete(name));
    this.showing.set(name, shown);
    return shown;
  }

  private load(name: DialogName, load: () => Promise<OpenDialog>): Promise<OpenDialog> {
    let module = this.loaded.get(name);
    if (!module) {
      // A failed load is not kept: the next open asks for the module again rather than failing at
      // once.
      module = load().catch((failure: unknown) => {
        this.loaded.delete(name);
        throw failure;
      });
      this.loaded.set(name, module);
    }
    return module;
  }
}
