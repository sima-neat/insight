/**
 * The board form's values and checks (#170's `model.js`, copy per Inv-PB §2.5), as pure
 * functions. Only the board dialog's form uses them, so they live apart from `board-view.ts`,
 * which the rail's board block imports: kept there, they would be in the initial bundle (ruling Q14).
 */

import type { BoardDefaults, BoardState, SshAddress } from './api';

/** The board form's fields as typed: the port stays text until `validateBoardForm` reads it. */
export interface BoardFormValues {
  host: string;
  port: string;
  user: string;
}

/** The target Insight falls back to without a manual one, for the form's "Default: …" hint; '' for none. */
export function defaultTargetText(defaults: BoardDefaults): string {
  if (defaults.on_board) return 'this board (Insight is running on it)';
  const env = defaults.sdk_env;
  if (env?.host) return `${env.user || 'sima'}@${env.host}:${env.port || 22} (paired SDK DevKit)`;
  return '';
}

/** The form starts from the saved manual target, else the SSH target in use, else the paired DevKit. */
export function initialBoardForm(state: BoardState | null): BoardFormValues {
  const ssh = state?.target?.mode === 'ssh' ? state.target : null;
  const from = state?.saved ?? ssh ?? state?.defaults.sdk_env ?? null;
  return { host: from?.host || '', port: String(from?.port || 22), user: from?.user || 'sima' };
}

/**
 * Checks the form before it is sent: the request body, or the first problem in #170's words. The
 * server checks again (`validate_ssh_target`), with its own messages.
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
