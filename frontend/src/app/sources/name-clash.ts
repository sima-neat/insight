import type { MediaConflict, Slot } from '../api.generated';
import { ApiRequestError } from './api-errors';
import { slotName, SLOTS_NOT_CHECKED } from './slot-row';

/**
 * An upload whose name exists already. The server decides: without an
 * `on_conflict` it answers 409 `name_taken` with the name it has and the one `keep_both` would
 * save under, having saved nothing; the import dialog asks per file and sends the file again with
 * the answer.
 */

/** What the user answers: the `on_conflict` to send again with, or to leave the file out. */
export type ClashChoice = 'replace' | 'keep_both' | 'skip';

export type UploadConflict = MediaConflict;

/** The question the dialog asks about one clash. */
export interface NameClash {
  /** "clip.mp4 already exists." */
  readonly question: string;
  /**
   * Under the question: "In use on src3, src9", the slots a Replace restarts on the new content,
   * and whether those could not be checked again before asking.
   */
  readonly notes: readonly string[];
}

/** The clash a refused upload names, or null for any other failure. */
export function uploadConflict(failure: unknown): UploadConflict | null {
  if (!(failure instanceof ApiRequestError) || failure.code !== 'name_taken') return null;
  const conflict = failure.body?.['conflict'];
  if (typeof conflict !== 'object' || conflict === null) return null;
  const { existing, suggested } = conflict as Record<string, unknown>;
  return typeof existing === 'string' && typeof suggested === 'string'
    ? { existing, suggested }
    : null;
}

/**
 * Whether the server unpacks the upload into a folder named after it (a ZIP, a tar or a gzipped
 * tar, by its name): such an upload clashes on that folder, and replacing it swaps the folder's
 * content, so the slots streaming any file in it are the ones a Replace touches.
 */
export function isArchiveUpload(fileName: string): boolean {
  const name = fileName.toLowerCase();
  return /\.(?:zip|tar|gz|tgz)$/.test(name);
}

/**
 * The question for a clash, named by the server's name for what exists (the file, or an
 * archive's folder), with the slots that use it (`SlotsService.assignedTo`, or `assignedUnder`
 * for a folder). `checked` is false when the slots could not be fetched again before asking, so
 * those named are the last known ones.
 */
export function nameClash(
  conflict: UploadConflict,
  slotsUsing: readonly Slot[],
  checked: boolean,
): NameClash {
  const notes: string[] = [];
  if (slotsUsing.length > 0) notes.push(`In use on ${slotsUsing.map(slotName).join(', ')}`);
  if (!checked) notes.push(SLOTS_NOT_CHECKED);
  return { question: `${conflict.existing} already exists.`, notes };
}

/**
 * What the outcome says of a clash that no one was there to answer: the dialog was closed by
 * leaving the page, and the upload went on in a toast, which cannot ask.
 */
export function skippedText(conflict: UploadConflict): string {
  return `Skipped ${conflict.existing}: it already exists.`;
}
