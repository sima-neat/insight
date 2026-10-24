import type { MediaNode } from './api';
import {
  hasFile,
  hiddenFileCount,
  hiddenFilesNote,
  MEDIA_BROWSER_LABELS,
  mediaCountLabel,
  mediaFilterPlaceholder,
  parentFolder,
} from './media-browser';

const TREE: MediaNode[] = [
  {
    name: '/people',
    path: 'people',
    type: 'folder',
    streamable_count: 1,
    children: [
      { name: 'walk.mp4', path: 'people/walk.mp4', type: 'file', streamable: true },
      { name: 'notes.txt', path: 'people/notes.txt', type: 'file', streamable: false },
      {
        name: '/raw',
        path: 'people/raw',
        type: 'folder',
        streamable_count: 0,
        children: [
          { name: 'a.png', path: 'people/raw/a.png', type: 'file', streamable: false },
          { name: 'b.png', path: 'people/raw/b.png', type: 'file', streamable: false },
        ],
      },
    ],
  },
  { name: 'cars.mp4', path: 'cars.mp4', type: 'file', streamable: true },
];

describe('media browser', () => {
  it('finds a file at any depth, and only a file', () => {
    expect(hasFile(TREE, 'cars.mp4')).toBe(true);
    expect(hasFile(TREE, 'people/raw/b.png')).toBe(true);
    expect(hasFile(TREE, 'people')).toBe(false);
    expect(hasFile(TREE, 'people/gone.mp4')).toBe(false);
    expect(hasFile([], 'cars.mp4')).toBe(false);
  });

  it('counts the files a folder holds that Insight cannot stream, not those in its subfolders', () => {
    expect(hiddenFileCount(TREE, '')).toBe(0);
    expect(hiddenFileCount(TREE, 'people')).toBe(1);
    expect(hiddenFileCount(TREE, 'people/raw')).toBe(2);
    // A folder that is gone (deleted elsewhere) hides nothing.
    expect(hiddenFileCount(TREE, 'gone')).toBe(0);
  });

  it('words the hidden-files note as #170 did, and says nothing when nothing is hidden', () => {
    expect(hiddenFilesNote(0)).toBeNull();
    expect(hiddenFilesNote(1)).toBe('1 file hidden because Insight cannot stream it.');
    expect(hiddenFilesNote(3)).toBe('3 files hidden because Insight cannot stream them.');
  });

  it("counts videos and words the filter as #170's browser did", () => {
    expect(mediaCountLabel('Media Root', 1)).toBe('1 video');
    expect(mediaCountLabel('people', 4)).toBe('4 videos');
    expect(MEDIA_BROWSER_LABELS.folderCount('people', 1)).toBe(
      '1 streamable video in people and its subfolders',
    );
    expect(MEDIA_BROWSER_LABELS.folderCount('people', 2)).toBe(
      '2 streamable videos in people and its subfolders',
    );
    expect(mediaFilterPlaceholder('')).toBe('Filter files in Media Root...');
    expect(mediaFilterPlaceholder('people/raw')).toBe('Filter files in raw...');
  });

  it('finds the folder a file is in', () => {
    expect(parentFolder('people/raw/a.png')).toBe('people/raw');
    expect(parentFolder('cars.mp4')).toBe('');
    expect(parentFolder('')).toBe('');
  });
});
