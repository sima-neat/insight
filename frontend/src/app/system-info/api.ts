/**
 * System Info's routes, typed from `server/api/openapi.yaml` (`api.generated.ts`). Types only:
 * the System Info dialog calls them.
 *
 * - `GET /api/system`: Insight's version and build, where it runs and what it resolved at start
 *   (`insight`), and an allowlist of what `neat --json` says about this machine (`neat`). neat runs
 *   once at start and again with `?refresh=true`; a plain read answers from memory, with
 *   `neat.state` `reading` until the first run ended.
 * - `GET /api/system/host`: this computer's CPU, memory and disk, not the board's.
 */

import type { SystemNeat } from '../api.generated';

export type {
  HostReadings,
  NeatComponent,
  SystemInfo,
  SystemInsight,
  SystemNeat,
  Usage,
} from '../api.generated';

/** A port the SDK container publishes; `hostPortEnd` is set for a range. */
export type ExposedPort = SystemNeat['exposed_ports'][number];
