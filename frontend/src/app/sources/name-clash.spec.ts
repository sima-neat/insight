import { ApiRequestError } from './api-errors';
import { isArchiveUpload, nameClash, skippedText, uploadConflict } from './name-clash';
import { fileSlot } from './slots.testing';

const CONFLICT = { existing: 'clip.mp4', suggested: 'clip_2.mp4' };

/** The library's error shape for a refusal, with what it adds beside `error`. */
const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiRequestError(status, code, { error: { code, message: code }, ...extra });

describe('uploadConflict', () => {
  it('reads the clash from the 409 name_taken an upload is refused with', () => {
    expect(uploadConflict(refusal(409, 'name_taken', { conflict: CONFLICT }))).toEqual(CONFLICT);
  });

  it('is null for any other failure, and for a name_taken without a clash', () => {
    expect(uploadConflict(refusal(400, 'invalid_request'))).toBeNull();
    expect(uploadConflict(refusal(409, 'in_use', { slots: [3] }))).toBeNull();
    expect(
      uploadConflict(refusal(409, 'name_taken', { conflict: { existing: 'a.mp4' } })),
    ).toBeNull();
    expect(uploadConflict(new Error('boom'))).toBeNull();
  });
});

describe('isArchiveUpload', () => {
  it('tells the archives the server unpacks into a folder', () => {
    expect(
      [
        'clips.zip',
        'clips.TAR',
        'clips.tar.gz',
        'clips.tgz',
        'clips.gz',
        'clip.mp4',
        'zip.mov',
      ].map(isArchiveUpload),
    ).toEqual([true, true, true, true, true, false, false]);
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
    expect(nameClash(CONFLICT, [fileSlot(3, 'clip.mp4'), fileSlot(9, 'clip.mp4')], true)).toEqual({
      question: 'clip.mp4 already exists.',
      notes: ['In use on src3, src9'],
    });
  });

  it('says when the slots could not be checked, under the last known ones (Q16)', () => {
    expect(nameClash(CONFLICT, [fileSlot(3, 'clip.mp4')], false)).toEqual({
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
