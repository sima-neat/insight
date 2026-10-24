import { inject, Injectable, signal } from '@angular/core';
import { NeatDialogRef } from '@sima/neat-ui/dialog';
import type { ImportOutcome } from './import-runner';

/**
 * One open import dialog, as its tabs see it: a tab starts its work through `run`, which holds
 * the dialog open while the work runs and closes it with the path saved last once the work went
 * through. The work itself is `ImportRunner`'s, so it outlives the dialog.
 */
@Injectable()
export class ImportSession {
  private readonly ref = inject<NeatDialogRef<string | null>>(NeatDialogRef);

  private readonly runningState = signal(false);
  /** Work this dialog started is running. */
  readonly running = this.runningState.asReadonly();

  async run(work: () => Promise<ImportOutcome>): Promise<void> {
    this.runningState.set(true);
    // Closing would not stop the work, but the user would lose sight of it and of a name clash
    // waiting for an answer; navigation still closes it, and the work moves into a toast.
    this.ref.setDismissible(false);
    try {
      const outcome = await work();
      if (outcome.ok) this.ref.close(outcome.path);
    } finally {
      this.runningState.set(false);
      this.ref.setDismissible(true);
    }
  }
}
