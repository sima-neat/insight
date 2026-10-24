import type { BoardState, BoardTarget } from './api';
import {
  boardIndicator,
  cameraSetupRows,
  connectionState,
  defaultTargetText,
  initialBoardForm,
  overlayName,
  sourceLabel,
  validateBoardForm,
} from './board-view';

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

const cameraSetup = {
  model: 'SiMa.ai Modalix SoM 16Gig Board',
  overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
};

describe('boardIndicator', () => {
  // #170's test; its `state.short` is the chip's label and its `title` the tooltip.
  it('the masthead board indicator collapses board state into a label and a short pill', () => {
    expect(boardIndicator(null, null).chip.label).toBe('Loading…');
    const none = boardIndicator(board({ target: null }), null);
    expect(none.label).toBe('No board');
    expect(none.chip.label).toBe('Not selected');
    // The masthead names the machine the way the SDK does; sima@host is a connection string and
    // stays in the panel.
    const connected = boardIndicator(
      board({
        target: target({
          label: 'sima@192.168.2.2',
          mode: 'ssh',
          source: 'sdk-env',
          host: '192.168.2.2',
        }),
        status: { state: 'connected', checked_at: null, error: null },
      }),
      null,
    );
    expect(connected.label).toBe('DevKit: 192.168.2.2');
    expect(connected.chip.label).toBe('Connected');
    expect(connected.chip.tone).toBe('success');
    // The full target stays in the tooltip.
    expect(connected.tooltip).toMatch(/^sima@192\.168\.2\.2 — Connected/);
    const manual = boardIndicator(
      board({
        target: target({ label: 'sima@10.0.0.4', mode: 'ssh', source: 'manual', host: '10.0.0.4' }),
        status: { state: 'connected', checked_at: null, error: null },
      }),
      null,
    );
    // A hand-entered board is not called a DevKit.
    expect(manual.label).toBe('Board: 10.0.0.4');
    expect(boardIndicator(board({ target: localTarget }), null).label).toBe('This board');
    const failedStatus = { state: 'error', checked_at: null, error: null } as const;
    const failed = boardIndicator(board({ target: localTarget, status: failedStatus }), null);
    expect(failed.chip.label).toBe('Error');
    // The card keeps the long label.
    expect(connectionState(failedStatus).label).toBe('Connection failed');
    expect(boardIndicator(board({ target: localTarget }), null).chip.label).toBe('Not checked');
  });

  it('keeps #170’s tooltips and maps its tones to the kit’s', () => {
    expect(boardIndicator(null, null)).toEqual({
      label: 'Board',
      chip: { label: 'Loading…', tone: 'neutral' },
      tooltip: 'Loading the selected board',
    });
    expect(boardIndicator(board(), null)).toEqual({
      label: 'No board',
      chip: { label: 'Not selected', tone: 'warning' },
      tooltip: 'No board is selected. Open board settings to choose one.',
    });
    const failed = boardIndicator(
      board({ target: localTarget, status: { state: 'error', checked_at: null, error: null } }),
      null,
    );
    expect(failed.chip).toEqual({ label: 'Error', tone: 'danger' });
    expect(failed.tooltip).toBe('This board — Connection failed. Open board settings.');
    expect(boardIndicator(board({ target: localTarget }), null).chip).toEqual({
      label: 'Not checked',
      tone: 'neutral',
    });
  });

  it('boardIndicator shows Error with the reason when the board could not be read, not Loading…', () => {
    const unreachable = {
      message: 'Could not reach the server.',
      code: 'network',
      hint: 'Check that Insight is still running, then retry.',
      details: {},
    };
    expect(boardIndicator(null, unreachable)).toEqual({
      label: 'Board',
      chip: { label: 'Error', tone: 'danger' },
      tooltip: 'Could not read the board: Could not reach the server.',
    });
    // With a last good state the pill still names the board, and says the read failed (F35).
    const connected = board({
      target: target({ label: 'sima@10.0.0.4', host: '10.0.0.4' }),
      status: { state: 'connected', checked_at: null, error: null },
    });
    expect(boardIndicator(connected, unreachable)).toEqual({
      label: 'Board: 10.0.0.4',
      chip: { label: 'Error', tone: 'danger' },
      tooltip: 'Could not read the board: Could not reach the server.',
    });
  });
});

describe('the board’s words', () => {
  it('connectionState gives the long label, the short one and the tone', () => {
    expect(connectionState({ state: 'connected', checked_at: null, error: null })).toEqual({
      label: 'Connected',
      short: 'Connected',
      tone: 'success',
    });
    expect(connectionState({ state: 'error', checked_at: null, error: null })).toEqual({
      label: 'Connection failed',
      short: 'Error',
      tone: 'danger',
    });
    expect(connectionState({ state: 'unknown', checked_at: null, error: null })).toEqual({
      label: 'Not checked',
      short: 'Not checked',
      tone: 'neutral',
    });
  });

  // #170's "labels for tiers, sources, and defaults", without the tiers: they are the
  // peripherals' words (Task 8), not the board's.
  it('labels for sources and defaults', () => {
    for (const [source, label] of [
      ['on-board', 'On this board'],
      ['sdk-env', 'SDK DevKit'],
      ['manual', 'Manual'],
    ] as const) {
      expect(sourceLabel(source)).toBe(label);
    }
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

  it('the board card names the model and camera overlays only when Sentinel reports them', () => {
    expect(cameraSetupRows(cameraSetup)).toEqual([
      ['Model', 'SiMa.ai Modalix SoM 16Gig Board'],
      ['Camera setup', 'modalix-som-waveshare-ARDU-IMX477-1CAM'],
    ]);
    expect(cameraSetupRows({ model: null, overlays: ['a.dtbo', '/boot/overlays/b.DTBO'] })).toEqual(
      [['Camera setup', 'a, b']],
    );
    expect(cameraSetupRows({ model: '', overlays: [] })).toEqual([]);
    expect(cameraSetupRows(null)).toEqual([]);
    expect(overlayName('modalix-som-imx219.dtbo')).toBe('modalix-som-imx219');
    expect(overlayName('no-extension')).toBe('no-extension');
  });
});
