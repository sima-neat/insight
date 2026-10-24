import { BoardProblem } from '../board/board-error';
import { ApiRequestError } from '../sources/stream-lines';
import installFailures from '../../../../tests/fixtures/sentinel/install-failures.json';
import { MAX_POLL_MS, POLL_MS, failureOf, haltsPolling, pollDelay } from './sentinel-failure';

/**
 * What POST /api/sentinel/install answers when it refuses or fails, captured from
 * `neat_insight.sentinel.api` (#170's `install-failures.json`).
 */
const INSTALL: Record<string, { status: number; body: Record<string, unknown> }> = installFailures;

const BOARD_PILL = 'from the board pill in the top bar';

describe('polling', () => {
  // The backoff assertions of #170's "values, changes, durations, ... read as a developer
  // expects; polling backs off".
  it('polling backs off from 2 s to a cap of 30 s', () => {
    expect([0, 1, 3, 99].map(pollDelay)).toEqual([POLL_MS, 4000, 16000, MAX_POLL_MS]);
    expect([POLL_MS, MAX_POLL_MS]).toEqual([2000, 30000]);
    // A count that is not a count of failures polls as normal.
    expect([-1, 1.5, Number.NaN].map(pollDelay)).toEqual([POLL_MS, POLL_MS, POLL_MS]);
  });

  it('a failure about the board or the daemon halts polling; one about a request does not', () => {
    for (const code of [
      'no_target',
      'unreachable',
      'auth_failed',
      'host_key_changed',
      'timeout',
      'permission_denied',
      'tool_missing',
      'command_failed',
      'sentinel_missing',
      'sentinel_stopped',
      'sentinel_denied',
    ]) {
      expect(haltsPolling(code), code).toBe(true);
    }
    for (const code of [
      'sentinel_schema',
      'sentinel_failed',
      'response_too_large',
      'network',
      '',
    ]) {
      expect(haltsPolling(code), code).toBe(false);
    }
  });
});

