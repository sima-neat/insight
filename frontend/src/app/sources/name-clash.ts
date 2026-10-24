import type { Slot, UploadConflictBody } from './api';
import { slotName } from './slot-row';
import { ApiRequestError } from './stream-lines';

/**
 * An upload whose name exists already (spec, "Name clashes"). The server decides: without an
 * `on_conflict` it answers 409 with the name it has and the one `keep_both` would save under,
 * having saved nothing; the import dialog asks per file and sends the file again with the answer.
 */

/** What the user answers: the `on_conflict` to send again with, or to leave the file out. */
export type ClashChoice = 'replace' | 'keep_both' | 'skip';

export type UploadConflict = UploadConflictBody['conflict'];

/** The question the dialog asks about one clash. */
export interface NameClash {
  /** "clip.mp4 already exists." */
  readonly question: string;
  /** "In use on src3, src9": the slots a Replace restarts on the new content; null for none. */
  readonly inUse: string | null;
}

/** The clash a refused upload names, or null for any other failure. */
export function uploadConflict(failure: unknown): UploadConflict | null {
  if (!(failure instanceof ApiRequestError) || failure.status !== 409) return null;
  const conflict = failure.body?.['conflict'];
  if (typeof conflict !== 'object' || conflict === null) return null;
  const { existing, suggested } = conflict as Record<string, unknown>;
  return typeof existing === 'string' && typeof suggested === 'string'
    ? { existing, suggested }
    : null;
}

/**
 * Whether the server extracts the upload into a folder named after it (app.py's
 * `_is_archive_upload`): such an upload clashes on that folder, and replacing it swaps the
 * folder's content, so the slots streaming any file in it are the ones a Replace touches.
 */
export function isArchiveUpload(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return /\.(?:zip|tar|gz)$/.test(name);
}

/**
 * The question for a clash, named by the server's name for what exists (the file, or an
 * archive's folder), with the slots that use it (`SlotsService.assignedTo`, or `assignedUnder`
 * for a folder).
 */
export function nameClash(conflict: UploadConflict, slotsUsing: readonly Slot[]): NameClash {
  return {
    question: `${conflict.existing} already exists.`,
    inUse: slotsUsing.length > 0 ? `In use on ${slotsUsing.map(slotName).join(', ')}` : null,
  };
}

/**
 * What the outcome says of a clash that no one was there to answer: the dialog was closed by
 * leaving the page, and the upload went on in a toast, which cannot ask (ruling Q17).
 */
export function skippedText(conflict: UploadConflict): string {
  return `Skipped ${conflict.existing}: it already exists.`;
}
