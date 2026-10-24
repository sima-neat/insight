/**
 * The shape of Flask's `GET /api/sysinfo` (Inv-PB §4.5; `neat --json`, schema
 * `sima.neat.status.v1`, enriched by `_enrich_sysinfo_payload`). Types only: the System Info
 * dialog calls the endpoint. A failed request answers `{error}`.
 *
 * `neat` decides what each section holds, so the values of the sections that are free-form
 * (`environment`, `insight`, `updateCheck`) are `unknown` and shown as the words they read as.
 */

/** One installed or installable piece of software, keyed by its id in `SystemInfo.components`. */
export interface SystemComponent {
  /** Shown instead of the key when `neat` names the component. */
  name?: string | null;
  version?: string | null;
  tag?: string | null;
  channel?: string | null;
  channelAssumed?: boolean | null;
  latestTag?: string | null;
  latestVersion?: string | null;
  metadataUrl?: string | null;
  updateAvailable?: boolean | null;
  /** A service's state, such as "Running"; set for components that run. */
  serviceState?: string | null;
  installed?: boolean | null;
  detail?: string | null;
  venv?: string | null;
}

/** A port the SDK container publishes; `hostPortEnd` is set for a range. */
export interface ExposedPort {
  name: string;
  protocol?: string | null;
  hostPortStart?: number | null;
  hostPortEnd?: number | null;
}

export interface SystemInfo {
  environment?: Record<string, unknown>;
  insight?: Record<string, unknown>;
  updateCheck?: Record<string, unknown>;
  components?: Record<string, SystemComponent>;
  exposedPorts?: ExposedPort[];
  /**
   * What could not be read, when Insight answered without it: `neat` when the command is not
   * installed (then `environment`, `components` and `updateCheck` are empty, and Insight's own
   * `insight` and `exposedPorts` are still filled in).
   */
  missing?: string[];
}
