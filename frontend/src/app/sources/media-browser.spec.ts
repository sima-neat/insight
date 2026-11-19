import type { MediaEntry } from '../api.generated';
import {
  hasFile,
  hiddenFileCount,
  hiddenFilesNote,
  MEDIA_BROWSER_LABELS,
  mediaCountLabel,
  mediaFilterPlaceholder,
  parentFolder,
  revealIn,
} from './media-browser';
import { mediaFile, mediaFolder } from './media.testing';

const TREE: MediaEntry[] = [
  mediaFolder('people', [
    mediaFile('people/walk.mp4'),
    mediaFile('people/notes.txt', false),
    mediaFolder('people/raw', [
      mediaFile('people/raw/a.png', false),
      mediaFile('people/raw/b.png', false),
    ]),
  ]),
  mediaFile('cars.mp4'),
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

  it('words the hidden-files note, and says nothing when nothing is hidden', () => {
    expect(hiddenFilesNote(0)).toBeNull();
    expect(hiddenFilesNote(1)).toBe('1 file hidden because Insight cannot stream it.');
    expect(hiddenFilesNote(3)).toBe('3 files hidden because Insight cannot stream them.');
  });

  it('counts videos and words the filter', () => {
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

  it('reveals a file in its folder, selected, and opens a folder (an archive’s)', () => {
    expect(revealIn(TREE, 'people/walk.mp4')).toEqual({
      folder: 'people',
      file: 'people/walk.mp4',
    });
    expect(revealIn(TREE, 'cars.mp4')).toEqual({ folder: '', file: 'cars.mp4' });
    expect(revealIn(TREE, 'people/raw')).toEqual({ folder: 'people/raw', file: null });
  });
});
