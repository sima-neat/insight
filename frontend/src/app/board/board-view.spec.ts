import type { BoardStatus, BoardTarget } from './api';
import { BoardProblem } from './board-error';
import { boardList, boardWith, DEVKIT, LOCAL, MANUAL } from './board.testing';
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

const cameraSetup = {
  model: 'SiMa.ai Modalix SoM 16Gig Board',
  overlays: ['modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo'],
};

const connected: BoardStatus = { state: 'connected' };
const failedStatus: BoardStatus = { state: 'error' };

describe('boardRailView', () => {
  const devkit: BoardTarget = { ...DEVKIT, host: '192.168.2.2', label: 'sima@192.168.2.2' };
  const unreachable = new BoardProblem(
    'Could not reach the Insight server.',
    'network',
    'Check that Insight is still running, then retry.',
  );

  it('a connected board is quiet: its short name, its address, a success dot', () => {
    expect(boardRailView(boardWith(devkit, { status: connected }), null)).toEqual({
      name: 'DevKit',
      detail: '192.168.2.2',
      tone: 'success',
      summary: 'DevKit — 192.168.2.2 — Connected',
    });
    // A hand-entered board is not called a DevKit; a port other than SSH's is part of the address.
    expect(boardRailView(boardWith(MANUAL, { status: connected }), null)).toMatchObject({
      name: 'Board',
      detail: '10.0.0.5:2222',
    });
  });

  it('this board has no address, so its state is the second line even when connected', () => {
    expect(boardRailView(boardWith(LOCAL, { status: connected }), null)).toEqual({
      name: 'This board',
      detail: 'Connected',
      tone: 'success',
      summary: 'This board — Connected',
    });
  });

  it('a board that is not connected says its state in words, with the dot of its tone', () => {
    expect(boardRailView(boardWith(devkit), null)).toEqual({
      name: 'DevKit',
      detail: 'Not checked',
      tone: 'neutral',
      summary: 'DevKit — 192.168.2.2 — Not checked',
    });
    // The short word is shown; the accessible name and tooltip have the long one.
    expect(boardRailView(boardWith(devkit, { status: failedStatus }), null)).toEqual({
      name: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      summary: 'DevKit — 192.168.2.2 — Connection failed',
    });
    expect(boardRailView(boardList(), null)).toEqual({
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
    expect(boardRailView(boardWith(devkit), null, true)).toEqual({
      name: 'DevKit',
      detail: 'Checking…',
      tone: 'warning',
      summary: 'DevKit — 192.168.2.2 — Checking the connection',
    });
    // A known state, no board, or a failed read keeps its own words while a check runs.
    expect(boardRailView(boardWith(devkit, { status: connected }), null, true).detail).toBe(
      '192.168.2.2',
    );
    expect(boardRailView(boardList(), null, true).detail).toBe('Not selected');
    expect(boardRailView(null, null, true).detail).toBe('Loading…');
    expect(boardRailView(boardWith(devkit), unreachable, true).detail).toBe('Error');
  });

  it('shows Error with the reason when the board could not be read, not Loading…', () => {
    expect(boardRailView(null, unreachable)).toEqual({
      name: 'Board',
      detail: 'Error',
      tone: 'danger',
      summary: 'Board — Could not read the board: Could not reach the Insight server.',
    });
    // With a last good state the block still names the board, and says the read failed.
    expect(boardRailView(boardWith(devkit, { status: connected }), unreachable)).toEqual({
      name: 'DevKit',
      detail: 'Error',
      tone: 'danger',
      summary:
        'DevKit — 192.168.2.2 — Could not read the board: Could not reach the Insight server.',
    });
    // A last state with no board selected keeps saying so.
    expect(boardRailView(boardList(), unreachable)).toEqual({
      name: 'No board',
      detail: 'Error',
      tone: 'danger',
      summary: 'No board — Could not read the board: Could not reach the Insight server.',
    });
  });
});

describe('the board’s words', () => {
  it('connectionState gives the long label, the short one and the tone', () => {
    expect(connectionState(connected)).toEqual({
      label: 'Connected',
      short: 'Connected',
      tone: 'success',
    });
    expect(connectionState(failedStatus)).toEqual({
      label: 'Connection failed',
      short: 'Error',
      tone: 'danger',
    });
    expect(connectionState({ state: 'unknown' })).toEqual({
      label: 'Not checked',
      short: 'Not checked',
      tone: 'neutral',
    });
  });

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
  const identity = {
    hostname: 'devkit',
    machine: 'modalix',
    build: '2.0.0',
    host_key: 'SHA256:abcd',
  };

  it('the status chip has the long labels, and No board without one selected', () => {
    const status = (state: BoardStatus['state']) =>
      boardStateChip(boardWith(DEVKIT, { status: { state } }));
    expect(status('connected')).toEqual({ label: 'Connected', tone: 'success' });
    expect(status('error')).toEqual({ label: 'Connection failed', tone: 'danger' });
    expect(status('unknown')).toEqual({ label: 'Not checked', tone: 'neutral' });
    expect(boardStateChip(boardList())).toEqual({ label: 'No board', tone: 'warning' });
  });

  it('the status line joins the hostname, the board and its source, each only when known', () => {
    expect(boardSummary(boardWith(DEVKIT, { identity }))).toBe(
      'devkit · sima@192.168.1.20 · SDK DevKit',
    );
    expect(boardSummary(boardWith(DEVKIT))).toBe('sima@192.168.1.20 · SDK DevKit');
    expect(boardSummary(boardWith(LOCAL))).toBe('This board · On this board');
    expect(boardSummary(boardList())).toBe('');
  });

  it('the facts are those the last check read, then the camera setup', () => {
    expect(boardFacts(boardWith(DEVKIT, { identity }), cameraSetup)).toEqual([
      ['Hostname', 'devkit'],
      ['Build', '2.0.0'],
      ['Machine', 'modalix'],
      ['Host key', 'SHA256:abcd'],
      ['Model', 'SiMa.ai Modalix SoM 16Gig Board'],
      ['Camera setup', 'modalix-som-waveshare-ARDU-IMX477-1CAM'],
    ]);
    // The local board has no host key; a fact the board did not report is left out.
    const local = { ...identity, hostname: '', host_key: '' };
    expect(boardFacts(boardWith(LOCAL, { identity: local }), null)).toEqual([
      ['Build', '2.0.0'],
      ['Machine', 'modalix'],
    ]);
    expect(boardFacts(boardWith(DEVKIT), null)).toEqual([]);
  });
});
