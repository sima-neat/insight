import type { Slot } from './api';
import { isArchiveUpload, nameClash, skippedText, uploadConflict } from './name-clash';
import { ApiRequestError } from './stream-lines';

const slot = (index: number, file: string): Slot => ({
  index,
  file,
  state: 'stopped',
  transport: '',
  codec: '',
  type: 'file',
  allowed_transports: [],
  urls: {},
});

const CONFLICT = { existing: 'clip.mp4', suggested: 'clip_2.mp4' };

describe('uploadConflict', () => {
  it('reads the clash from the 409 an upload is refused with', () => {
    const refused = new ApiRequestError(409, 'A file with this name exists.', {
      error: 'A file with this name exists.',
      conflict: CONFLICT,
    });
    expect(uploadConflict(refused)).toEqual(CONFLICT);
  });

  it('is null for any other failure, and for a 409 without a clash', () => {
    expect(uploadConflict(new ApiRequestError(400, 'No file provided.', null))).toBeNull();
    expect(uploadConflict(new ApiRequestError(409, 'Busy', { error: 'Busy' }))).toBeNull();
    expect(
      uploadConflict(new ApiRequestError(409, 'x', { conflict: { existing: 'a.mp4' } })),
    ).toBeNull();
    expect(uploadConflict(new Error('boom'))).toBeNull();
  });
});

describe('isArchiveUpload', () => {
  it('tells the archives the server extracts into a folder, as app.py does', () => {
    expect(
      ['clips.zip', 'clips.TAR', 'clips.tar.gz', 'clips.gz', 'clip.mp4', 'zip.mov'].map(
        isArchiveUpload,
      ),
    ).toEqual([true, true, true, true, false, false]);
  });
});

describe('nameClash', () => {
  it('asks about the name the server has', () => {
    expect(nameClash(CONFLICT, [], true)).toEqual({
      question: 'clip.mp4 already exists.',
      notes: [],
    });
  });

  it('names the slots that use what a Replace swaps', () => {
    expect(nameClash(CONFLICT, [slot(3, 'clip.mp4'), slot(9, 'clip.mp4')], true)).toEqual({
      question: 'clip.mp4 already exists.',
      notes: ['In use on src3, src9'],
    });
  });

  it('says when the slots could not be checked, under the last known ones (Q16)', () => {
    expect(nameClash(CONFLICT, [slot(3, 'clip.mp4')], false)).toEqual({
      question: 'clip.mp4 already exists.',
      notes: ['In use on src3', 'Could not check which slots use these files.'],
    });
  });
});

describe('skippedText', () => {
  it('reports a clash that no one was left to answer', () => {
    expect(skippedText(CONFLICT)).toBe('Skipped clip.mp4: it already exists.');
  });
});
