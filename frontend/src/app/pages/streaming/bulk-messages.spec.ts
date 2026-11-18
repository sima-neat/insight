import {
  autoAssignedMessage,
  clearedMessage,
  resetMessage,
  startedMessage,
  stoppedMessage,
} from './bulk-messages';

describe('bulk messages', () => {
  it('a bulk start counts what it started, what ran already and what failed, and names the external slots', () => {
    expect(
      startedMessage({
        started: [1, 2],
        already_running: [3],
        skipped_external: [],
        errors: [{ n: 4, code: 'file_not_found', error: 'gone' }],
      }),
    ).toBe('Started 2 source(s), 1 already running, 1 failed.');
    expect(
      startedMessage({ started: [], already_running: [], skipped_external: [5, 7], errors: [] }),
    ).toBe('Started 0 source(s), 0 already running, 0 failed. Skipped external: src5, src7.');
  });

  it('stop all and reset name the external streams they leave running', () => {
    expect(stoppedMessage({ stopped: [1, 2, 3], skipped_external: [] })).toBe(
      'Stopped 3 source(s).',
    );
    expect(stoppedMessage({ stopped: [1], skipped_external: [9] })).toBe(
      'Stopped 1 source(s). External stream(s) left running: src9.',
    );
    expect(resetMessage({ stopped: [], skipped_external: [] })).toBe(
      'Reset all source assignments.',
    );
    expect(resetMessage({ stopped: [], skipped_external: [2, 4] })).toBe(
      'Reset all source assignments. External stream(s) left running: src2, src4.',
    );
  });

  it('auto assign counts the slots given a file, and names the slots it left alone', () => {
    expect(
      autoAssignedMessage({ assigned: 4, available: 4, skipped_external: [], skipped_pulled: [] }),
    ).toBe('Assigned 4 source(s) with unique media file(s).');
    expect(
      autoAssignedMessage({
        assigned: 2,
        available: 2,
        skipped_external: [3],
        skipped_pulled: [6],
      }),
    ).toBe(
      'Assigned 2 source(s) with unique media file(s). Skipped external: src3. Skipped pulled: src6.',
    );
  });

  it('clearing renditions says what it removed and freed, and what a source keeps', () => {
    expect(clearedMessage({ removed: 2, freed_bytes: 4096, kept: 0 })).toBe(
      'Removed 2 rendition(s), freed 4.0 KB.',
    );
    expect(clearedMessage({ removed: 0, freed_bytes: 0, kept: 1 })).toBe(
      'Removed 0 rendition(s), freed 0 B. 1 kept: in use by a source.',
    );
  });
});
