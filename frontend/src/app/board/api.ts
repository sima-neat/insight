/**
 * The board's routes (`/api/boards...`), typed from `server/api/openapi.yaml`
 * (`api.generated.ts`), and the path every board route takes. `BoardService` calls the routes.
 *
 * A failed board request answers the error shape, `{error: {code, message, hint?}}`, which a
 * board's failure extends with `host_key` (`host_key_changed`: the trusted and the presented key)
 * or `command` (`auth_failed`: the command that authorizes Insight's key); `problemOf` in
 * `board-error.ts` reads it.
 */

import type { BoardList, BoardSelection, BoardTarget } from '../api.generated';

export type {
  BoardError,
  BoardIdentity,
  BoardList,
  BoardSelection,
  BoardStatus,
  BoardTarget,
  HostKeyChange,
  SelectedBoard,
  TrustHostKeyRequest,
} from '../api.generated';

/** `local` is Insight running on the board itself; `ssh` reaches a board over SSH. */
export type BoardMode = 'local' | 'ssh';

/** Where a board comes from: entered by hand, the one Insight runs on, the paired SDK's DevKit. */
export type BoardSource = 'manual' | 'on-board' | 'sdk-env';

/** An SSH address as the board form sends it (`POST /api/boards`). */
export type SshAddress = Required<BoardSelection>;

/**
 * The camera setup SiMa Sentinel read from the board's device tree (the `board` of its peripheral
 * catalog). Either field is absent or empty when Sentinel did not report it.
 */
export interface CameraSetup {
  model?: string | null;
  /** Device-tree overlay files, such as `modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo`. */
  overlays?: string[];
}

/** Where the selected board is (its mode, source and SSH address); null while none is selected. */
export function selectedTarget(state: BoardList | null): BoardTarget | null {
  const id = state?.selected?.id;
  return (id && state.boards.find((board) => board.id === id)) || null;
}

/**
 * The URL of a board route: `/api/boards/<id>`, or `/api/boards/<id>/<path>`, the id escaped.
 * Every request about a board names it, so one that lands after the board was replaced is answered
 * 404 `not_found` rather than for the new board.
 */
export function boardUrl(id: string, path = ''): string {
  const board = `/api/boards/${encodeURIComponent(id)}`;
  return path ? `${board}/${path}` : board;
}
