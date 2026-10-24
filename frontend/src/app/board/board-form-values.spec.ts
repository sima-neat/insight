import type { BoardState, BoardTarget } from './api';
import { defaultTargetText, initialBoardForm, validateBoardForm } from './board-form-values';

/** A board state in the shape `GET /api/board` answers, with the fields a test does not care about filled in. */
function board(overrides: Partial<BoardState> = {}): BoardState {
  return {
    target: null,
    saved: null,
    defaults: { on_board: false, sdk_env: null },
    generation: 1,
    status: { state: 'unknown', checked_at: null, error: null },
    board: null,
    ...overrides,
  };
}

function target(overrides: Partial<BoardTarget>): BoardTarget {
  return {
    mode: 'ssh',
    source: 'manual',
    host: null,
    port: null,
    user: null,
    label: '',
    ...overrides,
  };
}

const localTarget = target({ mode: 'local', source: 'on-board', label: 'This board' });

describe('the board form’s values', () => {
  // The defaults half of #170's "labels for tiers, sources, and defaults".
  it('labels for defaults', () => {
    expect(
      defaultTargetText({
        on_board: false,
        sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' },
      }),
    ).toBe('sima@192.168.2.2:22 (paired SDK DevKit)');
    expect(defaultTargetText({ on_board: false, sdk_env: null })).toBe('');
    expect(defaultTargetText({ on_board: true, sdk_env: null })).toBe(
      'this board (Insight is running on it)',
    );
  });

  it('board form defaults and validation', () => {
    const state = board({
      target: localTarget,
      saved: null,
      defaults: { on_board: false, sdk_env: { host: '192.168.2.2', port: 22, user: 'sima' } },
    });
    expect(initialBoardForm(state)).toEqual({ host: '192.168.2.2', port: '22', user: 'sima' });
    expect(initialBoardForm(null)).toEqual({ host: '', port: '22', user: 'sima' });
    expect(validateBoardForm({ host: ' devkit.local ', port: '2222', user: 'sima' })).toEqual({
      body: { host: 'devkit.local', port: 2222, user: 'sima' },
    });
    for (const [host, port, user] of [
      ['', '22', 'sima'],
      ['a b', '22', 'sima'],
      ['devkit', '70000', 'sima'],
      ['devkit', '22', ' '],
    ]) {
      expect(
        'error' in validateBoardForm({ host, port, user }),
        JSON.stringify({ host, port, user }),
      ).toBe(true);
    }
  });

  it('the form starts from the saved target, else the SSH target, and validates with #170’s messages', () => {
    const ssh = target({ host: '10.0.0.9', port: 2222, user: 'root', label: 'root@10.0.0.9:2222' });
    expect(initialBoardForm(board({ target: ssh }))).toEqual({
      host: '10.0.0.9',
      port: '2222',
      user: 'root',
    });
    expect(
      initialBoardForm(board({ target: ssh, saved: { host: '10.0.0.4', port: 22, user: 'sima' } })),
    ).toEqual({ host: '10.0.0.4', port: '22', user: 'sima' });
    expect(validateBoardForm({ host: ' ', port: '22', user: 'sima' })).toEqual({
      error: 'Enter the board host name or IP address.',
    });
    expect(validateBoardForm({ host: 'a b', port: '22', user: 'sima' })).toEqual({
      error: 'The host cannot contain spaces.',
    });
    expect(validateBoardForm({ host: 'devkit', port: '2.5', user: 'sima' })).toEqual({
      error: 'The SSH port must be a whole number from 1 to 65535.',
    });
    expect(validateBoardForm({ host: 'devkit', port: '22', user: '' })).toEqual({
      error: 'Enter the SSH user, usually "sima".',
    });
  });
});
