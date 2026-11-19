import type { NeatFileBrowserLabels } from '@sima/neat-ui/file-browser';
import type { MediaEntry } from '../api.generated';

/**
 * What the media library's `neat-file-browser` says, wherever it shows: Streaming's picker and the
 * Media page: it counts "videos" and names the root "Media Root", where the kit's defaults say
 * "files", so the app gives its own words, here, once.
 */

export const MEDIA_ROOT_LABEL = 'Media Root';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The count under the breadcrumb: the streamable files in the folder and below. */
export const mediaCountLabel = (_folder: string, count: number): string =>
  plural(count, 'video', 'videos');

export const MEDIA_BROWSER_LABELS: Partial<NeatFileBrowserLabels> & {
  folderCount: NeatFileBrowserLabels['folderCount'];
} = {
  folderCount: (folder, count) =>
    `${plural(count, 'streamable video', 'streamable videos')} in ${folder} and its subfolders`,
};

/** The filter field's placeholder, naming the folder it searches. */
export function mediaFilterPlaceholder(folder: string): string {
  return `Filter files in ${folder ? folder.split('/').pop() : MEDIA_ROOT_LABEL}...`;
}

/** The folder a library path is in; '' is the root. */
export function parentFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * The files directly in `folder` that Insight cannot stream: the ones a picker leaves out. Files
 * in its subfolders are not counted, since the note is about the listing on screen; a folder that
 * is not in the tree hides nothing.
 */
export function hiddenFileCount(tree: readonly MediaEntry[], folder: string): number {
  let entries: readonly MediaEntry[] = tree;
  let path = '';
  for (const segment of folder ? folder.split('/') : []) {
    path = path ? `${path}/${segment}` : segment;
    const next = entries.find((entry) => entry.folder && entry.path === path);
    if (!next) return 0;
    entries = next.children ?? [];
  }
  return entries.filter((entry) => !entry.folder && !entry.streamable).length;
}

/** The note under a picker's listing, or null when it leaves nothing out. */
export function hiddenFilesNote(count: number): string | null {
  if (count === 0) return null;
  return `${plural(count, 'file', 'files')} hidden because Insight cannot stream ${count === 1 ? 'it' : 'them'}.`;
}

/** Whether `path` is a file in the library's tree, at any depth. */
export function hasFile(tree: readonly MediaEntry[], path: string): boolean {
  return tree.some((entry) =>
    entry.folder ? hasFile(entry.children ?? [], path) : entry.path === path,
  );
}

/**
 * Where to show a path an import just saved: a file in its folder, selected; anything else (an
 * archive's folder) opened. A browser falls back to the nearest folder that exists.
 */
export function revealIn(
  tree: readonly MediaEntry[],
  path: string,
): { folder: string; file: string | null } {
  return hasFile(tree, path)
    ? { folder: parentFolder(path), file: path }
    : { folder: path, file: null };
}
