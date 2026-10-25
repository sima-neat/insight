// Runs fixtures for specs and for Playwright: the answers of Sentinel's traces and runs
// endpoints typed as the API's shapes, with the envelope Insight puts around them. Like
// `stats.testing.ts` it imports only types and JSON, with no vitest globals and no Angular, so
// Playwright can load it too.
import compareRaw from '../../../../tests/fixtures/sentinel/compare-raw.json';
import runDetail from '../../../../tests/fixtures/sentinel/run-detail-shape.json';
import runsList from '../../../../tests/fixtures/sentinel/runs-list.json';
import tracesActive from '../../../../tests/fixtures/sentinel/traces-active.json';
import type {
  CompareExport,
  RunMetadata,
  RunSummary,
  RunsAnswer,
  SavedRun,
  TraceAnswer,
} from './api';
import { METRICS_LIVE } from './stats.testing';

/**
 * The runs on a board: four finished and one still recording, newest first, as `GET
 * /api/sentinel/runs` lists them. The finished ones are the runs of the detail and compare
 * fixtures (Modalix, 2026-09-23 and -24) and an older idle baseline.
 */
export const RUNS_LIST: RunSummary[] = runsList;

/** The run being recorded (`ended_at` null): the first of `RUNS_LIST`. */
export const RECORDING_RUN: RunSummary = RUNS_LIST[0];

/** The trace `GET /api/sentinel/traces` names while `RECORDING_RUN` records. */
export const ACTIVE_TRACE: RunMetadata = tracesActive.trace;

/** `GET /api/sentinel/runs/<id>` for the finished run `20260923T152712.952Z-...-1790177227`. */
export const SAVED_RUN: SavedRun = runDetail;

/**
 * `GET /api/sentinel/compare?raw=1` for `tes3` against that run. The capture predates the
 * daemon's `system` and `sentinel_version` in run metadata and its metric `short` and
 * `description`, so it is cast; a consumer must read only what both captures hold.
 */
export const COMPARE_RAW = compareRaw.sentinel as unknown as CompareExport;

/** An answer to the runs list (or to a delete, which answers the runs left). */
export function runsAnswer(
  runs: RunSummary[] = RUNS_LIST,
  generation: number = METRICS_LIVE.generation,
): RunsAnswer {
  return { board: METRICS_LIVE.board, generation, sentinel: { runs } };
}

/**
 * An answer about the trace: `summary` is left out (a start answer) unless given, and null where
 * the read answer has no trace to summarise.
 */
export function traceAnswer(
  trace: RunMetadata | null,
  summary?: RunSummary | null,
  generation: number = METRICS_LIVE.generation,
): TraceAnswer {
  const sentinel = summary === undefined ? { trace } : { trace, summary };
  return { board: METRICS_LIVE.board, generation, sentinel };
}

/** `SAVED_RUN` with parts replaced. */
export function savedRun(overrides: Partial<SavedRun> = {}): SavedRun {
  return { ...SAVED_RUN, ...overrides };
}
