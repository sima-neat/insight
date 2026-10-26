/**
 * The board's words: what the pill and the board dialog say about the board, as pure
 * functions of the board state (#170's `peripherals/model.js`, copy per Inv-PB §2.1 and §2.5).
 * #170's tones map to the kit's: ok `success`, warn `warning`, periph-danger `danger`, none
 * `neutral`.
 */

import type { NeatTone } from '@sima/neat-ui';
import type { BoardSource, BoardState, BoardStatus, BoardTarget, CameraSetup } from './api';
import type { BoardProblem } from './board-error';

/** A connection state in words: the long label (the dialog), the short one (the pill's chip). */
export interface ConnectionState {
  label: string;
  short: string;
  tone: NeatTone;
}

export interface BoardChip {
  label: string;
  tone: NeatTone;
}

/** The top bar's pill: which board, its state as a chip, and the tooltip that says both in full. */
export interface BoardIndicator {
  label: string;
  chip: BoardChip;
  tooltip: string;
}

const SOURCES: Record<BoardSource, string> = {
  'on-board': 'On this board',
  'sdk-env': 'SDK DevKit',
  manual: 'Manual',
};

export function connectionState(status: BoardStatus): ConnectionState {
  if (status.state === 'connected')
    return { label: 'Connected', short: 'Connected', tone: 'success' };
  if (status.state === 'error')
    return { label: 'Connection failed', short: 'Error', tone: 'danger' };
  return { label: 'Not checked', short: 'Not checked', tone: 'neutral' };
}

/**
 * The pill's words. The state is the last good answer; `error` the last read failure, which wins
 * over it so that a board Insight can no longer read never looks fine (Inv-PB §6.1): the pill
 * keeps naming the last known board and says why it could not be read. Loading is only the
 * moment before the first answer, when there is neither. `checking` (a connection check is out)
 * turns Not checked into Checking…; a known state keeps its words until the check answers.
 */
export function boardIndicator(
  state: BoardState | null,
  error: BoardProblem | null,
  checking = false,
): BoardIndicator {
  if (error) {
    // The last known board is named in full, as in every other state: the label may be cut.
    const named = state?.target ? `${state.target.label} — ` : '';
    return {
      label: state ? targetName(state.target) : 'Board',
      chip: { label: 'Error', tone: 'danger' },
      tooltip: `${named}Could not read the board: ${error.message}`,
    };
  }
  if (!state) {
    return {
      label: 'Board',
      chip: { label: 'Loading…', tone: 'neutral' },
      tooltip: 'Loading the selected board',
    };
  }
  const target = state.target;
  if (!target) {
    return {
      label: targetName(target),
      chip: { label: 'Not selected', tone: 'warning' },
      tooltip: 'No board is selected. Open board settings to choose one.',
    };
  }
  if (checking && state.status.state === 'unknown') {
    return {
      label: targetName(target),
      chip: { label: 'Checking…', tone: 'neutral' },
      tooltip: `${target.label} — Checking the connection. Open board settings.`,
    };
  }
  const connection = connectionState(state.status);
  return {
    label: targetName(target),
    chip: { label: connection.short, tone: connection.tone },
    tooltip: `${target.label} — ${connection.label}. Open board settings.`,
  };
}

/**
 * Which machine, in the words the rest of the SDK uses for it. "sima@host" is the connection
 * string, which belongs in the dialog, not the pill.
 */
function targetName(target: BoardTarget | null): string {
  if (!target) return 'No board';
  if (target.mode === 'local') return 'This board';
  return `${target.source === 'sdk-env' ? 'DevKit' : 'Board'}: ${target.host}`;
}

/** The board dialog's state chip: the connection's long label, or "No board" without a target. */
export function boardStateChip(state: BoardState): BoardChip {
  if (!state.target) return { label: 'No board', tone: 'warning' };
  const connection = connectionState(state.status);
  return { label: connection.label, tone: connection.tone };
}

/**
 * The board dialog's status line after the chip: the hostname the board reported, the target and
 * where it comes from, each left out when unknown. '' without a target.
 */
export function boardSummary(state: BoardState): string {
  const target = state.target;
  if (!target) return '';
  return [state.board?.hostname, target.label, sourceLabel(target.source)]
    .filter(Boolean)
    .join(' · ');
}

const IDENTITY_FACTS: readonly [key: 'hostname' | 'build_version' | 'machine', term: string][] = [
  ['hostname', 'Hostname'],
  ['build_version', 'Build'],
  ['machine', 'Machine'],
];

/**
 * The board dialog's Details as [term, value] rows: the identity facts the board reported, then
 * the camera setup (`cameraSetupRows`) of the board it belongs to (`boardCameraSetup`).
 */
export function boardFacts(
  state: BoardState,
  setup: CameraSetup | null,
): [term: string, value: string][] {
  const identity = IDENTITY_FACTS.flatMap(([key, term]): [string, string][] => {
    const value = state.board?.[key];
    return value ? [[term, value]] : [];
  });
  return [...identity, ...cameraSetupRows(setup)];
}

export function sourceLabel(source: BoardSource): string {
  return SOURCES[source] ?? '';
}

/** "modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo" reads as "modalix-som-waveshare-ARDU-IMX477-1CAM". */
export function overlayName(file: string): string {
  return (file.split('/').pop() ?? '').replace(/\.dtbo$/i, '');
}

/** The board facts for the camera setup, as [term, value] rows; each is left out when Sentinel did not report it. */
export function cameraSetupRows(setup: CameraSetup | null): [term: string, value: string][] {
  const rows: [term: string, value: string][] = [];
  if (setup?.model) rows.push(['Model', setup.model]);
  const overlays = (setup?.overlays ?? []).map(overlayName).filter(Boolean);
  if (overlays.length) rows.push(['Camera setup', overlays.join(', ')]);
  return rows;
}
