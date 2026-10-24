/**
 * Request and response shapes of Flask's `/api/board*` and `/api/devkit-shell*` endpoints
 * (Inv-PB §4.1 and §4.4; `neat_insight/board/target.py` and `manager.py`, `app.py`'s
 * `_build_devkit_shell_payload`). Types only: `BoardService` calls the endpoints.
 *
 * A failed board request answers `{error, code, hint, ...extra}` (`BoardErrorBody`);
 * `problemOf` in `board-error.ts` reads it.
 */

/** `local` is Insight running on the board itself; `ssh` reaches a board over SSH. */
export type BoardMode = 'local' | 'ssh';

/** Where the target comes from, in resolution order: saved by hand, on-board, the paired SDK. */
export type BoardSource = 'manual' | 'on-board' | 'sdk-env';

/** An SSH address: the saved manual target, or the DevKit the SDK is paired with. */
export interface SshAddress {
  host: string;
  port: number;
  user: string;
}

/** The board Insight talks to. A `local` target has no host, port or user. */
export interface BoardTarget {
  mode: BoardMode;
  source: BoardSource;
  host: string | null;
  port: number | null;
  user: string | null;
  /** "This board", or `user@host`, with `:port` when the port is not 22. */
  label: string;
}

/** What the target falls back to when no manual target is saved. */
export interface BoardDefaults {
  on_board: boolean;
  sdk_env: SshAddress | null;
}

/**
 * A board error as the API sends it: as a failed request's body, and repeated in
 * `BoardStatus.error`. The extras depend on the code: `host_key_changed` adds `host`,
 * `expected_fingerprint` and `presented_fingerprint`; `auth_failed` adds the `command` that
 * authorizes Insight's key; `stale_snapshot` adds `expected_generation` and `current_generation`.
 */
export interface BoardErrorBody {
  error: string;
  code: string;
  hint: string | null;
  [extra: string]: unknown;
}

/** The last connection result: `unknown` until checked, and again after the target changes. */
export type ConnectionStatus = 'unknown' | 'connected' | 'error';

export interface BoardStatus {
  state: ConnectionStatus;
  /** ISO time of the last check; null while `unknown`. */
  checked_at: string | null;
  /** The last connection error; set only while `state` is `error`. */
  error: BoardErrorBody | null;
}

/** What a connection read from the board. Each fact is null when the board did not report it. */
export interface BoardIdentity {
  hostname: string | null;
  machine: string | null;
  build_version: string | null;
  /** Identifies the board (its machine id and host key), not the host key alone. */
  fingerprint: string;
}

/**
 * The board an answer describes (`board_summary` in `neat_insight/board/manager.py`): the selected
 * target and, once a connection read it, its identity. Peripherals and Sentinel answers carry it
 * as their `board`. The identity facts are null until a connection read them.
 */
export interface BoardSummary {
  label: string;
  source: BoardSource;
  hostname: string | null;
  machine: string | null;
  build_version: string | null;
  fingerprint: string | null;
}

/** `GET /api/board`, and the answer of every board action. */
export interface BoardState {
  target: BoardTarget | null;
  saved: SshAddress | null;
  defaults: BoardDefaults;
  /** Bumped by every change of the resolved target; answers about another board name another one. */
  generation: number;
  status: BoardStatus;
  /** The identity the last successful connection read; null until then and after a target change. */
  board: BoardIdentity | null;
}

/** `POST /api/board/select`: save a manual target, or clear it to fall back to the default. */
export type BoardSelectRequest = SshAddress | { reset: true };

/** `POST /api/board/trust-host-key`: the presented fingerprint the user confirmed. */
export interface TrustHostKeyRequest {
  fingerprint: string;
}

/**
 * The camera setup SiMa Sentinel read from the board's device tree (a peripherals snapshot's
 * `camera_setup`). Either field is absent or empty when Sentinel did not report it.
 */
export interface CameraSetup {
  model?: string | null;
  /** Device-tree overlay files, such as `modalix-som-waveshare-ARDU-IMX477-1CAM.dtbo`. */
  overlays?: string[];
}

/** `GET /api/devkit-shell` and `POST /api/devkit-shell/start`: the browser shell (webssh). */
export interface ShellInfo {
  /** A DevKit is selected or paired. */
  configured: boolean;
  devkit_ip: string | null;
  button_label: string | null;
  /** webssh is installed in Insight's environment. */
  available: boolean;
  running: boolean;
  webssh_port: number;
  /** The port the browser reaches webssh on (the SDK's port map, else `webssh_port`). */
  webssh_host_port: number;
  default_username: string;
  credentials_prefilled: boolean;
  /** Open shell can sign in by itself: `configured && credentials_prefilled`. */
  launch_supported: boolean;
  /** Carries the SDK's default password, so it is opened on click only, never shown. */
  launch_url: string | null;
}