describe('failureOf', () => {
  it('every backend failure becomes a title, a sentence and a place to fix it', () => {
    const noBoard = failureOf(
      { error: 'No board is selected.', code: 'no_target', hint: 'Enter the board address.' },
      null,
    );
    expect([noBoard.title, noBoard.hint, noBoard.board, noBoard.retryable]).toEqual([
      'No board is selected',
      'Enter the board address.',
      true,
      false,
    ]);
    expect(noBoard.problem.message).toBe('No board is selected.');

    const unreachable = failureOf(
      { error: 'ssh: connect failed', code: 'unreachable', hint: null },
      null,
    );
    expect(unreachable.board).toBe(true);
    expect(unreachable.hint).toContain(BOARD_PILL);

    expect(
      failureOf(
        {
          error: 'host key changed',
          code: 'host_key_changed',
          presented_fingerprint: 'SHA256:new',
        },
        null,
      ).problem.details['presented_fingerprint'],
    ).toBe('SHA256:new');

    const schema = failureOf({ error: 'Sentinel speaks schema 2', code: 'sentinel_schema' }, null);
    expect([schema.title, schema.board]).toEqual([
      'Sentinel and Insight speak different API versions',
      false,
    ]);
    expect(
      failureOf({ error: 'socket cannot be opened', code: 'sentinel_denied' }, null).daemon,
    ).toBe(true);
    expect(
      failureOf(
        { error: 'installer failed', code: 'sentinel_failed', detail: 'exit 1\nlog tail' },
        null,
      ).detail,
    ).toBe('exit 1\nlog tail');

    const tooLarge = failureOf(
      {
        error: 'larger than the 12 MiB Insight reads',
        code: 'response_too_large',
        limit_bytes: 12582912,
      },
      null,
    );
    expect([tooLarge.title, tooLarge.board, tooLarge.daemon]).toEqual([
      'Sentinel answered with more than Insight reads',
      false,
      false,
    ]);
    expect(failureOf({ error: 'boom', code: 'unheard_of' }, null).title).toBe(
      'Something went wrong',
    );
    expect(failureOf(new Error('plain'), null)).toMatchObject({
      code: '',
      title: 'Something went wrong',
      hint: '',
      detail: '',
    });
    const body = { error: 'no active trace', code: 'trace_conflict', generation: 4 };
    expect(failureOf(new ApiRequestError(409, 'no active trace', body), 3).generation).toBe(4);
    const noGeneration = { error: 'no board', code: 'no_target' };
    expect(failureOf(new ApiRequestError(409, 'no board', noGeneration), 3).generation).toBe(3);
    // A problem the board already read is read as it is.
    const problem = new BoardProblem('Sentinel is gone', 'sentinel_missing', '', {});
    expect(failureOf(problem, 2).problem).toBe(problem);
  });

  it('a request that never reached Insight is titled as that, with the hint to retry', () => {
    const failure = failureOf(new ApiRequestError(0, 'Failed to fetch', null), 1);
    expect([failure.code, failure.title, failure.board, failure.retryable]).toEqual([
      'network',
      'Insight is not answering',
      false,
      true,
    ]);
    expect(failure.hint).toBe('Check that Insight is still running, then retry.');
  });

  it('fallback hints point at the board pill in the top bar', () => {
    const hint = (code: string) => failureOf({ error: 'x', code }, null).hint;
    expect(hint('no_target')).toBe('Choose a board with the board pill in the top bar.');
    expect(hint('unreachable')).toBe(
      'Fix the connection from the board pill in the top bar, then retry.',
    );
    expect(hint('auth_failed')).toBe(hint('unreachable'));
    expect(hint('host_key_changed')).toBe(
      'Confirm the fingerprint in the board dialog, from the board pill in the top bar, before trusting the new key.',
    );
    // The rest keep #170's words, and nothing still points at a "Board panel above".
    expect(hint('timeout')).toBe('Check the board is awake and on the network, then retry.');
    expect(hint('sentinel_missing')).toBe(
      'Install Sentinel from this page, or start it on the board.',
    );
    expect(hint('sentinel_stopped')).toBe(
      'Start it on the board with `sudo systemctl start simaai-sentinel`.',
    );
    expect(hint('sentinel_failed')).toBe('Check `systemctl status simaai-sentinel` on the board.');
    expect(hint('unheard_of')).toBe('');
    for (const code of ['no_target', 'unreachable', 'auth_failed', 'host_key_changed']) {
      expect(hint(code)).not.toMatch(/Board panel/);
    }
  });

  it('the backend’s own hint wins over the fallback', () => {
    const gone = failureOf(
      {
        error: 'The board could not be reached.',
        code: 'unreachable',
        hint: 'Check that the board is powered on and on the network, and that `ssh -p 22 sima@192.168.2.254` works from this machine.',
      },
      null,
    );
    expect([gone.board, gone.daemon]).toEqual([true, false]);
    expect(gone.hint).toMatch(/ssh -p 22 sima@192\.168\.2\.254/);
  });

  it('only failures a retry can fix are retryable', () => {
    const notRetryable = [
      'no_target',
      'auth_failed',
      'host_key_changed',
      'sentinel_missing',
      'sentinel_denied',
      'sentinel_schema',
    ];
    for (const code of notRetryable) {
      expect(failureOf({ error: 'x', code }, null).retryable, code).toBe(false);
    }
    for (const code of [
      'unreachable',
      'timeout',
      'permission_denied',
      'tool_missing',
      'command_failed',
      'sentinel_stopped',
      'sentinel_failed',
      'already_installed',
      'trace_conflict',
      'not_found',
      'invalid_request',
      'request_too_large',
      'response_too_large',
      'network',
      'bad_response',
      'stale_snapshot',
      'unheard_of',
      '',
    ]) {
      expect(failureOf({ error: 'x', code }, null).retryable, code).toBe(true);
    }
  });

  it('an install that is refused or fails is titled as an install, not as a read', () => {
    const failure = (name: string) => failureOf(INSTALL[name].body, 7, 'install');
    const refused = failure('already_installed');
    expect(INSTALL['already_installed'].status).toBe(409);
    expect([refused.title, refused.detail]).toEqual(['Sentinel is already installed', '']);
    expect(refused.hint).toMatch(/would end a trace in flight/);

    const noCli = failure('sima_cli_missing');
    expect([noCli.code, noCli.title]).toEqual([
      'sentinel_failed',
      'Sentinel could not be installed',
    ]);
    expect(noCli.problem.message).toMatch(/`sima-cli` was not found on the board/);
    expect(noCli.hint).toMatch(/Install sima-cli on the board/);

    const sudo = failure('sudo_denied');
    expect([sudo.code, sudo.title, sudo.detail]).toEqual([
      'sentinel_denied',
      'Installing Sentinel needs sudo on the board',
      'sudo: a password is required',
    ]);
    expect(sudo.hint).toMatch(/in a shell on the board/);

    const failed = failure('installer_failed');
    expect(failed.title).toBe('Sentinel could not be installed');
    expect(failed.problem.message).toMatch(/failed on the board \(exit 1\)/);
    expect(failed.detail).toMatch(/vulcan: not found/);

    const down = failure('installer_left_it_down');
    expect(down.title).toBe('Sentinel could not be installed');
    expect(down.problem.message).toMatch(/the simaai-sentinel service is inactive/);
    expect(down.hint).toMatch(/systemctl status simaai-sentinel/);

    // Only the sudo refusal is one a retry cannot fix; the others are board or installer states.
    const retryable = [
      'already_installed',
      'sima_cli_missing',
      'sudo_denied',
      'installer_failed',
    ].map((name) => {
      const one = failure(name);
      return [one.board, one.retryable, one.action, one.generation];
    });
    expect(retryable).toEqual([
      [false, true, 'install', 7],
      [false, true, 'install', 7],
      [false, false, 'install', 7],
      [false, true, 'install', 7],
    ]);

    const timeout = { code: 'timeout', error: 'The board took too long to answer.' };
    const slow = failureOf(timeout, null, 'install');
    expect(slow.title).toBe('The installer did not finish in time');
    expect(slow.hint).toMatch(/as long as it needs/);
    expect(failureOf(timeout, null).title).toBe('The board took too long to answer');
    expect(failureOf(timeout, null).action).toBe('read');
  });

  it('a failure that lands after a board switch carries the generation it was issued under', () => {
    const unreachable = { error: 'ssh: connect failed', code: 'unreachable' };
    expect(failureOf(unreachable, 3).generation).toBe(3);
    expect(failureOf(unreachable, null).generation).toBeNull();
    // The generation the backend names is the board that answered, which may be another one.
    expect(failureOf({ ...unreachable, generation: 5 }, 3).generation).toBe(5);
    expect(failureOf({ ...unreachable, generation: '5' }, 3).generation).toBe(3);
  });
});
