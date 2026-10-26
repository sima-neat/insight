import type { BoardState, BoardTarget } from './api';
import { BoardProblem } from './board-error';
import {
  boardFacts,
  boardRailView,
  boardStateChip,
  boardSummary,
  cameraSetupRows,
  connectionState,
  overlayName,
  sourceLabel,
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

describe('boardRailView', () => {
  const connected = { state: 'connected', checked_at: null, error: null } as const;
  const failedStatus = { state: 'error', checked_at: null, error: null } as const;
  const devkit = target({
    label: 'sima@192.168.2.2',
    mode: 'ssh',
    source: 'sdk-env',
    host: '192.168.2.2',
    port: 22,
  });
  const unreachable = new BoardProblem(
    'Could not reach the Insight server.',
    'network',
    'Check that Insight is still running, then retry.',
    {},
  );

  it('a connected board is quiet: its short name, its address, a success dot', () => {
    expect(boardRailView(board({ target: devkit, status: connected }), null)).toEqual({
      name: 'DevKit',
      detail: '192.168.2.2',
      tone: 'success',
      summary: 'DevKit — 192.168.2.2 — Connected',
    });
    // A hand-entered board is not called a DevKit; a port other than SSH's is part of the address.
    const manual = target({
      label: 'sima@10.0.0.4',
      source: 'manual',
      host: '10.0.0.4',
      port: 2222,
    });
    expect(boardRailView(board({ target: manual, status: connected }), null)).toMatchObject({
      name: 'Board',
      detail: '10.0.0.4:2222',
    });
  });

  it('this board has no address, so its state is the second line even when connected', () => {
    expect(boardRailView(board({ target: localTarget, status: connected }), null)).toEqual({
      name: 'This board',
      detail: 'Connected',
      tone: 'success',
      summary: 'This board — Connected',
    });
  });

  it('a board that is not connected says its state in words, with the dot of its tone', () => {
    expect(boardRailView(board({ target: devkit }), null)).toEqual({
      name: 'DevKit',
      detail: 'Not checked',
      tone: 'neutral',
      summary: 'DevKit — 192.168.2.2 — Not checked',
    });
    // The short word is shown; the accessible name and tooltip have the long one.
    expect(boardRailView(board({ target: devkit, status: failedStatus }), null)).toEqual({
      name: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      summary: 'DevKit — 192.168.2.2 — Connection failed',
    });
    expect(connectionState(failedStatus).label).toBe('Connection failed');
    expect(boardRailView(board({ target: null }), null)).toEqual({
      name: 'No board',
      detail: 'Not selected',
      tone: 'neutral',
      summary: 'No board — Not selected',
    });
    expect(boardRailView(null, null)).toEqual({
      name: 'Board',
      detail: 'Loading…',
      tone: 'neutral',
      summary: 'Board — Loading the selected board',
    });
  });

  it('says Checking… in place of Not checked while a connection check is out, and only there', () => {
    expect(boardRailView(board({ target: devkit }), null, true)).toEqual({
      name: 'DevKit',
      detail: 'Checking…',
      tone: 'warning',
      summary: 'DevKit — 192.168.2.2 — Checking the connection',
    });
    // A known state, no board, or a failed read keeps its own words while a check runs.
    expect(boardRailView(board({ target: devkit, status: connected }), null, true).detail).toBe(
      '192.168.2.2',
    );
    expect(boardRailView(board(), null, true).detail).toBe('Not selected');
    expect(boardRailView(null, null, true).detail).toBe('Loading…');
    expect(boardRailView(board({ target: devkit }), unreachable, true).detail).toBe('Error');
  });

  it('shows Error with the reason when the board could not be read, not Loading…', () => {
    expect(boardRailView(null, unreachable)).toEqual({
      name: 'Board',
      detail: 'Error',
      tone: 'danger',
      summary: 'Board — Could not read the board: Could not reach the Insight server.',
    });
    // With a last good state the block still names the board, and says the read failed (F35).
    expect(boardRailView(board({ target: devkit, status: connected }), unreachable)).toEqual({
      name: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      summary:
        'DevKit — 192.168.2.2 — Could not read the board: Could not reach the Insight server.',
    });
    // A last state with no board selected keeps saying so (ruling Q4).
    expect(boardRailView(board({ target: null }), unreachable)).toEqual({
      name: 'No board',
      detail: 'Error',
      tone: 'danger',
      summary: 'No board — Could not read the board: Could not reach the Insight server.',
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

  // #170's "labels for tiers, sources, and defaults", without the tiers (the peripherals' words,
  // Task 8) and the defaults (the form's, board-form-values.spec.ts).
  it('labels for sources', () => {
    for (const [source, label] of [
      ['on-board', 'On this board'],
      ['sdk-env', 'SDK DevKit'],
      ['manual', 'Manual'],
    ] as const) {
      expect(sourceLabel(source)).toBe(label);
    }
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

describe('the board dialog’s words', () => {
  const devkit = target({
    mode: 'ssh',
    source: 'sdk-env',
    host: '192.168.1.20',
    label: 'sima@192.168.1.20',
  });
  const identity = {
    hostname: 'devkit',
    machine: 'modalix',
    build_version: '2.0.0',
    fingerprint: 'abcd',
  };

  it('the status chip has the long labels, and No board without a target', () => {
    const status = (state: 'unknown' | 'connected' | 'error') =>
      boardStateChip(board({ target: devkit, status: { state, checked_at: null, error: null } }));
    expect(status('connected')).toEqual({ label: 'Connected', tone: 'success' });
    expect(status('error')).toEqual({ label: 'Connection failed', tone: 'danger' });
    expect(status('unknown')).toEqual({ label: 'Not checked', tone: 'neutral' });
    expect(boardStateChip(board())).toEqual({ label: 'No board', tone: 'warning' });
  });

  it('the status line joins the hostname, the target and its source, each only when known', () => {
    expect(boardSummary(board({ target: devkit, board: identity }))).toBe(
      'devkit · sima@192.168.1.20 · SDK DevKit',
    );
    expect(boardSummary(board({ target: devkit }))).toBe('sima@192.168.1.20 · SDK DevKit');
    expect(boardSummary(board({ target: localTarget }))).toBe('This board · On this board');
    expect(boardSummary(board())).toBe('');
  });

  it('the facts are those the board reported, then the camera setup', () => {
    expect(boardFacts(board({ target: devkit, board: identity }), cameraSetup)).toEqual([
      ['Hostname', 'devkit'],
      ['Build', '2.0.0'],
      ['Machine', 'modalix'],
      ['Model', 'SiMa.ai Modalix SoM 16Gig Board'],
      ['Camera setup', 'modalix-som-waveshare-ARDU-IMX477-1CAM'],
    ]);
    const partial = { ...identity, hostname: null, machine: '' };
    expect(boardFacts(board({ target: devkit, board: partial }), null)).toEqual([
      ['Build', '2.0.0'],
    ]);
    expect(boardFacts(board({ target: devkit }), null)).toEqual([]);
  });
});
