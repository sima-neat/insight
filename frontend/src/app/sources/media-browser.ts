import type { NeatFileBrowserLabels } from '@sima/neat-ui/file-browser';
import type { MediaNode } from './api';

/**
 * What the media library's `neat-file-browser` says, wherever it shows: Streaming's picker and the
 * Media page. #170's browser counted "videos" and named the root "Media Root"; the kit's defaults
 * say "files", so the app gives its own words, here, once.
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
export function hiddenFileCount(tree: readonly MediaNode[], folder: string): number {
  let nodes: readonly MediaNode[] = tree;
  let path = '';
  for (const segment of folder ? folder.split('/') : []) {
    path = path ? `${path}/${segment}` : segment;
    const next = nodes.find((node) => node.type === 'folder' && node.path === path);
    if (next?.type !== 'folder') return 0;
    nodes = next.children;
  }
  return nodes.filter((node) => node.type === 'file' && !node.streamable).length;
}

/** #170's note under a picker's listing, or null when it leaves nothing out. */
export function hiddenFilesNote(count: number): string | null {
  if (count === 0) return null;
  return `${plural(count, 'file', 'files')} hidden because Insight cannot stream ${count === 1 ? 'it' : 'them'}.`;
}

/** Whether `path` is a file in the library's tree, at any depth. */
export function hasFile(tree: readonly MediaNode[], path: string): boolean {
  return tree.some((node) =>
    node.type === 'file' ? node.path === path : hasFile(node.children, path),
  );
}

/**
 * Where to show a path an import just saved: a file in its folder, selected; anything else (an
 * archive's folder) opened. A browser falls back to the nearest folder that exists.
 */
export function revealIn(
  tree: readonly MediaNode[],
  path: string,
): { folder: string; file: string | null } {
  return hasFile(tree, path)
    ? { folder: parentFolder(path), file: path }
    : { folder: path, file: null };
}
