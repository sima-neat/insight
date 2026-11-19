/**
 * The board form's values and checks, as pure functions. Only the board dialog's form uses them,
 * so they live apart from `board-view.ts`, which the rail's board block imports: kept there, they
 * would be in the initial bundle.
 */

import { selectedTarget, type BoardList, type BoardTarget, type SshAddress } from './api';

/** The board form's fields as typed: the port stays text until `validateBoardForm` reads it. */
export interface BoardFormValues {
  host: string;
  port: string;
  user: string;
}

const bySource = (state: BoardList | null, source: BoardTarget['source']) =>
  state?.boards.find((board) => board.source === source) ?? null;

/** The board entered by hand, which Use default forgets; null when none is. */
export function enteredBoard(state: BoardList | null): BoardTarget | null {
  return bySource(state, 'manual');
}

/**
 * The board the selection falls back to without one entered by hand, for the form's
 * "Default: …" hint: the board Insight runs on, else the SDK's DevKit; '' for none.
 */
export function defaultTargetText(state: BoardList | null): string {
  if (bySource(state, 'on-board')) return 'this board (Insight is running on it)';
  const devkit = bySource(state, 'sdk-env');
  if (devkit?.host) {
    return `${devkit.user || 'sima'}@${devkit.host}:${devkit.port || 22} (paired SDK DevKit)`;
  }
  return '';
}

/**
 * The form starts from the board entered by hand, else the SSH board in use, else the paired
 * DevKit.
 */
export function initialBoardForm(state: BoardList | null): BoardFormValues {
  const selected = selectedTarget(state);
  const ssh = selected?.mode === 'ssh' ? selected : null;
  const from = enteredBoard(state) ?? ssh ?? bySource(state, 'sdk-env');
  return { host: from?.host || '', port: String(from?.port || 22), user: from?.user || 'sima' };
}

/**
 * Checks the form before it is sent: the request body, or the first problem in words. The server
 * checks again, with its own messages.
 */
export function validateBoardForm(
  values: BoardFormValues,
): { body: SshAddress } | { error: string } {
  const host = values.host.trim();
  const user = values.user.trim();
  const port = Number(values.port);
  if (!host) return { error: 'Enter the board host name or IP address.' };
  if (/\s/.test(host)) return { error: 'The host cannot contain spaces.' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'The SSH port must be a whole number from 1 to 65535.' };
  }
  if (!user) return { error: 'Enter the SSH user, usually "sima".' };
  return { body: { host, port, user } };
}
