import type { BoardTarget } from './api';
import { boardList, DEVKIT, LOCAL, MANUAL, selectedBoard } from './board.testing';
import {
  defaultTargetText,
  enteredBoard,
  initialBoardForm,
  validateBoardForm,
} from './board-form-values';

describe('the board form’s values', () => {
  it('labels for defaults', () => {
    const devkit: BoardTarget = { ...DEVKIT, host: '192.168.2.2' };
    expect(defaultTargetText(boardList([devkit]))).toBe('sima@192.168.2.2:22 (paired SDK DevKit)');
    expect(defaultTargetText(boardList([MANUAL]))).toBe('');
    expect(defaultTargetText(boardList())).toBe('');
    expect(defaultTargetText(null)).toBe('');
    // The board Insight runs on comes before the DevKit, as the selection prefers them.
    expect(defaultTargetText(boardList([MANUAL, LOCAL, devkit]))).toBe(
      'this board (Insight is running on it)',
    );
  });

  it('the board entered by hand is the manual one, whichever is selected', () => {
    expect(enteredBoard(boardList([MANUAL, DEVKIT], selectedBoard(MANUAL)))).toBe(MANUAL);
    expect(enteredBoard(boardList([DEVKIT]))).toBeNull();
    expect(enteredBoard(null)).toBeNull();
  });

  it('board form defaults and validation', () => {
    const devkit: BoardTarget = { ...DEVKIT, host: '192.168.2.2' };
    expect(initialBoardForm(boardList([LOCAL, devkit]))).toEqual({
      host: '192.168.2.2',
      port: '22',
      user: 'sima',
    });
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

  it('the form starts from the entered board, else the SSH board in use, and validates with its messages', () => {
    const ssh: BoardTarget = { ...DEVKIT, host: '10.0.0.9', port: 2222, user: 'root' };
    expect(initialBoardForm(boardList([ssh]))).toEqual({
      host: '10.0.0.9',
      port: '2222',
      user: 'root',
    });
    // The entered board wins over the selected one, whichever the boards list first.
    expect(initialBoardForm(boardList([ssh, MANUAL]))).toEqual({
      host: '10.0.0.5',
      port: '2222',
      user: 'sima',
    });
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
