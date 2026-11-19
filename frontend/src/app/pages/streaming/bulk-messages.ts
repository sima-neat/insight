import type {
  AutoAssignResult,
  RenditionsCleared,
  SlotFailure,
  SlotStartResult,
  SlotStopResult,
} from '../../api.generated';
import { formatBytes } from '../../format-bytes';

/**
 * What Streaming's bulk actions say when they are done. The server's results carry counts and
 * slot numbers, not sentences, so these word them; a slot that failed is said in the server's
 * own words (`failedMessage`).
 */

/** " Skipped external: src3, src7." for a phrase and its slots; nothing without slots. */
function slotsSuffix(phrase: string, slots: readonly number[]): string {
  return slots.length === 0 ? '' : ` ${phrase}: ${slots.map((n) => `src${n}`).join(', ')}.`;
}

export function startedMessage(result: SlotStartResult): string {
  return (
    `Started ${result.started.length} source(s), ${result.already_running.length} already ` +
    `running, ${result.errors.length} failed.${slotsSuffix('Skipped external', result.skipped_external)}`
  );
}

/** Each slot a bulk start could not start, with the server's message: "src2: … src5: …". */
export function failedMessage(errors: readonly SlotFailure[]): string {
  return errors.map(({ n, error }) => `src${n}: ${error}`).join(' ');
}

export function stoppedMessage(result: SlotStopResult): string {
  return `Stopped ${result.stopped.length} source(s).${slotsSuffix('External stream(s) left running', result.skipped_external)}`;
}

export function resetMessage(result: SlotStopResult): string {
  return `Reset all source assignments.${slotsSuffix('External stream(s) left running', result.skipped_external)}`;
}

export function autoAssignedMessage(result: AutoAssignResult): string {
  return (
    `Assigned ${result.assigned} source(s) with unique media file(s).` +
    slotsSuffix('Skipped external', result.skipped_external) +
    slotsSuffix('Skipped pulled', result.skipped_pulled)
  );
}

export function clearedMessage({ removed, freed_bytes, kept }: RenditionsCleared): string {
  const keptText = kept > 0 ? ` ${kept} kept: in use by a source.` : '';
  return `Removed ${removed} rendition(s), freed ${formatBytes(freed_bytes)}.${keptText}`;
}
